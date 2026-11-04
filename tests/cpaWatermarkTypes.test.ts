import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  type WatermarkAccountState,
  type WatermarkTierState,
  type WatermarkMode,
  type ManualHoldType,
  type QuotaWindowKey,
  type WatermarkWindowView,
  type WatermarkAccountView,
  type WatermarkShadowDecision,
  type WatermarkFleetOverview,
  type ManualHoldRequest,
  type PolicyOverrideRequest,
  effectiveAccountState,
  WATERMARK_ACCOUNT_STATES,
  WATERMARK_TIER_STATES,
  WATERMARK_MODES,
  MANUAL_HOLD_TYPES,
  QUOTA_WINDOW_KEYS,
} from '../server/src/cpaWatermarkTypes';

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

console.log('========================================');
console.log('  CPA WATERMARK TYPES & BANNER TESTS    ');
console.log('========================================\n');

// -----------------------------------------------------------------------------
// Suite 1: effectiveAccountState Precedence, Stickiness, & Release Logic
// -----------------------------------------------------------------------------
console.log('Suite 1: effectiveAccountState Precedence, Stickiness, & Release');

// 1. None hold preserves any autoState
for (const state of WATERMARK_ACCOUNT_STATES) {
  assert(
    effectiveAccountState('none', state) === state,
    `effectiveAccountState('none', '${state}') preserves '${state}'`
  );
}

// 2. Airgap hold overrides every autoState
for (const state of WATERMARK_ACCOUNT_STATES) {
  assert(
    effectiveAccountState('airgap', state) === 'airgapped',
    `effectiveAccountState('airgap', '${state}') strictly enforces 'airgapped'`
  );
}

// 3. Quarantine hold overrides every autoState
for (const state of WATERMARK_ACCOUNT_STATES) {
  assert(
    effectiveAccountState('quarantine', state) === 'quarantined',
    `effectiveAccountState('quarantine', '${state}') strictly enforces 'quarantined'`
  );
}

// 4. Stickiness: manual hold stays active across changing autoState transitions
{
  let currentHold: ManualHoldType = 'quarantine';
  const autoTransitions: WatermarkAccountState[] = [
    'healthy',
    'tight',
    'draining',
    'exhausted',
    'recovering',
    'probation',
  ];

  let sticky = true;
  for (const s of autoTransitions) {
    if (effectiveAccountState(currentHold, s) !== 'quarantined') {
      sticky = false;
      break;
    }
  }
  assert(sticky, 'Quarantine hold remains sticky across automated state changes');

  // Releasing the hold returns the underlying autoState
  currentHold = 'none';
  assert(
    effectiveAccountState(currentHold, 'recovering') === 'recovering',
    'Releasing quarantine hold returns autoState (recovering)'
  );
  assert(
    effectiveAccountState(currentHold, 'healthy') === 'healthy',
    'Releasing quarantine hold returns autoState (healthy)'
  );
}

{
  let currentHold: ManualHoldType = 'airgap';
  const autoTransitions: WatermarkAccountState[] = [
    'healthy',
    'tight',
    'draining',
    'exhausted',
    'recovering',
    'probation',
  ];

  let sticky = true;
  for (const s of autoTransitions) {
    if (effectiveAccountState(currentHold, s) !== 'airgapped') {
      sticky = false;
      break;
    }
  }
  assert(sticky, 'Airgap hold remains sticky across automated state changes');

  // Releasing the hold returns the underlying autoState
  currentHold = 'none';
  assert(
    effectiveAccountState(currentHold, 'probation') === 'probation',
    'Releasing airgap hold returns autoState (probation)'
  );
  assert(
    effectiveAccountState(currentHold, 'exhausted') === 'exhausted',
    'Releasing airgap hold returns autoState (exhausted)'
  );
}

// -----------------------------------------------------------------------------
// Suite 2: Schema Shapes & Contract Types Validation
// -----------------------------------------------------------------------------
console.log('\nSuite 2: Schema Shapes & Contract Types Validation');

{
  // Test WatermarkWindowView
  const windowView: WatermarkWindowView = {
    key: 'session_5h',
    label: 'Session 5h',
    currentRemainingPct: 82.5,
    projectedRemainingPct: 71.0,
    resetsAt: new Date(Date.now() + 3600_000).toISOString(),
    resetSecondsRemaining: 3600,
    isBinding: true,
  };

  assert(typeof windowView.key === 'string', 'WatermarkWindowView has string key');
  assert(typeof windowView.label === 'string', 'WatermarkWindowView has label');
  assert(typeof windowView.currentRemainingPct === 'number', 'WatermarkWindowView has currentRemainingPct');
  assert(typeof windowView.projectedRemainingPct === 'number', 'WatermarkWindowView has projectedRemainingPct');
  assert(typeof windowView.resetsAt === 'string', 'WatermarkWindowView has resetsAt ISO string');
  assert(typeof windowView.resetSecondsRemaining === 'number', 'WatermarkWindowView has resetSecondsRemaining');
  assert(typeof windowView.isBinding === 'boolean', 'WatermarkWindowView has isBinding boolean');
}

