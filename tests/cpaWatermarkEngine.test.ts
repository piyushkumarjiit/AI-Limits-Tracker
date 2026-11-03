import {
  computeWatermarkTargets,
  type WatermarkSnapshot,
  type WatermarkPolicyConfig,
  type EngineState,
} from '../server/src/cpaWatermarkEngine';

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

function makeInitialState(mode: 'off' | 'shadow' | 'enforce' = 'enforce'): EngineState {
  return {
    mode,
    tierStates: {},
    accountStates: {},
    generation: 0,
  };
}

function makeProSnapshot(
  name: string,
  quotaEff: number,
  options: Partial<WatermarkSnapshot> = {}
): WatermarkSnapshot {
  return {
    cpaName: name,
    accountId: `acc-${name}`,
    provider: 'claude',
    tier: 'pro',
    modality: 'subscription_pool',
    quotaEffectivePct: quotaEff,
    burnRatePerMin: 0,
    stalenessSec: 10,
    isCooldown: false,
    currentWeight: 100,
    managed: true,
    ...options,
  };
}

function makeNonProSnapshot(
  name: string,
  quotaEff: number,
  options: Partial<WatermarkSnapshot> = {}
): WatermarkSnapshot {
  return {
    cpaName: name,
    accountId: `acc-${name}`,
    provider: 'antigravity',
    tier: 'non_pro',
    modality: 'subscription_pool',
    quotaEffectivePct: quotaEff,
    burnRatePerMin: 0,
    stalenessSec: 10,
    isCooldown: false,
    currentWeight: 0,
    managed: true,
    ...options,
  };
}

console.log('\n========================================');
console.log('  CPA WATERMARK ENGINE UNIT TESTS (WP-1)');
console.log('========================================\n');

// -----------------------------------------------------------------------------
// Suite 1: Pure Determinism & Zero I/O Side Effects
// -----------------------------------------------------------------------------
console.log('Suite 1: Determinism & Purity');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  const state = makeInitialState();
  const snaps = [
    makeProSnapshot('c1', 80, { burnRatePerMin: 0.5 }),
    makeProSnapshot('c2', 15, { burnRatePerMin: 1.0 }),
  ];

  const now = 1700000000000;
  const res1 = computeWatermarkTargets(snaps, policy, state, now);
  const res2 = computeWatermarkTargets(snaps, policy, state, now);

  assert(
    res1.targets.get('c1')?.targetWeight === res2.targets.get('c1')?.targetWeight,
    'Determinism: c1 weight identical across calls'
  );
  assert(
    res1.targets.get('c2')?.targetWeight === res2.targets.get('c2')?.targetWeight,
    'Determinism: c2 weight identical across calls'
  );
  assert(
    res1.nextState.generation === res2.nextState.generation,
    'Determinism: next generation identical'
  );
  assert(
    JSON.stringify(res1.writeBatch) === JSON.stringify(res2.writeBatch),
    'Determinism: writeBatch identical across invocations'
  );
}

