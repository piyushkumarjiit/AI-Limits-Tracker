import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppConfig } from '../server/src/app';
import {
  createSession,
  DEFAULT_SESSION_DAYS,
  parseSessionEpoch,
  SESSION_EPOCH_KEY,
  sign,
  verifySession,
} from '../server/src/auth';
import {
  resolveSessionDays,
  sessionDaysProblem,
  validateConfig,
  validateFatalConfig,
} from '../server/src/config';
import { Store } from '../server/src/store';
import type { Tracker } from '../server/src/tracker';
import { isInsecureContext } from '../web/src/session';

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

/** A tracker stand-in: these tests never sync providers. */
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
  store: Store;
}

/** Builds an app over a fresh temp data dir, listens on an ephemeral port, always cleans up. */
async function withApp(overrides: Partial<AppConfig>, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alt-session-'));
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
    await fn({ baseUrl: `http://127.0.0.1:${port}`, port, store });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
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

function stateWith(baseUrl: string, cookie?: string, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return fetch(`${baseUrl}/api/state`, { headers });
}

async function runAllTests() {
  console.log('\n========================================');
  console.log('  AI LIMITS TRACKER - SESSION TESTS     ');
  console.log('========================================\n');

  console.log('Suite 1: Session lifetime default');
  {
    assert(DEFAULT_SESSION_DAYS === 30, 'Session: the default lifetime is 30 days', String(DEFAULT_SESSION_DAYS));
  }

  console.log('\nSuite 2: Cookie format and epoch binding');
  {
    const cookie = createSession(APP_SECRET, 0);
    assert(cookie.split('.').length === 3, 'Session: a new cookie has epoch, issued and signature parts', cookie);
    assert(cookie.startsWith('0.'), 'Session: the epoch is the first cookie field', cookie.split('.')[0]);
    assert(verifySession(cookie, APP_SECRET, 30, 0), 'Session: a fresh cookie verifies under its own epoch');
    assert(!verifySession(cookie, 'another-secret-0123456789', 30, 0), 'Session: a cookie signed with another secret is refused');
    assert(!verifySession(undefined, APP_SECRET, 30, 0), 'Session: a missing cookie is refused');
    assert(!verifySession('', APP_SECRET, 30, 0), 'Session: an empty cookie is refused');

    const issued = String(Date.now());
    const legacy = `${issued}.${sign(issued, APP_SECRET)}`;
    assert(!verifySession(legacy, APP_SECRET, 30, 0), 'Session: the old two-part cookie format is refused');

    assert(!verifySession(cookie, APP_SECRET, 30, 1), 'Session: a cookie from an older epoch is refused');
    assert(verifySession(createSession(APP_SECRET, 5), APP_SECRET, 30, 5), 'Session: a cookie verifies under the current epoch');
    assert(!verifySession(createSession(APP_SECRET, 5), APP_SECRET, 30, 0), 'Session: raising the epoch ends older cookies');

    // Tampering with the epoch field breaks the signature.
    const forged = `1.${cookie.split('.').slice(1).join('.')}`;
    assert(!verifySession(forged, APP_SECRET, 30, 1), 'Session: editing the epoch field invalidates the signature');

    assert(!verifySession(cookie, APP_SECRET, 0, 0), 'Session: a cookie older than the lifetime is refused');
    assert(!verifySession(`x.${issued}.${sign(`x.${issued}`, APP_SECRET)}`, APP_SECRET, 30, 0), 'Session: a non-numeric epoch is refused');
  }

  console.log('\nSuite 3: Epoch storage helpers');
  {
    assert(parseSessionEpoch(null) === 0, 'Epoch: an absent setting means 0');
    assert(parseSessionEpoch('7') === 7, 'Epoch: a numeric setting is read');
    assert(parseSessionEpoch('nope') === 0, 'Epoch: a corrupt setting falls back to 0');
    assert(parseSessionEpoch('-1') === 0, 'Epoch: a negative setting falls back to 0');
    assert(parseSessionEpoch('1.5') === 0, 'Epoch: a fractional setting falls back to 0');
    assert(SESSION_EPOCH_KEY === 'session_epoch', 'Epoch: the settings key is session_epoch', SESSION_EPOCH_KEY);
  }

  console.log('\nSuite 4: SESSION_DAYS configuration');
  {
    assert(sessionDaysProblem({}) === null, 'SESSION_DAYS: unset is accepted (default applies)');
    assert(sessionDaysProblem({ SESSION_DAYS: '' }) === null, 'SESSION_DAYS: empty is accepted (default applies)');
    assert(sessionDaysProblem({ SESSION_DAYS: '1' }) === null, 'SESSION_DAYS: 1 day is accepted');
    assert(sessionDaysProblem({ SESSION_DAYS: '30' }) === null, 'SESSION_DAYS: 30 days is accepted');
    assert(sessionDaysProblem({ SESSION_DAYS: '365' }) === null, 'SESSION_DAYS: 365 days is accepted');
    assert(sessionDaysProblem({ SESSION_DAYS: ' 7 ' }) === null, 'SESSION_DAYS: surrounding whitespace is tolerated');
    for (const bad of ['0', '366', '-1', '30.5', 'abc', '1e3', 'thirty']) {
      assert(sessionDaysProblem({ SESSION_DAYS: bad }) !== null, `SESSION_DAYS: "${bad}" is refused`, String(sessionDaysProblem({ SESSION_DAYS: bad })));
    }

    assert(resolveSessionDays({}, 30) === 30, 'SESSION_DAYS: unset resolves to the fallback');
    assert(resolveSessionDays({ SESSION_DAYS: '14' }, 30) === 14, 'SESSION_DAYS: a valid value is used');
    let threw = false;
    try {
      resolveSessionDays({ SESSION_DAYS: '400' }, 30);
    } catch {
      threw = true;
    }
    assert(threw, 'SESSION_DAYS: resolving an invalid value throws');

    const strong = { ADMIN_PASSWORD: 'a-very-long-admin-password-123-4567', APP_SECRET: '0123456789abcdef0123456789abcdef' };
    assert(
      validateConfig({ ...strong, SESSION_DAYS: '0' }).some((e) => e.includes('SESSION_DAYS')),
      'SESSION_DAYS: validateConfig reports an out-of-range value'
    );
    assert(
      validateFatalConfig({ ...strong, SESSION_DAYS: '0' }).some((e) => e.includes('SESSION_DAYS')),
      'SESSION_DAYS: an invalid value stays fatal under ALLOW_WEAK_SECRETS=1'
    );
    assert(
      validateFatalConfig({ ...strong, SESSION_DAYS: '30', ALLOW_WEAK_SECRETS: '1' }).length === 0,
      'SESSION_DAYS: a valid value is not reported as fatal'
    );
  }

  console.log('\nSuite 5: Login issues an epoch-bound cookie and honours SESSION_DAYS');
  await withApp({ sessionDays: 7 }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    await res.text();
    const raw = res.headers.get('set-cookie') || '';
    const cookie = raw.split(';')[0];
    assert(res.status === 200, 'Login: the correct password is accepted', `got ${res.status}`);
    assert(cookie.split('=')[1].split('.').length === 3, 'Login: the issued cookie is epoch-bound', cookie);
    assert(raw.includes(`Max-Age=${7 * 86400}`), 'Login: the cookie Max-Age follows SESSION_DAYS', raw);

    const authed = await stateWith(baseUrl, cookie);
    assert(authed.status === 200, 'Login: the epoch-bound cookie authenticates', `got ${authed.status}`);
  });

  console.log('\nSuite 6: Revoke all');
  await withApp({}, async ({ baseUrl, store }) => {
    const cookie = await login(baseUrl);

    const anon = await fetch(`${baseUrl}/api/sessions/revoke-all`, { method: 'POST' });
    assert(anon.status === 401, 'Revoke-all: an unauthenticated call is 401', `got ${anon.status}`);
    assert(anon.headers.get('set-cookie') === null, 'Revoke-all: an unauthenticated call sets no cookie');

    const noType = await fetch(`${baseUrl}/api/sessions/revoke-all`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert(noType.status === 403, 'Revoke-all: a cookie call without Content-Type is 403 (CSRF)', `got ${noType.status}`);

    const textType = await fetch(`${baseUrl}/api/sessions/revoke-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Cookie: cookie },
    });
    assert(textType.status === 403, 'Revoke-all: a cookie call with text/plain is 403 (CSRF)', `got ${textType.status}`);

    const foreign = await fetch(`${baseUrl}/api/sessions/revoke-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookie },
    });
    assert(foreign.status === 403, 'Revoke-all: a foreign Origin is rejected', `got ${foreign.status}`);

    const before = await stateWith(baseUrl, cookie);
    assert(before.status === 200, 'Revoke-all: the session works before revoking', `got ${before.status}`);
    assert(store.getSetting(SESSION_EPOCH_KEY) === null, 'Revoke-all: no epoch is stored before the first revoke');

    const res = await fetch(`${baseUrl}/api/sessions/revoke-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    const body = await res.json();
    assert(res.status === 200, 'Revoke-all: an authenticated call is 200', `got ${res.status}`);
    assert(body.ok === true, 'Revoke-all: the response is {ok:true}', JSON.stringify(body));
    const cleared = res.headers.get('set-cookie') || '';
    assert(cleared.startsWith('alt_session=;') && cleared.includes('Max-Age=0'), 'Revoke-all: the caller cookie is cleared', cleared);
    assert(store.getSetting(SESSION_EPOCH_KEY) === '1', 'Revoke-all: the stored epoch is incremented', String(store.getSetting(SESSION_EPOCH_KEY)));

    const after = await stateWith(baseUrl, cookie);
    assert(after.status === 401, 'Revoke-all: the caller cookie is refused afterwards', `got ${after.status}`);

    const fresh = await login(baseUrl);
    const freshState = await stateWith(baseUrl, fresh);
    assert(freshState.status === 200, 'Revoke-all: a new login after revoking works', `got ${freshState.status}`);
    assert(fresh.split('=')[1].startsWith('1.'), 'Revoke-all: new cookies carry the new epoch', fresh.split('=')[1].split('.')[0]);

    // A second revoke moves the epoch again and kills the new session too.
    const second = await fetch(`${baseUrl}/api/sessions/revoke-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fresh },
    });
    await second.text();
    assert(second.status === 200, 'Revoke-all: a second revoke is accepted', `got ${second.status}`);
    assert(store.getSetting(SESSION_EPOCH_KEY) === '2', 'Revoke-all: the epoch advances on every call', String(store.getSetting(SESSION_EPOCH_KEY)));
    assert((await stateWith(baseUrl, fresh)).status === 401, 'Revoke-all: the previous session is refused after the second revoke');

    // The Bearer path is unaffected by the epoch.
    const bearer = await stateWith(baseUrl, undefined, API_TOKEN);
    assert(bearer.status === 200, 'Revoke-all: the Bearer API_TOKEN path keeps working', `got ${bearer.status}`);
  });

  console.log('\nSuite 7: Revoke all with a Bearer token');
  await withApp({}, async ({ baseUrl, store }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/api/sessions/revoke-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    await res.text();
    assert(res.status === 200, 'Revoke-all: a Bearer caller may revoke every cookie session', `got ${res.status}`);
    assert(store.getSetting(SESSION_EPOCH_KEY) === '1', 'Revoke-all: the Bearer call bumps the epoch', String(store.getSetting(SESSION_EPOCH_KEY)));
    assert((await stateWith(baseUrl, cookie)).status === 401, 'Revoke-all: a Bearer revoke ends cookie sessions too');
  });

  console.log('\nSuite 8: Logout requires authentication');
  await withApp({}, async ({ baseUrl }) => {
    const anon = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert(anon.status === 401, 'Logout: an unauthenticated call is 401', `got ${anon.status}`);
    assert(anon.headers.get('set-cookie') === null, 'Logout: an unauthenticated call sets no cookie');

    const anonNoType = await fetch(`${baseUrl}/api/logout`, { method: 'POST' });
    assert(anonNoType.status === 401, 'Logout: an unauthenticated call without Content-Type is 401, not 403', `got ${anonNoType.status}`);

    const cookie = await login(baseUrl);
    const authed = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    await authed.text();
    const cleared = authed.headers.get('set-cookie') || '';
    assert(authed.status === 200, 'Logout: an authenticated cookie call is 200', `got ${authed.status}`);
    assert(cleared.startsWith('alt_session=;') && cleared.includes('Max-Age=0'), 'Logout: the cookie is cleared', cleared);

    const noType = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert(noType.status === 403, 'Logout: a cookie call without Content-Type is 403 (CSRF)', `got ${noType.status}`);

    const bearer = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    assert(bearer.status === 200, 'Logout: a Bearer caller may log out', `got ${bearer.status}`);

    const revoke = await fetch(`${baseUrl}/api/sessions/revoke-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    await revoke.text();
    const staleLogout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    assert(staleLogout.status === 401, 'Logout: a revoked cookie cannot log out', `got ${staleLogout.status}`);
  });

  console.log('\nSuite 9: Insecure connection banner helper');
  {
    assert(isInsecureContext('http:', 'example.com'), 'Banner: plain HTTP on a remote host is insecure');
    assert(isInsecureContext('http:', '192.168.1.5'), 'Banner: plain HTTP on a LAN address is insecure');
    assert(!isInsecureContext('http:', 'LOCALHOST'), 'Banner: hostnames are compared case-insensitively');
    assert(!isInsecureContext('http:', 'localhost'), 'Banner: loopback localhost is not flagged');
    assert(!isInsecureContext('http:', '127.0.0.1'), 'Banner: loopback 127.0.0.1 is not flagged');
    assert(!isInsecureContext('http:', '::1'), 'Banner: loopback ::1 is not flagged');
    assert(
      !isInsecureContext('http:', new URL('http://[::1]:8795/').hostname),
      'Banner: the browser-serialized IPv6 loopback [::1] is not flagged'
    );
    assert(!isInsecureContext('https:', 'example.com'), 'Banner: HTTPS is never flagged');
    assert(!isInsecureContext('https:', 'localhost'), 'Banner: HTTPS on loopback is never flagged');
  }

  console.log('\n========================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('========================================\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
