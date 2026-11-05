import { Store } from '../server/src/store';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type WatermarkFleetOverview,
  type WatermarkAccountView,
  type WatermarkHistoryEntry,
  type ManualHoldType,
  type WatermarkAccountState,
  effectiveAccountState,
} from '../server/src/cpaWatermarkTypes';
import { CpaWatermarkStore } from '../server/src/cpaWatermarkStore';
import {
  detectInvariantViolations,
  type InvariantViolation,
  deriveRoutingEnforcement,
} from '../web/src/components/common/cpaUiUtils';
import type { Account } from '../web/src/api';

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

function assertEquals<T>(actual: T, expected: T, testName: string) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  assert(match, testName, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('======================================================');
console.log('  CPA UI OVERHAUL & COMPONENT STATE LOGIC TESTS       ');
console.log('======================================================\n');

// -----------------------------------------------------------------------------
// Suite 2: Dual-Indicator Account Card Status & Origins
// -----------------------------------------------------------------------------
console.log('\nSuite 2: Dual-Indicator Account Card Status & Origins');

{
  const mockAccount: Account = {
    id: 'acc-claude-test',
    name: 'Claude Dev Account',
    providerType: 'claude',
    orderIndex: 0,
    isActive: true,
    lastStatus: 'ok',
    createdAt: new Date().toISOString(),
    latestSnapshot: {
      status: 'ok',
      buckets: [
        {
          id: 'b-5h',
          label: '5-hour limit',
          windowType: 'session_5h',
          remainingPercent: 65,
          utilizationPercent: 35,
          resetsAt: new Date().toISOString(),
          isExhausted: false,
          severity: 'healthy',
        },
        {
          id: 'b-7d',
          label: 'Weekly limit',
          windowType: 'weekly_7d',
          remainingPercent: 90,
          utilizationPercent: 10,
          resetsAt: new Date().toISOString(),
          isExhausted: false,
          severity: 'healthy',
        },
      ],
      fetchedAt: new Date().toISOString(),
    },
  };


  // Test Auto Routing Enforcement
  const routingAuto = deriveRoutingEnforcement(mockAccount, null);
  assertEquals(routingAuto.effectiveState, 'Active', 'Auto routing enforcement is Active');
  assertEquals(routingAuto.origin, 'auto', 'Origin is auto');
  assertEquals(routingAuto.originLabel, 'AUTO-TRIPWIRE', 'Origin label is AUTO-TRIPWIRE');
  assertEquals(routingAuto.weight, 100, 'Weight is 100');

  // Test Manual Hold Quarantine Override
  const accountViewQuarantined: WatermarkAccountView = {
    accountId: mockAccount.id,
    name: mockAccount.name,
    provider: 'claude',
    state: 'healthy', // upstream auto state
    manualHold: 'quarantine', // operator manual hold
    currentWeight: 0,
    targetWeight: 0,
    readBackDrift: false,
    isQuarantined: true,
    isDisabled: false,
    bindingWindow: 'session_5h',
    windows: [],
    burnRatePerMin: 0,
    runwayMinutes: null,
    recentRequests5m: 0,
    recentErrors15m: { http429: 0, http5xx: 0 },
  };

  const routingManualQuarantine = deriveRoutingEnforcement(mockAccount, accountViewQuarantined);
  assertEquals(routingManualQuarantine.effectiveState, 'Quarantined', 'Effective state is Quarantined under manual hold');
  assertEquals(routingManualQuarantine.origin, 'manual', 'Origin is manual');
  assert(routingManualQuarantine.originLabel.includes('MANUAL HOLD'), 'Origin label includes MANUAL HOLD');
  assertEquals(routingManualQuarantine.weight, 0, 'Routing weight is 0');

  // Test Manual Hold Airgap Override
  const accountViewAirgapped: WatermarkAccountView = {
    ...accountViewQuarantined,
    manualHold: 'airgap',
  };
  const routingManualAirgap = deriveRoutingEnforcement(mockAccount, accountViewAirgapped);
  assertEquals(routingManualAirgap.effectiveState, 'Airgapped', 'Effective state is Airgapped under manual hold');
  assertEquals(routingManualAirgap.origin, 'manual', 'Origin is manual');
  assert(routingManualAirgap.originLabel.includes('AIRGAP'), 'Origin label includes AIRGAP');
}

// -----------------------------------------------------------------------------
// Suite 3: Pulsing Red DANGER Invariant Alert Detection
// -----------------------------------------------------------------------------
console.log('\nSuite 3: Pulsing Red DANGER Invariant Alert Detection');

{
  // Violation 1: An account marked exhausted upstream that still has routing weight > 0
  const overviewLeakedWeight: WatermarkFleetOverview = {
    mode: 'enforce',
    routingStrategy: 'wrr',
    writesBlockedReason: null,
    tierState: 'DEGRADED',
    poolRunwayMinutes: 300,
    healthyCount: 2,
    tightCount: 0,
    exhaustedCount: 1,
    quarantinedCount: 0,
    accounts: [
      {
        accountId: 'acc-leaked',
        name: 'Leaked Weight Account',
        provider: 'antigravity',
        state: 'exhausted', // exhausted
        manualHold: 'none',
        currentWeight: 75, // VIOLATION: weight > 0 while exhausted!
        targetWeight: 0,
        readBackDrift: true,
        isQuarantined: false,
        isDisabled: false,
        bindingWindow: 'session_5h',
        windows: [],
        burnRatePerMin: 0.1,
        runwayMinutes: 50,
        recentRequests5m: 10,
        recentErrors15m: { http429: 0, http5xx: 0 },
      },
    ],
    recentShadowDecisions: [],
    activeDangerAlerts: [],
  };

  const violations1 = detectInvariantViolations(overviewLeakedWeight);
  assertEquals(violations1.length, 1, 'Detected 1 invariant violation for leaked weight');
  assertEquals(violations1[0].type, 'leaked_weight', 'Violation type is leaked_weight');
  assertEquals(violations1[0].accountId, 'acc-leaked', 'Violation targets acc-leaked');
  assert(violations1[0].message.includes('EXHAUSTED'), 'Message details exhausted state');

  // Violation 2: 429 strikes logged on an account that should have been airgapped
  const overviewUnairgapped429: WatermarkFleetOverview = {
    mode: 'enforce',
    routingStrategy: 'wrr',
    writesBlockedReason: null,
    tierState: 'DEGRADED',
    poolRunwayMinutes: 200,
    healthyCount: 1,
    tightCount: 1,
    exhaustedCount: 0,
    quarantinedCount: 0,
    accounts: [
      {
        accountId: 'acc-429',
        name: '429 Strike Account',
        provider: 'claude',
        state: 'tight', // not airgapped!
        manualHold: 'none',
        currentWeight: 50,
        targetWeight: 50,
        readBackDrift: false,
        isQuarantined: false,
        isDisabled: false,
        bindingWindow: 'weekly_7d',
        windows: [],
        burnRatePerMin: 0.3,
        runwayMinutes: 100,
        recentRequests5m: 30,
        recentErrors15m: { http429: 2, http5xx: 0 }, // VIOLATION: 2 strikes without airgap!
      },
    ],
    recentShadowDecisions: [],
    activeDangerAlerts: [],
  };

  const violations2 = detectInvariantViolations(overviewUnairgapped429);
  assertEquals(violations2.length, 1, 'Detected 1 invariant violation for unairgapped 429');
  assertEquals(violations2[0].type, 'unairgapped_429', 'Violation type is unairgapped_429');
  assertEquals(violations2[0].recent429Count, 2, 'Strike count matches 2');

  // Resolved state: account is airgapped with weight 0
  const overviewClean: WatermarkFleetOverview = {
    ...overviewUnairgapped429,
    accounts: [
      {
        ...overviewUnairgapped429.accounts[0],
        state: 'airgapped',
        manualHold: 'airgap',
        currentWeight: 0,
      },
    ],
  };
  const violationsClean = detectInvariantViolations(overviewClean);
  assertEquals(violationsClean.length, 0, 'Zero violations when airgap is enforced and weight is 0');
}

// -----------------------------------------------------------------------------
// Suite 4: 1-Click Emergency Action & State Precedence Math
// -----------------------------------------------------------------------------
console.log('\nSuite 4: 1-Click Emergency Action & State Precedence Math');

{
  // Test EffectiveState = most_restrictive(ManualHold, AutoState)
  assertEquals(effectiveAccountState('airgap', 'healthy'), 'airgapped', 'airgap overrides healthy');
  assertEquals(effectiveAccountState('airgap', 'tight'), 'airgapped', 'airgap overrides tight');
  assertEquals(effectiveAccountState('airgap', 'exhausted'), 'airgapped', 'airgap overrides exhausted');

  assertEquals(effectiveAccountState('quarantine', 'healthy'), 'quarantined', 'quarantine overrides healthy');
  assertEquals(effectiveAccountState('quarantine', 'tight'), 'quarantined', 'quarantine overrides tight');
  assertEquals(effectiveAccountState('quarantine', 'exhausted'), 'quarantined', 'quarantine overrides exhausted');

  // Clearing hold returns underlying autoState
  assertEquals(effectiveAccountState('none', 'healthy'), 'healthy', 'clear hold restores healthy');
  assertEquals(effectiveAccountState('none', 'tight'), 'tight', 'clear hold restores tight');
  assertEquals(effectiveAccountState('none', 'exhausted'), 'exhausted', 'clear hold restores exhausted');
}

// -----------------------------------------------------------------------------
// Suite 6: Backend SQLite Manual Hold Store Persistence
// -----------------------------------------------------------------------------
console.log('\nSuite 6: Backend SQLite Manual Hold Store Persistence');

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-ui-test-'));
  const store = new Store(tempDir, 'test.db', '0123456789abcdef0123456789abcdef');

  // 1. Initially no manual holds
  assertEquals(store.listManualHolds().length, 0, 'No holds initially');
  assertEquals(store.getManualHold('acc-1'), null, 'getManualHold returns null initially');

  // 2. Set quarantine hold with TTL
  const now = 1000000;
  const ttlSeconds = 3600;
  const expiresAt = now + ttlSeconds * 1000;
  store.setManualHold('acc-1', 'quarantine', 'Test quarantine reason', expiresAt, now);

  // 3. Read back from SQLite
  const loadedQuarantine = store.getManualHold('acc-1', now);
  assert(Boolean(loadedQuarantine), 'Loaded quarantine from DB');
  assertEquals(loadedQuarantine?.holdType, 'quarantine', 'Loaded hold is quarantine');
  assertEquals(loadedQuarantine?.reason, 'Test quarantine reason', 'Loaded reason matches');
  assertEquals(loadedQuarantine?.expiresAt, expiresAt, 'expiresAt matches');

  // 4. Overwrite with airgap
  store.setManualHold('acc-1', 'airgap', 'Escalated to airgap', expiresAt + 3600000, now);
  const loadedAirgap = store.getManualHold('acc-1', now);
  assertEquals(loadedAirgap?.holdType, 'airgap', 'Loaded airgap hold');

  // 5. Add second account hold
  store.setManualHold('acc-2', 'quarantine', 'Second account quarantine', expiresAt, now);
  assertEquals(store.listManualHolds(now).length, 2, '2 active holds listed');

  // 6. Release hold on acc-1
  store.setManualHold('acc-1', 'none', undefined, undefined, now);
  assertEquals(store.getManualHold('acc-1', now), null, 'acc-1 hold is now null in DB');
  assertEquals(store.listManualHolds(now).length, 1, 'Only acc-2 remains in list');

  // 7. Expired hold automatically pruned
  assertEquals(store.getManualHold('acc-2', expiresAt + 1000), null, 'Expired hold returns null');
  assertEquals(store.listManualHolds(expiresAt + 1000).length, 0, 'Expired holds list is empty');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('\n======================================================');
console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
console.log('======================================================\n');

if (failedTests > 0) {
  process.exit(1);
}