// -----------------------------------------------------------------------------
// Suite 2: Multi-Window Projection Formula with Clamped Burn Rate
// -----------------------------------------------------------------------------
console.log('\nSuite 2: Multi-Window Projection Formula');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  const state = makeInitialState();

  // Account has nominal 25% quota, but burnRate is 6%/min.
  // Horizon = 65s, staleness = 15s -> total delta t = 80s = 80/60 = 1.333 min.
  // Projection delta = 6 * (80/60) = 8%.
  // Projected quota = 25 - 8 = 17% <= 20% drain threshold!
  // Therefore, it should enter drain (targetWeight = 1) even though nominal is 25% > 20%.
  const snaps = [
    makeProSnapshot('c1', 90), // healthy peer to avoid collective fallback
    makeProSnapshot('c2', 90), // healthy peer to avoid collective fallback
    makeProSnapshot('c3', 25, { burnRatePerMin: 6, stalenessSec: 15, currentWeight: 100 }),
  ];

  const res = computeWatermarkTargets(snaps, policy, state, 1700000000000);
  assert(res.targets.get('c3')?.targetWeight === 1, 'Velocity projection triggers drain at nominal 25%');
  assert(res.targets.get('c3')?.reason === 'drain', 'Reason is drain');

  // Burn rate clamp test: burn rate of 25%/min should be clamped to 15%/min
  // With nominal 35%, horizon 65s, staleness 0s: clamped delta = 15 * (65/60) = 16.25%
  // Projected = 35 - 16.25 = 18.75% <= 20% -> drain
  const snapClamp = [
    makeProSnapshot('c1', 90),
    makeProSnapshot('c2', 90),
    makeProSnapshot('c4', 35, { burnRatePerMin: 25, stalenessSec: 0, currentWeight: 100 }),
  ];
  const resClamp = computeWatermarkTargets(snapClamp, policy, state, 1700000000000);
  assert(resClamp.targets.get('c4')?.targetWeight === 1, 'Burn rate clamped at 15%/min properly projects quota');
}

// -----------------------------------------------------------------------------
// Suite 3: Two-Stage Watermark & Hysteresis Checks
// -----------------------------------------------------------------------------
console.log('\nSuite 3: Two-Stage Watermark & Hysteresis');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  let state = makeInitialState();
  const now = 1700000000000;

  // Step 1: Account drops into drain (18% <= 20%)
  const snaps1 = [
    makeProSnapshot('p1', 80),
    makeProSnapshot('p2', 80),
    makeProSnapshot('p3', 18, { currentWeight: 100 }),
  ];
  const res1 = computeWatermarkTargets(snaps1, policy, state, now);
  assert(res1.targets.get('p3')?.targetWeight === 1, 'p3 enters drain at 18%');
  state = res1.nextState;

  // Step 2: Account rises slightly to 22% (between 20% drain and 24% recovery)
  // Must stay in drain due to hysteresis!
  const snaps2 = [
    makeProSnapshot('p1', 80),
    makeProSnapshot('p2', 80),
    makeProSnapshot('p3', 22, { currentWeight: 1 }),
  ];
  const res2 = computeWatermarkTargets(snaps2, policy, state, now + 60000);
  assert(res2.targets.get('p3')?.targetWeight === 1, 'p3 stays in drain at 22% (< 24% recovery threshold)');
  state = res2.nextState;

  // Step 3: Account recovers to 25% (>= 24% recovery)
  const snaps3 = [
    makeProSnapshot('p1', 80),
    makeProSnapshot('p2', 80),
    makeProSnapshot('p3', 25, { currentWeight: 1 }),
  ];
  const res3 = computeWatermarkTargets(snaps3, policy, state, now + 120000);
  assert(res3.targets.get('p3')?.targetWeight === 100, 'p3 recovers to healthy (W=100) at 25%');
  state = res3.nextState;

  // Step 4: Hard floor breach (4% <= 5%) -> W = 0
  const snaps4 = [
    makeProSnapshot('p1', 80),
    makeProSnapshot('p2', 80),
    makeProSnapshot('p3', 4, { currentWeight: 100 }),
  ];
  const res4 = computeWatermarkTargets(snaps4, policy, state, now + 180000);
  assert(res4.targets.get('p3')?.targetWeight === 0, 'p3 enters hard_stop (W=0) at 4%');
  assert(res4.targets.get('p3')?.reason === 'hard_stop', 'p3 reason is hard_stop');
  state = res4.nextState;

  // Step 5: Hard floor hysteresis: rises to 7% (between 5% and 8% recovery)
  // Must stay in hard_stop (W = 0)
  const snaps5 = [
    makeProSnapshot('p1', 80),
    makeProSnapshot('p2', 80),
    makeProSnapshot('p3', 7, { currentWeight: 0 }),
  ];
  const res5 = computeWatermarkTargets(snaps5, policy, state, now + 240000);
  assert(res5.targets.get('p3')?.targetWeight === 0, 'p3 stays in hard_stop at 7% (< 8% recovery threshold)');
  state = res5.nextState;

  // Step 6: Hard floor recovery: rises to 10% (>= 8%)
  // Recovers to drain (10% < 24%)
  const snaps6 = [
    makeProSnapshot('p1', 80),
    makeProSnapshot('p2', 80),
    makeProSnapshot('p3', 10, { currentWeight: 0 }),
  ];
  const res6 = computeWatermarkTargets(snaps6, policy, state, now + 300000);
  assert(res6.targets.get('p3')?.targetWeight === 1, 'p3 exits hard_stop into drain (W=1) at 10% (>= 8% recovery)');
}

