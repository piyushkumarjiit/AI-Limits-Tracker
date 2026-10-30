import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { AddressInfo, connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppConfig } from '../server/src/app';
import { clientIp, createLoginLimiter } from '../server/src/auth';
import { allowsWeakSecrets, validateConfig, validateConfigWarnings, validateFatalConfig } from '../server/src/config';
import { Store } from '../server/src/store';
import type { Tracker } from '../server/src/tracker';

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

/**
 * A tracker stand-in: these tests never sync providers. `start` throws so an
 * accidental timer start from createApp fails loudly.
 */
function fakeTracker(): Tracker {
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
  } as unknown as Tracker;
}

interface Ctx {
  baseUrl: string;
  port: number;
}

/** Builds an app over a fresh temp data dir, listens on an ephemeral port, always cleans up. */
async function withApp(overrides: Partial<AppConfig>, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alt-hardening-'));
  const dataDir = join(dir, 'data');
  const webDir = join(dir, 'web');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><body>app-shell</body></html>');

  const store = new Store(dataDir, 'tracker.db', APP_SECRET);
  const server = createApp(
    {
      adminPassword: ADMIN_PASSWORD,
      appSecret: APP_SECRET,
      apiToken: API_TOKEN,
      secureCookies: false,
      trustProxy: false,
      webDir,
      ...overrides,
    },
    { store, tracker: fakeTracker() }
  );

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    await fn({ baseUrl: `http://127.0.0.1:${port}`, port });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the real server entrypoint and resolves with its exit code (null if it had to be killed). */
function runServerProcess(env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join('server', 'src', 'index.ts')], {
      env: {
        PATH: process.env.PATH || '',
        ADMIN_PASSWORD,
        APP_SECRET,
        HOST: '127.0.0.1',
        WEB_DIR: tmpdir(),
        ...env,
      },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sessionCookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  await res.text();
  const cookie = sessionCookieFrom(res);
  if (!cookie) throw new Error(`login failed: ${res.status}`);
  return cookie;
}

/** Sends raw bytes and resolves with whatever the server wrote back (best effort). */
function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(data);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', done);
    socket.on('error', done);
    socket.on('close', done);
    socket.setTimeout(3000, done);
  });
}

function rawGet(port: number, path: string, host: string): Promise<string> {
  return rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
}

/**
 * A login request that sends its headers (including Content-Length) but holds the
 * body until `send()` is called, so many handlers can be parked at the body read
 * before any of them records a failed attempt.
 */
function heldBodyRequest(port: number, body: string) {
  const socket = connect(port, '127.0.0.1');
  let data = '';
  let settled = false;
  let resolveResponse: (value: string) => void = () => {};
  const response = new Promise<string>((resolve) => {
    resolveResponse = resolve;
  });
  const done = () => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolveResponse(data);
  };
  socket.setEncoding('utf8');
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      socket.write(
        'POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`
      );
      resolve();
    });
    socket.once('error', reject);
  });
  socket.on('data', (chunk) => {
    data += chunk;
  });
  socket.on('end', done);
  socket.on('error', done);
  socket.on('close', done);
  socket.setTimeout(5000, done);
  return { connected, send: () => socket.write(body), response };
}

function fakeReq(headers: Record<string, string> = {}, remoteAddress = '10.0.0.1'): any {
  return { headers, socket: { remoteAddress } };
}

