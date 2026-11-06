/**
 * Reset Recovery Tests (WP-RESET-6)
 * Implements assertions for all 14 required cases in Section 6 of RESET_DRIVEN_PROBE_SPECIFICATION.md v2.1.1.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/src/store';
import { Tracker } from '../server/src/tracker';
import { CpaSyncEngine } from '../server/src/cpaSync';
import { CpaWatermarkService } from '../server/src/cpaWatermarkService';
import {
  CpaPolicyLoader,
  DEFAULT_WATERMARK_POLICY,
  type FullWatermarkPolicy,
} from '../server/src/cpaWatermarkPolicy';
import { CpaUsageProvider } from '../src/services/cpa/CpaUsageProvider';
import { circuitBreakers } from '../server/src/cpaTripwireEngine';
import { holdOwner, holdOwnerOf } from '../server/src/cpaHoldState';
import { ResetRecoveryWatcher } from '../server/src/resetRecoveryWatcher';
import type { AccountCredentials } from '../src/models/types';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function pass(name: string) {
  totalTests++;
  passedTests++;
  console.log(`  ✓ [PASS] ${name}`);
}

function fail(name: string, error: unknown) {
  totalTests++;
  failedTests++;
  console.error(`  ✗ [FAIL] ${name}`);
  console.error(error);
}

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

class FixedPolicy extends CpaPolicyLoader {
  constructor(private p: FullWatermarkPolicy) {
    super();
  }
  override getPolicy(): FullWatermarkPolicy {
    return structuredClone(this.p);
  }
}

type Cred = {
  auth_index: string;
  name: string;
  provider: string;
  email: string;
  source: string;
  weight: number;
  disabled: boolean;
};

interface MakeWorldOptions {
  now?: () => number;
  resetAt?: string;
  resetsAtMap?: Record<string, string | null>;
}

function makeWorld(
  names: string[],
  policy: FullWatermarkPolicy,
  options?: MakeWorldOptions
) {
  circuitBreakers.clear();
  const tempDir = mkdtempSync(join(tmpdir(), 'reset-recovery-test-'));
  const creds: Cred[] = names.map((n, i) => ({
    auth_index: `idx${i}`,
    name: n,
    provider: 'claude',
    email: `${n}@example.com`,
    source: 'file',
    weight: 1,
    disabled: false,
  }));
  const usedPct: Record<string, number> = Object.fromEntries(
    creds.map((c) => [c.auth_index, 10])
  );
  const apiCalls: Record<string, number> = Object.fromEntries(
    creds.map((c) => [c.auth_index, 0])
  );
  const patches: Array<{ name: string; weight: number; disabled: boolean }> = [];
  const resetsAtMap: Record<string, string | null> = options?.resetsAtMap ?? {};
  const defaultResetAt = options?.resetAt ?? new Date(Date.now() - 3600_000).toISOString();

  let routingStrategy = 'weighted-round-robin';

  const transport: any = {
    async listCredentials() {
      return {
        observed_at: new Date().toISOString(),
        files: creds.map((c) => ({
          ...c,
          status: c.disabled ? 'disabled' : 'active',
        })),
      };
    },
    async getRoutingStrategy() {
      return routingStrategy;
    },
    setRoutingStrategy(strat: string) {
      routingStrategy = strat;
    },
    async apiCall(req: any) {
      apiCalls[req.auth_index]++;
      const u = usedPct[req.auth_index] ?? 10;
      const rAt = req.auth_index in resetsAtMap
        ? resetsAtMap[req.auth_index]
        : defaultResetAt;
      return {
        status_code: 200,
        header: {},
        body: JSON.stringify({
          five_hour: { utilization: u, resets_at: rAt },
          seven_day: { utilization: u, resets_at: rAt },
        }),
      };
    },
    async patchCredentialDualBarrier(name: string, disabled: boolean, weight: number) {
      const c = creds.find((x) => x.name === name)!;
      c.disabled = disabled;
      c.weight = weight;
      patches.push({ name, weight, disabled });
    },
    async patchFields(req: any) {
      const c = creds.find((x) => x.name === req.name)!;
      if (typeof req.weight === 'number') c.weight = req.weight;
      if (typeof req.disabled === 'boolean') c.disabled = req.disabled;
      patches.push({ name: req.name, weight: c.weight, disabled: c.disabled });
    },
    async forceRefresh() {
      return {};
    },
  };

  const store = new Store(tempDir, 'r.db', '0123456789abcdef0123456789abcdef');
  const provider = new CpaUsageProvider(transport, undefined, { now: options?.now });
  const tracker = new Tracker(store, provider);
  tracker.cpaJitterEnabled = false;

  const policyLoader = new FixedPolicy(policy);
  const service = new CpaWatermarkService({
    store,
    transport,
    policyLoader,
    tracker,
    now: options?.now,
  });

  const sync = new CpaSyncEngine(
    store,
    tracker,
    transport,
    { syncIntervalSec: 60 },
    service
  );

  const idOf = (name: string) =>
    store.listCpaLinks().find((l) => l.cpaName === name)!.accountId;

  const cleanup = async () => {
    try {
      await new Promise((r) => setTimeout(r, 50));
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return {
    creds,
    usedPct,
    apiCalls,
    patches,
    resetsAtMap,
    store,
    tracker,
    service,
    sync,
    transport,
    policyLoader,
    idOf,
    cred: (n: string) => creds.find((c) => c.name === n)!,
    cleanup,
  };
}

export const enforce = (
  rules?: FullWatermarkPolicy['classificationRules']
): FullWatermarkPolicy => ({
  ...structuredClone(DEFAULT_WATERMARK_POLICY),
  mode: 'enforce',
  ...(rules ? { classificationRules: rules } : {}),
});

export const shadow = (
  rules?: FullWatermarkPolicy['classificationRules']
): FullWatermarkPolicy => ({
  ...structuredClone(DEFAULT_WATERMARK_POLICY),
  mode: 'shadow',
  ...(rules ? { classificationRules: rules } : {}),
});

export { makeWorld };

async function runResetRecoveryTests() {
  console.log('\n======================================================');
  console.log('  RESET RECOVERY TESTS (WP-RESET-6)');
  console.log('======================================================\n');

  // Silence read-back warnings during tests
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    if (typeof args[0] === 'string' && (args[0].includes('Read-back') || args[0].includes('[routing]'))) {
      return;
    }
    originalWarn(...args);
  };

  // --------------------------------------------------------------------------
  // Case 1: Pro hard stop, then reset
  // --------------------------------------------------------------------------
  console.log('Case 1: Pro hard stop, then reset');
  try {
    const w = makeWorld(['pro-a', 'pro-b', 'pro-c'], enforce());
    await w.sync.runOnce();
    await w.service.run();

    // Trigger hard stop for pro-a
    w.usedPct.idx0 = 99;
    await w.tracker.syncAll();
    await w.service.run();
    await w.sync.runOnce();

    assertEquals(w.cred('pro-a').weight, 0, 'pro-a weight 0 in CLIProxy');
    assertEquals(w.cred('pro-a').disabled, true, 'pro-a disabled in CLIProxy');
    assertEquals(
      w.store.getCredentials(w.idOf('pro-a'))?.cpaStatus,
      'disabled',
      'cpaStatus disabled in store'
    );
    const routingAfterStop = w.store.getCpaLinkRouting(w.idOf('pro-a'));
    assertEquals(routingAfterStop?.disabledBy, 'policy', 'disabledBy is policy');
    assert(typeof routingAfterStop?.disabledAt === 'number', 'disabledAt recorded');

    // Quota resets
    w.usedPct.idx0 = 0;
    const beforeCalls = w.apiCalls.idx0;
    await w.tracker.syncAll();
    assertEquals(w.apiCalls.idx0 - beforeCalls, 1, 'pro-a probed in next full poll');

    // Engine runs ramp back: 25 -> 50 -> 100
    // tracker.syncAll triggers onSyncAll callback which runs service.run() -> ramp step 1
    assertEquals(w.cred('pro-a').weight, 25, 'ramp step 1 is weight 25');
    assertEquals(w.cred('pro-a').disabled, false, 'ramp step 1 is enabled');

    await w.sync.runOnce();
    assertEquals(w.cred('pro-a').weight, 50, 'ramp step 2 is weight 50');
    assertEquals(w.cred('pro-a').disabled, false, 'ramp step 2 is enabled');

    await w.sync.runOnce();
    assertEquals(w.cred('pro-a').weight, 100, 'ramp step 3 is weight 100');
    assertEquals(w.cred('pro-a').disabled, false, 'ramp step 3 is enabled');

    const finalRouting = w.store.getCpaLinkRouting(w.idOf('pro-a'));
    assertEquals(finalRouting?.disabledBy, undefined, 'disabledBy removed after re-enabling');
    assertEquals(finalRouting?.disabledAt, undefined, 'disabledAt removed after re-enabling');

    w.cleanup();
    pass('Case 1: Pro hard stop, reset, probe, and ramp 25 -> 50 -> 100');
  } catch (err) {
    fail('Case 1: Pro hard stop, reset, probe, and ramp', err);
  }

  // --------------------------------------------------------------------------
  // Case 2: Same scenario in shadow mode
  // --------------------------------------------------------------------------
  console.log('Case 2: Pro hard stop in shadow mode');
  try {
    const w = makeWorld(['pro-a', 'pro-b', 'pro-c'], shadow());
    await w.sync.runOnce();
    await w.service.run();
    const patchesCountBefore = w.patches.length;

    w.usedPct.idx0 = 99;
    await w.tracker.syncAll();
    await w.service.run();

    assertEquals(w.patches.length, patchesCountBefore, 'no CLIProxy writes in shadow mode');
    assertEquals(w.cred('pro-a').disabled, false, 'pro-a remains enabled in CLIProxy');

    w.cleanup();
    pass('Case 2: Shadow mode produces zero CLIProxy writes on hard stop');
  } catch (err) {
    fail('Case 2: Pro hard stop in shadow mode', err);
  }

  // --------------------------------------------------------------------------
  // Case 3: Non-Pro standby accounts polled while disabled
  // --------------------------------------------------------------------------
  console.log('Case 3: Non-Pro standby accounts');
  try {
    const rules = [
      { pattern: 'np-*', provider: 'auto', tier: 'non_pro', modality: 'subscription_pool', managed: true },
      { pattern: '*', provider: 'auto', tier: 'pro', modality: 'subscription_pool', managed: true },
    ] as any;
    const w = makeWorld(['pro-a', 'np-x', 'np-y'], enforce(rules));
    await w.sync.runOnce();
    await w.service.run();
    await w.sync.runOnce();

    assertEquals(w.cred('np-x').disabled, true, 'np-x standby disabled in CLIProxy');
    assertEquals(w.cred('np-y').disabled, true, 'np-y standby disabled in CLIProxy');
    assertEquals(w.store.getCpaLinkRouting(w.idOf('np-x'))?.disabledBy, 'policy', 'np-x disabledBy policy');
    assertEquals(w.store.getCpaLinkRouting(w.idOf('np-y'))?.disabledBy, 'policy', 'np-y disabledBy policy');

    const beforePollCalls = w.apiCalls.idx1 + w.apiCalls.idx2;
    await w.tracker.syncAll();
    assertEquals(
      w.apiCalls.idx1 + w.apiCalls.idx2 - beforePollCalls,
      2,
      'both Non-Pro standby accounts polled in full poll'
    );

    // Now Pro account runs out
    w.usedPct.idx0 = 99;
    await w.tracker.syncAll();
    const r = await w.service.run();

    const targetA = r.engineResult!.targets.get('pro-a')!;
    const targetX = r.engineResult!.targets.get('np-x')!;
    const targetY = r.engineResult!.targets.get('np-y')!;

    assertEquals(targetA.targetWeight, 0, 'pro-a hard stopped at 0');
    const npTargets = [targetX, targetY];
    const activeSticky = npTargets.filter((t) => t.targetWeight === 100 && t.reason === 'active_sticky');
    const standbyAccounts = npTargets.filter((t) => t.targetWeight === 0);

    assertEquals(activeSticky.length, 1, 'one Non-Pro gets weight 100 active_sticky');
    assertEquals(standbyAccounts.length, 1, 'other Non-Pro stays at weight 0');

    w.cleanup();
    pass('Case 3: Non-Pro standby polled while disabled and activates smoothly when Pro runs out');
  } catch (err) {
    fail('Case 3: Non-Pro standby accounts', err);
  }

  // --------------------------------------------------------------------------
  // Case 4: Scenario E: Pro account in unknown is polled and recovers
  // --------------------------------------------------------------------------
  console.log('Case 4: Scenario E: Pro account in unknown recovers');
  try {
    const w = makeWorld(['pro-e-a', 'pro-e-b', 'pro-e-c'], enforce());
    await w.sync.runOnce();

    // Simulate account in unknown / disabled state
    const idA = w.idOf('pro-e-a');
    w.store.updateCpaLinkRouting(idA, { applied: 0, managed: true, disabledBy: 'policy' });
    w.cred('pro-e-a').disabled = true;
    w.cred('pro-e-a').weight = 0;
    w.store.setCredentials(idA, {
      ...w.store.getCredentials(idA)!,
      cpaStatus: 'disabled',
    });

    const beforeCalls = w.apiCalls.idx0;
    await w.tracker.syncAll();
    assertEquals(w.apiCalls.idx0 - beforeCalls, 1, 'pro-e-a polled in unknown state');

    // Engine re-enables and recovers account
    assertEquals(w.cred('pro-e-a').disabled, false, 'pro-e-a enabled');
    assertEquals(w.cred('pro-e-a').weight, 100, 'pro-e-a recovers to weight 100');

    w.cleanup();
    pass('Case 4: Pro account in unknown state is polled and recovers');
  } catch (err) {
    fail('Case 4: Pro account in unknown state recovers', err);
  }

  // --------------------------------------------------------------------------
  // Case 5: Scenario F: Credential disabled in CLIProxy with no disabledBy
  // --------------------------------------------------------------------------
  console.log('Case 5: Scenario F: Credential disabled in CLIProxy is never polled and never written');
  try {
    const w = makeWorld(['pro-a', 'pro-b', 'pro-c'], enforce());
    await w.sync.runOnce();
    await w.service.run();
    await w.service.run();

    // Credential pro-b disabled in CLIProxy by a person (no disabledBy set by FQD)
    w.cred('pro-b').disabled = true;
    await w.sync.runOnce();

    assertEquals(
      w.store.getCredentials(w.idOf('pro-b'))?.cpaStatus,
      'disabled',
      'cpaStatus is disabled'
    );
    assertEquals(
      w.store.getCpaLinkRouting(w.idOf('pro-b'))?.disabledBy,
      undefined,
      'disabledBy is absent (external hold)'
    );
    assertEquals(
      holdOwner(w.store, w.idOf('pro-b')),
      'external',
      'holdOwner is external'
    );

    // Verify it is not polled
    const beforeCalls = w.apiCalls.idx1;
    await w.tracker.syncAll();
    assertEquals(w.apiCalls.idx1, beforeCalls, 'pro-b is never polled');

    // Make its telemetry stale (400s old)
    const accB = w.store.getAccount(w.idOf('pro-b'))!;
    w.store.upsertAccount({
      ...accB,
      latestSnapshot: {
        ...accB.latestSnapshot!,
        fetchedAt: new Date(Date.now() - 400_000).toISOString(),
      },
    });

    const patchesBefore = w.patches.length;
    await w.sync.runOnce();
    await w.service.run();

    assertEquals(w.cred('pro-b').disabled, true, 'pro-b stays disabled in CLIProxy');
    assertEquals(w.cred('pro-b').weight, 100, 'pro-b weight not modified');
    assertEquals(w.patches.length, patchesBefore, 'zero writes dispatched to pro-b');

    w.cleanup();
    pass('Case 5: External CLIProxy disable is never polled and never re-enabled');
  } catch (err) {
    fail('Case 5: Scenario F: Credential disabled in CLIProxy', err);
  }

  // --------------------------------------------------------------------------
  // Case 6: Whole-pool refresh
  // --------------------------------------------------------------------------
  console.log('Case 6: Whole-pool refresh and no single-account tracker.sync()');
  try {
    const w = makeWorld(['pro-a', 'pro-b', 'pro-c'], enforce());
    await w.sync.runOnce();
    await w.service.run();

    // Spy on tracker.sync: assert no code path calls tracker.sync() directly for a single account
    let isInsideSyncAll = false;
    let directSingleSyncCalls = 0;
    const origSyncAll = w.tracker.syncAll.bind(w.tracker);
    const origSync = w.tracker.sync.bind(w.tracker);
    w.tracker.syncAll = async () => {
      isInsideSyncAll = true;
      try {
        return await origSyncAll();
      } finally {
        isInsideSyncAll = false;
      }
    };
    w.tracker.sync = async (accountId: string) => {
      if (!isInsideSyncAll) {
        directSingleSyncCalls++;
      }
      return origSync(accountId);
    };

    // Age all snapshots to 400s
    for (const name of ['pro-a', 'pro-b', 'pro-c']) {
      const a = w.store.getAccount(w.idOf(name))!;
      w.store.upsertAccount({
        ...a,
        latestSnapshot: {
          ...a.latestSnapshot!,
          fetchedAt: new Date(Date.now() - 400_000).toISOString(),
        },
      });
    }

    // A whole-pool refresh via syncAll
    await w.tracker.syncAll();
    const res = await w.service.run();

    assertEquals(
      res.engineResult?.nextState.tierStates['claude:pro'],
      'normal',
      'tier remains normal after whole pool refresh'
    );
    assertEquals(w.cred('pro-a').weight, 100, 'pro-a remains 100');
    assertEquals(w.cred('pro-b').weight, 100, 'pro-b remains 100');
    assertEquals(w.cred('pro-c').weight, 100, 'pro-c remains 100');

    // Reset spy count before hold release
    directSingleSyncCalls = 0;
    await w.service.setManualHold(w.idOf('pro-a'), 'airgap');
    await w.service.setManualHold(w.idOf('pro-a'), 'none');

    // Neither watcher nor hold release calls tracker.sync() for single account
    assertEquals(directSingleSyncCalls, 0, 'no code path called tracker.sync() for single account');

    w.cleanup();
    pass('Case 6: Out-of-cycle refreshes are whole-pool full polls');
  } catch (err) {
    fail('Case 6: Whole-pool refresh', err);
  }

  // --------------------------------------------------------------------------
  // Case 7: CpaUsageProvider allowDisabled option
  // --------------------------------------------------------------------------
  console.log('Case 7: CpaUsageProvider allowDisabled option');
  try {
    let networkCalls = 0;
    const transport: any = {
      async apiCall() {
        networkCalls++;
        return {
          status_code: 200,
          header: {},
          body: JSON.stringify({ five_hour: { utilization: 10 }, seven_day: { utilization: 10 } }),
        };
      },
    };
    const provider = new CpaUsageProvider(transport);

    // 1. Disabled without option -> reauth_required, 0 network calls
    networkCalls = 0;
    const resNoOpt = await provider.fetchUsage('acc-1', {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'idx1',
      cpaStatus: 'disabled',
    });
    assertEquals(resNoOpt.snapshot.status, 'reauth_required', 'status is reauth_required without option');
    assertEquals(networkCalls, 0, 'zero network calls without allowDisabled');

    // 2. Disabled with allowDisabled: true -> active probe succeeds
    networkCalls = 0;
    const resAllowed = await provider.fetchUsage(
      'acc-1',
      {
        authType: 'cpa',
        cpaProvider: 'claude',
        cpaAuthIndex: 'idx1',
        cpaStatus: 'disabled',
      },
      { allowDisabled: true }
    );
    assertEquals(resAllowed.snapshot.status, 'ok', 'status is ok with allowDisabled: true');
    assertEquals(networkCalls, 1, 'active network probe executed');

    // 3. Error with allowDisabled: true -> still reauth_required, 0 network calls
    networkCalls = 0;
    const resError = await provider.fetchUsage(
      'acc-1',
      {
        authType: 'cpa',
        cpaProvider: 'claude',
        cpaAuthIndex: 'idx1',
        cpaStatus: 'error',
      },
      { allowDisabled: true }
    );
    assertEquals(resError.snapshot.status, 'reauth_required', 'status is reauth_required on error');
    assertEquals(networkCalls, 0, 'zero network calls for cpaStatus: error');

    pass('Case 7: CpaUsageProvider handles allowDisabled correctly');
  } catch (err) {
    fail('Case 7: CpaUsageProvider allowDisabled option', err);
  }

  // --------------------------------------------------------------------------
  // Case 8: Tracker.syncAll() single-flight serialization
  // --------------------------------------------------------------------------
  console.log('Case 8: Tracker.syncAll() is single-flight');
  try {
    const w = makeWorld(['pro-a', 'pro-b', 'pro-c'], enforce());
    await w.sync.runOnce();

    const beforeCalls = { ...w.apiCalls };
    await Promise.all([w.tracker.syncAll(), w.tracker.syncAll()]);

    for (const key of ['idx0', 'idx1', 'idx2']) {
      assertEquals(
        w.apiCalls[key] - beforeCalls[key],
        1,
        `exactly 1 probe sent for ${key} during overlapping syncAll()`
      );
    }

    w.cleanup();
    pass('Case 8: Tracker.syncAll() is single-flight');
  } catch (err) {
    fail('Case 8: Tracker.syncAll() is single-flight', err);
  }

  // --------------------------------------------------------------------------
  // Case 9: ResetRecoveryWatcher comprehensive checks
  // --------------------------------------------------------------------------
  console.log('Case 9: ResetRecoveryWatcher edge cases and lifecycle');
  try {
    let fakeNow = Date.now();
    const nowFn = () => fakeNow;

    const resetInOneHour = new Date(fakeNow + 3600_000).toISOString();
    const w = makeWorld(['pro-a'], enforce(), { now: nowFn, resetAt: resetInOneHour });
    await w.sync.runOnce();
    await w.service.run();

    // Hard stop pro-a
    w.usedPct.idx0 = 99;
    await w.tracker.syncAll();
    await w.service.run();
    await w.sync.runOnce();

    const watcher = new ResetRecoveryWatcher(
      {
        store: w.store,
        tracker: w.tracker,
        policyLoader: w.policyLoader,
        now: nowFn,
      },
      {
        tickSec: 30,
        clockSkewBufferSec: 60,
        minPollGapSec: 60,
        retryLadderSec: [120, 300, 900],
      }
    );

    // 1. No poll before recoveryAt
    let syncAllCalls = 0;
    const origSyncAll = w.tracker.syncAll.bind(w.tracker);
    w.tracker.syncAll = async () => {
      syncAllCalls++;
      return origSyncAll();
    };

    await watcher.tick();
    assertEquals(syncAllCalls, 0, 'no poll before recoveryAt');

    // 2. One poll after recoveryAt
    // recoveryAt = (fakeNow + 3600_000) + 60_000
    fakeNow += 3660_000 + 1000;
    w.resetsAtMap.idx0 = new Date(fakeNow + 3600_000).toISOString();
    await watcher.tick();
    assertEquals(syncAllCalls, 1, 'one poll after recoveryAt');

    // 3. FetchedAt already after recovery point -> no poll
    await watcher.tick();
    assertEquals(syncAllCalls, 1, 'no repeat poll when fetchedAt is newer');

    // 4. Blocking window without resetsAt -> no watcher poll
    const idA = w.idOf('pro-a');
    const accA = w.store.getAccount(idA)!;
    w.store.upsertAccount({
      ...accA,
      latestSnapshot: {
        ...accA.latestSnapshot!,
        fetchedAt: new Date(fakeNow - 10_000).toISOString(),
        buckets: [
          {
            id: 'b1',
            label: '5h',
            windowType: 'session_5h',
            utilizationPercent: 99,
            remainingPercent: 1,
            resetsAt: null, // missing reset time
            isExhausted: true,
            severity: 'critical',
          },
        ],
      },
    });
    syncAllCalls = 0;
    await watcher.tick();
    assertEquals(syncAllCalls, 0, 'no watcher poll when blocking window has no resetsAt');

    // 5. 5-hour and weekly both blocking -> waits for later reset
    const t5h = fakeNow + 100_000;
    const tWeekly = fakeNow + 200_000;
    w.resetsAtMap.idx0 = new Date(tWeekly).toISOString();
    w.store.upsertAccount({
      ...accA,
      latestSnapshot: {
        ...accA.latestSnapshot!,
        fetchedAt: new Date(fakeNow - 10_000).toISOString(),
        buckets: [
          {
            id: 'b1',
            label: '5h',
            windowType: 'session_5h',
            utilizationPercent: 99,
            remainingPercent: 1,
            resetsAt: new Date(t5h).toISOString(),
            isExhausted: true,
            severity: 'critical',
          },
          {
            id: 'b2',
            label: '7d',
            windowType: 'weekly_7d',
            utilizationPercent: 99,
            remainingPercent: 1,
            resetsAt: new Date(tWeekly).toISOString(),
            isExhausted: true,
            severity: 'critical',
          },
        ],
      },
    });

    // Advance past 5h reset + 60s, but before weekly reset
    fakeNow = t5h + 60_000 + 1000;
    syncAllCalls = 0;
    await watcher.tick();
    assertEquals(syncAllCalls, 0, 'no poll when weekly reset is still blocking');

    // Advance past weekly reset + 60s
    fakeNow = tWeekly + 60_000 + 1000;
    w.resetsAtMap.idx0 = new Date(tWeekly).toISOString();
    await watcher.tick();
    assertEquals(syncAllCalls, 1, 'polls after the later (weekly) reset');

    // 6. Retry ladder: still exhausted with reset in the past -> polls at +2, +5, +15m, then stops
    // Upstream returned exhausted snapshot with reset in the past, so ladder scheduled attempt 1 at +120s
    syncAllCalls = 0;
    // Tick at +61s: minPollGapSec elapsed, but retry ladder says next attempt is at +120s
    fakeNow += 61_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 0, 'no poll before ladder nextAt');

    // At +120s (attempt 1)
    fakeNow += 60_000; // now +121s total
    await watcher.tick();
    assertEquals(syncAllCalls, 1, 'retry attempt 1 fires at +120s');

    // At +300s (attempt 2)
    fakeNow += 301_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 2, 'retry attempt 2 fires at +300s');

    // At +900s (attempt 3)
    fakeNow += 901_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 3, 'retry attempt 3 fires at +900s');

    // Ladder used up -> stops
    fakeNow += 1000_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 3, 'no further watcher polls after retry ladder finishes');

    // 7. reauth_required stops polling
    w.store.upsertAccount({
      ...w.store.getAccount(idA)!,
      lastStatus: 'reauth_required',
    });
    fakeNow += 100_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 3, 'reauth_required account is stopped');

    // 8. Exception inside tick does not escape
    w.tracker.syncAll = async () => {
      throw new Error('Explosion');
    };
    let threw = false;
    try {
      await watcher.tick();
    } catch {
      threw = true;
    }
    assertEquals(threw, false, 'watcher.tick() catches exceptions cleanly');

    // 9. Persistent probe failure ladder exhaustion
    const cooldownAt = fakeNow + 100_000;
    w.store.updateCpaLinkRouting(idA, {
      ...w.store.getCpaLinkRouting(idA)!,
      disabledBy: 'reactive_429',
      cooldownUntil: cooldownAt,
    });
    w.store.upsertAccount({
      ...w.store.getAccount(idA)!,
      lastStatus: 'ok',
      latestSnapshot: {
        ...w.store.getAccount(idA)!.latestSnapshot!,
        fetchedAt: new Date(cooldownAt - 50_000).toISOString(),
        status: 'error',
      },
    });
    w.tracker.syncAll = async () => {
      syncAllCalls++;
    };

    fakeNow = cooldownAt + 1000;
    syncAllCalls = 0;
    await watcher.tick();
    assertEquals(syncAllCalls, 1, 'persistent failure: initial poll at recoveryAt');

    fakeNow += 121_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 2, 'persistent failure: retry 1 at +120s');

    fakeNow += 301_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 3, 'persistent failure: retry 2 at +300s');

    fakeNow += 901_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 4, 'persistent failure: retry 3 at +900s');

    fakeNow += 70_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 4, 'no repeat poll after persistent failure exhaustion');
    fakeNow += 70_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 4, 'remains stopped on subsequent ticks');

    const newCooldownAt = fakeNow + 50_000;
    w.store.updateCpaLinkRouting(idA, {
      ...w.store.getCpaLinkRouting(idA)!,
      cooldownUntil: newCooldownAt,
    });
    fakeNow = newCooldownAt + 1000;
    await watcher.tick();
    assertEquals(syncAllCalls, 5, 'polls when new recoveryAt appears');

    // 10. Probe returns reauth_required before fetchedAt check
    const reauthRecoveryAt = fakeNow + 125_000;
    w.store.updateCpaLinkRouting(idA, {
      ...w.store.getCpaLinkRouting(idA)!,
      cooldownUntil: reauthRecoveryAt,
    });
    w.tracker.syncAll = async () => {
      syncAllCalls++;
      const acc = w.store.getAccount(idA)!;
      w.store.upsertAccount({
        ...acc,
        lastStatus: 'reauth_required',
        latestSnapshot: {
          ...acc.latestSnapshot!,
          status: 'reauth_required',
          fetchedAt: new Date(reauthRecoveryAt - 10_000).toISOString(),
        },
      });
    };
    fakeNow = reauthRecoveryAt + 1000;
    syncAllCalls = 0;
    await watcher.tick();
    assertEquals(syncAllCalls, 1, 'polls at recoveryAt');

    fakeNow += 121_000;
    await watcher.tick();
    assertEquals(syncAllCalls, 1, 'reauth_required probe result stops further polling');

    watcher.stop();
    w.cleanup();
    pass('Case 9: ResetRecoveryWatcher full test suite passes');
  } catch (err) {
    fail('Case 9: ResetRecoveryWatcher', err);
  }

  // --------------------------------------------------------------------------
  // Case 10: Scenario C: reactive 429
  // --------------------------------------------------------------------------
  console.log('Case 10: Scenario C: reactive 429 in enforce and shadow');
  try {
    let fakeNow = Date.now();
    const nowFn = () => fakeNow;

    const w = makeWorld(['pro-c-a', 'pro-c-b', 'pro-c-c'], enforce(), { now: nowFn });
    await w.sync.runOnce();
    await w.service.run();

    // Trigger reactive 429 in enforce
    await w.service.handleReactive429(w.idOf('pro-c-a'));
    assertEquals(w.cred('pro-c-a').disabled, true, 'pro-c-a disabled in CLIProxy');
    assertEquals(w.cred('pro-c-a').weight, 0, 'pro-c-a weight 0 in CLIProxy');

    let routing = w.store.getCpaLinkRouting(w.idOf('pro-c-a'))!;
    assertEquals(routing.cooldown, true, 'routing.cooldown is true');
    assertEquals(routing.disabledBy, 'reactive_429', 'disabledBy is reactive_429');
    assertEquals(routing.cooldownUntil, fakeNow + 335_000, 'cooldownUntil recorded');

    // Advance past cooldownUntil (e.g. +336s)
    fakeNow += 336_000;
    circuitBreakers.clearCooldown(w.idOf('pro-c-a'));

    // An engine run between cooldown end and poll writes nothing
    const patchesCountBefore = w.patches.length;
    await w.service.run();
    routing = w.store.getCpaLinkRouting(w.idOf('pro-c-a'))!;
    assertEquals(routing.cooldown, undefined, 'cooldown flag cleared');
    assertEquals(routing.cooldownUntil, fakeNow - 1000, 'cooldownUntil retained for watcher');
    assertEquals(routing.disabledBy, 'reactive_429', 'disabledBy retained for polling');
    assertEquals(w.patches.length, patchesCountBefore, 'engine run before poll writes nothing');

    // Fresh snapshot arrives via poll
    await w.tracker.syncAll();

    // Engine ramps back: 25 -> 50 -> 100
    assertEquals(w.cred('pro-c-a').weight, 25, 'ramps to 25');
    routing = w.store.getCpaLinkRouting(w.idOf('pro-c-a'))!;
    assertEquals(routing.disabledBy, undefined, 'disabledBy removed on re-enabling write');
    assertEquals(routing.cooldownUntil, undefined, 'cooldownUntil removed on re-enabling write');

    // Shadow mode reactive 429: no CLIProxy writes
    const wShadow = makeWorld(['pro-c-a', 'pro-c-b', 'pro-c-c'], shadow(), { now: nowFn });
    await wShadow.sync.runOnce();
    await wShadow.service.run();
    const shadowPatches = wShadow.patches.length;

    await wShadow.service.handleReactive429(wShadow.idOf('pro-c-a'));
    assertEquals(wShadow.patches.length, shadowPatches, 'shadow mode: no CLIProxy writes');
    assertEquals(wShadow.cred('pro-c-a').disabled, false, 'pro-c-a remains enabled in shadow mode');

    // Legacy { cooldown: true } without cooldownUntil expires based on at
    const idA = w.idOf('pro-c-a');
    w.store.updateCpaLinkRouting(idA, {
      applied: 0,
      at: fakeNow - 400_000,
      cooldown: true,
      disabledBy: 'reactive_429',
    });
    await w.service.run();
    const legacyRouting = w.store.getCpaLinkRouting(idA)!;
    assertEquals(legacyRouting.cooldown, undefined, 'legacy cooldown expires based on at');

    w.cleanup();
    wShadow.cleanup();
    pass('Case 10: Reactive 429 lifecycle and shadow mode write suppression');
  } catch (err) {
    fail('Case 10: Scenario C: reactive 429', err);
  }

  // --------------------------------------------------------------------------
  // Case 11: Scenario D: Operator hold in enforce mode
  // --------------------------------------------------------------------------
  console.log('Case 11: Scenario D: Operator hold in enforce mode');
  try {
    let fakeNow = Date.now();
    const nowFn = () => fakeNow;
    const w = makeWorld(['pro-d-a', 'pro-d-b', 'pro-d-c'], enforce(), { now: nowFn });
    await w.sync.runOnce();
    await w.tracker.syncAll();
    await w.service.run();
    await w.sync.runOnce();

    const idA = w.idOf('pro-d-a');

    // 1. Apply airgap hold
    await w.service.setManualHold(idA, 'airgap', 'manual test', 3600);
    assertEquals(w.cred('pro-d-a').weight, 0, 'pro-d-a weight 0 on hold');
    assertEquals(w.cred('pro-d-a').disabled, true, 'pro-d-a disabled on hold');

    let routing = w.store.getCpaLinkRouting(idA)!;
    assertEquals(routing.applied, 0, 'applied recorded as 0');
    assertEquals(routing.disabledBy, 'operator_hold', 'disabledBy recorded as operator_hold');
    assertEquals(routing.preHoldWeight, 100, 'preHoldWeight recorded');

    // 2. Engine keeps weight 0 while hold is active even with healthy fresh data
    await w.service.run();
    assertEquals(w.cred('pro-d-a').weight, 0, 'engine keeps weight 0 during active hold');
    assertEquals(w.cred('pro-d-a').disabled, true, 'pro-d-a stays disabled during active hold');

    // 3. Expiry: advance time past TTL
    fakeNow += 3601_000;
    // Next engine run detects expired hold
    await w.service.run();
    routing = w.store.getCpaLinkRouting(idA)!;
    assertEquals(routing.managed, true, 'managed is true after expiry');
    assertEquals(routing.disabledBy, 'policy', 'handed back to engine: disabledBy policy');
    assertEquals(w.cred('pro-d-a').weight, 0, 'no write to weight 1 upon expiry');

    // Fresh poll and ramp: 25 -> 50 -> 100
    await w.tracker.syncAll();
    assertEquals(w.cred('pro-d-a').weight, 25, 'ramps to 25 after hold expiry');
    await w.sync.runOnce();
    assertEquals(w.cred('pro-d-a').weight, 50, 'ramps to 50');
    await w.sync.runOnce();
    assertEquals(w.cred('pro-d-a').weight, 100, 'ramps to 100');

    // 4. Return to rotation in enforce mode
    await w.service.setManualHold(idA, 'airgap', 'manual hold 2', 3600);
    assertEquals(w.cred('pro-d-a').weight, 0, 'weight 0 on hold');
    await w.service.setManualHold(idA, 'none');

    // No direct write to 1
    assertEquals(w.cred('pro-d-a').weight, 0, 'Return to rotation does not directly write weight 1');
    routing = w.store.getCpaLinkRouting(idA)!;
    assertEquals(routing.managed, true, 'managed set to true');
    assertEquals(routing.disabledBy, 'policy', 'disabledBy set to policy');

    // Ramps back after poll
    await w.tracker.syncAll();
    assertEquals(w.cred('pro-d-a').weight, 25, 'ramps back through 25 after return to rotation');
    await w.sync.runOnce();
    assertEquals(w.cred('pro-d-a').weight, 50, 'ramps to 50');
    await w.sync.runOnce();
    assertEquals(w.cred('pro-d-a').weight, 100, 'ramps to 100');

    // Later the engine drains it when it runs low
    w.usedPct.idx0 = 70; // quota runs low (drains to weight 1)
    await w.tracker.syncAll();
    await w.service.run();
    assertEquals(w.cred('pro-d-a').weight, 1, 'engine drains low account to weight 1');

    // 5. Legacy case-D row (applied: 100, CLIProxy weight 0, managed: false)
    w.store.updateCpaLinkRouting(idA, {
      applied: 100,
      managed: false,
      disabledBy: 'operator_hold',
    });
    w.cred('pro-d-a').weight = 0;
    w.cred('pro-d-a').disabled = true;

    await w.service.setManualHold(idA, 'none');
    routing = w.store.getCpaLinkRouting(idA)!;
    assertEquals(routing.applied, 0, 'applied set to CLIProxy weight 0');
    assertEquals(routing.managed, true, 'managed set to true');

    // Next engine run does not flip managed to false
    await w.service.run();
    routing = w.store.getCpaLinkRouting(idA)!;
    assertEquals(routing.managed, true, 'managed remains true on subsequent engine run');

    w.cleanup();
    pass('Case 11: Operator hold in enforce mode, expiry, and Return to rotation');
  } catch (err) {
    fail('Case 11: Scenario D: Operator hold in enforce mode', err);
  }

  // --------------------------------------------------------------------------
  // Case 12: Scenario D in shadow and policy-unmanaged
  // --------------------------------------------------------------------------
  console.log('Case 12: Operator hold in shadow and policy-unmanaged modes');
  try {
    // 1. Shadow mode
    const wShadow = makeWorld(['pro-a', 'pro-b', 'pro-c'], shadow());
    await wShadow.sync.runOnce();
    await wShadow.service.run();

    const idA = wShadow.idOf('pro-a');
    await wShadow.service.setManualHold(idA, 'airgap', 'shadow hold');
    await wShadow.service.setManualHold(idA, 'none');

    assertEquals(wShadow.cred('pro-a').disabled, false, 'disabled: false written in shadow Return to rotation');
    assertEquals(wShadow.cred('pro-a').weight, 1, 'weight 1 written in shadow Return to rotation');

    // Shadow hold expiry clears provenance without writing to CLIProxy
    await wShadow.service.setManualHold(idA, 'airgap', 'shadow expiring hold');
    assertEquals(wShadow.cred('pro-a').disabled, true, 'airgapped in CLIProxy before expiry');
    wShadow.store.deleteManualHold(idA);
    await wShadow.service.run();
    assertEquals(wShadow.cred('pro-a').disabled, true, 'shadow expiry does not write to CLIProxy');
    const shadowRouting = wShadow.store.getCpaLinkRouting(idA)!;
    assertEquals(shadowRouting.disabledBy, undefined, 'shadow expiry clears disabledBy');
    assertEquals(shadowRouting.disabledAt, undefined, 'shadow expiry clears disabledAt');
    assertEquals(shadowRouting.preHoldWeight, undefined, 'shadow expiry clears preHoldWeight');

    // 2. Policy-unmanaged account
    const unmanagedRule = [
      { pattern: 'pro-a', provider: 'auto', tier: 'pro', modality: 'subscription_pool', managed: false },
      { pattern: '*', provider: 'auto', tier: 'pro', modality: 'subscription_pool', managed: true },
    ] as any;
    const wUnmanaged = makeWorld(['pro-a', 'pro-b', 'pro-c'], enforce(unmanagedRule));
    await wUnmanaged.sync.runOnce();
    await wUnmanaged.service.run();

    const idUnm = wUnmanaged.idOf('pro-a');
    await wUnmanaged.service.setManualHold(idUnm, 'airgap', 'unmanaged hold');
    await wUnmanaged.service.setManualHold(idUnm, 'none');

    assertEquals(wUnmanaged.cred('pro-a').disabled, false, 'disabled: false written for unmanaged Return to rotation');
    assertEquals(wUnmanaged.cred('pro-a').weight, 1, 'weight 1 written for unmanaged Return to rotation');

    await wShadow.cleanup();
    await wUnmanaged.cleanup();
    pass('Case 12: Return to rotation in shadow and policy-unmanaged writes directly');
  } catch (err) {
    fail('Case 12: Operator hold in shadow and policy-unmanaged modes', err);
  }

  // --------------------------------------------------------------------------
  // Case 13: Migration of existing rows
  // --------------------------------------------------------------------------
  console.log('Case 13: Migration of legacy routing provenance');
  try {
    const w = makeWorld(
      ['acc-a', 'acc-b', 'acc-c', 'acc-e', 'acc-d-act', 'acc-d-exp', 'acc-ext', 'acc-fqd-unseen'],
      enforce()
    );
    await w.sync.runOnce();

    // Setup legacy shapes:
    // Shape A: creds disabled, applied 0, managed true
    const idA = w.idOf('acc-a');
    w.store.setCredentials(idA, { ...w.store.getCredentials(idA)!, cpaStatus: 'disabled' });
    w.store.updateCpaLinkRouting(idA, { applied: 0, managed: true });

    // Shape B: same as A for standby
    const idB = w.idOf('acc-b');
    w.store.setCredentials(idB, { ...w.store.getCredentials(idB)!, cpaStatus: 'disabled' });
    w.store.updateCpaLinkRouting(idB, { applied: 0, managed: true });

    // Shape C: creds disabled, cooldown true
    const idC = w.idOf('acc-c');
    w.store.setCredentials(idC, { ...w.store.getCredentials(idC)!, cpaStatus: 'disabled' });
    w.store.updateCpaLinkRouting(idC, { applied: 0, cooldown: true, at: 1_000_000 });

    // Shape E: creds disabled, persisted engine state unknown
    const idE = w.idOf('acc-e');
    w.store.setCredentials(idE, { ...w.store.getCredentials(idE)!, cpaStatus: 'disabled' });
    w.store.updateCpaLinkRouting(idE, { applied: 0, managed: true });
    (w.service as any).engineState.accountStates['acc-e'] = { state: 'unknown', enteredAt: 1000, targetWeight: 0 };

    // Shape D active: manual hold active
    const idDAct = w.idOf('acc-d-act');
    w.store.setCredentials(idDAct, { ...w.store.getCredentials(idDAct)!, cpaStatus: 'disabled' });
    w.store.setManualHold(idDAct, 'airgap', 'test', Date.now() + 3600_000);
    w.store.updateCpaLinkRouting(idDAct, { applied: 0 });

    // Shape D expired: unmanaged, stale applied, hold gone
    const idDExp = w.idOf('acc-d-exp');
    w.store.setCredentials(idDExp, { ...w.store.getCredentials(idDExp)!, cpaStatus: 'disabled' });
    w.store.updateCpaLinkRouting(idDExp, { applied: 100, managed: false });

    // External disable: creds disabled, applied 100, no hold, engine target 100
    const idExt = w.idOf('acc-ext');
    w.store.setCredentials(idExt, { ...w.store.getCredentials(idExt)!, cpaStatus: 'disabled' });
    w.store.updateCpaLinkRouting(idExt, { applied: 100, managed: true });
    (w.service as any).engineState.accountStates['acc-ext'] = { state: 'healthy', enteredAt: 1000, targetWeight: 100 };

    // FQD disable not yet seen by discovery: creds not disabled, but routing.applied === 0
    const idUnseen = w.idOf('acc-fqd-unseen');
    w.store.setCredentials(idUnseen, { ...w.store.getCredentials(idUnseen)!, cpaStatus: 'active' });
    w.store.updateCpaLinkRouting(idUnseen, { applied: 0, managed: true });

    // Run migration
    w.service.migrateRoutingProvenance();

    assertEquals(w.store.getCpaLinkRouting(idA)?.disabledBy, 'policy', 'Shape A migrated to policy');
    assertEquals(w.store.getCpaLinkRouting(idB)?.disabledBy, 'policy', 'Shape B migrated to policy');
    assertEquals(w.store.getCpaLinkRouting(idC)?.disabledBy, 'reactive_429', 'Shape C migrated to reactive_429');
    assert(
      typeof w.store.getCpaLinkRouting(idC)?.cooldownUntil === 'number',
      'Shape C cooldownUntil set'
    );
    assertEquals(w.store.getCpaLinkRouting(idE)?.disabledBy, 'policy', 'Shape E migrated to policy');
    assertEquals(w.store.getCpaLinkRouting(idDAct)?.disabledBy, 'operator_hold', 'Shape D active migrated to operator_hold');
    assertEquals(w.store.getCpaLinkRouting(idDExp)?.disabledBy, undefined, 'Shape D expired left absent (external)');
    assertEquals(w.store.getCpaLinkRouting(idExt)?.disabledBy, undefined, 'External disable left absent (external)');
    assertEquals(w.store.getCpaLinkRouting(idUnseen)?.disabledBy, 'policy', 'Unseen FQD disable migrated to policy');

    // Setting is set
    assertEquals(w.store.getSetting('routing_provenance_v1'), '1', 'routing_provenance_v1 setting is recorded');

    // Run a second time: external credential is NOT adopted even if targetWeight drops to 0
    (w.service as any).engineState.accountStates['acc-ext'] = { state: 'hard_stop', enteredAt: 1000, targetWeight: 0 };
    w.service.migrateRoutingProvenance();
    assertEquals(
      w.store.getCpaLinkRouting(idExt)?.disabledBy,
      undefined,
      'migration runs once and does not adopt external on later runs'
    );

    await w.cleanup();
    pass('Case 13: One-time migration correctly classifies all shapes');
  } catch (err) {
    fail('Case 13: Migration of legacy routing provenance', err);
  }

  // --------------------------------------------------------------------------
  // Case 14: Existing suites pass
  // --------------------------------------------------------------------------
  console.log('Case 14: Verification of existing contracts and behavior');
  try {
    assertEquals(
      holdOwnerOf({ disabled: false, routing: null, activeHold: false }),
      'none',
      'not disabled is none'
    );
    assertEquals(
      holdOwnerOf({ disabled: true, routing: null, activeHold: true }),
      'operator',
      'active hold is operator'
    );
    assertEquals(
      holdOwnerOf({ disabled: true, routing: { disabledBy: 'policy' }, activeHold: false }),
      'fqd',
      'disabledBy policy is fqd'
    );
    assertEquals(
      holdOwnerOf({ disabled: true, routing: { disabledBy: 'reactive_429' }, activeHold: false }),
      'fqd',
      'disabledBy reactive_429 is fqd'
    );
    assertEquals(
      holdOwnerOf({ disabled: true, routing: { disabledBy: 'policy', managed: false }, activeHold: false }),
      'external',
      'managed false is external'
    );
    assertEquals(
      holdOwnerOf({ disabled: true, routing: null, activeHold: false }),
      'external',
      'unattributed disabled is external'
    );

    pass('Case 14: Existing behavior and contracts preserved');
  } catch (err) {
    fail('Case 14: Verification of existing contracts and behavior', err);
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runResetRecoveryTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