// -----------------------------------------------------------------------------
// Suite 4: Collective Degraded Fallback & Anti-Thundering Herd Recovery
// -----------------------------------------------------------------------------
console.log('\nSuite 4: Collective Degraded Fallback');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  let state = makeInitialState();
  let now = 1700000000000;

  // 3 Pro accounts: N = 3, K = max(2, ceil(3/3)) = 2.
  // If healthy accounts < 2, collective degraded fallback triggers: all non-hard_stop accounts get W = 100.
  const snaps1 = [
    makeProSnapshot('p1', 15), // drain
    makeProSnapshot('p2', 12), // drain
    makeProSnapshot('p3', 80), // healthy -> only 1 healthy < K (2)
  ];

  const res1 = computeWatermarkTargets(snaps1, policy, state, now);
  assert(
    res1.nextState.tierStates['claude:pro'] === 'collective_fallback',
    'Tier enters collective_fallback when healthy < K'
  );
  assert(res1.targets.get('p1')?.targetWeight === 100, 'p1 elevated to W=100 in collective fallback');
  assert(res1.targets.get('p2')?.targetWeight === 100, 'p2 elevated to W=100 in collective fallback');
  assert(res1.targets.get('p3')?.targetWeight === 100, 'p3 remains W=100 in collective fallback');
  state = res1.nextState;

  // Even if accounts recover to >= 24%, fallback must not exit before minimum dwell time (10 mins = 600s)
  now += 300000; // 5 minutes later
  const snaps2 = [
    makeProSnapshot('p1', 50),
    makeProSnapshot('p2', 50),
    makeProSnapshot('p3', 80),
  ];
  const res2 = computeWatermarkTargets(snaps2, policy, state, now);
  assert(
    res2.nextState.tierStates['claude:pro'] === 'collective_fallback',
    'Tier stays in collective fallback before 10 min dwell time elapses'
  );
  state = res2.nextState;

  // After 10 mins (600s), fallback exits
  now += 350000; // Total 650s elapsed
  const res3 = computeWatermarkTargets(snaps2, policy, state, now);
  assert(
    res3.nextState.tierStates['claude:pro'] === 'normal',
    'Tier exits collective fallback after 10 min dwell time with >= K recovered accounts'
  );
}

