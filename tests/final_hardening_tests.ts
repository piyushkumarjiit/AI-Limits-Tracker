import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/src/app';
import { installServerNetworking, SERVER_RESPONSE_BYTES } from '../server/src/net';
import { Store } from '../server/src/store';
import type { Tracker } from '../server/src/tracker';
import {
  assertSafeUrl,
  isBlockedAddress,
  isolatedFetch,
  readJsonSafe,
  readTextSafe,
  ResponseTooLargeError,
  setHostResolver,
  setMaxResponseBytes,
} from '../src/services/http';
import { GeminiProvider } from '../src/services/providers/GeminiProvider';
import type { AccountCredentials } from '../src/models/types';

const ADMIN_PASSWORD = 'test-admin-password-123';
const APP_SECRET = 'test-app-secret-0123456789abcdef';
const API_TOKEN = 'test-api-token-abc123';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, extraInfo?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  ✗ [FAIL] ${testName} ${extraInfo ? `-> ${extraInfo}` : ''}`);
  }
}

/** Asserts that `fn` throws, optionally with a message containing `needle`. */
function throws(fn: () => unknown, testName: string, needle?: string): void {
  try {
    fn();
    assert(false, testName, 'expected an error, none was thrown');
  } catch (e: any) {
    const message = String(e?.message || e);
    assert(!needle || message.toLowerCase().includes(needle.toLowerCase()), testName, message);
  }
}

/** Asserts that `fn` rejects, optionally with a message containing `needle`. */
async function rejects(fn: () => Promise<unknown>, testName: string, needle?: string): Promise<void> {
  try {
    await fn();
    assert(false, testName, 'expected a rejection, none was thrown');
  } catch (e: any) {
    const message = String(e?.message || e);
    assert(!needle || message.toLowerCase().includes(needle.toLowerCase()), testName, message);
  }
}

function fakeTracker(overrides: Record<string, unknown> = {}): Tracker {
  return {
    lastSyncAllAt: null,
    intervalMin: () => 5,
    setIntervalMin: () => {},
    syncAll: async () => {},
    sync: async () => {},
    startOAuth: () => {
      throw new Error('not available');
    },
    finishOAuth: async () => ({ ok: false, error: 'not available' }),
    connectManual: async () => ({ ok: false, error: 'not available' }),
    reorder: () => {},
    start: () => {
      throw new Error('tracker.start() must not be called by createApp');
    },
    stop: () => {},
    ...overrides,
  } as unknown as Tracker;
}

/** Runs `fn` against a real app on an ephemeral port over a temp data dir. */
async function withApp(tracker: Tracker, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alt-final-'));
  const dataDir = join(dir, 'data');
  const webDir = join(dir, 'web');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(webDir, { recursive: true });

  const store = new Store(dataDir, 'tracker.db', APP_SECRET);
  const server = createApp(
    {
      adminPassword: ADMIN_PASSWORD,
      appSecret: APP_SECRET,
      apiToken: API_TOKEN,
      secureCookies: false,
      trustProxy: false,
      webDir,
    },
    { store, tracker }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- SSRF: URL guard ---------------- */

function testSafeUrl() {
  console.log('\n[1] SSRF guard: URL and address forms');

  throws(() => assertSafeUrl('https://intranet/'), 'URL guard: single-label hostname is refused');
  throws(() => assertSafeUrl('https://intranet./'), 'URL guard: trailing-dot single label is refused');
  throws(() => assertSafeUrl('https://localhost/'), 'URL guard: localhost is refused');
  throws(() => assertSafeUrl('https://printer.local/'), 'URL guard: .local is refused');
  throws(() => assertSafeUrl('https://metadata.internal/'), 'URL guard: .internal is refused');
  throws(() => assertSafeUrl('http://example.com/'), 'URL guard: plain http is refused');
  throws(() => assertSafeUrl('https://user:pass@example.com/'), 'URL guard: credentials are refused');
  throws(() => assertSafeUrl('https://2130706433/'), 'URL guard: decimal-encoded loopback is refused');

  const blocked = [
    'https://10.0.0.1/',
    'https://172.16.0.1/',
    'https://172.31.255.255/',
    'https://192.168.1.1/',
    'https://127.0.0.1/',
    'https://169.254.1.1/',
    'https://100.64.0.1/',
    'https://198.18.0.1/',
    'https://198.19.255.255/',
    'https://192.0.0.1/',
    'https://192.0.2.1/',
    'https://198.51.100.1/',
    'https://203.0.113.1/',
    'https://224.0.0.1/',
    'https://239.255.255.255/',
    'https://240.0.0.1/',
    'https://255.255.255.255/',
  ];
  for (const url of blocked) throws(() => assertSafeUrl(url), `URL guard: blocks ${url}`);

  const blockedV6 = [
    'https://[::1]/',
    'https://[::]/',
    'https://[fc00::1]/',
    'https://[fd12:3456::1]/',
    'https://[fe80::1]/',
    'https://[febf::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:10.0.0.1]/',
    'https://[::ffff:7f00:1]/',
  ];
  for (const url of blockedV6) throws(() => assertSafeUrl(url), `URL guard: blocks IPv6 ${url}`);

  for (const url of [
    'https://example.com/',
    'https://api.anthropic.com/v1/usage',
    'https://[2606:4700:4700::1111]/',
  ]) {
    try {
      assertSafeUrl(url);
      assert(true, `URL guard: allows ${url}`);
    } catch (e: any) {
      assert(false, `URL guard: allows ${url}`, e?.message);
    }
  }

  assert(
    isBlockedAddress('10.0.0.1') &&
      isBlockedAddress('127.0.0.1') &&
      isBlockedAddress('::1') &&
      isBlockedAddress('::ffff:7f00:1') &&
      isBlockedAddress('fd00::1') &&
      isBlockedAddress('fe80::1'),
    'Address guard: private and reserved forms are blocked'
  );
  assert(
    !isBlockedAddress('93.184.216.34') && !isBlockedAddress('2606:4700:4700::1111'),
    'Address guard: public addresses pass'
  );
}

/* ---------------- SSRF: DNS resolution ---------------- */

async function testDnsGuard() {
  console.log('\n[2] SSRF guard: DNS resolution');

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    setHostResolver(async () => ['127.0.0.1']);
    await rejects(
      () => isolatedFetch('https://rebind.example/x'),
      'DNS: a name resolving to loopback is refused',
      'private'
    );

    setHostResolver(async () => ['93.184.216.34', '10.0.0.5']);
    await rejects(
      () => isolatedFetch('https://mixed.example/x'),
      'DNS: any private address among several is refused',
      'private'
    );

    setHostResolver(async () => ['93.184.216.34']);
    calls = 0;
    const resp = await isolatedFetch('https://public.example/x');
    assert(resp.status === 200 && calls === 1, 'DNS: a name with only public addresses is fetched');

    setHostResolver(async () => {
      throw new Error('ENOTFOUND');
    });
    await rejects(
      () => isolatedFetch('https://missing.example/x'),
      'DNS: a lookup failure is refused',
      'could not be resolved'
    );

    setHostResolver(async () => []);
    await rejects(
      () => isolatedFetch('https://empty.example/x'),
      'DNS: a name with no addresses is refused',
      'could not be resolved'
    );

    // IP literals were already validated, so no lookup is attempted for them.
    setHostResolver(async () => ['10.0.0.5']);
    calls = 0;
    await isolatedFetch('https://93.184.216.34/x');
    assert(calls === 1, 'DNS: IP literals skip resolution');
  } finally {
    setHostResolver(null);
    globalThis.fetch = realFetch;
  }
}

/* ---------------- SSRF: redirects ---------------- */

interface Route {
  status: number;
  location?: string;
  body?: string;
}

async function testRedirects() {
  console.log('\n[3] SSRF guard: redirects');

  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let routes: Record<string, Route> = {};

  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response('unexpected ' + url, { status: 500 });
    const headers: Record<string, string> = {};
    if (route.location) headers.location = route.location;
    return new Response(route.body ?? null, { status: route.status, headers });
  }) as unknown as typeof fetch;

  setHostResolver(null);
  try {
    routes = {
      'https://example.com/start': { status: 302, location: '/next' },
      'https://example.com/next': { status: 200, body: 'ok' },
    };
    calls.length = 0;
    const followed = await isolatedFetch('https://example.com/start');
    assert(
      followed.status === 200 && calls[1] === 'https://example.com/next',
      'Redirects: relative Location is resolved and followed',
      calls.join(' -> ')
    );
    assert(followed.redirected === true, 'Redirects: a followed response reports redirected');

    routes['https://example.com/to-private'] = { status: 302, location: 'https://127.0.0.1/' };
    await rejects(
      () => isolatedFetch('https://example.com/to-private'),
      'Redirects: a redirect to loopback is refused',
      'Private addresses'
    );

    routes['https://example.com/to-http'] = { status: 302, location: 'http://example.com/downgrade' };
    await rejects(
      () => isolatedFetch('https://example.com/to-http'),
      'Redirects: a redirect to plain http is refused',
      'https'
    );

    routes['https://example.com/to-local'] = { status: 302, location: 'https://printer.local/' };
    await rejects(
      () => isolatedFetch('https://example.com/to-local'),
      'Redirects: a redirect to a .local name is refused',
      'Host is not allowed'
    );

    routes['https://example.com/no-location'] = { status: 302 };
    await rejects(
      () => isolatedFetch('https://example.com/no-location'),
      'Redirects: a redirect without Location is an error',
      'Location'
    );

    routes['https://example.com/post'] = { status: 302, location: '/next' };
    await rejects(
      () => isolatedFetch('https://example.com/post', { method: 'POST', body: '{}' }),
      'Redirects: a POST redirect is an error',
      'not followed'
    );

    // Exactly three redirects are allowed; a fourth is refused.
    routes = {};
    for (let i = 0; i < 4; i++) routes[`https://example.com/r${i}`] = { status: 302, location: `/r${i + 1}` };
    routes['https://example.com/r3'] = { status: 200, body: 'end' };
    const end = await isolatedFetch('https://example.com/r0');
    assert(end.status === 200, 'Redirects: three hops are followed');

    routes['https://example.com/r3'] = { status: 302, location: '/r4' };
    routes['https://example.com/r4'] = { status: 200, body: 'end' };
    await rejects(
      () => isolatedFetch('https://example.com/r0'),
      'Redirects: a fourth hop is refused',
      'Too many redirects'
    );

    routes = { 'https://example.com/not-modified': { status: 304 } };
    const notModified = await isolatedFetch('https://example.com/not-modified');
    assert(notModified.status === 304, 'Redirects: 304 is returned rather than followed');
  } finally {
    setHostResolver(null);
    globalThis.fetch = realFetch;
  }
}