async function runAllTests() {
  console.log('\n========================================');
  console.log('  AI LIMITS TRACKER - HARDENING TESTS   ');
  console.log('========================================\n');

  console.log('Suite 1: Secret validation');
  {
    const strong = { ADMIN_PASSWORD: 'a-very-long-admin-password-123-4567', APP_SECRET: '0123456789abcdef0123456789abcdef' };
    assert(validateConfig(strong).length === 0, 'Config: strong secrets pass', validateConfig(strong).join('; '));

    for (const placeholder of ['change-me', 'password', 'admin', 'changeme', 'change-me-please', 'CHANGE-ME-abc']) {
      const errs = validateConfig({ ...strong, ADMIN_PASSWORD: placeholder });
      assert(
        errs.some((e) => e.includes('ADMIN_PASSWORD')),
        `Config: placeholder ADMIN_PASSWORD "${placeholder}" is rejected`,
        errs.join('; ')
      );
    }
    assert(
      validateConfig({ ...strong, ADMIN_PASSWORD: '' }).some((e) => e.includes('ADMIN_PASSWORD')),
      'Config: empty ADMIN_PASSWORD is rejected'
    );

    assert(
      validateConfig({ ...strong, APP_SECRET: '' }).some((e) => e.includes('APP_SECRET')),
      'Config: empty APP_SECRET is rejected'
    );
    assert(
      validateConfig({ ...strong, APP_SECRET: 'change-me-0123456789abcdef' }).some((e) => e.includes('APP_SECRET')),
      'Config: placeholder APP_SECRET is rejected'
    );
    assert(
      validateConfig({ ...strong, APP_SECRET: 'a'.repeat(32) }).some((e) => e.includes('predictable')),
      'Config: a single repeated character APP_SECRET is rejected'
    );
    assert(
      validateConfig({ ...strong, APP_SECRET: 'aaabbbcccdddeeff' }).some((e) => e.includes('predictable')),
      'Config: an APP_SECRET with fewer than 8 distinct characters is rejected'
    );
    assert(
      validateConfig({ ...strong, APP_SECRET: 'abcdefghabcdefgh' }).length === 0,
      'Config: 8 distinct characters is enough for APP_SECRET'
    );
    assert(
      validateConfig({ ...strong, APP_SECRET: 'short-secret' }).some((e) => e.includes('at least')),
      'Config: APP_SECRET under 16 characters is rejected'
    );
    assert(
      validateConfig({ ...strong, API_TOKEN: 'x'.repeat(23) }).some((e) => e.includes('API_TOKEN')),
      'Config: API_TOKEN under 24 characters is rejected'
    );
    assert(
      validateConfig({ ...strong, API_TOKEN: 'x'.repeat(24) }).length === 0,
      'Config: API_TOKEN of 24 characters is accepted'
    );

    const shortButFine = '0123456789abcdef0123456789abcdef'.slice(0, 20);
    assert(
      validateConfig({ ...strong, APP_SECRET: shortButFine }).length === 0,
      'Config: a 16-31 character random APP_SECRET does not fail'
    );
    assert(
      validateConfigWarnings({ ...strong, APP_SECRET: shortButFine }).some((w) => w.includes('APP_SECRET')),
      'Config: a 16-31 character random APP_SECRET warns instead'
    );
    assert(validateConfigWarnings(strong).length === 0, 'Config: a 32-character secret does not warn');

    assert(allowsWeakSecrets({ ALLOW_WEAK_SECRETS: '1' }), 'Config: ALLOW_WEAK_SECRETS=1 is detected');
    assert(!allowsWeakSecrets({}), 'Config: weak-secret escape hatch is off by default');

    const hatch = { ALLOW_WEAK_SECRETS: '1' };
    assert(
      validateConfig({ ...strong, ADMIN_PASSWORD: '', ...hatch }).some((e) => e.includes('ADMIN_PASSWORD')),
      'Config: ALLOW_WEAK_SECRETS=1 cannot downgrade an empty ADMIN_PASSWORD'
    );
    assert(
      validateFatalConfig({ ...strong, ADMIN_PASSWORD: '', ...hatch }).some((e) => e.includes('ADMIN_PASSWORD')),
      'Config: an empty ADMIN_PASSWORD stays fatal under ALLOW_WEAK_SECRETS=1'
    );
    assert(
      validateConfig({ ...strong, APP_SECRET: '', ...hatch }).some((e) => e.includes('APP_SECRET')),
      'Config: ALLOW_WEAK_SECRETS=1 cannot downgrade an empty APP_SECRET'
    );
    assert(
      validateFatalConfig({ ...strong, APP_SECRET: '', ...hatch }).some((e) => e.includes('APP_SECRET')),
      'Config: an empty APP_SECRET stays fatal under ALLOW_WEAK_SECRETS=1'
    );
    const weakButPresent = { ...strong, ADMIN_PASSWORD: 'change-me', APP_SECRET: 'short-secret', ...hatch };
    assert(
      validateConfig(weakButPresent).some((e) => e.includes('ADMIN_PASSWORD')) &&
        validateConfig(weakButPresent).some((e) => e.includes('APP_SECRET')),
      'Config: weak non-empty secrets are still reported for the escape hatch to downgrade'
    );
    assert(
      validateFatalConfig(weakButPresent).length === 0,
      'Config: ALLOW_WEAK_SECRETS=1 may downgrade weak non-empty secrets to warnings'
    );
  }

  console.log('\nSuite 2: Client address resolution');
  {
    assert(clientIp(fakeReq({}, '10.1.2.3'), false) === '10.1.2.3', 'clientIp: uses the socket address without trustProxy');
    assert(
      clientIp(fakeReq({ 'x-real-ip': '203.0.113.9' }, '10.1.2.3'), true) === '203.0.113.9',
      'clientIp: trustProxy uses a valid X-Real-IP'
    );
    assert(
      clientIp(fakeReq({ 'x-real-ip': 'not-an-ip' }, '10.1.2.3'), true) === '10.1.2.3',
      'clientIp: an invalid X-Real-IP falls back to the socket'
    );
    assert(
      clientIp(fakeReq({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }, '10.1.2.3'), true) === '203.0.113.7',
      'clientIp: trustProxy uses the last X-Forwarded-For hop'
    );
    assert(
      clientIp(fakeReq({ 'x-real-ip': '203.0.113.9' }, '10.1.2.3'), false) === '10.1.2.3',
      'clientIp: X-Real-IP is ignored without trustProxy'
    );
  }

  console.log('\nSuite 3: Limiter bookkeeping');
  {
    const limiter = createLoginLimiter({ maxPerIp: 2, windowMs: 1000, maxGlobal: 100, maxEntries: 3 });
    limiter.recordFailure('1.1.1.1');
    limiter.recordFailure('1.1.1.1');
    assert(limiter.tooManyAttempts('1.1.1.1'), 'Limiter: address at the per-IP ceiling is refused');
    assert(!limiter.tooManyAttempts('2.2.2.2'), 'Limiter: a fresh address is allowed');
    limiter.reset('1.1.1.1');
    assert(!limiter.tooManyAttempts('1.1.1.1'), 'Limiter: reset clears the address window');

    const global = createLoginLimiter({ maxPerIp: 100, windowMs: 1000, maxGlobal: 2 });
    global.recordFailure('a');
    global.recordFailure('b');
    assert(!global.tooManyAttempts('c'), 'Limiter: the global ceiling does not refuse a never-seen address');
    assert(global.globalExceeded(), 'Limiter: the global ceiling is reported for failed attempts');

    const capped = createLoginLimiter({ maxPerIp: 1, windowMs: 60_000, maxGlobal: 100, maxEntries: 2 });
    capped.recordFailure('old');
    capped.recordFailure('mid');
    capped.recordFailure('new'); // evicts "old"
    assert(!capped.tooManyAttempts('old'), 'Limiter: the oldest entry is evicted at the map cap');
    assert(capped.tooManyAttempts('new'), 'Limiter: the newest entry survives the cap');

    const pruning = createLoginLimiter({ maxPerIp: 1, windowMs: 30, maxGlobal: 100 });
    pruning.recordFailure('stale');
    assert(pruning.tooManyAttempts('stale'), 'Limiter: an address over its ceiling is refused before expiry');
    await new Promise((r) => setTimeout(r, 60));
    assert(!pruning.tooManyAttempts('stale'), 'Limiter: expired entries are pruned');

    const backoff = createLoginLimiter();
    assert(backoff.delayMs(1) === 100, 'Limiter: first failure delays 100ms', String(backoff.delayMs(1)));
    assert(backoff.delayMs(2) === 200, 'Limiter: delays double per failure', String(backoff.delayMs(2)));
    assert(backoff.delayMs(50) === 2000, 'Limiter: the delay is capped at 2s', String(backoff.delayMs(50)));
  }

  console.log('\nSuite 4: Malformed requests do not crash the server');
  await withApp({}, async ({ baseUrl, port }) => {
    // A request target Node itself cannot parse must be answered, not thrown.
    const bad = await rawRequest(port, 'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert(/^HTTP\/1\.1 400/.test(bad), 'Malformed request target is answered with 400', bad.split('\r\n')[0]);
    assert(bad.includes('"error":"bad request"'), 'Malformed request target body is {"error":"bad request"}', bad.slice(0, 160));

    // The server is still healthy afterwards.
    const health = await fetch(`${baseUrl}/api/health`);
    assert(health.status === 200, 'Server still serves requests after a malformed request line', `got ${health.status}`);

    // Invalid header syntax is rejected by the parser and answered by clientError.
    const badHeader = await rawRequest(port, 'GET /api/health HTTP/1.1\r\nHost: localhost\r\nBad Header Line\r\n\r\n');
    assert(/^HTTP\/1\.1 400/.test(badHeader), 'Unparsable headers are answered with 400', badHeader.split('\r\n')[0]);
  });

  console.log('\nSuite 5: Request body limit is 413');
  await withApp({}, async ({ baseUrl }) => {
    const oversized = JSON.stringify({ password: 'x'.repeat(256 * 1024 + 16) });
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    const text = await res.text();
    assert(res.status === 413, 'Body over 256 KB is answered with 413', `got ${res.status}`);
    assert(text.includes('payload too large'), 'Body over 256 KB names the reason', text.slice(0, 80));
  });

  console.log('\nSuite 6: Invalid JSON and empty bodies');
  await withApp({}, async ({ baseUrl }) => {
    const invalid = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password": ',
    });
    assert(invalid.status === 400, 'Invalid JSON on a state-changing endpoint is 400', `got ${invalid.status}`);

    const cookie = await login(baseUrl);
    const empty = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '',
    });
    assert(empty.status === 200, 'An empty body is treated as {} (not a JSON error)', `got ${empty.status}`);

    const invalidAuthed = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: 'not json',
    });
    assert(invalidAuthed.status === 400, 'Invalid JSON with a session cookie is 400', `got ${invalidAuthed.status}`);
  });

  console.log('\nSuite 7: CSRF, content type and Origin');
  await withApp({}, async ({ baseUrl, port }) => {
    const cookie = await login(baseUrl);

    const noType = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert(noType.status === 403, 'CSRF: cookie POST without Content-Type is 403', `got ${noType.status}`);

    const textType = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Cookie: cookie },
    });
    assert(textType.status === 403, 'CSRF: cookie POST with text/plain is 403', `got ${textType.status}`);

    const foreignOrigin = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookie },
    });
    assert(foreignOrigin.status === 403, 'CSRF: cookie POST from a foreign Origin is 403', `got ${foreignOrigin.status}`);

    const sameOriginHost = new URL(baseUrl).host;
    const sameOrigin = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://${sameOriginHost}`, Cookie: cookie },
    });
    assert(sameOrigin.status === 200, 'CSRF: cookie POST from the same Origin is allowed', `got ${sameOrigin.status}`);

    const withOrigin = (host: string, origin: string) =>
      rawRequest(
        port,
        `POST /api/logout HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
          `Cookie: ${cookie}\r\nOrigin: ${origin}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );

    const samePort = await withOrigin('limits.example:8443', 'https://limits.example:8443');
    assert(
      /^HTTP\/1\.1 200/.test(samePort),
      'CSRF: the same host and non-default port are accepted',
      samePort.split('\r\n')[0]
    );

    const defaultPort = await withOrigin('limits.example:443', 'https://limits.example');
    assert(
      /^HTTP\/1\.1 200/.test(defaultPort),
      'CSRF: an omitted Origin port means the scheme default',
      defaultPort.split('\r\n')[0]
    );

    const crossPort = await withOrigin('limits.example:8443', 'https://limits.example:9443');
    assert(
      /^HTTP\/1\.1 403/.test(crossPort),
      'CSRF: the same host on a different port is refused',
      crossPort.split('\r\n')[0]
    );

    const noOrigin = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    assert(noOrigin.status === 200, 'CSRF: a missing Origin is allowed', `got ${noOrigin.status}`);

    const bearerNoType = await fetch(`${baseUrl}/api/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    assert(bearerNoType.status === 200, 'CSRF: Bearer requests are not content-type gated', `got ${bearerNoType.status}`);

    const anon = await fetch(`${baseUrl}/api/refresh`, { method: 'POST' });
    assert(anon.status === 401, 'CSRF: unauthenticated state-changing calls are 401, not 403', `got ${anon.status}`);

    const getWithCookie = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } });
    assert(getWithCookie.status === 200, 'CSRF: GET requests are not content-type gated', `got ${getWithCookie.status}`);
  });

  console.log('\nSuite 8: Host allowlist');
  await withApp({ allowedHosts: ['allowed.example', 'pinned.example:8443', '[::1]'] }, async ({ baseUrl, port }) => {
    const allowed = await rawGet(port, '/api/health', 'allowed.example');
    assert(/^HTTP\/1\.1 200/.test(allowed), 'Host allowlist: a listed Host is served', allowed.split('\r\n')[0]);

    const allowedWithPort = await rawGet(port, '/api/state', 'allowed.example:1455');
    assert(
      /^HTTP\/1\.1 401/.test(allowedWithPort),
      'Host allowlist: a listed Host with a non-default port is accepted',
      allowedWithPort.split('\r\n')[0]
    );

    const pinned = await rawGet(port, '/api/state', 'pinned.example');
    assert(
      /^HTTP\/1\.1 401/.test(pinned),
      'Host allowlist: a configured entry with a port matches a bare Host',
      pinned.split('\r\n')[0]
    );

    const ipv6 = await rawGet(port, '/api/state', '[::1]:1455');
    assert(
      /^HTTP\/1\.1 401/.test(ipv6),
      'Host allowlist: IPv6 brackets and port are stripped before comparing',
      ipv6.split('\r\n')[0]
    );

    const denied = await rawGet(port, '/api/state', 'other.example');
    assert(/^HTTP\/1\.1 421/.test(denied), 'Host allowlist: an unlisted Host is 421', denied.split('\r\n')[0]);

    const viaFetch = await fetch(`${baseUrl}/api/state`);
    assert(viaFetch.status === 421, 'Host allowlist: an unlisted Host via fetch is 421', `got ${viaFetch.status}`);

    const probe = await rawGet(port, '/api/health', '127.0.0.1:1455');
    assert(
      /^HTTP\/1\.1 200/.test(probe),
      'Host allowlist: GET /api/health is exempt so the image healthcheck passes',
      probe.split('\r\n')[0]
    );
  });

  await withApp({}, async ({ port }) => {
    const noAllowlist = await rawGet(port, '/api/health', 'anything.example');
    assert(/^HTTP\/1\.1 200/.test(noAllowlist), 'Host allowlist: off by default', noAllowlist.split('\r\n')[0]);
  });

  {
    const base = {
      adminPassword: ADMIN_PASSWORD,
      appSecret: APP_SECRET,
      apiToken: API_TOKEN,
      secureCookies: false,
      trustProxy: false,
      webDir: '/nonexistent',
    };
    const rejects = (entry: string): boolean => {
      try {
        createApp({ ...base, allowedHosts: [entry] }, { store: null as any, tracker: fakeTracker() });
        return false;
      } catch {
        return true;
      }
    };
    assert(rejects('::1'), 'Host allowlist: a bare IPv6 entry is rejected instead of silently ignored');
    assert(rejects(':1455'), 'Host allowlist: a port-only entry is rejected instead of silently ignored');
    assert(!rejects('tracker.example.com:1455'), 'Host allowlist: a hostname with a port is a valid entry');
    assert(!rejects('[::1]:1455'), 'Host allowlist: a bracketed IPv6 entry with a port is valid');
  }

  console.log('\nSuite 9: Login limiter behaviour over HTTP');
  await withApp({}, async ({ baseUrl }) => {
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      logged.push(args.map(String).join(' '));
    };
    let statuses: number[] = [];
    try {
      for (let i = 0; i < 11; i++) {
        const res = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'wrong-password' }),
        });
        await res.text();
        statuses.push(res.status);
      }
      // A successful login resets the per-address window even at the ceiling... which
      // the 429 above now blocks, so prove the reset in a fresh address window below.
      const after = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      });
      await after.text();
      statuses.push(after.status);
    } finally {
      console.log = originalLog;
    }
    assert(statuses.slice(0, 10).every((s) => s === 401), 'Login: the first 10 failures are 401', statuses.join(','));
    assert(statuses[10] === 429, 'Login: the 11th attempt is 429 once the address is at its ceiling', `got ${statuses[10]}`);
    assert(statuses[11] === 429, 'Login: the correct password cannot skip a tripped limiter', `got ${statuses[11]}`);

    const failures = logged.filter((line) => line.startsWith('login_failed '));
    assert(failures.length === 10, 'Login: every failed attempt is logged once', String(failures.length));
    assert(
      failures.every((line) => /^login_failed ip=\S+ ts=\d+$/.test(line)),
      'Login: log lines look like login_failed ip=<ip> ts=<epoch>',
      failures[0]
    );
    assert(!logged.some((line) => line.includes('wrong-password')), 'Login: the attempted password is never logged');
  });

  console.log('\nSuite 10: Login limiter is not bypassable with delayed bodies');
  await withApp({}, async ({ port }) => {
    const body = JSON.stringify({ password: 'wrong-password' });
    const held = Array.from({ length: 20 }, () => heldBodyRequest(port, body));
    await Promise.all(held.map((h) => h.connected));
    // Give the server time to run the pre-check for every held request.
    await new Promise((r) => setTimeout(r, 200));
    for (const h of held) h.send();
    const responses = await Promise.all(held.map((h) => h.response));
    const statuses = responses.map((r) => Number(/^HTTP\/1\.1 (\d{3})/.exec(r)?.[1]));
    const accepted = statuses.filter((s) => s === 401).length;
    const refused = statuses.filter((s) => s === 429).length;
    assert(accepted === 10, 'Login: a burst of held bodies gets at most 10 password guesses', statuses.join(','));
    assert(refused === 10, 'Login: the rest of the held-body burst is refused with 429', statuses.join(','));
  });

  console.log('\nSuite 11: Global failure ceiling hard-bounds guessing');
  await withApp({ trustProxy: true }, async ({ baseUrl, port }) => {
    const attempt = (ip: string, password: string) =>
      fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
        body: JSON.stringify({ password }),
      });

    // 60 failures from 60 distinct addresses trip the documented global ceiling.
    const burst = await Promise.all(
      Array.from({ length: 60 }, (_, i) => attempt(`198.51.100.${i + 1}`, 'wrong-password'))
    );
    await Promise.all(burst.map((r) => r.text()));
    assert(
      burst.every((r) => r.status === 401),
      'Global ceiling: the first 60 failures are still answered 401',
      burst.map((r) => r.status).join(',')
    );

    const correct = await attempt('203.0.113.200', ADMIN_PASSWORD);
    await correct.text();
    assert(correct.status === 429, 'Global ceiling: a correct password is refused while the ceiling holds', `got ${correct.status}`);

    const wrong = await attempt('203.0.113.201', 'wrong-password');
    await wrong.text();
    assert(wrong.status === 429, 'Global ceiling: a fresh address is refused while the ceiling holds', `got ${wrong.status}`);

    const unread = await rawRequest(
      port,
      'POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
        'X-Real-IP: 203.0.113.202\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"password":'
    );
    assert(
      /^HTTP\/1\.1 429/.test(unread),
      'Global ceiling: an over-ceiling request is refused without reading the body',
      unread.split('\r\n')[0]
    );
  });

  console.log('\nSuite 12: Bearer token limiter');
  await withApp({ trustProxy: true }, async ({ baseUrl }) => {
    const withIp = (ip: string, token: string) =>
      fetch(`${baseUrl}/api/state`, { headers: { Authorization: `Bearer ${token}`, 'X-Real-IP': ip } });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await withIp('198.51.100.10', 'wrong-token');
      await res.text();
      statuses.push(res.status);
    }
    assert(statuses.slice(0, 10).every((s) => s === 401), 'Bearer: the first 10 failures are 401', statuses.join(','));
    assert(statuses[10] === 429, 'Bearer: the 11th failed token is 429', `got ${statuses[10]}`);

    const sameAddress = await withIp('198.51.100.10', API_TOKEN);
    await sameAddress.text();
    assert(
      sameAddress.status === 429,
      'Bearer: a valid token cannot skip a tripped per-address limiter',
      `got ${sameAddress.status}`
    );

    const good = await withIp('198.51.100.11', API_TOKEN);
    await good.text();
    assert(good.status === 200, 'Bearer: a valid token still works from a fresh address', `got ${good.status}`);
  });

  console.log('\nSuite 12b: Startup failures exit non-zero');
  {
    const dir = mkdtempSync(join(tmpdir(), 'alt-startup-'));
    const blocker = createNetServer();
    try {
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const busyPort = (blocker.address() as AddressInfo).port;
      const portInUse = await runServerProcess({ PORT: String(busyPort), DATA_DIR: join(dir, 'data') });
      assert(portInUse !== 0 && portInUse !== null, 'Startup: a port already in use exits non-zero', `exit ${portInUse}`);

      const notADir = join(dir, 'file');
      writeFileSync(notADir, '');
      const badDataDir = await runServerProcess({ PORT: '0', DATA_DIR: join(notADir, 'data') });
      assert(badDataDir !== 0 && badDataDir !== null, 'Startup: an unusable DATA_DIR exits non-zero', `exit ${badDataDir}`);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('\nSuite 13: Response headers');
  await withApp({}, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/health`);
    await res.text();
    assert(
      res.headers.get('permissions-policy') === 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Headers: Permissions-Policy is set',
      String(res.headers.get('permissions-policy'))
    );
    assert(
      res.headers.get('cross-origin-opener-policy') === 'same-origin',
      'Headers: Cross-Origin-Opener-Policy is same-origin',
      String(res.headers.get('cross-origin-opener-policy'))
    );
    assert(
      res.headers.get('cross-origin-resource-policy') === 'same-origin',
      'Headers: Cross-Origin-Resource-Policy is same-origin',
      String(res.headers.get('cross-origin-resource-policy'))
    );
    const csp = res.headers.get('content-security-policy') || '';
    assert(csp.includes("style-src 'self'") && csp.includes("style-src-attr 'unsafe-inline'"), 'Headers: CSP narrows style-src', csp);
    assert(!/style-src[^;]*'unsafe-inline'[^;]*;?\s*style-src-attr/.test(csp) && !csp.includes("style-src 'self' 'unsafe-inline'"), 'Headers: CSP does not allow inline <style> blocks', csp);
    assert(res.headers.get('strict-transport-security') === null, 'Headers: no HSTS when secure cookies are off');
  });

  await withApp({ secureCookies: true }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/health`);
    await res.text();
    assert(
      res.headers.get('strict-transport-security') === 'max-age=31536000',
      'Headers: HSTS is set when secure cookies are on',
      String(res.headers.get('strict-transport-security'))
    );
  });

  console.log('\n========================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('========================================\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
