import {
  RoutingConfig,
  DEFAULT_ROUTING,
  validateRoutingConfig,
  PlannerInput,
  WeightPlan,
  headroom,
  planWeights,
} from '../src/services/cpa/routingPlanner';
import type { UsageSnapshot, QuotaBucket } from '../src/models/types';
import type { StatPoint } from '../src/services/stats';

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

function approxEqual(a: number, b: number, eps = 0.05): boolean {
  return Math.abs(a - b) <= eps;
}

function makeSnapshot(
  accountId: string,
  providerType: any,
  planName: string,
  buckets: QuotaBucket[],
  options: { status?: any; isStale?: boolean } = {}
): UsageSnapshot {
  return {
    accountId,
    providerType,
    planName,
    status: options.status ?? 'ok',
    isStale: options.isStale ?? false,
    fetchedAt: new Date().toISOString(),
    buckets,
  };
}

function makeBucket(
  id: string,
  label: string,
  windowType: any,
  remainingPercent: number | null,
  resetsAt: string | null = null,
  isExhausted = false
): QuotaBucket {
  const used = remainingPercent !== null ? 100 - remainingPercent : null;
  return {
    id,
    label,
    windowType,
    remainingPercent,
    utilizationPercent: used,
    resetsAt,
    isExhausted,
    severity: (used ?? 0) >= 100 ? 'exhausted' : (used ?? 0) >= 90 ? 'critical' : 'normal',
  };
}

console.log('\n========================================');
console.log('  CPA ROUTING PLANNER UNIT TESTS (WP4)  ');
console.log('========================================\n');