// -----------------------------------------------------------------------------
// Suite 5: Telemetry Staleness Table & Fail-Static Pool Freezing
// -----------------------------------------------------------------------------
console.log('\nSuite 5: Telemetry Staleness Table');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  const now = 1700000000000;

  // Stale healthy transitions to drain (W = 1)
  const stateWithHealthy: EngineState = {
    mode: 'enforce',
    generation: 1,
    tierStates: {},
    accountStates: {
      p1: { state: 'healthy', enteredAt: now - 500000, targetWeight: 100 },
      p2: { state: 'healthy', enteredAt: now - 500000, targetWeight: 100 },
    },
  };

  const snaps = [
    makeProSnapshot('p1', 90, { stalenessSec: 350, currentWeight: 100 }), // stale > 300s
    makeProSnapshot('p2', 90, { stalenessSec: 20, currentWeight: 100 }),  // fresh
    makeProSnapshot('p3', 90, { stalenessSec: 20, currentWeight: 100 }),  // fresh (2 fresh >= K=2 so normal tier state)
  ];

  const res = computeWatermarkTargets(snaps, policy, stateWithHealthy, now);
  assert(res.targets.get('p1')?.targetWeight === 1, 'Stale healthy account transitions to drain W=1');
  assert(res.targets.get('p1')?.reason === 'stale_telemetry_drain', 'Reason is stale_telemetry_drain');
  assert(res.targets.get('p2')?.targetWeight === 100, 'Fresh peer remains healthy W=100');

  // When ALL accounts in pool are stale (>300s), pool enters fail_static
  const allStaleSnaps = [
    makeProSnapshot('p1', 90, { stalenessSec: 350, currentWeight: 100 }),
    makeProSnapshot('p2', 90, { stalenessSec: 400, currentWeight: 50 }),
  ];
  const resFailStatic = computeWatermarkTargets(allStaleSnaps, policy, stateWithHealthy, now);
  assert(
    resFailStatic.nextState.tierStates['claude:pro'] === 'fail_static',
    'Pool enters fail_static when all accounts in pool are stale'
  );
  assert(
    resFailStatic.targets.get('p1')?.targetWeight === 100,
    'fail_static freezes p1 weight at previous target'
  );
}

// -----------------------------------------------------------------------------
// Suite 6: Cross-Tier Activation (Non-Pro Activates Only When Pro Depleted)
// -----------------------------------------------------------------------------
console.log('\nSuite 6: Cross-Tier Activation');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  let state = makeInitialState();
  const now = 1700000000000;

  // Scenario 1: Pro account is healthy -> Non-Pro accounts remain on standby W = 0
  const snaps1 = [
    makeProSnapshot('ag-pro', 80, { provider: 'antigravity' }),
    makeNonProSnapshot('ag-free-1', 90),
    makeNonProSnapshot('ag-free-2', 90),
  ];
  const res1 = computeWatermarkTargets(snaps1, policy, state, now);
  assert(res1.targets.get('ag-pro')?.targetWeight === 100, 'Pro account is active at W=100');
  assert(res1.targets.get('ag-free-1')?.targetWeight === 0, 'Non-pro 1 is on standby W=0 while Pro is active');
  assert(res1.targets.get('ag-free-2')?.targetWeight === 0, 'Non-pro 2 is on standby W=0 while Pro is active');
  state = res1.nextState;

  // Scenario 2: Pro account hits hard_stop (0%) -> Non-Pro activates sequentially!
  const snaps2 = [
    makeProSnapshot('ag-pro', 0, { provider: 'antigravity', isCooldown: true }),
    makeNonProSnapshot('ag-free-1', 90),
    makeNonProSnapshot('ag-free-2', 90),
  ];
  const res2 = computeWatermarkTargets(snaps2, policy, state, now + 60000);
  assert(res2.targets.get('ag-pro')?.targetWeight === 0, 'Pro account is evicted W=0');
  assert(res2.targets.get('ag-free-1')?.targetWeight === 100, 'Non-pro 1 sequentially activated at W=100');
  assert(res2.targets.get('ag-free-2')?.targetWeight === 0, 'Non-pro 2 remains standby W=0 (sticky fill-first)');
  state = res2.nextState;

  // Scenario 3: Pro recovers -> Non-pro transitions to drain (W = 1) for in-flight turn completion
  const snaps3 = [
    makeProSnapshot('ag-pro', 85, { provider: 'antigravity', isCooldown: false }),
    makeNonProSnapshot('ag-free-1', 90, { currentWeight: 100 }),
    makeNonProSnapshot('ag-free-2', 90),
  ];
  const res3 = computeWatermarkTargets(snaps3, policy, state, now + 120000);
  assert(res3.targets.get('ag-pro')?.targetWeight === 100, 'Pro account recovers to W=100');
  assert(
    res3.targets.get('ag-free-1')?.targetWeight === 1,
    'Non-pro 1 steps down through drain (W=1) to prevent in-flight context fragmentation'
  );
}

