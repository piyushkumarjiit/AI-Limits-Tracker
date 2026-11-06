import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  calculateLeadTimeSec,
  computeEwmaBurnRate,
  computeDualWindowBurnRate,
  evaluateAccountTripwire,
  applyFailClosedCollectiveFallback,
  CircuitBreakerRegistry,
  DEFAULT_LEAD_TIME_SEC,
} from '../server/src/cpaTripwireEngine';
import { effectiveAccountState } from '../server/src/cpaWatermarkTypes';
import { Store } from '../server/src/store';
import { CpaWatermarkService } from '../server/src/cpaWatermarkService';
import { CpaPolicyLoader, DEFAULT_WATERMARK_POLICY } from '../server/src/cpaWatermarkPolicy';
import type { CpaTransport } from '../src/services/cpa/CpaTransport';
import { applyDualBarrier } from '../server/src/cpaSync';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

const APP_SECRET = '0123456789abcdef0123456789abcdef';

function createTempDir(prefix = 'cpa-tripwires-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

async function run() {
  console.log('\n======================================================');
  console.log('  CPA BACKEND TRIPWIRES & FAIL-CLOSED TESTS (WP-4A)   ');
  console.log('======================================================\n');

  console.log('Suite 1: Predictive Lead-Time Tripwire Engine Math');
  {
    const L = calculateLeadTimeSec(60, 30, 5);
    assert(L === 335, 'computes lead time L = 5*tau + T_drain + T_poll = 335s with defaults');
    assert(DEFAULT_LEAD_TIME_SEC === 335, 'DEFAULT_LEAD_TIME_SEC is 335s');

    const now = 1000000;
    const history = [
      { t: now - 120000, value: 20 },
      { t: now - 60000, value: 35 },
      { t: now, value: 50 },
    ];
    const { b, bFast, bSlow } = computeDualWindowBurnRate(history, now, 2, 10);
    assert(bFast > 10, 'computes fast EWMA burn rate > 10%/min under rapid consumption');
    assert(b === Math.max(bFast, bSlow), 'takes max(b_fast, b_slow) as binding burn rate');
  }

  console.log('\nSuite 2: Headroom Evaluation & Tripwire Transitions');
  {
    const now = 1000000;
    // Current headroom is 25%, but burn rate ~5%/min => projected in 5.58m is ~27.9% consumed => headroom <= 0%
    const history = [
      { t: now - 120000, value: 65 },
      { t: now - 60000, value: 70 },
      { t: now, value: 75 },
    ];
    const windowsExhausted = [
      {
        key: 'session_5h',
        utilizationPct: 75,
        remainingPct: 25,
        history,
      },
    ];

    const resExhausted = evaluateAccountTripwire('acc-1', 'claude', windowsExhausted, {}, now);
    assert(resExhausted.autoState === 'exhausted', 'trips to exhausted when projected headroom <= 5%');
    assert(resExhausted.targetWeight === 0, 'exhausted target weight is 0');
    assert(resExhausted.disabled === true, 'exhausted disabled flag is true');
    assert(resExhausted.projectedHeadroomPct <= 5, 'projected headroom <= 5%');

    // Current headroom 25%, burn rate ~2%/min => projected burn ~11.16% => projected headroom ~13.84% (<= 15% tight)
    const historyTight = [
      { t: now - 120000, value: 71 },
      { t: now - 60000, value: 73 },
      { t: now, value: 75 },
    ];
    const windowsTight = [
      {
        key: 'session_5h',
        utilizationPct: 75,
        remainingPct: 25,
        history: historyTight,
      },
    ];

    const resTight = evaluateAccountTripwire('acc-2', 'claude', windowsTight, {}, now);
    assert(resTight.autoState === 'tight', 'trips to tight when projected headroom <= 15% but > 5%');
    assert(resTight.targetWeight === 1, 'tight target weight is 1');
    assert(resTight.disabled === false, 'tight disabled flag is false');

    // Binding window check: rolling 5h vs weekly 7d
    const windowsMulti = [
      {
        key: 'session_5h',
        utilizationPct: 40,
        remainingPct: 60,
        history: [{ t: now - 60000, value: 39 }, { t: now, value: 40 }],
      },
      {
        key: 'weekly_7d',
        utilizationPct: 96,
        remainingPct: 4,
        history: [{ t: now - 60000, value: 95 }, { t: now, value: 96 }],
      },
    ];

    const resMulti = evaluateAccountTripwire('acc-3', 'claude', windowsMulti, {}, now);
    assert(resMulti.bindingWindow === 'weekly_7d', 'selects most constrained binding window');
    assert(resMulti.autoState === 'exhausted', 'trips to exhausted based on binding window');
  }

  console.log('\nSuite 3: Dual-Barrier Airgap Writes (Weight 0 AND Disabled True)');
  {
    const patches: any[] = [];
    const mockTransport: Partial<CpaTransport> = {
      patchCredentialDualBarrier: async (name, airgapped, weight) => {
        patches.push({ name, airgapped, weight });
        return { success: true } as any;
      },
      patchFields: async (fields) => {
        patches.push(fields);
        return { success: true } as any;
      },
    };

    await applyDualBarrier(mockTransport as CpaTransport, 'cred_exhausted', 'exhausted');
    assert(
      patches.length === 1 && patches[0].airgapped === true && patches[0].weight === 0,
      'writes weight 0 AND disabled true for exhausted'
    );

    patches.length = 0;
    await applyDualBarrier(mockTransport as CpaTransport, 'cred_airgapped', 'airgapped');
    assert(
      patches.length === 1 && patches[0].airgapped === true && patches[0].weight === 0,
      'writes weight 0 AND disabled true for airgapped'
    );

    patches.length = 0;
    await applyDualBarrier(mockTransport as CpaTransport, 'cred_quarantined', 'quarantined');
    assert(
      patches.length === 1 && patches[0].airgapped === true && patches[0].weight === 0,
      'writes weight 0 AND disabled true for quarantined'
    );

    patches.length = 0;
    await applyDualBarrier(mockTransport as CpaTransport, 'cred_healthy', 'healthy', 10);
    assert(
      patches.length === 1 && patches[0].airgapped === false && patches[0].weight === 10,
      'writes positive weight AND disabled false for healthy recovery'
    );
  }

  console.log('\nSuite 4: Reactive Circuit Breakers & Cooldown Lockout');
  {
    const cb = new CircuitBreakerRegistry();
    const now = 1000000;
    cb.recordError('acc-429', '429', now, 335000);
    assert(cb.isCooldownActive('acc-429', now + 1000), 'cooldown active immediately after 429');
    assert(cb.isCooldownActive('acc-429', now + 334999), 'cooldown active before 335s expires');
    assert(!cb.isCooldownActive('acc-429', now + 335001), 'cooldown clears after 335s expires');

    cb.recordError('acc-err', '429', now);
    cb.recordError('acc-err', '5xx', now);
    const errs = cb.getErrors15m('acc-err', now + 1000);
    assert(errs.http429 === 1, 'tracks 15m http 429 count');
    assert(errs.http5xx === 1, 'tracks 15m http 5xx count');
  }

  console.log('\nSuite 5: Fail-Closed Collective Quota Fallback');
  {
    const accounts = [
      {
        accountId: 'acc-1',
        provider: 'antigravity',
        currentHeadroomPct: 2,
        projectedHeadroomPct: 1,
        autoState: 'exhausted' as const,
        targetWeight: 0,
        disabled: true,
        isCooldown: true,
      },
      {
        accountId: 'acc-2',
        provider: 'antigravity',
        currentHeadroomPct: 4,
        projectedHeadroomPct: 3,
        autoState: 'exhausted' as const,
        targetWeight: 0,
        disabled: true,
        isCooldown: true,
      },
    ] as any[];

    const resSingle = applyFailClosedCollectiveFallback(accounts, { mode: 'single_tight' });
    assert(resSingle.fallbackActive === true, 'collective fallback engages when no healthy accounts exist');
    assert(resSingle.activeSingleAccountId === 'acc-2', 'picks highest-headroom account as single tight');

    const acc2 = resSingle.evaluations.find((a) => a.accountId === 'acc-2');
    const acc1 = resSingle.evaluations.find((a) => a.accountId === 'acc-1');
    assert(acc2?.autoState === 'tight' && acc2?.targetWeight === 1 && !acc2?.disabled, 'single tight account activated with weight 1');
    assert(acc1?.autoState === 'exhausted' && acc1?.targetWeight === 0 && acc1?.disabled, 'remaining accounts in pool airgapped');

    const resAirgap = applyFailClosedCollectiveFallback(accounts, { mode: 'airgap_pool' });
    assert(resAirgap.fallbackActive === true, 'airgap_pool fallback engages');
    assert(resAirgap.evaluations[0].targetWeight === 0 && resAirgap.evaluations[0].disabled, 'all accounts airgapped under airgap_pool mode');
  }

  console.log('\nSuite 6: Operator Manual Holds in SQLite Store');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const now = 1000000;
    const expiresAt = now + 86400 * 1000;

    store.setManualHold('acc-hold', 'quarantine', 'manual investigation', expiresAt, now);
    let hold = store.getManualHold('acc-hold', now);
    assert(hold !== null && hold.holdType === 'quarantine', 'persists operator manual hold in SQLite');

    assert(effectiveAccountState('quarantine', 'healthy') === 'quarantined', 'quarantine hold overrides healthy autoState');
    assert(effectiveAccountState('airgap', 'tight') === 'airgapped', 'airgap hold overrides tight autoState');
    assert(effectiveAccountState('none', 'tight') === 'tight', 'none hold releases back to tight autoState');

    hold = store.getManualHold('acc-hold', now + 86401 * 1000);
    assert(hold === null, 'manual hold automatically expires after TTL');

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nSuite 7: CpaWatermarkService Reactive 429 & Fleet Overview Telemetry');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    store.upsertAccount({
      id: 'acc-test',
      name: 'Test Account',
      providerType: 'claude',
      email: 'test@example.com',
      orderIndex: 0,
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    store.upsertCpaLink({
      accountId: 'acc-test',
      identityKey: 'claude:test@example.com',
      authIndex: 'auth-test',
      cpaName: 'claude-test',
      state: 'linked',
      lastSeenAt: 1000000,
    });

    const patches: any[] = [];
    const mockTransport: Partial<CpaTransport> = {
      patchCredentialDualBarrier: async (name, airgapped, weight) => {
        patches.push({ name, airgapped, weight });
        return { success: true } as any;
      },
      listCredentials: async () => ({
        files: [
          { name: 'claude-test', auth_index: 'auth-test', weight: 10, disabled: false, provider: 'claude' },
        ],
        observed_at: new Date().toISOString(),
      }),
      getRoutingStrategy: async () => 'weighted-round-robin',
    };

    class EnforcePolicyLoader extends CpaPolicyLoader {
      override getPolicy() {
        return { ...DEFAULT_WATERMARK_POLICY, mode: 'enforce' as const };
      }
    }

    const service = new CpaWatermarkService({
      store,
      transport: mockTransport as CpaTransport,
      policyLoader: new EnforcePolicyLoader(),
      now: () => 1000000,
    });

    await service.handleReactive429('acc-test');
    assert(
      patches.length === 1 && patches[0].name === 'claude-test' && patches[0].airgapped === true && patches[0].weight === 0,
      'reactive 429 fires immediate dual-barrier airgap write'
    );

    const overview = await service.getFleetOverview(1000000);
    assert(overview.accounts.length === 1, 'fleet overview returns accounts');
    assert(overview.accounts[0].state === 'exhausted', 'state is exhausted following 429');
    assert(overview.accounts[0].targetWeight === 0, 'targetWeight is 0');
    assert(overview.accounts[0].recentErrors15m.http429 === 1, 'recentErrors15m tracks 429');

    // Operator manual hold via service
    patches.length = 0;
    const holdRes = await service.setManualHold('acc-test', 'airgap', 'security lock', 3600);
    assert(holdRes.effectiveState === 'airgapped', 'service setManualHold returns effectiveState airgapped');
    assert(patches.length === 1 && patches[0].airgapped === true, 'setManualHold dispatches dual barrier write');

    const holdOverview = await service.getFleetOverview(1000000);
    assert(holdOverview.accounts[0].manualHold === 'airgap', 'fleet overview reflects manual hold');
    assert(holdOverview.accounts[0].state === 'airgapped', 'fleet overview reflects effective airgapped state');

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n======================================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