// ----------------------------------------------------
// Suite 1: Config Validation
// ----------------------------------------------------
console.log('Suite 1: Config Validation');
{
  // Default routing valid
  const defaultCfg = validateRoutingConfig({});
  assert(defaultCfg.mode === 'shadow', 'validateRoutingConfig defaults mode to shadow');
  assert(defaultCfg.wBase === 100, 'validateRoutingConfig defaults wBase to 100');
  assert(defaultCfg.gamma === 1.5, 'validateRoutingConfig defaults gamma to 1.5');
  assert(defaultCfg.coolRemainingPct === 3, 'validateRoutingConfig defaults coolRemainingPct to 3');
  assert(defaultCfg.coolExhaustHours === 0.25, 'validateRoutingConfig defaults coolExhaustHours to 0.25');
  assert(defaultCfg.releaseRemainingPct === 10, 'validateRoutingConfig defaults releaseRemainingPct to 10');
  assert(defaultCfg.minDeltaRatio === 0.25, 'validateRoutingConfig defaults minDeltaRatio to 0.25');
  assert(defaultCfg.minWriteIntervalSec === 300, 'validateRoutingConfig defaults minWriteIntervalSec to 300');
  assert(defaultCfg.maxWritesPerMin === 30, 'validateRoutingConfig defaults maxWritesPerMin to 30');

  // Custom valid config
  const custom = validateRoutingConfig({
    mode: 'enforce',
    wBase: 200,
    gamma: 2.0,
    coolRemainingPct: 5,
    coolExhaustHours: 0.5,
    releaseRemainingPct: 15,
    minDeltaRatio: 0.2,
    minWriteIntervalSec: 60,
    maxWritesPerMin: 10,
  });
  assert(custom.mode === 'enforce' && custom.wBase === 200 && custom.gamma === 2.0, 'Accepts valid custom config');

  // Throws on bad input
  let threw = false;
  try {
    validateRoutingConfig(null);
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on null config');

  threw = false;
  try {
    validateRoutingConfig({ mode: 'invalid' as any });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on invalid mode');

  threw = false;
  try {
    validateRoutingConfig({ wBase: 0 });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on wBase < 1');

  threw = false;
  try {
    validateRoutingConfig({ gamma: 0.2 });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on gamma < 0.5');

  threw = false;
  try {
    validateRoutingConfig({ coolRemainingPct: -1 });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on negative coolRemainingPct');

  threw = false;
  try {
    validateRoutingConfig({ releaseRemainingPct: 60 });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on releaseRemainingPct > 50');

  threw = false;
  try {
    validateRoutingConfig({ minDeltaRatio: 1.5 });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on minDeltaRatio > 1');

  threw = false;
  try {
    validateRoutingConfig({ minWriteIntervalSec: -10 });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on minWriteIntervalSec < 0');

  threw = false;
  try {
    validateRoutingConfig({ maxWritesPerMin: 0 });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Throws on maxWritesPerMin < 1');
}

// ----------------------------------------------------
// Suite 2: Full capacity gives weight proportional to plan
// ----------------------------------------------------
console.log('\nSuite 2: Full capacity plan weighting (Max 20x 2000 vs Pro 100)');
{
  const now = Date.now();
  const resetIso = new Date(now + 4 * 3600000).toISOString();

  // 100% capacity on session & weekly
  const proBuckets = [
    makeBucket('b1', 'Session', 'session_5h', 100, resetIso),
    makeBucket('b2', 'Weekly', 'weekly_7d', 100, new Date(now + 48 * 3600000).toISOString()),
  ];
  const maxBuckets = [
    makeBucket('b1', 'Session', 'session_5h', 100, resetIso),
    makeBucket('b2', 'Weekly', 'weekly_7d', 100, new Date(now + 48 * 3600000).toISOString()),
  ];

  const snapPro = makeSnapshot('acc-pro', 'anthropic', 'Pro', proBuckets);
  const snapMax = makeSnapshot('acc-max', 'anthropic', 'Max 20x', maxBuckets);

  const hPro = headroom(snapPro, [], now);
  const hMax = headroom(snapMax, [], now);

  assert(approxEqual(hPro, 1.0), 'Headroom at full capacity is 1.0 for Pro');
  assert(approxEqual(hMax, 1.0), 'Headroom at full capacity is 1.0 for Max 20x');

  const inputs: PlannerInput[] = [
    {
      accountId: 'acc-pro',
      provider: 'anthropic',
      cpaName: 'cpa-pro',
      plan: 'Pro',
      snapshot: snapPro,
      history: [],
      currentWeight: null,
      managed: true,
    },
    {
      accountId: 'acc-max',
      provider: 'anthropic',
      cpaName: 'cpa-max',
      plan: 'Max 20x',
      snapshot: snapMax,
      history: [],
      currentWeight: null,
      managed: true,
    },
  ];

  const plans = planWeights(inputs, DEFAULT_ROUTING, now);
  const planPro = plans.find((p) => p.accountId === 'acc-pro');
  const planMax = plans.find((p) => p.accountId === 'acc-max');

  assert(planPro !== undefined && planPro.target === 100, 'Pro account target weight is 100 (100 * 1 * 1.0^1.5)');
  assert(planMax !== undefined && planMax.target === 2000, 'Max 20x account target weight is 2000 (100 * 20 * 1.0^1.5)');
  assert(planPro?.write === true, 'First plan write is true when currentWeight is null');
  assert(planPro?.reason === 'headroom', 'Reason is headroom');
}

// ----------------------------------------------------
// Suite 3: Burn rate pace factor & reduced weights
// ----------------------------------------------------
console.log('\nSuite 3: Remaining 50% with burn exhausting before reset gives reduced weight');
{
  const now = 10000000;
  // Window resets in 4 hours (h = 4)
  const resetIso = new Date(now + 4 * 3600000).toISOString();
  const buckets = [makeBucket('b1', 'Session', 'session_5h', 50, resetIso)];
  const snap = makeSnapshot('acc-burn', 'anthropic', 'Pro', buckets);

  // 1. History with heavy burn: used grew from 30% to 50% in 1 hour -> burn = 20%/h
  // At remaining = 50% and burn = 20%/h, time to exhaust e = 50 / 20 = 2.5h.
  // Since e (2.5h) < h (4.0h), paceFactor = e / h = 2.5 / 4 = 0.625.
  // Headroom score = (50 / 100) * 0.625 = 0.5 * 0.625 = 0.3125.
  const history: StatPoint[] = [
    { accountId: 'acc-burn', t: now - 3600000, session: 30, weekly: null },
    { accountId: 'acc-burn', t: now, session: 50, weekly: null },
  ];

  const hScore = headroom(snap, history, now);
  assert(approxEqual(hScore, 0.3125, 0.01), `Pace factor reduces headroom to ~0.3125 (got ${hScore.toFixed(4)})`);

  const input: PlannerInput = {
    accountId: 'acc-burn',
    provider: 'anthropic',
    cpaName: 'cpa-burn',
    plan: 'Pro',
    snapshot: snap,
    history,
    currentWeight: 100,
    managed: true,
  };

  const plans = planWeights([input], DEFAULT_ROUTING, now);
  // Target weight = round(100 * 1 * (0.3125)^1.5) = round(100 * 0.1747) = 17
  assert(plans[0].target === 17, `Target weight reduced to 17 under burn rate (got ${plans[0].target})`);
  assert(plans[0].reason === 'headroom', 'Reason is headroom');
  assert(plans[0].write === true, 'Write flag is true because delta is |17 - 100| / 100 = 83% >= 25%');
}

// ----------------------------------------------------
// Suite 4: Exhaustion, near-exhaust, and release hysteresis
// ----------------------------------------------------
console.log('\nSuite 4: Exhaustion → 0, near_exhaust → 0, release only after reset or >= 10%');
{
  const now = Date.now();
  const futureReset = new Date(now + 2 * 3600000).toISOString();

  // Baseline healthy account so starvation guard does not kick in
  const healthyPartner: PlannerInput = {
    accountId: 'acc-healthy',
    provider: 'anthropic',
    cpaName: 'cpa-healthy',
    plan: 'Pro',
    snapshot: makeSnapshot('acc-healthy', 'anthropic', 'Pro', [
      makeBucket('b_h', 'Session', 'session_5h', 80, futureReset),
    ]),
    history: [],
    currentWeight: 100,
    managed: true,
  };

  // Case 4A: Fully exhausted (0% remaining)
  const exhaustedSnap = makeSnapshot('acc-ex', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 0, futureReset, true),
  ]);
  const planEx = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-ex',
        provider: 'anthropic',
        cpaName: 'cpa-ex',
        plan: 'Pro',
        snapshot: exhaustedSnap,
        history: [],
        currentWeight: 100,
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pEx = planEx.find((p) => p.accountId === 'acc-ex')!;
  assert(pEx.target === 0, 'Exhausted account target is 0');
  assert(pEx.cooldown === true, 'Exhausted account cooldown is true');
  assert(pEx.reason === 'exhausted', 'Reason is exhausted');
  assert(pEx.write === true, 'Transition from 100 to 0 triggers immediate write');

  // Case 4B: Near exhaust (< 3% remaining: e.g. 2% remaining)
  const nearExSnap = makeSnapshot('acc-near', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 2, futureReset),
  ]);
  const planNear = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-near',
        provider: 'anthropic',
        cpaName: 'cpa-near',
        plan: 'Pro',
        snapshot: nearExSnap,
        history: [],
        currentWeight: 50,
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pNear = planNear.find((p) => p.accountId === 'acc-near')!;
  assert(pNear.target === 0, 'Near exhaust (<3%) target is 0');
  assert(pNear.reason === 'near_exhaust', 'Reason is near_exhaust');

  // Case 4C: Cooldown release blocked when remaining < 10% and not reset (e.g. 6% remaining)
  const midRecoverySnap = makeSnapshot('acc-mid', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 6, futureReset),
  ]);
  const planMid = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-mid',
        provider: 'anthropic',
        cpaName: 'cpa-mid',
        plan: 'Pro',
        snapshot: midRecoverySnap,
        history: [],
        currentWeight: 0,
        prev: { applied: 0, at: now - 600 * 1000, cooldown: true },
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pMid = planMid.find((p) => p.accountId === 'acc-mid')!;
  assert(pMid.target === 0, 'Cooldown is retained at 6% remaining (<10% release threshold)');
  assert(pMid.cooldown === true, 'Still in cooldown');
  assert(pMid.write === false, 'No write while remaining at 0');

  // Case 4D: Cooldown released when remaining >= 10% (e.g. 15% remaining)
  const recoveredSnap = makeSnapshot('acc-rec', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 15, futureReset),
  ]);
  const planRec = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-rec',
        provider: 'anthropic',
        cpaName: 'cpa-rec',
        plan: 'Pro',
        snapshot: recoveredSnap,
        history: [],
        currentWeight: 0,
        prev: { applied: 0, at: now - 600 * 1000, cooldown: true },
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pRec = planRec.find((p) => p.accountId === 'acc-rec')!;
  assert(pRec.target > 0, 'Cooldown released when remaining >= 10%');
  assert(pRec.cooldown === false, 'Cooldown is false after release');
  assert(pRec.reason === 'released', 'Reason is released');
  assert(pRec.write === true, 'Write flag is true on transition from 0 to >0');

  // Case 4E: Cooldown released when now >= resetsAt even if remaining < 10%
  const pastReset = new Date(now - 1000).toISOString();
  const resetSnap = makeSnapshot('acc-reset', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 5, pastReset),
  ]);
  const planReset = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-reset',
        provider: 'anthropic',
        cpaName: 'cpa-reset',
        plan: 'Pro',
        snapshot: resetSnap,
        history: [],
        currentWeight: 0,
        prev: { applied: 0, at: now - 600 * 1000, cooldown: true },
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pReset = planReset.find((p) => p.accountId === 'acc-reset')!;
  assert(pReset.target > 0, 'Cooldown released after window reset');
  assert(pReset.reason === 'released', 'Reason is released after reset');
}