// -----------------------------------------------------------------------------
// Suite 7: Precedence Hierarchy (Operator Override & Cooldown)
// -----------------------------------------------------------------------------
console.log('\nSuite 7: Precedence Hierarchy');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  const state = makeInitialState();
  const now = 1700000000000;

  // 1. Operator manual override (managed: false)
  const unmanagedSnap = makeProSnapshot('c1', 1, { managed: false, currentWeight: 42 });
  const resUnmanaged = computeWatermarkTargets([unmanagedSnap], policy, state, now);
  assert(
    resUnmanaged.targets.get('c1')?.targetWeight === 42,
    'Operator override (managed: false) preserves human weight even at 1% quota'
  );
  assert(resUnmanaged.targets.get('c1')?.reason === 'unmanaged', 'Reason is unmanaged');
  assert(resUnmanaged.writeBatch.length === 0, 'Never writes to unmanaged account');

  // 2. Active Cooldown / HTTP 429 forces W = 0 even with 99% quota
  const cooldownSnap = makeProSnapshot('c2', 99, { isCooldown: true });
  const resCooldown = computeWatermarkTargets([cooldownSnap], policy, state, now);
  assert(resCooldown.targets.get('c2')?.targetWeight === 0, 'Active cooldown forces W=0 regardless of quota');
  assert(resCooldown.targets.get('c2')?.reason === 'cooldown', 'Reason is cooldown');
}

// -----------------------------------------------------------------------------
// Suite 8: Make-Before-Break Ordering & Emergency Bypass
// -----------------------------------------------------------------------------
console.log('\nSuite 8: Make-Before-Break & Emergency Bypass');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  const state = makeInitialState();
  const now = 1700000000000;

  // Scenario 1: Standard transition where one account drains (W drops 100 -> 1) and another promotes (W increases 1 -> 100)
  // Increases must appear before decreases!
  const snaps = [
    makeProSnapshot('p1', 80, { currentWeight: 1 }),   // W will increase 1 -> 100
    makeProSnapshot('p2', 15, { currentWeight: 100 }), // W will decrease 100 -> 1
    makeProSnapshot('p3', 80, { currentWeight: 100 }),
  ];

  const res = computeWatermarkTargets(snaps, policy, state, now);
  const writeBatch = res.writeBatch;

  const idxIncrease = writeBatch.findIndex((w) => w.name === 'p1');
  const idxDecrease = writeBatch.findIndex((w) => w.name === 'p2');
  assert(
    idxIncrease < idxDecrease && idxIncrease !== -1 && idxDecrease !== -1,
    'Make-before-break: write increases (W ↑) execute before write decreases (W ↓)'
  );

  // Scenario 2: Emergency demotion (hard floor breached or 429) outranks make-before-break
  const snapsEmergency = [
    makeProSnapshot('p1', 80, { currentWeight: 1 }), // promotion candidate
    makeProSnapshot('p2', 2, { currentWeight: 100 }),  // hard stop breach <= 5% -> emergency demotion!
    makeProSnapshot('p3', 80, { currentWeight: 100 }),
  ];

  const resEmergency = computeWatermarkTargets(snapsEmergency, policy, state, now);
  const batchEmergency = resEmergency.writeBatch;
  const p2Op = batchEmergency.find((w) => w.name === 'p2');
  assert(p2Op?.isEmergency === true, 'Hard floor eviction marked as emergency write');
  assert(batchEmergency[0].name === 'p2', 'Emergency demotion executes first in writeBatch');
}