/* ---------------- SSRF: extended IPv6 ranges ---------------- */

function testIPv6ReservedRanges() {
  console.log('\n[4] SSRF guard: IPv6 reserved and IPv4-embedding ranges');

  const blocked = [
    'https://[ff00::]/',
    'https://[ff02::1]/',
    'https://[2001:db8::1]/',
    'https://[64:ff9b::a9fe:a9fe]/',
    'https://[64:ff9b::7f00:1]/',
    'https://[2002:a9fe:a9fe::1]/',
    'https://[2002:7f00:1::]/',
    'https://[2002:0a00:1::]/',
  ];
  for (const url of blocked) throws(() => assertSafeUrl(url), `IPv6 guard: blocks ${url}`);

  for (const url of ['https://[64:ff9b::808:808]/', 'https://[2002:808:808::1]/']) {
    try {
      assertSafeUrl(url);
      assert(true, `IPv6 guard: allows ${url}`);
    } catch (e: any) {
      assert(false, `IPv6 guard: allows ${url}`, e?.message);
    }
  }

  assert(
    isBlockedAddress('ff02::1') &&
      isBlockedAddress('2001:db8::1') &&
      isBlockedAddress('64:ff9b::a9fe:a9fe') &&
      isBlockedAddress('2002:a9fe:a9fe::1'),
    'Address guard: multicast, documentation and embedded-private IPv6 are blocked'
  );
  assert(
    !isBlockedAddress('64:ff9b::808:808') && !isBlockedAddress('2002:808:808::1'),
    'Address guard: public IPv4 embedded in IPv6 passes'
  );
}