// ----------------------------------------------------
// Suite 5: Hysteresis & Min interval write gating
// ----------------------------------------------------
console.log('\nSuite 5: Hysteresis (10% delta does not write, 30% delta writes, min interval hold back)');
{
  const now = Date.now();
  const resetIso = new Date(now + 4 * 3600000).toISOString();

  // Baseline healthy account so starvation guard does not kick in
  const healthyPartner: PlannerInput = {
    accountId: 'acc-healthy-5',
    provider: 'anthropic',
    cpaName: 'cpa-healthy-5',
    plan: 'Pro',
    snapshot: makeSnapshot('acc-healthy-5', 'anthropic', 'Pro', [
      makeBucket('b_h5', 'Session', 'session_5h', 80, resetIso),
    ]),
    history: [],
    currentWeight: 100,
    managed: true,
  };

  // Suppose target weight is 100
  const fullSnap = makeSnapshot('acc-hys', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 100, resetIso),
  ]);

  // 10% delta: currentWeight = 95 -> target = 100.
  // Delta ratio = |100 - 95| / 95 = 5.26% < 25% threshold
  const planSmallDelta = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-hys',
        provider: 'anthropic',
        cpaName: 'cpa-hys',
        plan: 'Pro',
        snapshot: fullSnap,
        history: [],
        currentWeight: 95,
        prev: { applied: 95, at: now - 400 * 1000, cooldown: false },
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pHysSmall = planSmallDelta.find((p) => p.accountId === 'acc-hys')!;
  assert(pHysSmall.target === 100, 'Target is 100');
  assert(pHysSmall.write === false, 'Small delta (~5%) does not write (minDeltaRatio = 0.25)');

  // 30% delta: currentWeight = 70 -> target = 100.
  // Delta ratio = |100 - 70| / 70 = 42.8% >= 25% threshold
  // With elapsed time > minWriteIntervalSec (400s > 300s)
  const planLargeDelta = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-hys',
        provider: 'anthropic',
        cpaName: 'cpa-hys',
        plan: 'Pro',
        snapshot: fullSnap,
        history: [],
        currentWeight: 70,
        prev: { applied: 70, at: now - 400 * 1000, cooldown: false },
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pHysLarge = planLargeDelta.find((p) => p.accountId === 'acc-hys')!;
  assert(pHysLarge.target === 100, 'Target is 100');
  assert(pHysLarge.write === true, 'Large delta (42.8%) writes when interval elapsed');

  // Large delta but elapsed time < minWriteIntervalSec (e.g. 120s < 300s) -> write blocked
  const planTimeBlocked = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-hys',
        provider: 'anthropic',
        cpaName: 'cpa-hys',
        plan: 'Pro',
        snapshot: fullSnap,
        history: [],
        currentWeight: 70,
        prev: { applied: 70, at: now - 120 * 1000, cooldown: false },
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pHysBlocked = planTimeBlocked.find((p) => p.accountId === 'acc-hys')!;
  assert(pHysBlocked.write === false, 'Min interval (120s < 300s) holds write back');

  // Immediate write on transition to 0 even if within min interval
  const zeroSnap = makeSnapshot('acc-hys', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 0, resetIso, true),
  ]);
  const planImmediateZero = planWeights(
    [
      healthyPartner,
      {
        accountId: 'acc-hys',
        provider: 'anthropic',
        cpaName: 'cpa-hys',
        plan: 'Pro',
        snapshot: zeroSnap,
        history: [],
        currentWeight: 70,
        prev: { applied: 70, at: now - 60 * 1000, cooldown: false }, // only 60s ago
        managed: true,
      },
    ],
    DEFAULT_ROUTING,
    now
  );
  const pHysZero = planImmediateZero.find((p) => p.accountId === 'acc-hys')!;
  assert(pHysZero.target === 0, 'Target drops to 0');
  assert(pHysZero.write === true, 'Transition to 0 writes immediately despite min interval');
}