{
  // Test WatermarkAccountView
  const accountView: WatermarkAccountView = {
    accountId: 'acc-claude-prod-1',
    name: 'Claude Pro #1',
    provider: 'claude',
    email: 'ops@company.internal',
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
        label: '5-hour window',
        currentRemainingPct: 90,
        projectedRemainingPct: 85,
        resetsAt: new Date().toISOString(),
        resetSecondsRemaining: 7200,
        isBinding: true,
      },
      {
        key: 'weekly_7d',
        label: 'Weekly window',
        currentRemainingPct: 95,
        projectedRemainingPct: 92,
        resetsAt: new Date().toISOString(),
        resetSecondsRemaining: 180000,
        isBinding: false,
      },
    ],
    burnRatePerMin: 0.12,
    runwayMinutes: 750,
    recentRequests5m: 45,
    recentErrors15m: {
      http429: 0,
      http5xx: 0,
    },
  };

  assert(accountView.accountId === 'acc-claude-prod-1', 'WatermarkAccountView accountId matches');
  assert(accountView.windows.length === 2, 'WatermarkAccountView windows array populated');
  assert(accountView.recentErrors15m.http429 === 0, 'WatermarkAccountView error tracking shape valid');
}

{
  // Test WatermarkAccountView with optional fields omitted and null runwayMinutes
  const minimalAccountView: WatermarkAccountView = {
    accountId: 'acc-2',
    name: 'Codex Dev',
    provider: 'codex',
    state: 'exhausted',
    manualHold: 'quarantine',
    currentWeight: 0,
    targetWeight: 0,
    readBackDrift: false,
    isQuarantined: true,
    isDisabled: false,
    bindingWindow: 'weekly_7d',
    windows: [],
    burnRatePerMin: 0,
    runwayMinutes: null,
    recentRequests5m: 0,
    recentErrors15m: { http429: 3, http5xx: 1 },
  };

  assert(minimalAccountView.email === undefined, 'WatermarkAccountView email is optional');
  assert(minimalAccountView.runwayMinutes === null, 'WatermarkAccountView runwayMinutes can be null');
  assert(minimalAccountView.manualHold === 'quarantine', 'WatermarkAccountView manualHold can be quarantine');
}

{
  // Test WatermarkFleetOverview
  const overview: WatermarkFleetOverview = {
    mode: 'enforce',
    routingStrategy: 'wrr',
    writesBlockedReason: null,
    tierState: 'OPEN',
    poolRunwayMinutes: 480,
    healthyCount: 5,
    tightCount: 1,
    exhaustedCount: 0,
    quarantinedCount: 0,
    accounts: [],
    recentShadowDecisions: [
      {
        at: Date.now() - 60000,
        accountId: 'acc-1',
        currentWeight: 100,
        proposedWeight: 50,
        reason: 'velocity_drain',
      },
    ],
    activeDangerAlerts: ['Fleet pool runway < 12h'],
  };

  assert(overview.mode === 'enforce', 'WatermarkFleetOverview mode matches');
  assert(overview.tierState === 'OPEN', 'WatermarkFleetOverview tierState matches');
  assert(overview.recentShadowDecisions.length === 1, 'WatermarkFleetOverview shadow decisions populated');
  assert(overview.activeDangerAlerts.length === 1, 'WatermarkFleetOverview danger alerts populated');
}

{
  // Test ManualHoldRequest
  const req1: ManualHoldRequest = {
    hold: 'quarantine',
    reason: 'Suspicious 429 spike observed',
    actor: 'admin@fqd.local',
  };
  const req2: ManualHoldRequest = {
    hold: 'none',
  };

  assert(req1.hold === 'quarantine', 'ManualHoldRequest hold value matches');
  assert(req1.reason !== undefined, 'ManualHoldRequest reason is present');
  assert(req2.hold === 'none' && req2.reason === undefined, 'ManualHoldRequest optional fields work');
}

{
  // Test PolicyOverrideRequest
  const numOverride: PolicyOverrideRequest = {
    key: 'pro.drainPct',
    value: 25,
    actor: 'engineer@corp.com',
    reason: 'High load spike test',
    ttlSeconds: 3600,
  };
  const strOverride: PolicyOverrideRequest = {
    key: 'routing.strategy',
    value: 'wrr',
    actor: 'engineer@corp.com',
    reason: 'Routing mode toggle',
    ttlSeconds: 1800,
  };
  const boolOverride: PolicyOverrideRequest = {
    key: 'antiFlagging.enabled',
    value: true,
    actor: 'engineer@corp.com',
    reason: 'Emergency flag mitigation',
    ttlSeconds: 7200,
  };

  assert(typeof numOverride.value === 'number', 'PolicyOverrideRequest supports number value');
  assert(typeof strOverride.value === 'string', 'PolicyOverrideRequest supports string value');
  assert(typeof boolOverride.value === 'boolean', 'PolicyOverrideRequest supports boolean value');
}

