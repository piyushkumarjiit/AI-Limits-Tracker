import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Store, ServerAccount } from '../server/src/store';
import { Tracker } from '../server/src/tracker';
import { createApp } from '../server/src/app';
import { QuotaCache, buildQuotaView, computeETag } from '../server/src/quotaCache';
import { renderMetrics } from '../server/src/metrics';
import { validateConfig, validateConfigWarnings } from '../server/src/config';

let totalTests = 0;
let failedTests = 0;

function assert(condition: boolean, msg: string) {
  totalTests++;
  if (!condition) {
    failedTests++;
    console.error(`  ✗ [FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ [PASS] ${msg}`);
  }
}

function assertEquals<T>(actual: T, expected: T, msg: string) {
  totalTests++;
  if (actual !== expected) {
    failedTests++;
    console.error(
      `  ✗ [FAIL] ${msg} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`
    );
    throw new Error(
      `Assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  } else {
    console.log(`  ✓ [PASS] ${msg}`);
  }
}

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const ADMIN_PASSWORD = 'test-admin-password-12345';
const API_TOKEN = 'test-api-token-abcdef0123456789';
const METRICS_TOKEN = 'test-metrics-token-1234567890abcdef';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'quota-endpoints-test-'));
}

async function runTests() {
  console.log('\n========================================');
  console.log('  QUOTA ENDPOINTS & METRICS TESTS (WP6) ');
  console.log('========================================\n');

  // --- Suite 1: Config validation for METRICS_TOKEN ---
  console.log('Suite 1: Config METRICS_TOKEN Validation');
  {
    const errorsShort = validateConfig({
      ADMIN_PASSWORD,
      APP_SECRET,
      METRICS_TOKEN: 'short-token',
    });
    assert(
      errorsShort.some((e) => e.includes('METRICS_TOKEN must be at least 24')),
      'Rejects METRICS_TOKEN shorter than 24 characters'
    );

    const errorsValid = validateConfig({
      ADMIN_PASSWORD,
      APP_SECRET,
      METRICS_TOKEN: '123456789012345678901234',
    });
    assert(
      !errorsValid.some((e) => e.includes('METRICS_TOKEN')),
      'Accepts valid METRICS_TOKEN of 24 characters'
    );

    const warnings = validateConfigWarnings({
      ADMIN_PASSWORD,
      APP_SECRET,
      METRICS_TOKEN: '123456789012345678901234',
    });
    assert(
      warnings.some((w) => w.includes('METRICS_TOKEN is shorter than 32 characters')),
      'Warns if METRICS_TOKEN is shorter than 32 characters'
    );
  }

  // --- Suite 2: buildQuotaView schema and zero secret leakage ---
  console.log('\nSuite 2: buildQuotaView Schema & Secret Hygiene');
  {
    const accounts: ServerAccount[] = [
      {
        id: 'acc-native-1',
        name: 'Personal Claude',
        providerType: 'claude',
        orderIndex: 0,
        isActive: true,
        createdAt: 1000,
        email: 'alice@example.com',
        plan: 'Pro',
        latestSnapshot: {
          accountId: 'acc-native-1',
          providerType: 'claude',
          planName: 'Pro',
          status: 'ok',
          fetchedAt: new Date(2000).toISOString(),
          buckets: [
            {
              id: 'five_hour',
              label: '5-Hour Limit',
              windowType: 'session_5h',
              utilizationPercent: 40,
              remainingPercent: 60,
              resetsAt: new Date(3600000).toISOString(),
              isExhausted: false,
              severity: 'normal',
            },
            {
              id: 'seven_day',
              label: 'Weekly Limit',
              windowType: 'weekly_7d',
              utilizationPercent: 80,
              remainingPercent: 20,
              resetsAt: new Date(86400000).toISOString(),
              isExhausted: false,
              severity: 'critical',
            },
          ],
        },
      },
      {
        id: 'acc-cpa-1',
        name: 'Work ChatGPT CPA',
        providerType: 'chatgpt',
        orderIndex: 1,
        isActive: true,
        createdAt: 2000,
        email: 'work@company.com',
        plan: 'Team',
        latestSnapshot: {
          accountId: 'acc-cpa-1',
          providerType: 'chatgpt',
          planName: 'Team',
          status: 'ok',
          fetchedAt: new Date(2000).toISOString(),
          buckets: [
            {
              id: 'primary',
              label: '5h',
              windowType: 'session_5h',
              utilizationPercent: 100,
              remainingPercent: 0,
              resetsAt: new Date(1800000).toISOString(),
              isExhausted: true,
              severity: 'exhausted',
            },
          ],
        },
      },
    ];

    const ctx = {
      cpaLinks: [
        {
          accountId: 'acc-cpa-1',
          identityKey: 'chatgpt:cpa:1',
          cpaName: 'cpa-gpt-1',
          authIndex: 1,
          state: 'linked' as const,
          lastSeenAt: 2000,
          unlinkedAt: null,
          routingJson: JSON.stringify({ applied: 75, cooldown: true }),
        },
      ],
      cpaRouting: {
        plans: [
          {
            accountId: 'acc-cpa-1',
            cpaName: 'cpa-gpt-1',
            headroom: 0,
            target: 0,
            cooldown: true,
            reason: 'exhausted' as const,
            write: true,
          },
        ],
      },
    };

    const now = 10000;
    const view = buildQuotaView(accounts, ctx, now);

    assertEquals(view.version, 1, 'Version is 1');
    assertEquals(view.accounts.length, 2, '2 accounts returned');

    // acc-native-1
    const nat = view.accounts.find((a) => a.id === 'acc-native-1')!;
    assert(Boolean(nat), 'Found native account');
    assertEquals(nat.source, 'native', 'Source is native');
    assertEquals(nat.auth_index, null, 'auth_index is null for native');
    assertEquals(nat.binding_window?.id, 'seven_day', 'Binding window is lowest remaining (seven_day at 20%)');
    assertEquals(nat.effective_remaining_percent, 20, 'Effective remaining is 20');
    assertEquals(nat.headroom_score, 0.2, 'Headroom score is 0.2');

    // acc-cpa-1
    const cpa = view.accounts.find((a) => a.id === 'acc-cpa-1')!;
    assert(Boolean(cpa), 'Found CPA account');
    assertEquals(cpa.source, 'cpa', 'Source is cpa');
    assertEquals(cpa.auth_index, '1', 'auth_index matches CPA authIndex');
    assertEquals(cpa.binding_window?.id, 'primary', 'Binding window is primary');
    assertEquals(cpa.effective_remaining_percent, 0, 'Effective remaining is 0');
    assertEquals(cpa.headroom_score, 0, 'Headroom score is 0');
    assertEquals(cpa.target_weight, 0, 'Target weight is 0 from plan');
    assertEquals(cpa.cooldown, true, 'Cooldown is true from plan');

    // Totals
    assertEquals(view.totals.total_accounts, 2, 'Total accounts is 2');
    assertEquals(view.totals.active_accounts, 2, 'Active accounts is 2');
    assertEquals(view.totals.headroom_available, 0.2, 'Headroom available sum is 0.2');
    assertEquals(view.totals.providers.claude.total, 1, 'Claude total is 1');
    assertEquals(view.totals.providers.chatgpt.total, 1, 'ChatGPT total is 1');

    // Zero secret leakage check
    const serialized = JSON.stringify(view);
    assert(!serialized.includes('accessToken'), 'Zero leakage: no accessToken');
    assert(!serialized.includes('refreshToken'), 'Zero leakage: no refreshToken');
    assert(!serialized.includes('sessionKey'), 'Zero leakage: no sessionKey');
    assert(!serialized.includes('managementKey'), 'Zero leakage: no managementKey');
  }

  // --- Suite 3: Prometheus metrics rendering ---
  console.log('\nSuite 3: Prometheus Metrics Rendering (alt_ prefix and Prometheus 0.0.4)');
  {
    const accounts: ServerAccount[] = [
      {
        id: 'acc-native-1',
        name: 'Personal Claude',
        providerType: 'claude',
        orderIndex: 0,
        isActive: true,
        createdAt: 1000,
        email: 'alice@example.com',
        plan: 'Pro',
        latestSnapshot: {
          accountId: 'acc-native-1',
          providerType: 'claude',
          planName: 'Pro',
          status: 'ok',
          fetchedAt: new Date(2000).toISOString(),
          buckets: [
            {
              id: 'five_hour',
              label: '5-Hour Limit',
              windowType: 'session_5h',
              utilizationPercent: 40,
              remainingPercent: 60,
              resetsAt: '2026-04-01T12:00:00.000Z',
              isExhausted: false,
              severity: 'normal',
            },
          ],
        },
      },
      {
        id: 'acc-cpa-1',
        name: 'Work GPT',
        providerType: 'chatgpt',
        orderIndex: 1,
        isActive: true,
        createdAt: 2000,
        email: 'bob@example.com',
        plan: 'Plus',
        latestSnapshot: {
          accountId: 'acc-cpa-1',
          providerType: 'chatgpt',
          planName: 'Plus',
          status: 'ok',
          fetchedAt: new Date(2000).toISOString(),
          buckets: [],
        },
      },
    ];

    const ctx = {
      cpaLinks: [
        {
          accountId: 'acc-cpa-1',
          identityKey: 'chatgpt:cpa:1',
          cpaName: 'cpa-gpt-1',
          authIndex: 2,
          state: 'linked' as const,
          lastSeenAt: 2000,
          unlinkedAt: null,
          routingJson: JSON.stringify({ applied: 50, cooldown: false }),
        },
      ],
    };

    const view = buildQuotaView(accounts, ctx, 10000);
    const metrics = renderMetrics(view);

    assert(metrics.endsWith('\n'), 'Metrics end with newline');
    assert(metrics.includes('# HELP alt_headroom_score'), 'alt_headroom_score HELP present');
    assert(metrics.includes('# TYPE alt_headroom_score gauge'), 'alt_headroom_score TYPE present');
    assert(
      metrics.includes('alt_headroom_score{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com"} 0.6'),
      'Native account has auth_index="" and correct score'
    );
    assert(
      metrics.includes('alt_effective_remaining_ratio{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com"} 0.6'),
      'Effective remaining ratio rendered'
    );
    assert(
      metrics.includes('alt_window_remaining_ratio{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com",window="five_hour"} 0.6'),
      'Window remaining ratio rendered'
    );
    assert(
      metrics.includes('alt_window_reset_timestamp_seconds{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com",window="five_hour"} 1775044800'),
      'Window reset epoch rendered'
    );
    assert(
      metrics.includes('alt_current_weight{provider="chatgpt",account="acc-cpa-1",auth_index="2",email="bob@example.com"} 50'),
      'CPA current weight rendered with auth_index="2"'
    );
    assert(
      metrics.includes('alt_accounts_total{provider="claude"} 1'),
      'Accounts total metric rendered'
    );
    assert(
      metrics.includes('alt_headroom_available_total 0.6'),
      'Headroom available total rendered'
    );
  }

  // --- Suite 4: HTTP GET /api/quota with filtering and ETag/304 ---
  console.log('\nSuite 4: HTTP GET /api/quota, Filtering, and ETag/304');
  {
    const tempDir = createTempDir();
    const store = new Store(tempDir, 'test.db', APP_SECRET);
    const tracker = new Tracker(store);

    // Populate 2 accounts
    store.upsertAccount({
      id: 'claude-1',
      name: 'Claude Account',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: 1000,
      email: 'user1@example.com',
      plan: 'Pro',
      latestSnapshot: {
        accountId: 'claude-1',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date(2000).toISOString(),
        buckets: [
          {
            id: '5h',
            label: '5h',
            windowType: 'session_5h',
            utilizationPercent: 30,
            remainingPercent: 70,
            resetsAt: null,
            isExhausted: false,
            severity: 'normal',
          },
        ],
      },
    });

    store.upsertAccount({
      id: 'gpt-1',
      name: 'GPT CPA',
      providerType: 'chatgpt',
      orderIndex: 1,
      isActive: true,
      createdAt: 2000,
      email: 'user2@example.com',
      plan: 'Plus',
      latestSnapshot: {
        accountId: 'gpt-1',
        providerType: 'chatgpt',
        planName: 'Plus',
        status: 'ok',
        fetchedAt: new Date(2000).toISOString(),
        buckets: [
          {
            id: '5h',
            label: '5h',
            windowType: 'session_5h',
            utilizationPercent: 100,
            remainingPercent: 0,
            resetsAt: null,
            isExhausted: true,
            severity: 'exhausted',
          },
        ],
      },
    });

    store.upsertCpaLink({
      accountId: 'gpt-1',
      identityKey: 'chatgpt:cpa:gpt-1',
      cpaName: 'cpa-gpt-1',
      authIndex: '3',
      state: 'linked',
      lastSeenAt: 2000,
      unlinkedAt: null,
    });

    const quotaCache = new QuotaCache(
      () => store.listAccounts(),
      () => ({ cpaLinks: store.listCpaLinks() }),
      renderMetrics
    );

    const app = createApp(
      {
        adminPassword: ADMIN_PASSWORD,
        appSecret: APP_SECRET,
        apiToken: API_TOKEN,
        metricsToken: METRICS_TOKEN,
        secureCookies: false,
        trustProxy: false,
        webDir: tempDir,
      },
      { store, tracker, quotaCache }
    );

    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const port = (app.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Unauthenticated request to /api/quota -> 401
      const unauthRes = await fetch(`${base}/api/quota`);
      assertEquals(unauthRes.status, 401, 'Unauthenticated /api/quota is 401');

      // 2. Authenticated request with Bearer API_TOKEN -> 200
      const authedRes = await fetch(`${base}/api/quota`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      assertEquals(authedRes.status, 200, 'Authenticated /api/quota is 200');
      const etag = authedRes.headers.get('etag');
      assert(Boolean(etag), 'ETag header is returned');
      const body = await authedRes.json();
      assertEquals(body.version, 1, 'Body version is 1');
      assertEquals(body.accounts.length, 2, '2 accounts returned in unfiltered view');

      // 3. Conditional GET with If-None-Match -> 304 Not Modified
      const notModifiedRes = await fetch(`${base}/api/quota`, {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'If-None-Match': etag!,
        },
      });
      assertEquals(notModifiedRes.status, 304, 'If-None-Match with matching ETag returns 304');

      // 4. Query filter: ?provider=claude
      const claudeRes = await fetch(`${base}/api/quota?provider=claude`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      assertEquals(claudeRes.status, 200, 'Filter ?provider=claude is 200');
      const claudeBody = await claudeRes.json();
      assertEquals(claudeBody.accounts.length, 1, 'Only 1 account returned for provider=claude');
      assertEquals(claudeBody.accounts[0].id, 'claude-1', 'Returned claude-1');

      // 5. Query filter: ?source=cpa
      const cpaRes = await fetch(`${base}/api/quota?source=cpa`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      const cpaBody = await cpaRes.json();
      assertEquals(cpaBody.accounts.length, 1, 'Only 1 account returned for source=cpa');
      assertEquals(cpaBody.accounts[0].id, 'gpt-1', 'Returned gpt-1');

      // 6. Query filter: ?auth_index=3
      const authIdxRes = await fetch(`${base}/api/quota?auth_index=3`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      const authIdxBody = await authIdxRes.json();
      assertEquals(authIdxBody.accounts.length, 1, 'Only 1 account returned for auth_index=3');
      assertEquals(authIdxBody.accounts[0].id, 'gpt-1', 'Returned gpt-1');

      // 7. Query filter: ?include_exhausted=false (default includes exhausted, unless excluded or filtering)
      const exhRes = await fetch(`${base}/api/quota?include_exhausted=false`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      const exhBody = await exhRes.json();
      assertEquals(exhBody.accounts.length, 1, 'Only non-exhausted returned when include_exhausted=false');
      assertEquals(exhBody.accounts[0].id, 'claude-1', 'Returned non-exhausted claude-1');
    } finally {
      app.close();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // --- Suite 5: HTTP GET /metrics authentication and format ---
  console.log('\nSuite 5: HTTP GET /metrics Auth and Content-Type');
  {
    const tempDir = createTempDir();
    const store = new Store(tempDir, 'test.db', APP_SECRET);
    const tracker = new Tracker(store);

    store.upsertAccount({
      id: 'claude-1',
      name: 'Claude Pro',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: 1000,
      email: 'c@example.com',
      plan: 'Pro',
      latestSnapshot: {
        accountId: 'claude-1',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date(2000).toISOString(),
        buckets: [],
      },
    });

    const quotaCache = new QuotaCache(
      () => store.listAccounts(),
      () => ({}),
      renderMetrics
    );

    const app = createApp(
      {
        adminPassword: ADMIN_PASSWORD,
        appSecret: APP_SECRET,
        apiToken: API_TOKEN,
        metricsToken: METRICS_TOKEN,
        secureCookies: false,
        trustProxy: false,
        webDir: tempDir,
      },
      { store, tracker, quotaCache }
    );

    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const port = (app.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Unauthenticated /metrics -> 401
      const unauthRes = await fetch(`${base}/metrics`);
      assertEquals(unauthRes.status, 401, 'Unauthenticated /metrics is 401');

      // 2. Cookie auth rejected on /metrics -> 401
      const cookieRes = await fetch(`${base}/metrics`, {
        headers: { Cookie: 'alt_session=somerandomsessioncookie' },
      });
      assertEquals(cookieRes.status, 401, 'Cookie auth on /metrics is rejected with 401');

      // 3. Invalid Bearer token -> 401
      const invalidTokenRes = await fetch(`${base}/metrics`, {
        headers: { Authorization: 'Bearer wrong-metrics-token' },
      });
      assertEquals(invalidTokenRes.status, 401, 'Invalid Bearer token is 401');

      // 4. Valid Bearer METRICS_TOKEN -> 200 with text/plain; version=0.0.4
      const validRes = await fetch(`${base}/metrics`, {
        headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
      });
      assertEquals(validRes.status, 200, 'Valid METRICS_TOKEN returns 200');
      const ct = validRes.headers.get('content-type') || '';
      assert(ct.includes('text/plain') && ct.includes('version=0.0.4'), 'Content-Type is text/plain; version=0.0.4');
      const text = await validRes.text();
      assert(text.includes('alt_accounts_total{provider="claude"} 1'), 'Rendered metric in body');
    } finally {
      app.close();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // --- Suite 6: GET /metrics returns 404 when neither METRICS_TOKEN nor API_TOKEN configured ---
  console.log('\nSuite 6: GET /metrics 404 when unconfigured');
  {
    const tempDir = createTempDir();
    const store = new Store(tempDir, 'test.db', APP_SECRET);
    const tracker = new Tracker(store);

    const app = createApp(
      {
        adminPassword: ADMIN_PASSWORD,
        appSecret: APP_SECRET,
        apiToken: '', // empty
        metricsToken: '', // empty
        secureCookies: false,
        trustProxy: false,
        webDir: tempDir,
      },
      { store, tracker }
    );

    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const port = (app.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/metrics`, {
        headers: { Authorization: 'Bearer some-token-value' },
      });
      assertEquals(res.status, 404, 'Returns 404 when metrics tokens unconfigured');
    } finally {
      app.close();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // --- Suite 7: Cache invalidation on sync ---
  console.log('\nSuite 7: Cache Invalidation on Sync');
  {
    let count = 0;
    const accounts: ServerAccount[] = [];
    const cache = new QuotaCache(
      () => {
        count++;
        return accounts;
      },
      undefined,
      renderMetrics
    );

    const first = cache.getView();
    assertEquals(count, 1, 'Store read once');
    const second = cache.getView();
    assertEquals(count, 1, 'Store cached, read count remains 1');

    cache.invalidate();
    const third = cache.getView();
    assertEquals(count, 2, 'Store read again after invalidation');
  }

  console.log('\n========================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${totalTests - failedTests} | Failed: ${failedTests}`);
  console.log('========================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled error in tests:', err);
  process.exit(1);
});