// ----------------------------------------------------
// Suite 6: Starvation Guard
// ----------------------------------------------------
console.log('\nSuite 6: Starvation guard (all accounts at 0 → earliest reset gets weight 1)');
{
  const now = 10000000;
  const resetEarly = new Date(now + 1 * 3600000).toISOString();
  const resetLate = new Date(now + 3 * 3600000).toISOString();

  // Two accounts for anthropic, both exhausted
  const snap1 = makeSnapshot('acc-1', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 0, resetLate, true),
  ]);
  const snap2 = makeSnapshot('acc-2', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 0, resetEarly, true),
  ]);

  const inputs: PlannerInput[] = [
    {
      accountId: 'acc-1',
      provider: 'anthropic',
      cpaName: 'cpa-1',
      plan: 'Pro',
      snapshot: snap1,
      history: [],
      currentWeight: 0,
      managed: true,
    },
    {
      accountId: 'acc-2',
      provider: 'anthropic',
      cpaName: 'cpa-2',
      plan: 'Pro',
      snapshot: snap2,
      history: [],
      currentWeight: 0,
      managed: true,
    },
  ];

  const plans = planWeights(inputs, DEFAULT_ROUTING, now);
  const p1 = plans.find((p) => p.accountId === 'acc-1');
  const p2 = plans.find((p) => p.accountId === 'acc-2');

  assert(p1 !== undefined && p1.target === 0, 'acc-1 with later reset stays 0');
  assert(p2 !== undefined && p2.target === 1, 'acc-2 with earlier reset gets weight 1');
  assert(p2?.reason === 'starvation_guard', 'acc-2 reason is starvation_guard');
  assert(p2?.cooldown === false, 'acc-2 cooldown cleared by starvation guard');
  assert(p2?.write === true, 'acc-2 write is true (transition 0 -> 1)');
}

