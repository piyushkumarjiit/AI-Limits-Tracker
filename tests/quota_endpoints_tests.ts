import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Store, ServerAccount } from '../server/src/store';
import { Tracker } from '../server/src/tracker';
import { createApp } from '../server/src/app';
import { QuotaCache, buildQuotaView, filterQuotaView } from '../server/src/quotaCache';
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

  // --- Suite 2: buildQuotaView schema (§5.3 camelCase & exact fields) and zero secret leakage ---
  console.log('\nSuite 2: buildQuotaView Schema (§5.3 Conformance) & Secret Hygiene');
  {
    const now = 1000000;
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
          fetchedAt: new Date(now - 42000).toISOString(),
          buckets: [
            {
              id: 'five_hour',
              label: 'Session (5h)',
              windowType: 'session_5h',
              utilizationPercent: 29,
              remainingPercent: 71,
              resetsAt: new Date(now + 8000000).toISOString(),
              isExhausted: false,
              severity: 'normal',
            },
            {
              id: 'seven_day',
              label: 'Weekly',
              windowType: 'weekly_7d',
              utilizationPercent: 80,
              remainingPercent: 20,
              resetsAt: new Date(now + 86400000).toISOString(),
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
          fetchedAt: new Date(now - 10000).toISOString(),
          buckets: [
            {
              id: 'primary',
              label: '5h',
              windowType: 'session_5h',
              utilizationPercent: 100,
              remainingPercent: 0,
              resetsAt: new Date(now + 1800000).toISOString(),
              isExhausted: true,
              severity: 'exhausted',
            },
          ],
        },
      },
    ];

    const ctx = {
      intervalSec: 300,
      cpaStatus: {
        enabled: true,
        lastDiscoveryAt: '2026-11-01T05:25:00.000Z',
        lastDiscoveryOk: true,
        routingMode: 'shadow' as const,
      },
      cpaLinks: [
        {
          accountId: 'acc-cpa-1',
          identityKey: 'chatgpt:cpa:1',
          cpaName: 'claude-user@x.json',
          authIndex: 'a1b2c3d4e5f60718',
          state: 'linked' as const,
          lastSeenAt: 2000,
          unlinkedAt: null,
          routingJson: JSON.stringify({ applied: 1240, cooldown: false, reason: 'headroom' }),
        },
      ],
      cpaRouting: {
        plans: [
          {
            accountId: 'acc-cpa-1',
            cpaName: 'claude-user@x.json',
            headroom: 0.62,
            target: 1240,
            cooldown: false,
            reason: 'headroom' as const,
            write: true,
          },
        ],
      },
      getHistory: () => [
        { accountId: 'acc-native-1', t: now - 3600000, session: 20, weekly: 70 },
        { accountId: 'acc-native-1', t: now - 1800000, session: 26, weekly: 75 },
      ],
    };

    const view = buildQuotaView(accounts, ctx, now);

    assertEquals(view.version, 1, 'Version is 1');
    assertEquals(view.intervalSec, 300, 'intervalSec is 300');
    assert(Boolean(view.generatedAt), 'generatedAt is present');
    assertEquals(view.cpa.enabled, true, 'cpa.enabled is true');
    assertEquals(view.cpa.routingMode, 'shadow', 'cpa.routingMode is shadow');
    assertEquals((view as any).totals, undefined, 'Invented root totals is removed');

    // acc-native-1 checks
    const nat = view.accounts.find((a) => a.id === 'acc-native-1')!;
    assert(Boolean(nat), 'Found native account');
    assertEquals(nat.source, 'native', 'Source is native');
    assertEquals(nat.cpa, null, 'cpa is null for native');
    assertEquals(nat.plan, 'Pro', 'Plan is Pro');
    assertEquals(nat.ageSeconds, 42, 'ageSeconds is 42');
    assertEquals(nat.stale, false, 'stale is false');
    assertEquals(nat.effectiveRemainingPct, 20, 'effectiveRemainingPct is 20 (binding)');
    assert(nat.headroom !== null, 'headroom is computed');
    assertEquals(nat.windows.length, 2, '2 windows for native');
    assertEquals(nat.windows[0].id, 'five_hour', 'Window id is five_hour per canonical mapping');
    assertEquals(nat.windows[0].type, 'session_5h', 'Window type is session_5h');
    assertEquals(nat.windows[0].remainingPct, 71, 'remainingPct is 71');
    assertEquals(nat.windows[0].usedPct, 29, 'usedPct is 29');
    assertEquals(nat.windows[0].resetInSec, 8000, 'resetInSec is 8000');
    assertEquals(nat.windows[0].exhausted, false, 'exhausted is false');

    // acc-cpa-1 checks
    const cpa = view.accounts.find((a) => a.id === 'acc-cpa-1')!;
    assert(Boolean(cpa), 'Found CPA account');
    assertEquals(cpa.source, 'cpa', 'Source is cpa');
    assertEquals(cpa.cpa?.authIndex, 'a1b2c3d4e5f60718', 'cpa.authIndex matches spec');
    assertEquals(cpa.cpa?.name, 'claude-user@x.json', 'cpa.name matches spec');
    assertEquals(cpa.cpa?.linkState, 'linked', 'cpa.linkState matches spec');
    assertEquals(cpa.routing.planned, 1240, 'routing.planned matches spec');
    assertEquals(cpa.routing.applied, 1240, 'routing.applied matches spec');
    assertEquals(cpa.routing.managed, true, 'routing.managed is true');
    assertEquals(cpa.routing.cooldown, false, 'routing.cooldown matches spec');
    assertEquals(cpa.routing.reason, 'headroom', 'routing.reason matches spec');

    // Zero secret leakage check
    const serialized = JSON.stringify(view);
    assert(!serialized.includes('accessToken'), 'Zero leakage: no accessToken');
    assert(!serialized.includes('refreshToken'), 'Zero leakage: no refreshToken');
    assert(!serialized.includes('sessionKey'), 'Zero leakage: no sessionKey');
    assert(!serialized.includes('managementKey'), 'Zero leakage: no managementKey');
  }

  // --- Suite 3: Staleness dynamic evaluation (ageSeconds and 3*interval) ---
  console.log('\nSuite 3: Dynamic Staleness Evaluation at Query Time');
  {
    const baseNow = 1000000;
    const intervalSec = 300;
    const accounts: ServerAccount[] = [
      {
        id: 'acc-stale-test',
        name: 'Staleness Account',
        providerType: 'claude',
        orderIndex: 0,
        isActive: true,
        createdAt: 1000,
        plan: 'Pro',
        latestSnapshot: {
          accountId: 'acc-stale-test',
          providerType: 'claude',
          planName: 'Pro',
          status: 'ok',
          fetchedAt: new Date(baseNow).toISOString(),
          buckets: [],
        },
      },
    ];

    const view = buildQuotaView(accounts, { intervalSec }, baseNow);
    assertEquals(view.accounts[0].stale, false, 'Account is fresh at baseNow');
    assertEquals(view.accounts[0].ageSeconds, 0, 'ageSeconds is 0 at baseNow');

    // Query 500s later (500 < 3*300 = 900)
    const view500 = filterQuotaView(view, {}, baseNow + 500 * 1000);
    assertEquals(view500.accounts[0].ageSeconds, 500, 'ageSeconds is 500');
    assertEquals(view500.accounts[0].stale, false, 'Account still fresh at 500s');

    // Query 901s later (901 > 3*300 = 900) -> stale flips to true!
    const view901 = filterQuotaView(view, {}, baseNow + 901 * 1000);
    assertEquals(view901.accounts[0].ageSeconds, 901, 'ageSeconds is 901');
    assertEquals(view901.accounts[0].stale, true, 'Account stale flips to true past 3 * intervalSec');
  }

  // --- Suite 4: Prometheus metrics rendering (§5.4 exact families) ---
  console.log('\nSuite 4: Prometheus Metrics Rendering (§5.4 Exact Metric Names)');
  {
    const now = 1000000;
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
          fetchedAt: new Date(now - 42000).toISOString(),
          buckets: [
            {
              id: 'five_hour',
              label: 'Session (5h)',
              windowType: 'session_5h',
              utilizationPercent: 29,
              remainingPercent: 71,
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
          fetchedAt: new Date(now).toISOString(),
          buckets: [],
        },
      },
    ];

    const ctx = {
      intervalSec: 300,
      cpaStatus: {
        enabled: true,
        lastDiscoveryAt: '2026-11-01T05:25:00.000Z',
        lastDiscoveryOk: true,
        routingMode: 'shadow' as const,
      },
      cpaLinks: [
        {
          accountId: 'acc-cpa-1',
          identityKey: 'chatgpt:cpa:1',
          cpaName: 'cpa-gpt-1',
          authIndex: 'idx-gpt',
          state: 'linked' as const,
          lastSeenAt: 2000,
          unlinkedAt: null,
          routingJson: JSON.stringify({ applied: 50 }),
        },
      ],
      cpaRouting: {
        plans: [
          {
            accountId: 'acc-cpa-1',
            cpaName: 'cpa-gpt-1',
            headroom: 0.5,
            target: 50,
            cooldown: false,
            reason: 'headroom' as const,
            write: false,
          },
        ],
      },
      getHistory: () => [
        { accountId: 'acc-native-1', t: now - 3600000, session: 20, weekly: 0 },
        { accountId: 'acc-native-1', t: now - 1800000, session: 29, weekly: 0 },
      ],
    };

    const view = buildQuotaView(accounts, ctx, now);
    const metrics = renderMetrics(view, now);

    assert(metrics.endsWith('\n'), 'Metrics end with newline');

    // §5.4 metric families assertion
    assert(metrics.includes('# HELP alt_quota_used_ratio'), 'alt_quota_used_ratio present');
    assert(metrics.includes('# TYPE alt_quota_used_ratio gauge'), 'alt_quota_used_ratio gauge');
    assert(
      metrics.includes('alt_quota_used_ratio{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com",window="five_hour"} 0.29'),
      'alt_quota_used_ratio has native auth_index="" and window="five_hour"'
    );

    assert(metrics.includes('# HELP alt_quota_remaining_ratio'), 'alt_quota_remaining_ratio present');
    assert(
      metrics.includes('alt_quota_remaining_ratio{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com",window="five_hour"} 0.71'),
      'alt_quota_remaining_ratio rendered'
    );

    assert(metrics.includes('# HELP alt_quota_reset_timestamp_seconds'), 'alt_quota_reset_timestamp_seconds present');
    assert(
      metrics.includes('alt_quota_reset_timestamp_seconds{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com",window="five_hour"} 1775044800'),
      'alt_quota_reset_timestamp_seconds rendered'
    );

    assert(metrics.includes('# HELP alt_quota_burn_ratio_per_hour'), 'alt_quota_burn_ratio_per_hour present');
    assert(
      metrics.includes('alt_quota_burn_ratio_per_hour{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com",window="five_hour"}'),
      'alt_quota_burn_ratio_per_hour rendered for non-null burn'
    );

    assert(metrics.includes('# HELP alt_account_headroom_ratio'), 'alt_account_headroom_ratio present');
    assert(metrics.includes('# HELP alt_account_up'), 'alt_account_up present');
    assert(
      metrics.includes('alt_account_up{provider="claude",account="acc-native-1",auth_index="",email="alice@example.com",status="ok"} 1'),
      'alt_account_up rendered with status="ok"'
    );

    assert(metrics.includes('# HELP alt_account_last_success_timestamp_seconds'), 'alt_account_last_success_timestamp_seconds present');
    assert(metrics.includes('# HELP alt_cpa_routing_weight'), 'alt_cpa_routing_weight present');
    assert(
      metrics.includes('alt_cpa_routing_weight{provider="chatgpt",account="acc-cpa-1",auth_index="idx-gpt",email="bob@example.com",kind="planned"} 50'),
      'alt_cpa_routing_weight planned rendered with auth_index'
    );
    assert(
      metrics.includes('alt_cpa_routing_weight{provider="chatgpt",account="acc-cpa-1",auth_index="idx-gpt",email="bob@example.com",kind="applied"} 50'),
      'alt_cpa_routing_weight applied rendered with auth_index'
    );

    assert(metrics.includes('# HELP alt_cpa_routing_writes_total'), 'alt_cpa_routing_writes_total present');
    assert(metrics.includes('# HELP alt_cpa_discovery_last_success_timestamp_seconds'), 'alt_cpa_discovery_last_success_timestamp_seconds present');
    assert(metrics.includes('# HELP alt_cpa_credentials'), 'alt_cpa_credentials present');
    assert(
      metrics.includes('alt_cpa_credentials{provider="chatgpt",link_state="linked"} 1'),
      'alt_cpa_credentials rendered'
    );
  }

  // --- Suite 5: HTTP GET /api/quota with repeatable providers, source, and ETag W/"<version>" ---
  console.log('\nSuite 5: HTTP GET /api/quota, Repeatable Query, and ETag: W/"<version>"');
  {
    const tempDir = createTempDir();
    const store = new Store(tempDir, 'test.db', APP_SECRET);
    const tracker = new Tracker(store);

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
        buckets: [],
      },
    });

    store.upsertAccount({
      id: 'agy-1',
      name: 'Antigravity CPA',
      providerType: 'antigravity',
      orderIndex: 2,
      isActive: true,
      createdAt: 3000,
      email: 'user3@example.com',
      plan: 'Free',
      latestSnapshot: {
        accountId: 'agy-1',
        providerType: 'antigravity',
        planName: 'Free',
        status: 'ok',
        fetchedAt: new Date(3000).toISOString(),
        buckets: [],
      },
    });

    store.upsertCpaLink({
      accountId: 'gpt-1',
      identityKey: 'chatgpt:cpa:gpt-1',
      cpaName: 'cpa-gpt-1',
      authIndex: 'idx-gpt',
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
      // 1. Unauthenticated -> 401
      const unauthRes = await fetch(`${base}/api/quota`);
      assertEquals(unauthRes.status, 401, 'Unauthenticated /api/quota is 401');

      // 2. Authenticated -> 200, ETag is W/"<version>", Cache-Control is private, max-age=15
      const authedRes = await fetch(`${base}/api/quota`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      assertEquals(authedRes.status, 200, 'Authenticated /api/quota is 200');
      const etag = authedRes.headers.get('etag');
      assert(etag?.startsWith('W/"') === true, `ETag is weak version format W/"<version>": ${etag}`);
      assertEquals(
        authedRes.headers.get('cache-control'),
        'private, max-age=15',
        'Cache-Control is private, max-age=15'
      );
      const body = await authedRes.json();
      assertEquals(body.version, 1, 'Body version is 1');
      assertEquals(body.accounts.length, 3, '3 accounts in unfiltered view');

      // 3. Conditional GET with If-None-Match -> 304 Not Modified
      const notModifiedRes = await fetch(`${base}/api/quota`, {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'If-None-Match': etag!,
        },
      });
      assertEquals(notModifiedRes.status, 304, 'If-None-Match with matching ETag returns 304');

      // 4. Repeatable query: ?provider=claude&provider=antigravity
      const repeatRes = await fetch(`${base}/api/quota?provider=claude&provider=antigravity`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      assertEquals(repeatRes.status, 200, 'Repeatable provider query returns 200');
      const repeatBody = await repeatRes.json();
      assertEquals(repeatBody.accounts.length, 2, '2 accounts returned for claude + antigravity');
      assert(
        repeatBody.accounts.some((a: any) => a.id === 'claude-1') &&
          repeatBody.accounts.some((a: any) => a.id === 'agy-1'),
        'Returned claude-1 and agy-1'
      );

      // 5. Source filter: ?source=cpa
      const cpaRes = await fetch(`${base}/api/quota?source=cpa`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      const cpaBody = await cpaRes.json();
      assertEquals(cpaBody.accounts.length, 1, '1 account returned for source=cpa');
      assertEquals(cpaBody.accounts[0].id, 'gpt-1', 'Returned gpt-1');

      // 6. Source filter: ?source=all
      const allRes = await fetch(`${base}/api/quota?source=all`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      const allBody = await allRes.json();
      assertEquals(allBody.accounts.length, 3, '3 accounts returned for source=all');
    } finally {
      app.close();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // --- Suite 6: /metrics bearer rate limiter & caching ---
  console.log('\nSuite 6: HTTP GET /metrics Bearer Rate Limiter & Auth');
  {
    const tempDir = createTempDir();
    const store = new Store(tempDir, 'test.db', APP_SECRET);
    const tracker = new Tracker(store);

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
      // 1. Unauthenticated -> 401
      const unauthRes = await fetch(`${base}/metrics`);
      assertEquals(unauthRes.status, 401, 'Unauthenticated /metrics is 401');

      // 2. Cookie auth rejected -> 401
      const cookieRes = await fetch(`${base}/metrics`, {
        headers: { Cookie: 'alt_session=somerandomsessioncookie' },
      });
      assertEquals(cookieRes.status, 401, 'Cookie auth on /metrics is rejected with 401');

      // 3. Bearer rate limiter: 10 failed guesses trigger 429
      for (let i = 0; i < 10; i++) {
        const failRes = await fetch(`${base}/metrics`, {
          headers: { Authorization: `Bearer wrong-token-${i}` },
        });
        assertEquals(failRes.status, 401, `Failed attempt ${i + 1} is 401`);
      }
      // 11th attempt should be throttled by bearerLimiter with 429
      const throttledRes = await fetch(`${base}/metrics`, {
        headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
      });
      assertEquals(throttledRes.status, 429, '11th attempt is 429 (bearer rate limiter active on /metrics)');
    } finally {
      app.close();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // --- Suite 7: 250ms debounced invalidation & zero fetch during 100 requests ---
  console.log('\nSuite 7: Debounced Invalidation & Zero-Fetch Performance');
  {
    let accountReadCount = 0;
    const accounts: ServerAccount[] = [];
    const cache = new QuotaCache(
      () => {
        accountReadCount++;
        return accounts;
      },
      undefined,
      renderMetrics
    );

    // Initial read
    cache.getView();
    assertEquals(accountReadCount, 1, 'Initial read performed');
    assertEquals(cache.getVersion(), 1, 'Initial version is 1');

    // 100 rapid cache.get() calls
    for (let i = 0; i < 100; i++) {
      cache.get({ source: 'all' });
    }
    assertEquals(accountReadCount, 1, 'Zero extra upstream reads over 100 requests');

    // Debounced invalidation calls in rapid succession
    cache.invalidate();
    cache.invalidate();
    cache.invalidate();
    // Before debounce timer fires: version hasn't bumped yet
    assertEquals(cache.getVersion(), 1, 'Version not yet bumped before 250ms debounce');

    // Wait 300ms for debounce timer to fire
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(cache.getVersion(), 2, 'Version bumped to 2 after 250ms debounce');

    // Next read re-fetches from store
    cache.getView();
    assertEquals(accountReadCount, 2, 'Store read once after debounced invalidation');
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