// -----------------------------------------------------------------------------
// Suite 9: Invariant Guards (No-Blackout & Hard Floor)
// -----------------------------------------------------------------------------
console.log('\nSuite 9: Invariant Guard Rails');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  const state = makeInitialState();
  const now = 1700000000000;

  // Invariant 3: No-Accidental-Blackout Invariant (sum W > 0 unless all accounts hard-stopped)
  // If an account is not in hard stop but all ended up at 0, no-blackout preserves W=1 on best account
  const snaps = [
    makeProSnapshot('p1', 12, { currentWeight: 0 }),
  ];
  // With 1 account at 12%, normal drain might assign W=1. Let's verify sum W > 0
  const res = computeWatermarkTargets(snaps, policy, state, now);
  let totalW = 0;
  for (const [, target] of res.targets) {
    totalW += target.targetWeight;
  }
  assert(totalW > 0, 'No accidental blackout: sum of weights > 0 when accounts are above hard floor');

  // When ALL managed accounts are hard-stopped (e.g. 2%), sum W = 0 is allowed and expected
  const snapsAllDead = [
    makeProSnapshot('p1', 2, { currentWeight: 100 }),
    makeProSnapshot('p2', 1, { currentWeight: 100 }),
  ];
  const resAllDead = computeWatermarkTargets(snapsAllDead, policy, state, now);
  let totalWDead = 0;
  for (const [, target] of resAllDead.targets) {
    totalWDead += target.targetWeight;
  }
  assert(totalWDead === 0, 'All accounts hard-stopped: sum of weights is 0 (CLIProxy returns 503 for LiteLLM failover)');
}

// -----------------------------------------------------------------------------
// Suite 10: Shadow Mode Write Batch Suppression
// -----------------------------------------------------------------------------
console.log('\nSuite 10: Shadow Mode Write Batch Suppression');
{
  const policy: WatermarkPolicyConfig = { mode: 'shadow' };
  const state = makeInitialState('shadow');
  const now = 1700000000000;
  const snaps = [
    makeProSnapshot('p1', 80, { currentWeight: 0 }),
    makeProSnapshot('p2', 2, { currentWeight: 100 }),
  ];
  const res = computeWatermarkTargets(snaps, policy, state, now);
  assert(res.writeBatch.length === 0, 'Shadow mode produces empty writeBatch');
  assert(res.targets.get('p1')?.targetWeight === 100, 'Shadow mode computes targets for observability');
  assert(res.targets.get('p2')?.targetWeight === 0, 'Shadow mode evaluates hard stop target');
}