// ----------------------------------------------------
// Suite 7: Unmanaged accounts guard
// ----------------------------------------------------
console.log('\nSuite 7: Unmanaged accounts guard (managed: false → write: false, reason: unmanaged)');
{
  const now = 10000000;
  const resetIso = new Date(now + 4 * 3600000).toISOString();
  const snap = makeSnapshot('acc-unman', 'anthropic', 'Pro', [
    makeBucket('b1', 'Session', 'session_5h', 100, resetIso),
  ]);

  const input: PlannerInput = {
    accountId: 'acc-unman',
    provider: 'anthropic',
    cpaName: 'cpa-unman',
    plan: 'Pro',
    snapshot: snap,
    history: [],
    currentWeight: 50,
    managed: false, // human edited
  };

  const plans = planWeights([input], DEFAULT_ROUTING, now);
  assert(plans[0].reason === 'unmanaged', 'Reason is unmanaged');
  assert(plans[0].write === false, 'Never writes to unmanaged account');
  assert(plans[0].target === 100, 'Still computes informational target for unmanaged account');
}

// ----------------------------------------------------
// Suite 8: Stale snapshots guard
// ----------------------------------------------------
console.log('\nSuite 8: Stale snapshots guard (stale or error → write: false, reason: stale)');
{
  const now = 10000000;
  // Baseline healthy account so starvation guard does not kick in
  const healthyPartner: PlannerInput = {
    accountId: 'acc-healthy-8',
    provider: 'anthropic',
    cpaName: 'cpa-healthy-8',
    plan: 'Pro',
    snapshot: makeSnapshot('acc-healthy-8', 'anthropic', 'Pro', [
      makeBucket('b_h8', 'Session', 'session_5h', 80),
    ]),
    history: [],
    currentWeight: 100,
    managed: true,
  };

  // Error status snapshot
  const errSnap = makeSnapshot(
    'acc-err',
    'anthropic',
    'Pro',
    [],
    { status: 'error' }
  );

  // Stale flagged snapshot
  const staleSnap = makeSnapshot(
    'acc-stale',
    'anthropic',
    'Pro',
    [makeBucket('b1', 'Session', 'session_5h', 80)],
    { isStale: true }
  );

  const inputs: PlannerInput[] = [
    healthyPartner,
    {
      accountId: 'acc-err',
      provider: 'anthropic',
      cpaName: 'cpa-err',
      plan: 'Pro',
      snapshot: errSnap,
      history: [],
      currentWeight: 100,
      managed: true,
    },
    {
      accountId: 'acc-stale',
      provider: 'anthropic',
      cpaName: 'cpa-stale',
      plan: 'Pro',
      snapshot: staleSnap,
      history: [],
      currentWeight: 100,
      managed: true,
    },
    {
      accountId: 'acc-missing',
      provider: 'anthropic',
      cpaName: 'cpa-missing',
      plan: 'Pro',
      snapshot: undefined,
      history: [],
      currentWeight: 100,
      managed: true,
    },
  ];

  const plans = planWeights(inputs, DEFAULT_ROUTING, now);
  const testPlans = plans.filter((p) => p.accountId !== 'acc-healthy-8');
  for (const p of testPlans) {
    assert(p.reason === 'stale', `${p.accountId} reason is stale`);
    assert(p.write === false, `${p.accountId} write is false`);
    assert(p.headroom === 0, `${p.accountId} headroom is 0`);
  }
}

