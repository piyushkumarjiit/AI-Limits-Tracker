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
  formatRunway,
  calculatePoolSummary,
  detectInvariantViolations,
  type InvariantViolation,
  deriveUpstreamQuota,
  deriveRoutingEnforcement,
  parseAuditItems,
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
// Suite 1: Fleet Header Banner & Pool Runway Calculations
// -----------------------------------------------------------------------------
console.log('Suite 1: Fleet Header Banner & Pool Runway Calculations');

{
  // formatRunway tests
  assertEquals(formatRunway(null).urgency, 'nominal', 'formatRunway(null) is nominal');
  assertEquals(formatRunway(null).text, 'Nominal (No Burn)', 'formatRunway(null) text is Nominal');
  assertEquals(formatRunway(-10).urgency, 'nominal', 'formatRunway(-10) is nominal');
  assertEquals(formatRunway(NaN).urgency, 'nominal', 'formatRunway(NaN) is nominal');

  // Urgent: <= 60 minutes
  assertEquals(formatRunway(45).urgency, 'urgent', 'formatRunway(45) urgency is urgent');
  assertEquals(formatRunway(45).text, '45m runway', 'formatRunway(45) text is 45m runway');
  assertEquals(formatRunway(60).urgency, 'urgent', 'formatRunway(60) urgency is urgent');

  // Warning: 61 - 719 minutes (< 12 hours)
  assertEquals(formatRunway(150).urgency, 'warning', 'formatRunway(150) urgency is warning');
  assertEquals(formatRunway(150).text, '2h 30m runway', 'formatRunway(150) text is 2h 30m runway');

  // Safe: 12 - 47 hours
  assertEquals(formatRunway(1200).urgency, 'safe', 'formatRunway(1200) urgency is safe');
  assertEquals(formatRunway(1200).text, '20h runway', 'formatRunway(1200) text is 20h runway');

  // Multi-day safe: >= 48 hours
  assertEquals(formatRunway(3000).urgency, 'safe', 'formatRunway(3000) urgency is safe');
  assertEquals(formatRunway(3000).text, '2d 2h runway', 'formatRunway(3000) text has days');
}

{
  // calculatePoolSummary with mock account views
  const agyViews: WatermarkAccountView[] = [
    {
      accountId: 'agy-1',
      name: 'AGY Slot 1',
      provider: 'antigravity',
      state: 'healthy',
      manualHold: 'none',
      currentWeight: 100,
      targetWeight: 100,
      readBackDrift: false,
      isQuarantined: false,
      isDisabled: false,
      bindingWindow: 'session_5h',
      windows: [
        {
          key: 'session_5h',
          label: '5-Hour',
          currentRemainingPct: 80,
          projectedRemainingPct: 75,
          resetsAt: new Date().toISOString(),
          resetSecondsRemaining: 3600,
          isBinding: true,
        },
      ],
      burnRatePerMin: 0.1,
      runwayMinutes: 800,
      recentRequests5m: 10,
      recentErrors15m: { http429: 0, http5xx: 0 },
    },
    {
      accountId: 'agy-2',
      name: 'AGY Slot 2',
      provider: 'antigravity',
      state: 'tight',
      manualHold: 'none',
      currentWeight: 60,
      targetWeight: 60,
      readBackDrift: false,
      isQuarantined: false,
      isDisabled: false,
      bindingWindow: 'session_5h',
      windows: [
        {
          key: 'session_5h',
          label: '5-Hour',
          currentRemainingPct: 30,
          projectedRemainingPct: 25,
          resetsAt: new Date().toISOString(),
          resetSecondsRemaining: 1800,
          isBinding: true,
        },
      ],
      burnRatePerMin: 0.2,
      runwayMinutes: 150,
      recentRequests5m: 25,
      recentErrors15m: { http429: 0, http5xx: 0 },
    },
    {
      accountId: 'agy-3',
      name: 'AGY Slot 3',
      provider: 'antigravity',
      state: 'exhausted',
      manualHold: 'none',
      currentWeight: 0,
      targetWeight: 0,
      readBackDrift: false,
      isQuarantined: true,
      isDisabled: false,
      bindingWindow: 'session_5h',
      windows: [
        {
          key: 'session_5h',
          label: '5-Hour',
          currentRemainingPct: 5,
          projectedRemainingPct: 0,
          resetsAt: new Date().toISOString(),
          resetSecondsRemaining: 600,
          isBinding: true,
        },
      ],
      burnRatePerMin: 0,
      runwayMinutes: null,
      recentRequests5m: 0,
      recentErrors15m: { http429: 1, http5xx: 0 },
    },
  ];

  const summary = calculatePoolSummary('antigravity', agyViews, []);
  assertEquals(summary.provider, 'antigravity', 'Summary provider is antigravity');
  assertEquals(summary.totalCount, 3, 'Summary total count is 3');
  // (80 + 30 + 5) / 3 = 115 / 3 = 38%
  assertEquals(summary.headroomPct, 38, 'Headroom is average 38%');
  // burnRateSum = 0.1 + 0.2 = 0.3. 38 / 0.3 = 127 minutes runway
  assertEquals(summary.runwayMinutes, 127, 'Runway minutes correctly calculated from total burn');
  assertEquals(summary.activeCount, 1, 'Active count is 1');
  assertEquals(summary.tightCount, 1, 'Tight count is 1');
  assertEquals(summary.exhaustedCount, 1, 'Exhausted count is 1');
  assertEquals(summary.quarantinedCount, 0, 'Quarantined count is 0');
}

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

  const quota = deriveUpstreamQuota(mockAccount, null);
  assertEquals(quota.headroomPct, 65, 'deriveUpstreamQuota headroom is 65%');
  assertEquals(quota.bindingWindow, '5h', '5h window correctly detected as binding');
  assertEquals(quota.severity, 'healthy', '65% headroom classified as healthy');

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
// Suite 5: Shadow-Mode Telemetry & Audit Feed Parsing
// -----------------------------------------------------------------------------
console.log('\nSuite 5: Shadow-Mode Telemetry & Audit Feed Parsing');