/* ---------------- SSRF: redirect credentials ---------------- */

async function testRedirectCredentials() {
  console.log('\n[5] SSRF guard: redirects do not forward credentials');

  const realFetch = globalThis.fetch;
  const seen: Array<Record<string, string>> = [];
  let routes: Record<string, Route> = {};

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push(init?.headers ? { ...(init.headers as Record<string, string>) } : {});
    const route = routes[url];
    if (!route) return new Response('unexpected ' + url, { status: 500 });
    const headers: Record<string, string> = {};
    if (route.location) headers.location = route.location;
    return new Response(route.body ?? null, { status: route.status, headers });
  }) as unknown as typeof fetch;

  setHostResolver(null);
  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer secret-token',
    Cookie: 'sessionKey=secret-cookie',
    'proxy-authorization': 'Basic secret-proxy',
    Host: 'example.com',
  };
  try {
    routes = {
      'https://example.com/start': { status: 302, location: 'https://other.example/next' },
      'https://other.example/next': { status: 200, body: 'ok' },
    };
    seen.length = 0;
    await isolatedFetch('https://example.com/start', { headers });
    assert(
      seen[0]?.Authorization === 'Bearer secret-token' && seen[0]?.Cookie === 'sessionKey=secret-cookie',
      'Redirect credentials: the first hop carries the supplied credentials'
    );
    const second = seen[1] ?? {};
    const forwarded = Object.keys(second).filter((k) =>
      ['authorization', 'cookie', 'proxy-authorization', 'host'].includes(k.toLowerCase())
    );
    assert(
      forwarded.length === 0,
      'Redirect credentials: a cross-origin hop drops authorization, cookie, proxy-authorization and host',
      JSON.stringify(second)
    );
    assert(
      second.Accept === 'application/json',
      'Redirect credentials: ordinary headers survive a cross-origin hop',
      JSON.stringify(second)
    );

    routes = {
      'https://example.com/same': { status: 302, location: '/same-next' },
      'https://example.com/same-next': { status: 200, body: 'ok' },
    };
    seen.length = 0;
    await isolatedFetch('https://example.com/same', { headers });
    assert(
      seen[1]?.Authorization === 'Bearer secret-token' && seen[1]?.Cookie === 'sessionKey=secret-cookie',
      'Redirect credentials: a same-origin hop keeps the credentials'
    );
  } finally {
    setHostResolver(null);
    globalThis.fetch = realFetch;
  }
}