// -------------------------------------------------------------
// Suite 11: Anti-Thundering-Herd Ramping Sequence
// -------------------------------------------------------------
console.log('\nSuite 11: Anti-Thundering-Herd Ramping Sequence');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  let state = makeInitialState();
  const now = 1700000000000;

  // Step 0: Account p1 is hard-stopped at 2%, p2 and p3 are healthy at 80% (N=3, K=2, so tier stays normal!)
  const snapHard = [
    makeProSnapshot('p1', 2, { currentWeight: 0 }),
    makeProSnapshot('p2', 80, { currentWeight: 100 }),
    makeProSnapshot('p3', 80, { currentWeight: 100 }),
  ];
  let res = computeWatermarkTargets(snapHard, policy, state, now);
  state = res.nextState;
  assert(res.targets.get('p1')?.targetWeight === 0, 'Ramping: p1 hard-stopped at 0');

  // Step 1: p1 recovers to 50% (well above 8% recovery threshold)
  const snapRecov = [
    makeProSnapshot('p1', 50, { currentWeight: 0 }),
    makeProSnapshot('p2', 80, { currentWeight: 100 }),
    makeProSnapshot('p3', 80, { currentWeight: 100 }),
  ];
  res = computeWatermarkTargets(snapRecov, policy, state, now + 1000);
  state = res.nextState;
  assert(res.targets.get('p1')?.targetWeight === 25, 'Ramping: p1 recovers with first ramp step W=25');
  assert(state.accountStates['p1']?.state === 'ramping', 'Ramping: state is ramping on step 1');

  // Step 2: Second tick -> W=50
  res = computeWatermarkTargets(snapRecov, policy, state, now + 2000);
  state = res.nextState;
  assert(res.targets.get('p1')?.targetWeight === 50, 'Ramping: p1 progresses to second ramp step W=50');
  assert(state.accountStates['p1']?.state === 'ramping', 'Ramping: state is ramping on step 2');

  // Step 3: Third tick -> W=100
  res = computeWatermarkTargets(snapRecov, policy, state, now + 3000);
  state = res.nextState;
  assert(res.targets.get('p1')?.targetWeight === 100, 'Ramping: p1 progresses to full capacity W=100');
  assert(state.accountStates['p1']?.state === 'healthy', 'Ramping: state is healthy on step 3');
  assert(state.rampStep?.['p1'] === undefined, 'Ramping: rampStep cleaned up once W=100');

  // Fallback exit ramp:
  // Setup 3 accounts in collective fallback
  const snapsFallback = [
    makeProSnapshot('f1', 15, { currentWeight: 100 }),
    makeProSnapshot('f2', 15, { currentWeight: 100 }),
    makeProSnapshot('f3', 15, { currentWeight: 100 }),
  ];
  let fbState = makeInitialState();
  res = computeWatermarkTargets(snapsFallback, policy, fbState, now);
  fbState = res.nextState;
  assert(fbState.tierStates['claude:pro'] === 'collective_fallback', 'Fallback exit: tier in collective_fallback');

  // Now all 3 recover to 80% after 600s dwell time
  const snapsRecovered = [
    makeProSnapshot('f1', 80, { currentWeight: 100 }),
    makeProSnapshot('f2', 80, { currentWeight: 100 }),
    makeProSnapshot('f3', 80, { currentWeight: 100 }),
  ];
  const exitNow = now + 650000; // > 600s
  res = computeWatermarkTargets(snapsRecovered, policy, fbState, exitNow);
  fbState = res.nextState;
  assert(fbState.tierStates['claude:pro'] === 'normal', 'Fallback exit: tier exited to normal');
  assert(res.targets.get('f1')?.targetWeight === 25, 'Fallback exit: f1 ramps at W=25');
  assert(res.targets.get('f2')?.targetWeight === 25, 'Fallback exit: f2 ramps at W=25');

  // Next tick: W=50
  res = computeWatermarkTargets(snapsRecovered, policy, fbState, exitNow + 1000);
  fbState = res.nextState;
  assert(res.targets.get('f1')?.targetWeight === 50, 'Fallback exit: f1 ramps to W=50');

  // Next tick: W=100
  res = computeWatermarkTargets(snapsRecovered, policy, fbState, exitNow + 2000);
  fbState = res.nextState;
  assert(res.targets.get('f1')?.targetWeight === 100, 'Fallback exit: f1 reaches W=100');
  assert(fbState.rampStep?.['f1'] === undefined, 'Fallback exit: rampStep cleaned up after reaching W=100');
}