// ----------------------------------------------------
// Suite 9: Determinism & Antigravity provider remaining
// ----------------------------------------------------
console.log('\nSuite 9: Determinism & Antigravity provider remaining (no burn rate)');
{
  const now = 10000000;
  const resetIso = new Date(now + 4 * 3600000).toISOString();

  // Antigravity buckets
  const agyBuckets = [
    makeBucket('gemini_session_5h', 'Gemini Flash', 'session_5h', 80, resetIso),
    makeBucket('argon_session_5h', 'Claude 3.5 Sonnet', 'session_5h', 40, resetIso),
  ];
  const agySnap = makeSnapshot('acc-agy', 'antigravity', 'Free', agyBuckets);

  // Binding is the minimum remaining (40%)
  const h = headroom(agySnap, [], now);
  assert(approxEqual(h, 0.4), `Antigravity headroom matches binding remaining 40% (got ${h})`);

  const input: PlannerInput = {
    accountId: 'acc-agy',
    provider: 'antigravity',
    cpaName: 'cpa-agy',
    plan: 'Free',
    snapshot: agySnap,
    history: [],
    currentWeight: null,
    managed: true,
  };

  // Run 1
  const run1 = planWeights([input], DEFAULT_ROUTING, now);
  // Run 2
  const run2 = planWeights([input], DEFAULT_ROUTING, now);

  assert(JSON.stringify(run1) === JSON.stringify(run2), 'planWeights is completely deterministic');
  // target = round(100 * 1 * (0.4)^1.5) = round(100 * 0.25298) = 25
  assert(run1[0].target === 25, `Antigravity target is 25 (got ${run1[0].target})`);
}

// ----------------------------------------------------
// Suite 10: Mode 'off' returns empty list
// ----------------------------------------------------
console.log('\nSuite 10: Mode "off" returns empty list');
{
  const offCfg: RoutingConfig = { ...DEFAULT_ROUTING, mode: 'off' };
  const plans = planWeights(
    [
      {
        accountId: 'acc-off',
        provider: 'anthropic',
        cpaName: 'cpa-off',
        plan: 'Pro',
        history: [],
        currentWeight: 100,
        managed: true,
      },
    ],
    offCfg,
    Date.now()
  );
  assert(plans.length === 0, 'Mode "off" returns empty plan array');
}

console.log(`\n========================================`);
console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
console.log(`========================================\n`);

if (failedTests > 0) {
  process.exit(1);
}