/* ---------------- SSRF: DNS timeout ---------------- */

async function testDnsAbort() {
  console.log('\n[6] SSRF guard: DNS lookup honours the request timeout');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
  // A resolver that never settles models a blackholed system resolver.
  setHostResolver(() => new Promise<string[]>(() => {}));
  const started = Date.now();
  try {
    let guardFired = false;
    const outcome = await Promise.race([
      isolatedFetch('https://blackhole.example/x', { timeoutMs: 50 }).then(
        () => 'resolved',
        (e: any) => String(e?.message || e)
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          guardFired = true;
          resolve('hung');
        }, 2000)
      ),
    ]);
    assert(
      !guardFired,
      'DNS: a lookup that never settles is aborted by the request timeout',
      outcome
    );
    assert(/timed out/i.test(outcome), 'DNS: the aborted lookup reports a timeout', outcome);
    assert(
      Date.now() - started < 2000,
      'DNS: the abort fires near the request timeout rather than hanging'
    );
  } finally {
    setHostResolver(null);
    globalThis.fetch = realFetch;
  }
}

/* ---------------- SSRF: response cap ---------------- */

async function testResponseCap() {
  console.log('\n[7] SSRF guard: response body cap');

  setMaxResponseBytes(1024);
  try {
    await rejects(
      () => readJsonSafe(new Response('x'.repeat(4096))),
      'Body cap: oversized JSON is refused',
      'byte limit'
    );

    const small = await readJsonSafe(new Response(JSON.stringify({ a: 1 })));
    assert(small?.a === 1, 'Body cap: small JSON still parses');

    assert((await readJsonSafe(new Response('not json'))) === null, 'Body cap: invalid JSON still returns null');

    await rejects(
      () => readTextSafe(new Response('y'.repeat(4096))),
      'Body cap: oversized text is refused',
      'byte limit'
    );

    const atLimit = await readTextSafe(new Response('z'.repeat(1024)));
    assert(atLimit.length === 1024, 'Body cap: a body exactly at the limit is allowed');

    let caught: unknown = null;
    try {
      await readTextSafe(new Response('w'.repeat(4096)));
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ResponseTooLargeError, 'Body cap: raises ResponseTooLargeError');
  } finally {
    setMaxResponseBytes(null);
  }

  const unlimited = await readJsonSafe(new Response(JSON.stringify({ big: 'x'.repeat(4096) })));
  assert(unlimited?.big?.length === 4096, 'Body cap: no limit is applied when unset');
}

