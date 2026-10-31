import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppConfig } from '../server/src/app';
import { sign } from '../server/src/auth';
import { Store } from '../server/src/store';
import type { Tracker } from '../server/src/tracker';

const ADMIN_PASSWORD = 'test-admin-password-123';
const APP_SECRET = 'test-app-secret-0123456789abcdef';
const API_TOKEN = 'test-api-token-abc123';

/**
 * Independent oracle for the documented alt_session token contract:
 * `<epoch>.<issued>.<base64url(HMAC-SHA256(epoch.issued, APP_SECRET))>`. Derived here with
 * node:crypto rather than the server's own sign(), so a mis-keyed or
 * secret-dropping implementation is rejected.
 */
function independentSign(issued: string, secret: string): string {
  return createHmac('sha256', secret).update(issued).digest('base64url');
}

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
    console.log(`::error file=tests/security_tests.ts::[FAIL] ${testName} ${extraInfo ? `-> ${extraInfo.replace(/\r?\n/g, ' ')}` : ''}`);
  }
}

/**
 * A tracker stand-in: the security tests never sync providers. `start` throws so
 * any accidental timer start from createApp fails loudly.
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
  } as unknown as Tracker;
}

interface Ctx {
  baseUrl: string;
}

/** Builds an app over a fresh temp data dir, listens on an ephemeral port, always cleans up. */
async function withApp(overrides: Partial<AppConfig>, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'alt-security-'));
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
    await fn({ baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sessionCookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

async function runAllTests() {
  console.log('\n========================================');
  console.log('  AI LIMITS TRACKER - SECURITY TESTS    ');
  console.log('========================================\n');

  console.log('Suite 1: Login');
  await withApp({}, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert(res.status === 401, 'Login: wrong password is 401', `got ${res.status}`);

    const ok = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    assert(ok.status === 200, 'Login: correct password is 200', `got ${ok.status}`);
    const rawCookie = ok.headers.get('set-cookie') || '';
    assert(/alt_session=/.test(rawCookie), 'Login: sets alt_session cookie');
    assert(/HttpOnly/i.test(rawCookie), 'Login: cookie is HttpOnly', rawCookie);
    assert(/SameSite=Lax/i.test(rawCookie), 'Login: cookie is SameSite=Lax', rawCookie);
    assert(/Max-Age=2592000/.test(rawCookie), 'Login: session lives 30 days by default', rawCookie);
  });

  console.log('\nSuite 1b: Login limiter');
  await withApp({}, async ({ baseUrl }) => {
    for (let i = 0; i < 9; i++) {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      await res.text();
      assert(res.status === 401, `Limiter: wrong password ${i + 1}/9 is 401`, `got ${res.status}`);
    }

    const firstOk = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    await firstOk.text();
    assert(firstOk.status === 200, 'Limiter: correct password after 9 failures is 200', `got ${firstOk.status}`);

    const secondOk = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    await secondOk.text();
    assert(secondOk.status === 200, 'Limiter: a successful login resets the attempt window', `got ${secondOk.status}`);
  });

  await withApp({}, async ({ baseUrl }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      await res.text();
      statuses.push(res.status);
    }
    assert(
      statuses.slice(0, 10).every((s) => s === 401),
      'Limiter: first 10 failed attempts are 401',
      statuses.join(',')
    );
    assert(statuses[10] === 429, 'Limiter: the 11th failed attempt is 429', `got ${statuses[10]}`);
  });

  console.log('\nSuite 2: Session cookie verification');
  await withApp({}, async ({ baseUrl }) => {
    const noCookie = await fetch(`${baseUrl}/api/state`);
    assert(noCookie.status === 401, '/api/state: no cookie is 401', `got ${noCookie.status}`);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const cookie = sessionCookieFrom(login);
    assert(Boolean(cookie), 'Login: response carries a usable cookie');

    const authed = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie! } });
    const body: any = await authed.json();
    assert(authed.status === 200, '/api/state: valid cookie is 200', `got ${authed.status}`);
    assert(Array.isArray(body.accounts), '/api/state: returns an accounts array');

    const issued = String(Date.now());
    const tampered = `${issued}.${sign(issued, APP_SECRET).slice(0, -1)}x`;
    const tamperedRes = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: `alt_session=${tampered}` } });
    assert(tamperedRes.status === 401, '/api/state: tampered signature is 401', `got ${tamperedRes.status}`);

    const expiredIssued = String(Date.now() - 181 * 86400 * 1000);
    const expired = `${expiredIssued}.${sign(expiredIssued, APP_SECRET)}`;
    const expiredRes = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: `alt_session=${expired}` } });
    assert(expiredRes.status === 401, '/api/state: expired cookie is 401', `got ${expiredRes.status}`);
  });

  console.log('\nSuite 2b: Session signature independent oracle');
  await withApp({}, async ({ baseUrl }) => {
    const issued = String(Date.now());

    const knownVector = `0.${issued}.${independentSign(`0.${issued}`, APP_SECRET)}`;
    const accepted = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: `alt_session=${knownVector}` } });
    assert(
      accepted.status === 200,
      '/api/state: cookie built from an independent HMAC-SHA256(epoch.issued, APP_SECRET) is 200',
      `got ${accepted.status}`
    );

    const foreignSecret = `0.${issued}.${independentSign(`0.${issued}`, 'a-different-app-secret-0123456789')}`;
    const foreignRes = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: `alt_session=${foreignSecret}` } });
    assert(
      foreignRes.status === 401,
      '/api/state: cookie signed with a different secret is 401',
      `got ${foreignRes.status}`
    );
  });

  console.log('\nSuite 3: Bearer token');
  await withApp({}, async ({ baseUrl }) => {
    const good = await fetch(`${baseUrl}/api/state`, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
    assert(good.status === 200, '/api/state: valid Bearer token is 200', `got ${good.status}`);

    const bad = await fetch(`${baseUrl}/api/state`, { headers: { Authorization: 'Bearer wrong-token' } });
    assert(bad.status === 401, '/api/state: wrong Bearer token is 401', `got ${bad.status}`);
  });

  console.log('\nSuite 4: Static file traversal');
  await withApp({}, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/..%2f..%2fetc/passwd`);
    const text = await res.text();
    assert(res.status === 200, 'Traversal: /..%2f..%2fetc/passwd falls back to index', `got ${res.status}`);
    assert(text.includes('app-shell'), 'Traversal: serves the SPA index', text.slice(0, 80));
    assert(!/root:.*:0:0:/.test(text), 'Traversal: never leaks /etc/passwd content');
  });

  console.log('\nSuite 5: Request body limit');
  await withApp({}, async ({ baseUrl }) => {
    const oversized = JSON.stringify({ password: 'x'.repeat(256 * 1024 + 16) });
    let rejected = false;
    let status = 0;
    try {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversized,
      });
      status = res.status;
      await res.text();
      rejected = res.status >= 400;
    } catch {
      // The server may drop the connection while the body is still streaming.
      rejected = true;
    }
    assert(rejected, 'Body over 256 KB is rejected', `got status ${status}`);
    assert(
      status === 0 || status === 413 || status === 500,
      'Body over 256 KB is a server error, not a login attempt',
      `got ${status}`
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