// -----------------------------------------------------------------------------
// Suite 3: Enum & Constant Coverage
// -----------------------------------------------------------------------------
console.log('\nSuite 3: Enum & Constant Coverage');

assert(
  WATERMARK_ACCOUNT_STATES.length === 8 &&
    WATERMARK_ACCOUNT_STATES.includes('healthy') &&
    WATERMARK_ACCOUNT_STATES.includes('tight') &&
    WATERMARK_ACCOUNT_STATES.includes('draining') &&
    WATERMARK_ACCOUNT_STATES.includes('exhausted') &&
    WATERMARK_ACCOUNT_STATES.includes('recovering') &&
    WATERMARK_ACCOUNT_STATES.includes('probation') &&
    WATERMARK_ACCOUNT_STATES.includes('quarantined') &&
    WATERMARK_ACCOUNT_STATES.includes('airgapped'),
  'WATERMARK_ACCOUNT_STATES contains all 8 expected states'
);

assert(
  WATERMARK_TIER_STATES.length === 3 &&
    WATERMARK_TIER_STATES.includes('OPEN') &&
    WATERMARK_TIER_STATES.includes('DEGRADED') &&
    WATERMARK_TIER_STATES.includes('CLOSED'),
  'WATERMARK_TIER_STATES contains OPEN, DEGRADED, CLOSED'
);

assert(
  WATERMARK_MODES.length === 3 &&
    WATERMARK_MODES.includes('off') &&
    WATERMARK_MODES.includes('shadow') &&
    WATERMARK_MODES.includes('enforce'),
  'WATERMARK_MODES contains off, shadow, enforce'
);

assert(
  MANUAL_HOLD_TYPES.length === 3 &&
    MANUAL_HOLD_TYPES.includes('none') &&
    MANUAL_HOLD_TYPES.includes('quarantine') &&
    MANUAL_HOLD_TYPES.includes('airgap'),
  'MANUAL_HOLD_TYPES contains none, quarantine, airgap'
);

assert(
  QUOTA_WINDOW_KEYS.length === 3 &&
    QUOTA_WINDOW_KEYS.includes('session_5h') &&
    QUOTA_WINDOW_KEYS.includes('weekly_7d') &&
    QUOTA_WINDOW_KEYS.includes('model_cap'),
  'QUOTA_WINDOW_KEYS contains session_5h, weekly_7d, model_cap'
);

// -----------------------------------------------------------------------------
// Suite 4: esbuild Server Node ESM Banner
// -----------------------------------------------------------------------------
console.log('\nSuite 4: esbuild Server Node ESM Banner');

{
  const expectedBanner =
    "import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url'; import { dirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);";

  // Check scripts/build.mjs
  const buildScriptPath = path.resolve(__dirname, '../scripts/build.mjs');
  const buildScriptContent = fs.readFileSync(buildScriptPath, 'utf8');

  assert(
    buildScriptContent.includes(expectedBanner),
    'scripts/build.mjs includes exact Node ESM banner in buildServer()'
  );

  // Check generated server/dist/server.mjs bundle
  const serverDistPath = path.resolve(__dirname, '../server/dist/server.mjs');
  const serverDistContent = fs.readFileSync(serverDistPath, 'utf8');

  assert(
    serverDistContent.startsWith(expectedBanner) || serverDistContent.includes(expectedBanner),
    'server/dist/server.mjs bundle contains Node ESM banner'
  );

  // Test Node evaluation of the banner logic in an ESM context
  // This verifies that require, __filename, and __dirname are created without error and require('node:process') works
  const testEvalCmd = `node --input-type=module -e "${expectedBanner} const proc = require('node:process'); if (!proc || typeof proc.cwd !== 'function') throw new Error('process not working'); if (typeof __filename !== 'string' || typeof __dirname !== 'string') throw new Error('filename/dirname not working');"`;
  let evalSuccess = false;
  try {
    execSync(testEvalCmd, { stdio: 'pipe' });
    evalSuccess = true;
  } catch (err: any) {
    console.error('Eval error:', err?.stderr?.toString() || err);
  }
  assert(
    evalSuccess,
    "Banner can be evaluated in Node ESM without 'Dynamic require of process is not supported'"
  );
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
console.log('========================================\n');

if (failedTests > 0) {
  process.exit(1);
}