{
  const overviewWithDecisions: WatermarkFleetOverview = {
    mode: 'shadow',
    routingStrategy: 'wrr',
    writesBlockedReason: null,
    tierState: 'OPEN',
    poolRunwayMinutes: 600,
    healthyCount: 3,
    tightCount: 0,
    exhaustedCount: 0,
    quarantinedCount: 0,
    accounts: [],
    recentShadowDecisions: [
      {
        at: 1700000000000,
        accountId: 'acc-tripwire-1',
        currentWeight: 100,
        proposedWeight: 1,
        reason: 'velocity_drain: projected exhaustion in 18m before 5h window reset',
      },
      {
        at: 1700000060000,
        accountId: 'acc-429-prevent',
        currentWeight: 100,
        proposedWeight: 0,
        reason: '429_prevention: tripwire halted traffic before upstream rate limit',
      },
      {
        at: 1700000120000,
        accountId: 'acc-leadtime-1',
        currentWeight: 80,
        proposedWeight: 50,
        reason: 'lead_time_projection: window refill scheduled in 42m',
      },
    ],
    activeDangerAlerts: [],
  };

  const historyEntries: WatermarkHistoryEntry[] = [
    {
      id: 1,
      recordedAt: 1700000180000,
      eventType: 'manual_hold_airgap',
      generation: 1,
      summary: JSON.stringify({
        accountId: 'acc-emergency-1',
        actor: 'operator_alice',
        reason: 'Suspected token leak, immediate airgap',
      }),
      stateJson: '{}',
    },
  ];

  const parsed = parseAuditItems(overviewWithDecisions, historyEntries);
  assertEquals(parsed.length, 4, 'Parsed 4 total audit items');

  const tripwireItem = parsed.find((p) => p.accountId === 'acc-tripwire-1');
  assert(Boolean(tripwireItem), 'Tripwire item exists');
  assertEquals(tripwireItem?.type, 'tripwire', 'Classified as tripwire');
  assertEquals(tripwireItem?.oldWeight, 100, 'Old weight is 100');
  assertEquals(tripwireItem?.newWeight, 1, 'New weight is 1');

  const item429 = parsed.find((p) => p.accountId === 'acc-429-prevent');
  assert(Boolean(item429), '429 prevention item exists');
  assertEquals(item429?.type, '429', 'Classified as 429');

  const leadtimeItem = parsed.find((p) => p.accountId === 'acc-leadtime-1');
  assert(Boolean(leadtimeItem), 'Leadtime item exists');
  assertEquals(leadtimeItem?.type, 'leadtime', 'Classified as leadtime');

  const holdItem = parsed.find((p) => p.accountId === 'acc-emergency-1');
  assert(Boolean(holdItem), 'Manual hold item exists');
  assertEquals(holdItem?.type, 'hold', 'Classified as hold');
  assertEquals(holdItem?.details, 'Actor: operator_alice', 'Actor details parsed');
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