// -------------------------------------------------------------
// Suite 12: Non-Pro Stickiness & Standby Stability
// -------------------------------------------------------------
console.log('\nSuite 12: Non-Pro Stickiness & Standby Stability');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  let state = makeInitialState();
  const now = 1700000000000;

  // Same provider 'antigravity' across all snapshots for this pool
  // Pro accounts are exhausted (0 Pro eligible), Non-Pro active
  // NonPro-B was already active (targetWeight = 100).
  // NonPro-A is healthy. Alphabetically NonPro-A comes first, but stickiness must keep NonPro-B!
  state.accountStates['np-b'] = { state: 'healthy', enteredAt: now, targetWeight: 100 };
  state.accountStates['np-a'] = { state: 'healthy', enteredAt: now, targetWeight: 0 };

  const snaps = [
    makeProSnapshot('pro1', 2, { provider: 'antigravity', currentWeight: 0 }),
    makeNonProSnapshot('np-a', 80, { currentWeight: 0 }),
    makeNonProSnapshot('np-b', 75, { currentWeight: 100 }),
  ];

  let res = computeWatermarkTargets(snaps, policy, state, now);
  state = res.nextState;
  assert(res.targets.get('np-b')?.targetWeight === 100, 'Non-Pro Stickiness: np-b stays active W=100 (not preempted by np-a)');
  assert(res.targets.get('np-a')?.targetWeight === 0, 'Non-Pro Stickiness: np-a stays on standby W=0');

  // Standby stability when Pro recovers:
  // Pro1 recovers to 90%.
  // Active np-b must step down to W=1 (cross_tier_drain_stepdown).
  // Standby np-a must stay at W=0 (standby_pro_active) and NOT oscillate!
  const snapsProBack = [
    makeProSnapshot('pro1', 90, { provider: 'antigravity', currentWeight: 0 }),
    makeNonProSnapshot('np-a', 80, { currentWeight: 0 }),
    makeNonProSnapshot('np-b', 75, { currentWeight: 100 }),
  ];

  // Tick 1
  res = computeWatermarkTargets(snapsProBack, policy, state, now + 1000);
  state = res.nextState;
  assert(res.targets.get('np-b')?.targetWeight === 1, 'Standby Stability: active np-b steps down to W=1');
  assert(res.targets.get('np-a')?.targetWeight === 0, 'Standby Stability: standby np-a stays at W=0');

  // Tick 2: Both non-pro should be at W=0, no oscillation
  res = computeWatermarkTargets(snapsProBack, policy, state, now + 2000);
  state = res.nextState;
  assert(res.targets.get('np-b')?.targetWeight === 0, 'Standby Stability: np-b steps down to W=0 on tick 2');
  assert(res.targets.get('np-a')?.targetWeight === 0, 'Standby Stability: np-a stays at W=0 on tick 2');

  // Tick 3: Both non-pro remain at W=0
  res = computeWatermarkTargets(snapsProBack, policy, state, now + 3000);
  assert(res.targets.get('np-b')?.targetWeight === 0, 'Standby Stability: np-b stable at W=0 on tick 3');
  assert(res.targets.get('np-a')?.targetWeight === 0, 'Standby Stability: np-a stable at W=0 on tick 3');
}

// -----------------------------------------------------------------------------
// Suite 13: Invariant 3 Safety & Violation Observability
// -----------------------------------------------------------------------------
console.log('\nSuite 13: Invariant 3 Safety & Violation Observability');
{
  const policy: WatermarkPolicyConfig = { mode: 'enforce' };
  const state = makeInitialState();
  const now = 1700000000000;

  // Pool with 2 accounts: both breached hard stop (3% and 1%)
  const snaps = [
    makeProSnapshot('dead1', 3, { currentWeight: 100 }),
    makeProSnapshot('dead2', 1, { currentWeight: 100 }),
  ];

  const res = computeWatermarkTargets(snaps, policy, state, now);
  assert(res.targets.get('dead1')?.targetWeight === 0, 'Invariant 3: dead1 is W=0');
  assert(res.targets.get('dead2')?.targetWeight === 0, 'Invariant 3: dead2 is W=0');

  let totalW = 0;
  for (const [, t] of res.targets) {
    totalW += t.targetWeight;
  }
  assert(totalW === 0, 'Invariant 3 Safety: sum(W) === 0, never promotes hard-stopped accounts');
  assert(Array.isArray(res.invariantViolations), 'Invariant Violations: array present on result');
}

console.log('\n========================================');
console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
console.log('========================================\n');

if (failedTests > 0) {
  process.exit(1);
}