/* ---------------- Server wiring ---------------- */

async function testServerWiring() {
  console.log('\n[8] Server wiring: resolver installed at startup');

  assert(SERVER_RESPONSE_BYTES === 1024 * 1024, 'Server: the outbound response cap is 1 MB');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
  try {
    installServerNetworking();
    // `.invalid` is reserved and never resolves, so this exercises the installed lookup.
    await rejects(
      () => isolatedFetch('https://does-not-exist.invalid/x'),
      'Server: an unresolvable host is refused by the installed resolver',
      'could not be resolved'
    );
  } finally {
    setHostResolver(null);
    setMaxResponseBytes(null);
    globalThis.fetch = realFetch;
  }
}

/* ---------------- Error hygiene ---------------- */

async function testErrorHygiene() {
  console.log('\n[9] Error hygiene: oauth/start');

  const tracker = fakeTracker({
    startOAuth: () => {
      throw new Error('internal-secret-detail-xyz');
    },
  });

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(' '));
  };

  let status = 0;
  let body: any = null;
  try {
    await withApp(tracker, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/oauth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ provider: 'claude' }),
      });
      status = res.status;
      body = await res.json();
    });
  } finally {
    console.error = originalError;
  }

  assert(status === 400, 'Error hygiene: oauth/start answers 400', String(status));
  assert(
    body?.error === 'Could not start sign-in',
    'Error hygiene: oauth/start returns a short fixed message',
    JSON.stringify(body)
  );
  assert(
    !JSON.stringify(body).includes('internal-secret-detail-xyz'),
    'Error hygiene: oauth/start does not echo the exception'
  );
  assert(
    logged.some((line) => line.includes('internal-secret-detail-xyz')),
    'Error hygiene: the real error is logged server-side'
  );
}

/* ---------------- Database permissions ---------------- */

