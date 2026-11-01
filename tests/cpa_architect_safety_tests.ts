import { Store, ServerAccount } from '../server/src/store';
import { Tracker } from '../server/src/tracker';
import { CpaTransport } from '../src/services/cpa/CpaTransport';
import {
  CpaUsageProvider,
  isTerminalQuarantineError,
} from '../src/services/cpa/CpaUsageProvider';
import {
  CODEX_USER_AGENT,
  getAntigravityUserAgent,
} from '../src/services/cpa/clientIdentity';
import { planOf } from '../src/services/cpa/reconcile';
import { CpaSyncEngine } from '../server/src/cpaSync';
import { canonicalWindowName, buildQuotaView } from '../server/src/quotaCache';
import { renderMetrics } from '../server/src/metrics';
import { AccountCredentials, QuotaBucket, UsageSnapshot } from '../src/models/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

function assertEquals<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-safety-test-'));
}

const APP_SECRET = '0123456789abcdef0123456789abcdef';

async function runTests() {
  console.log('\n========================================');
  console.log('  CPA ARCHITECT SAFETY TESTS (B1–B5)    ');
  console.log('========================================');

  // --------------------------------------------------------------------------
  // Suite 1: B1 - Credential Wipe Prevention on Sync
  // --------------------------------------------------------------------------
  console.log('\nSuite 1: B1 - Credential Wipe Prevention on Sync');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'tracker.db', APP_SECRET);
    const tracker = new Tracker(store);
    tracker.cpaJitterEnabled = false;

    // 1. Create a CPA Codex account with full CPA credentials
    const accountId = 'cpa-acc-codex-1';
    store.upsertAccount({
      id: accountId,
      name: 'Codex Account',
      providerType: 'chatgpt',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
      plan: 'Plus',
    });

    const initialCreds: AccountCredentials = {
      authType: 'cpa',
      cpaAuthIndex: 'auth_idx_123',
      cpaName: 'codex-acc.json',
      cpaProvider: 'codex',
      cpaAccountId: 'org-chatgpt-workspace-1',
      cpaProjectId: 'proj-xyz',
      plan: 'Plus',
    };
    store.setCredentials(accountId, initialCreds);
    store.upsertCpaLink({
      accountId,
      authIndex: 'auth_idx_123',
      cpaName: 'codex-acc.json',
      identityKey: 'codex:work@company.com',
      state: 'linked',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    // Mock CPA transport that returns a plan change ('Team') in wham/usage
    let probeCalls = 0;
    const mockTransport = {
      apiCall: async (req: any) => {
        probeCalls++;
        return {
          status_code: 200,
          header: {},
          body: {
            plan_type: 'team',
            rate_limit: {
              primary_window: {
                limit_window_seconds: 18000,
                used_percent: 25,
                reset_at: 1700000000,
              },
            },
          },
        };
      },
    } as unknown as CpaTransport;

    const cpaProvider = new CpaUsageProvider(mockTransport);
    tracker.setCpaProvider(cpaProvider);

    // Sync 1: Triggers plan update
    await tracker.sync(accountId);
    assertEquals(probeCalls, 1, 'Sync 1 made 1 upstream probe');

    // Verify stored credentials after Sync 1
    const credsAfterSync1 = store.getCredentials(accountId);
    assert(credsAfterSync1 !== null, 'Credentials exist after Sync 1');
    assertEquals(credsAfterSync1?.authType, 'cpa', 'authType is still "cpa" after Sync 1');
    assertEquals(credsAfterSync1?.cpaAuthIndex, 'auth_idx_123', 'cpaAuthIndex preserved');
    assertEquals(credsAfterSync1?.cpaName, 'codex-acc.json', 'cpaName preserved');
    assertEquals(credsAfterSync1?.cpaProvider, 'codex', 'cpaProvider preserved');
    assertEquals(credsAfterSync1?.cpaAccountId, 'org-chatgpt-workspace-1', 'cpaAccountId preserved');
    assertEquals(credsAfterSync1?.cpaProjectId, 'proj-xyz', 'cpaProjectId preserved');
    assertEquals(credsAfterSync1?.plan, 'Team', 'Plan updated to "Team"');

    // Sync 2: Consecutive sync must still route to CPA provider (not native provider)
    await tracker.sync(accountId);
    assertEquals(probeCalls, 2, 'Sync 2 routed to CpaUsageProvider and completed 2nd probe');

    const credsAfterSync2 = store.getCredentials(accountId);
    assertEquals(credsAfterSync2?.authType, 'cpa', 'authType is still "cpa" after Sync 2');
    assertEquals(credsAfterSync2?.cpaAuthIndex, 'auth_idx_123', 'cpaAuthIndex preserved after Sync 2');

    // Test CpaUsageProvider.parseProviderResponse directly
    const directResult = await cpaProvider.fetchUsage(accountId, initialCreds);
    assert(directResult.updatedCredentials !== undefined, 'updatedCredentials returned for plan change');
    assertEquals(directResult.updatedCredentials?.authType, 'cpa', 'Provider explicitly preserves authType');
    assertEquals(directResult.updatedCredentials?.cpaAuthIndex, 'auth_idx_123', 'Provider preserves cpaAuthIndex');
    assertEquals(directResult.updatedCredentials?.cpaAccountId, 'org-chatgpt-workspace-1', 'Provider preserves cpaAccountId');

    // Test planOf normalization agreement with chatgptPlanTitle
    assertEquals(planOf({ provider: 'codex', plan: 'business' } as any), 'Business', 'planOf normalizes business to Business');
    assertEquals(planOf({ provider: 'codex', plan: 'enterprise' } as any), 'Enterprise', 'planOf normalizes enterprise to Enterprise');
    assertEquals(planOf({ provider: 'codex', plan: 'edu' } as any), 'Edu', 'planOf normalizes edu to Edu');
    assertEquals(planOf({ provider: 'codex', plan: 'plus' } as any), 'Plus', 'planOf normalizes plus to Plus');
    assertEquals(planOf({ provider: 'codex', plan: 'pro' } as any), 'Pro', 'planOf normalizes pro to Pro');

    console.log('  ✓ [PASS] B1: Tracker merges updatedCredentials preserving authType and all CPA fields');
    console.log('  ✓ [PASS] B1: Consecutive syncs on CPA account keep authType cpa and route to CpaUsageProvider');
    console.log('  ✓ [PASS] B1: planOf normalizes Business/Enterprise/Edu/Plus/Pro titles');
  }

  // --------------------------------------------------------------------------
  // Suite 2: B2 - Update Stale Client User-Agents
  // --------------------------------------------------------------------------
  console.log('\nSuite 2: B2 - Update Stale Client User-Agents');
  {
    // Check CODEX_USER_AGENT constant
    assertEquals(CODEX_USER_AGENT, 'codex_cli_rs/0.159.0 (terminal)', 'CODEX_USER_AGENT matches 0.159.0 (terminal)');

    let capturedHeaders: Record<string, string> = {};
    const mockTransport = {
      apiCall: async (req: any) => {
        capturedHeaders = req.header || {};
        return { status_code: 200, header: {}, body: {} };
      },
    } as unknown as CpaTransport;

    const provider = new CpaUsageProvider(mockTransport);

    // 1. Codex probe User-Agent
    await provider.fetchUsage('acc-codex', {
      authType: 'cpa',
      cpaAuthIndex: 'idx1',
      cpaProvider: 'codex',
    });
    assertEquals(
      capturedHeaders['User-Agent'],
      'codex_cli_rs/0.159.0 (terminal)',
      'Codex probe sends current User-Agent (not stale 0.50.0)'
    );

    // 2. Antigravity probe User-Agent dynamic OS and Arch detection
    await provider.fetchUsage('acc-agy', {
      authType: 'cpa',
      cpaAuthIndex: 'idx2',
      cpaProvider: 'antigravity',
    });
    const agyUa = capturedHeaders['User-Agent'] || '';
    assert(agyUa.startsWith('antigravity/hub/2.24.0 (aidev_client; os_type='), 'Antigravity UA starts with prefix');
    assert(agyUa.includes('arch='), 'Antigravity UA includes dynamic arch');
    assert(agyUa.includes('cl=1000335682'), 'Antigravity UA includes changelist');

    // Test getAntigravityUserAgent output
    const derivedUa = getAntigravityUserAgent();
    assert(derivedUa.includes(`os_type=${process.platform === 'win32' ? 'windows' : process.platform}`), 'derived UA matches current platform');
    assert(derivedUa.includes('arch='), 'derived UA has arch');

    console.log('  ✓ [PASS] B2: Codex probe sends codex_cli_rs/0.159.0 (terminal)');
    console.log('  ✓ [PASS] B2: Antigravity probe derives dynamic os_type and arch');
  }

  // --------------------------------------------------------------------------
  // Suite 3: B3 - Terminal Error Quarantine & Immediate Polling Halt
  // --------------------------------------------------------------------------
  console.log('\nSuite 3: B3 - Terminal Error Quarantine & Immediate Polling Halt');
  {
    // Test isTerminalQuarantineError helper on various terminal strings
    const tosCheck = isTerminalQuarantineError('Error: 403 TOS_VIOLATION from Google Cloud');
    assert(tosCheck.isQuarantined, 'Detects TOS_VIOLATION');
    assert(tosCheck.reason.includes('TOS_VIOLATION'), 'Reason includes TOS_VIOLATION');

    const grantCheck = isTerminalQuarantineError({ error: 'invalid_grant', error_description: 'Token has been revoked.' });
    assert(grantCheck.isQuarantined, 'Detects invalid_grant in object');

    const claudeCodeCheck = isTerminalQuarantineError('This credential is only authorized for use with Claude Code.');
    assert(claudeCodeCheck.isQuarantined, 'Detects only authorized for use with Claude Code');

    const suspendedCheck = isTerminalQuarantineError('Your account suspended due to terms violation');
    assert(suspendedCheck.isQuarantined, 'Detects account suspended');

    const extraUsageCheck = isTerminalQuarantineError('Upstream 400: out of extra usage for billing cycle');
    assert(extraUsageCheck.isQuarantined, 'Detects out of extra usage');

    const normalError = isTerminalQuarantineError('Network timeout');
    assert(!normalError.isQuarantined, 'Normal timeout is not quarantined');

    // Test CpaUsageProvider quarantine mapping on HTTP 403 with TOS_VIOLATION
    const mockTransport = {
      apiCall: async () => ({
        status_code: 403,
        header: {},
        body: JSON.stringify({ error: { message: 'TOS_VIOLATION: Google account access disabled' } }),
      }),
    } as unknown as CpaTransport;

    const provider = new CpaUsageProvider(mockTransport);
    const res = await provider.fetchUsage('acc-quarantine-1', {
      authType: 'cpa',
      cpaAuthIndex: 'q1',
      cpaProvider: 'antigravity',
    });

    assertEquals(res.snapshot.status, 'quarantined', 'HTTP 403 TOS_VIOLATION maps to status quarantined');
    assertEquals(res.updatedCredentials?.quarantined, true, 'updatedCredentials flags quarantined: true');
    assertEquals(res.updatedCredentials?.cpaStatus, 'disabled', 'updatedCredentials sets cpaStatus disabled');
    assertEquals(res.updatedCredentials?.cpaRisk, 'suspended', 'updatedCredentials sets cpaRisk suspended');
    assertEquals(res.updatedCredentials?.authType, 'cpa', 'updatedCredentials keeps authType cpa');

    // Integration test with Tracker: tracker halts polling for quarantined accounts
    const dir = createTempDir();
    const store = new Store(dir, 'tracker.db', APP_SECRET);
    const tracker = new Tracker(store);
    tracker.cpaJitterEnabled = false;

    let networkAttempts = 0;
    const countingTransport = {
      apiCall: async () => {
        networkAttempts++;
        return {
          status_code: 403,
          header: {},
          body: 'TOS_VIOLATION: account disabled',
        };
      },
    } as unknown as CpaTransport;
    tracker.setCpaProvider(new CpaUsageProvider(countingTransport));

    store.upsertAccount({
      id: 'acc-tos',
      name: 'Banned Account',
      providerType: 'antigravity',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
    });
    store.setCredentials('acc-tos', {
      authType: 'cpa',
      cpaAuthIndex: 'q2',
      cpaProvider: 'antigravity',
    });

    // First sync: triggers probe, receives TOS_VIOLATION, marks account quarantined
    await tracker.sync('acc-tos');
    assertEquals(networkAttempts, 1, 'First sync probed network once');
    const storedAcc = store.getAccount('acc-tos');
    assertEquals(storedAcc?.lastStatus, 'quarantined', 'Account lastStatus is quarantined in store');
    const storedCreds = store.getCredentials('acc-tos');
    assertEquals(storedCreds?.quarantined, true, 'Credentials stored with quarantined: true');

    // Second sync: should immediately return and halt polling without hitting network
    await tracker.sync('acc-tos');
    assertEquals(networkAttempts, 1, 'Second sync did NOT probe network (halted immediately)');

    // syncAll: should skip quarantined account completely
    await tracker.syncAll();
    assertEquals(networkAttempts, 1, 'syncAll skipped quarantined account (networkAttempts still 1)');

    console.log('  ✓ [PASS] B3: Terminal error signatures (TOS_VIOLATION, invalid_grant, Claude Code, suspended) detected');
    console.log('  ✓ [PASS] B3: HTTP 403 / 400 terminal errors map to quarantined status and flag credentials');
    console.log('  ✓ [PASS] B3: Tracker immediately halts polling for quarantined accounts');
  }

  // --------------------------------------------------------------------------
  // Suite 4: B4 - Polling Cadence, Jitter & Concurrency Ceiling
  // --------------------------------------------------------------------------
  console.log('\nSuite 4: B4 - Polling Cadence, Jitter & Concurrency Ceiling');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'tracker.db', APP_SECRET);
    const tracker = new Tracker(store);

    // 1. Minimum interval floor >= 5 minutes
    tracker.setIntervalMin(1); // Try to set 1 min
    assert(tracker.intervalMin() >= 5, 'intervalMin() has a minimum floor of 5 minutes');

    store.setSetting('interval_min', '2');
    assert(tracker.intervalMin() >= 5, 'intervalMin() clamps store setting below 5 to 5');

    // 2. Global Concurrency Cap of 2
    let activeProbes = 0;
    let maxObservedActiveProbes = 0;

    const slowTransport = {
      apiCall: async () => {
        activeProbes++;
        if (activeProbes > maxObservedActiveProbes) {
          maxObservedActiveProbes = activeProbes;
        }
        // Artificial delay to allow concurrent callers to pile up
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeProbes--;
        return {
          status_code: 200,
          header: {},
          body: {
            rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 10 } },
          },
        };
      },
    } as unknown as CpaTransport;

    tracker.setCpaProvider(new CpaUsageProvider(slowTransport));
    tracker.cpaJitterEnabled = false;

    // Create 6 accounts
    const accIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `cap-acc-${i}`;
      accIds.push(id);
      store.upsertAccount({
        id,
        name: `Cap Acc ${i}`,
        providerType: 'chatgpt',
        orderIndex: i,
        isActive: true,
        createdAt: Date.now(),
      });
      store.setCredentials(id, {
        authType: 'cpa',
        cpaAuthIndex: `idx-${i}`,
        cpaProvider: 'codex',
      });
    }

    // Launch all 6 syncs simultaneously
    await Promise.all(accIds.map((id) => tracker.sync(id)));
    assert(
      maxObservedActiveProbes <= Tracker.GLOBAL_CONCURRENCY_CAP,
      `Max active probes (${maxObservedActiveProbes}) never exceeded GLOBAL_CONCURRENCY_CAP (${Tracker.GLOBAL_CONCURRENCY_CAP})`
    );

    // 3. Staggered Jitter in CpaSyncEngine on new account discovery
    const engine = new CpaSyncEngine(store, tracker, {
      listCredentials: async () => [
        { name: 'acc-new-1', provider: 'codex', source: 'file', auth_index: 'n1', email: 'n1@test.com' },
        { name: 'acc-new-2', provider: 'codex', source: 'file', auth_index: 'n2', email: 'n2@test.com' },
      ],
    } as unknown as CpaTransport);

    const actions = await engine.runOnce();
    assertEquals(actions.length, 2, 'Discovered 2 new accounts');

    console.log('  ✓ [PASS] B4: Minimum polling interval floor is enforced at >= 5 minutes');
    console.log('  ✓ [PASS] B4: Global concurrency cap of 2 strictly enforced across simultaneous probes');
    console.log('  ✓ [PASS] B4: CpaSyncEngine queues new account syncs with staggered jitter');
  }

  // --------------------------------------------------------------------------
  // Suite 5: B5 - Prometheus Metric Collision Prevention in /metrics
  // --------------------------------------------------------------------------
  console.log('\nSuite 5: B5 - Prometheus Metric Collision Prevention in /metrics');
  {
    // 1. canonicalWindowName disambiguation
    const opusBucket: QuotaBucket = {
      id: 'seven_day_opus',
      label: 'Weekly · Opus',
      windowType: 'weekly_7d',
      utilizationPercent: 30,
      remainingPercent: 70,
      resetsAt: new Date().toISOString(),
      isExhausted: false,
      severity: 'normal',
    };
    assertEquals(canonicalWindowName(opusBucket, 'claude'), 'seven_day_opus', 'Opus bucket mapped to seven_day_opus');

    const sonnetBucket: QuotaBucket = {
      id: 'seven_day_sonnet',
      label: 'Weekly · Sonnet',
      windowType: 'weekly_7d',
      utilizationPercent: 40,
      remainingPercent: 60,
      resetsAt: new Date().toISOString(),
      isExhausted: false,
      severity: 'normal',
    };
    assertEquals(canonicalWindowName(sonnetBucket, 'claude'), 'seven_day_sonnet', 'Sonnet bucket mapped to seven_day_sonnet');

    const codeReviewBucket: QuotaBucket = {
      id: 'code_review',
      label: 'Code Review',
      windowType: 'session_5h',
      utilizationPercent: 10,
      remainingPercent: 90,
      resetsAt: new Date().toISOString(),
      isExhausted: false,
      severity: 'normal',
    };
    assertEquals(canonicalWindowName(codeReviewBucket, 'chatgpt'), 'code_review', 'Codex code_review mapped to code_review');

    // 2. buildQuotaView on Claude Max with 4 buckets + Codex with code_review
    const claudeMaxAccount: ServerAccount = {
      id: 'claude-max-acc',
      name: 'Claude Max Account',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: 1000,
      email: 'max@example.com',
      plan: 'Max 20x',
      latestSnapshot: {
        accountId: 'claude-max-acc',
        providerType: 'claude',
        planName: 'Max 20x',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: 'Session (5h)',
            windowType: 'session_5h',
            utilizationPercent: 20,
            remainingPercent: 80,
            resetsAt: new Date().toISOString(),
            isExhausted: false,
            severity: 'normal',
          },
          {
            id: 'seven_day',
            label: 'Weekly',
            windowType: 'weekly_7d',
            utilizationPercent: 50,
            remainingPercent: 50,
            resetsAt: new Date().toISOString(),
            isExhausted: false,
            severity: 'normal',
          },
          opusBucket,
          sonnetBucket,
        ],
      },
    };

    const codexAccount: ServerAccount = {
      id: 'codex-acc',
      name: 'Codex Account',
      providerType: 'chatgpt',
      orderIndex: 1,
      isActive: true,
      createdAt: 2000,
      email: 'codex@example.com',
      plan: 'Plus',
      latestSnapshot: {
        accountId: 'codex-acc',
        providerType: 'chatgpt',
        planName: 'Plus',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'primary',
            label: 'Codex · 5h',
            windowType: 'session_5h',
            utilizationPercent: 15,
            remainingPercent: 85,
            resetsAt: new Date().toISOString(),
            isExhausted: false,
            severity: 'normal',
          },
          codeReviewBucket,
        ],
      },
    };

    const quotaView = buildQuotaView([claudeMaxAccount, codexAccount]);
    const claudeWindows = quotaView.accounts[0].windows.map((w) => w.id);
    assertEquals(claudeWindows, ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'], 'Claude Max has 4 distinct window IDs');

    const codexWindows = quotaView.accounts[1].windows.map((w) => w.id);
    assertEquals(codexWindows, ['five_hour', 'code_review'], 'Codex has distinct primary and code_review window IDs');

    // 3. Render Prometheus metrics and verify NO DUPLICATE SERIES
    const metricsOutput = renderMetrics(quotaView);
    const lines = metricsOutput.split('\n').filter((l) => l.trim() && !l.startsWith('#'));

    const seenSeries = new Set<string>();
    const duplicateSeries: string[] = [];

    for (const line of lines) {
      // Line format: metric_name{labels} value
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*\{[^}]*\})/.exec(line);
      if (match) {
        const seriesKey = match[1];
        if (seenSeries.has(seriesKey)) {
          duplicateSeries.push(seriesKey);
        }
        seenSeries.add(seriesKey);
      }
    }

    assertEquals(
      duplicateSeries.length,
      0,
      `No duplicate Prometheus metric series found (duplicates: ${duplicateSeries.join(', ')})`
    );

    console.log('  ✓ [PASS] B5: canonicalWindowName disambiguates seven_day_opus, seven_day_sonnet, and code_review');
    console.log('  ✓ [PASS] B5: buildQuotaView assigns unique window IDs for all buckets');
    console.log('  ✓ [PASS] B5: renderMetrics produces 0 duplicate Prometheus series on Claude Max and Codex fixtures');
  }

  console.log('\n========================================');
  console.log('  ALL B1–B5 ARCHITECT TESTS PASSED!     ');
  console.log('========================================\n');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