function testDatabasePermissions() {
  console.log('\n[10] Database: file modes');

  const root = mkdtempSync(join(tmpdir(), 'alt-perm-'));
  try {
    // Pre-create the data directory world-readable; the store must narrow it.
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    const store = new Store(dataDir, 'tracker.db', APP_SECRET);
    try {
      const dirMode = statSync(dataDir).mode & 0o777;
      assert(dirMode === 0o700, 'Database: data directory is 0700', dirMode.toString(8));

      const dbFile = join(dataDir, 'tracker.db');
      const dbMode = statSync(dbFile).mode & 0o777;
      assert(dbMode === 0o600, 'Database: database file is 0600', dbMode.toString(8));

      for (const suffix of ['-wal', '-shm']) {
        const file = dbFile + suffix;
        if (!existsSync(file)) continue;
        const mode = statSync(file).mode & 0o777;
        assert(mode === 0o600, `Database: ${suffix} file is 0600`, mode.toString(8));
      }
    } finally {
      store.close();
    }

    // A fresh nested directory is created with the same mode.
    const fresh = join(root, 'nested', 'deeper');
    const freshStore = new Store(fresh, 'tracker.db', APP_SECRET);
    try {
      const mode = statSync(fresh).mode & 0o777;
      assert(mode === 0o700, 'Database: a newly created data directory is 0700', mode.toString(8));
    } finally {
      freshStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ---------------- Gemini: oversized app page ---------------- */

async function testGeminiOversizedPage() {
  console.log('\n[11] Gemini: oversized app page surfaces an error');

  const realFetch = globalThis.fetch;
  setHostResolver(null);
  globalThis.fetch = (async () =>
    new Response('x'.repeat(4096), { status: 200 })) as unknown as typeof fetch;
  setMaxResponseBytes(1024);
  try {
    const credentials: AccountCredentials = { cookies: '__Secure-1PSID=secret' };
    const result = await new GeminiProvider().fetchUsage('gemini-acct', credentials);
    assert(
      result.snapshot.status === 'error',
      'Gemini: an oversized app page is reported as an error, not reauth_required',
      result.snapshot.status
    );
    assert(
      /byte limit|too large|exceed/i.test(result.snapshot.errorMessage ?? ''),
      'Gemini: the error names the oversized response',
      result.snapshot.errorMessage
    );
  } finally {
    setMaxResponseBytes(null);
    setHostResolver(null);
    globalThis.fetch = realFetch;
  }
}

async function testGeminiFetchFailure() {
  console.log('\n[12] Gemini: app page fetch failure surfaces an error');

  const realFetch = globalThis.fetch;
  setHostResolver(null);
  globalThis.fetch = (async () => {
    throw new Error('Host could not be resolved');
  }) as unknown as typeof fetch;
  try {
    const credentials: AccountCredentials = { cookies: '__Secure-1PSID=secret' };
    const result = await new GeminiProvider().fetchUsage('gemini-acct', credentials);
    assert(
      result.snapshot.status === 'error',
      'Gemini: an app page fetch failure is reported as an error, not reauth_required',
      result.snapshot.status
    );
    assert(
      /could not be resolved/i.test(result.snapshot.errorMessage ?? ''),
      'Gemini: the app page fetch failure message is surfaced',
      result.snapshot.errorMessage
    );
  } finally {
    setHostResolver(null);
    globalThis.fetch = realFetch;
  }
}

/* ---------------- Runner ---------------- */

async function runAllTests() {
  console.log('\n========================================');
  console.log('FINAL HARDENING TESTS');
  console.log('========================================');

  testSafeUrl();
  await testDnsGuard();
  await testRedirects();
  testIPv6ReservedRanges();
  await testRedirectCredentials();
  await testDnsAbort();
  await testResponseCap();
  await testServerWiring();
  await testErrorHygiene();
  testDatabasePermissions();
  await testGeminiOversizedPage();
  await testGeminiFetchFailure();

  console.log('\n========================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('========================================\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
