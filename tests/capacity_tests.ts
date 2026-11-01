import {
  severityOf,
  severityRank,
  resolveRingWindows,
  dualRingData,
  aggregateFamily,
  groupFamilies,
  planWeight,
  PLAN_WEIGHTS,
  arcPath,
  familySlots,
  ringA11yLabel,
  AccountFamilyMember,
  FamilySummary,
} from '../src/services/capacity';
import { SEVERITY_COLORS, severityColor, SeverityTokens } from '../src/constants/theme';
import { QuotaBucket } from '../src/models/types';

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

console.log('\n========================================');
console.log('  CAPACITY & DUAL-RING UNIT TESTS (P0)  ');
console.log('========================================\n');

// ----------------------------------------------------
// Suite 1: Severity thresholds & rank
// ----------------------------------------------------
console.log('Suite 1: Severity thresholds & rank');
{
  assert(severityOf(100) === 'healthy', 'severityOf: 100 -> healthy');
  assert(severityOf(50) === 'healthy', 'severityOf: 50 -> healthy');
  assert(severityOf(36) === 'healthy', 'severityOf: 36 -> healthy');
  assert(severityOf(35) === 'warning', 'severityOf: 35 -> warning');
  assert(severityOf(25) === 'warning', 'severityOf: 25 -> warning');
  assert(severityOf(21) === 'warning', 'severityOf: 21 -> warning');
  assert(severityOf(20) === 'critical', 'severityOf: 20 -> critical');
  assert(severityOf(15) === 'critical', 'severityOf: 15 -> critical');
  assert(severityOf(11) === 'critical', 'severityOf: 11 -> critical');
  assert(severityOf(10) === 'exhausted', 'severityOf: 10 -> exhausted');
  assert(severityOf(5) === 'exhausted', 'severityOf: 5 -> exhausted');
  assert(severityOf(0) === 'exhausted', 'severityOf: 0 -> exhausted');
  assert(severityOf(-5) === 'exhausted', 'severityOf: negative -> exhausted');
  assert(severityOf(null) === 'unknown', 'severityOf: null -> unknown');
  assert(severityOf(undefined as any) === 'unknown', 'severityOf: undefined -> unknown');
  assert(severityOf(NaN) === 'unknown', 'severityOf: NaN -> unknown');

  // severityRank
  assert(severityRank('unknown') < severityRank('healthy'), 'severityRank: unknown < healthy');
  assert(severityRank('healthy') < severityRank('warning'), 'severityRank: healthy < warning');
  assert(severityRank('warning') < severityRank('critical'), 'severityRank: warning < critical');
  assert(severityRank('critical') < severityRank('exhausted'), 'severityRank: critical < exhausted');

  // Theme colors
  assert(SEVERITY_COLORS.healthy === '#1f9d74', 'SEVERITY_COLORS healthy matches spec');
  assert(SEVERITY_COLORS.warning === '#d97706', 'SEVERITY_COLORS warning matches spec');
  assert(SEVERITY_COLORS.critical === '#ea580c', 'SEVERITY_COLORS critical matches spec');
  assert(SEVERITY_COLORS.exhausted === '#dc2626', 'SEVERITY_COLORS exhausted matches spec');
  assert(SEVERITY_COLORS.unknown === '#a1a1aa', 'SEVERITY_COLORS unknown matches spec');

  assert(severityColor(100) === '#1f9d74', 'severityColor(100) -> healthy color');
  assert(severityColor(30) === '#d97706', 'severityColor(30) -> warning color');
  assert(severityColor(15) === '#ea580c', 'severityColor(15) -> critical color');
  assert(severityColor(0) === '#dc2626', 'severityColor(0) -> exhausted color');
  assert(severityColor(null) === '#a1a1aa', 'severityColor(null) -> unknown color');
  assert(severityColor(100, 'gemini') === '#3b5bdb', 'severityColor(100, gemini) preserves ringBlue');
}

// ----------------------------------------------------
// Suite 2: Dual-ring resolution & binding
// ----------------------------------------------------
console.log('\nSuite 2: Dual-ring resolution & binding');
{
  const b5h: QuotaBucket = {
    id: 'b5h',
    label: '5-hour',
    windowType: 'session_5h',
    windowSeconds: 18000,
    utilizationPercent: 10,
    remainingPercent: 90,
  };
  const bWeekly: QuotaBucket = {
    id: 'b7d',
    label: 'Weekly',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    utilizationPercent: 65,
    remainingPercent: 35,
  };

  // 5h=90, weekly=35 -> binding=weekly (35%), outer=weekly, inner=5h, severity=warning
  const res = resolveRingWindows([b5h, bWeekly]);
  assert(res.inner?.remaining === 90, 'Dual-ring: inner is 5h (90%)');
  assert(res.outer?.remaining === 35, 'Dual-ring: outer is weekly (35%)');
  assert(res.binding === res.outer, 'Dual-ring: binding is weekly');
  assert(res.effectiveRemaining === 35, 'Dual-ring: effectiveRemaining is 35%');
  assert(res.severity === 'warning', 'Dual-ring: severity is warning');

  // Case with weekly=40 -> healthy
  const bWeekly40: QuotaBucket = { ...bWeekly, remainingPercent: 40, utilizationPercent: 60 };
  const resWeekly40 = resolveRingWindows([b5h, bWeekly40]);
  assert(resWeekly40.effectiveRemaining === 40, 'Dual-ring: 5h=90, weekly=40 -> effective is 40%');
  assert(resWeekly40.binding === resWeekly40.outer, 'Dual-ring: 5h=90, weekly=40 -> binding=weekly');
  assert(resWeekly40.outer?.remaining === 40, 'Dual-ring: outer is weekly (40%)');
  assert(resWeekly40.inner?.remaining === 90, 'Dual-ring: inner is 5h (90%)');
  assert(resWeekly40.severity === 'healthy', 'Dual-ring: 40% is healthy under >35 scale');

  // Case where 5h is lower: 5h=15, weekly=80 -> binding=5h (15%), severity=critical
  const b5hLow: QuotaBucket = { ...b5h, remainingPercent: 15, utilizationPercent: 85 };
  const res2 = resolveRingWindows([b5hLow, bWeekly]);
  assert(res2.binding === res2.inner, 'Dual-ring: binding is 5h when 5h is lower');
  assert(res2.effectiveRemaining === 15, 'Dual-ring: effectiveRemaining is 15%');
  assert(res2.severity === 'critical', 'Dual-ring: severity is critical');
}

// ----------------------------------------------------
// Suite 3: Single-ring fallbacks
// ----------------------------------------------------
console.log('\nSuite 3: Single-ring fallbacks');
{
  // Sliding window (Cursor / Copilot recipes)
  const sliding: QuotaBucket = {
    id: 'slide',
    label: 'Sliding limit',
    windowType: 'sliding_window',
    windowSeconds: 86400,
    utilizationPercent: 30,
    remainingPercent: 70,
  };
  const resSliding = resolveRingWindows([sliding]);
  assert(resSliding.outer?.remaining === 70, 'Single sliding: outer has remaining 70%');
  assert(resSliding.outer?.short === 'limit', 'Single sliding: outer short is limit');
  assert(resSliding.inner === null, 'Single sliding: inner is null');
  assert(resSliding.binding === resSliding.outer, 'Single sliding: binding is outer');
  assert(resSliding.effectiveRemaining === 70, 'Single sliding: effective is 70%');

  // Single session_5h
  const single5h: QuotaBucket = {
    id: 's5h',
    label: 'Session',
    windowType: 'session_5h',
    windowSeconds: 18000,
    utilizationPercent: 45,
    remainingPercent: 55,
  };
  const res5h = resolveRingWindows([single5h]);
  assert(res5h.outer?.remaining === 55, 'Single 5h: outer has remaining 55%');
  assert(res5h.outer?.short === '5h', 'Single 5h: outer short is 5h');
  assert(res5h.inner === null, 'Single 5h: inner is null');

  // Single weekly_7d
  const single7d: QuotaBucket = {
    id: 's7d',
    label: 'Weekly',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    utilizationPercent: 80,
    remainingPercent: 20,
  };
  const res7d = resolveRingWindows([single7d]);
  assert(res7d.outer?.remaining === 20, 'Single weekly: outer has remaining 20%');
  assert(res7d.outer?.short === '7d', 'Single weekly: outer short is 7d');
  assert(res7d.inner === null, 'Single weekly: inner is null');

  // Empty / undefined buckets
  const emptyRes = resolveRingWindows([]);
  assert(emptyRes.outer === null && emptyRes.inner === null, 'Empty buckets: null rings');
  assert(emptyRes.effectiveRemaining === null, 'Empty buckets: effective null');
  assert(emptyRes.severity === 'unknown', 'Empty buckets: severity unknown');
}

// ----------------------------------------------------
// Suite 4: Claude multi-weekly buckets
// ----------------------------------------------------
console.log('\nSuite 4: Claude multi-weekly buckets');
{
  const b5h: QuotaBucket = {
    id: 'claude_5h',
    label: '5-hour',
    windowType: 'session_5h',
    windowSeconds: 18000,
    utilizationPercent: 8,
    remainingPercent: 92,
  };
  const bWeeklyAll: QuotaBucket = {
    id: 'claude_weekly',
    label: 'Weekly',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    utilizationPercent: 60,
    remainingPercent: 40,
  };
  const bWeeklyOpus: QuotaBucket = {
    id: 'claude_opus',
    label: 'Weekly · Opus',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    utilizationPercent: 75,
    remainingPercent: 25,
  };
  const bWeeklySonnet: QuotaBucket = {
    id: 'claude_sonnet',
    label: 'Weekly · Sonnet',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    utilizationPercent: 50,
    remainingPercent: 50,
  };

  // Outer ring should pick the lowest remaining weekly bucket (Opus at 25%)
  const res = resolveRingWindows([b5h, bWeeklyAll, bWeeklyOpus, bWeeklySonnet]);
  assert(res.outer?.remaining === 25, 'Claude multi-weekly: outer picks lowest remaining (25%)');
  assert(res.outer?.bucket.id === 'claude_opus', 'Claude multi-weekly: outer bucket is Opus');
  assert(res.inner?.remaining === 92, 'Claude multi-weekly: inner is 5h (92%)');
  assert(res.effectiveRemaining === 25, 'Claude multi-weekly: effective is 25% (binding on Opus)');
  assert(res.binding?.bucket.id === 'claude_opus', 'Claude multi-weekly: binding is Opus');
}

// ----------------------------------------------------
// Suite 5: Antigravity multi-family resolution
// ----------------------------------------------------
console.log('\nSuite 5: Antigravity multi-family resolution');
{
  const gemini5h: QuotaBucket = {
    id: 'gemini_5h',
    label: 'Gemini · 5-hour',
    windowType: 'session_5h',
    windowSeconds: 18000,
    remainingPercent: 60,
    details: { family: 'gemini' },
  };
  const geminiWeekly: QuotaBucket = {
    id: 'gemini_weekly',
    label: 'Gemini · Weekly',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    remainingPercent: 85,
    details: { family: 'gemini' },
  };
  const p3Weekly: QuotaBucket = {
    id: '3p_weekly',
    label: '3P · Weekly',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    remainingPercent: 62,
    details: { family: '3p' },
  };
  const argonWeekly: QuotaBucket = {
    id: 'argon_weekly',
    label: 'Argon · Weekly',
    windowType: 'weekly_7d',
    windowSeconds: 604800,
    remainingPercent: 90,
    details: { family: 'argon' },
  };

  const res = resolveRingWindows([gemini5h, geminiWeekly, p3Weekly, argonWeekly]);
  assert(res.inner?.remaining === 60, 'Antigravity: inner is gemini 5h (60%)');
  assert(res.outer?.remaining === 85, 'Antigravity: outer is gemini weekly (85%)');
  assert(res.effectiveRemaining === 60, 'Antigravity: effective is 60% (binding on 5h)');
  assert(res.extras.length === 2, 'Antigravity: exactly 2 extra families extracted');
  assert(res.extras[0].short === '3P' && res.extras[0].remaining === 62, 'Antigravity: extra 0 is 3P 62%');
  assert(res.extras[1].short === 'Argon' && res.extras[1].remaining === 90, 'Antigravity: extra 1 is Argon 90%');
}

// ----------------------------------------------------
// Suite 6: Family aggregation math & plan weights
// ----------------------------------------------------
console.log('\nSuite 6: Family aggregation math & plan weights');
{
  const now = 1700000000000;
  const in1h = new Date(now + 3600 * 1000).toISOString();
  const in3h = new Date(now + 3 * 3600 * 1000).toISOString();
  const in5h = new Date(now + 5 * 3600 * 1000).toISOString();

  // Test scenario: 3 accounts (30%, 25%, 15%)
  // poolUnits = (30 + 25 + 15) / 100 = 0.70
  // poolPct = 70 / 3 = 23.3%
  // poolMax = 3
  const members: AccountFamilyMember[] = [
    {
      id: 'acc1',
      name: 'Account 1',
      providerType: 'claude',
      plan: 'Pro',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        planName: 'Pro',
        buckets: [
          { id: 'b1', label: '5h', windowType: 'session_5h', remainingPercent: 30, resetsAt: in3h },
        ],
      },
    },
    {
      id: 'acc2',
      name: 'Account 2',
      providerType: 'claude',
      plan: 'Pro',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        planName: 'Pro',
        buckets: [
          { id: 'b2', label: '5h', windowType: 'session_5h', remainingPercent: 25, resetsAt: in1h },
        ],
      },
    },
    {
      id: 'acc3',
      name: 'Account 3',
      providerType: 'claude',
      plan: 'Pro',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        planName: 'Pro',
        buckets: [
          { id: 'b3', label: '5h', windowType: 'session_5h', remainingPercent: 15, resetsAt: in5h },
        ],
      },
    },
  ];

  const summary = aggregateFamily('claude', members, 'equal', now);
  assert(approxEqual(summary.poolUnits, 0.70, 0.001), 'Family aggregation: poolUnits is 0.70');
  assert(summary.poolMax === 3, 'Family aggregation: poolMax is 3');
  assert(summary.poolPct !== null && approxEqual(summary.poolPct, 23.3, 0.1), 'Family aggregation: poolPct is 23.3%');
  assert(summary.earliestReset?.accountId === 'acc2', 'Family aggregation: earliestReset is acc2 (in 1h)');
  assert(summary.nextFullRefill?.accountId === 'acc2', 'Family aggregation: nextFullRefill is acc2');

  // Plan weights
  assert(planWeight('Max 20x') === 20, 'planWeight: Max 20x -> 20');
  assert(planWeight('Max 5x') === 5, 'planWeight: Max 5x -> 5');
  assert(planWeight('Max') === 5, 'planWeight: Max -> 5');
  assert(planWeight('Pro') === 1, 'planWeight: Pro -> 1');
  assert(planWeight('Plus') === 1, 'planWeight: Plus -> 1');
  assert(planWeight('Free') === 1, 'planWeight: unknown/free -> 1');

  // Weighted aggregation: Pro@0% + Max20x@80%
  // poolUnits = 1*0 + 20*0.80 = 16.0 Pro-eq
  // poolMax = 1 + 20 = 21
  // poolPct = 16 / 21 * 100 = 76.2%
  const weightedMembers: AccountFamilyMember[] = [
    {
      id: 'w1',
      name: 'Pro Account',
      providerType: 'claude',
      plan: 'Pro',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'wb1', label: '5h', windowType: 'session_5h', remainingPercent: 0 }],
      },
    },
    {
      id: 'w2',
      name: 'Max20x Account',
      providerType: 'claude',
      plan: 'Max 20x',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'wb2', label: '5h', windowType: 'session_5h', remainingPercent: 80 }],
      },
    },
  ];
  const weightedSummary = aggregateFamily('claude', weightedMembers, 'plan', now);
  assert(approxEqual(weightedSummary.poolUnits, 16.0, 0.01), 'Weighted aggregation: poolUnits is 16.0 Pro-eq');
  assert(weightedSummary.poolMax === 21, 'Weighted aggregation: poolMax is 21');
  assert(weightedSummary.poolPct !== null && approxEqual(weightedSummary.poolPct, 76.2, 0.1), 'Weighted aggregation: poolPct is 76.2%');
}

// ----------------------------------------------------
// Suite 7: "Use next" recommendation logic
// ----------------------------------------------------
console.log('\nSuite 7: "Use next" recommendation');
{
  const now = 1700000000000;
  const in2h = new Date(now + 2 * 3600 * 1000).toISOString();
  const in4h = new Date(now + 4 * 3600 * 1000).toISOString();

  // 2 accounts: acc1 (82%), acc2 (45%) -> Use next is acc1
  const members2: AccountFamilyMember[] = [
    {
      id: 'acc1',
      name: 'Work Pro',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'b1', label: '5h', windowType: 'session_5h', remainingPercent: 82, resetsAt: in4h }],
      },
    },
    {
      id: 'acc2',
      name: 'Personal Pro',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'b2', label: '5h', windowType: 'session_5h', remainingPercent: 45, resetsAt: in2h }],
      },
    },
  ];

  const summary = aggregateFamily('claude', members2, 'equal', now);
  assert(summary.useNext?.id === 'acc1', 'Use next: picks highest capacity account (Work Pro at 82%)');

  // Tie break by nearest binding reset:
  // Both have 60% remaining; accA resets in 2h, accB in 4h -> accA should be chosen
  const tiedMembers: AccountFamilyMember[] = [
    {
      id: 'accB',
      name: 'Account B',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'bB', label: '5h', windowType: 'session_5h', remainingPercent: 60, resetsAt: in4h }],
      },
    },
    {
      id: 'accA',
      name: 'Account A',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'bA', label: '5h', windowType: 'session_5h', remainingPercent: 60, resetsAt: in2h }],
      },
    },
  ];
  const tieSummary = aggregateFamily('claude', tiedMembers, 'equal', now);
  assert(tieSummary.useNext?.id === 'accA', 'Use next: tie-breaks by nearest binding reset');

  // Single-account family -> useNext is null (rule §1.5 / §2.1)
  const singleMember: AccountFamilyMember[] = [members2[0]];
  const singleSummary = aggregateFamily('claude', singleMember, 'equal', now);
  assert(singleSummary.useNext === null, 'Use next: null for single-member family');

  // Both accounts exhausted or < 10% -> useNext is null
  const exhaustedMembers: AccountFamilyMember[] = [
    {
      id: 'low1',
      name: 'Low 1',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'lb1', label: '5h', windowType: 'session_5h', remainingPercent: 8 }],
      },
    },
    {
      id: 'low2',
      name: 'Low 2',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'lb2', label: '5h', windowType: 'session_5h', remainingPercent: 5 }],
      },
    },
  ];
  const exhaustedSummary = aggregateFamily('claude', exhaustedMembers, 'equal', now);
  assert(exhaustedSummary.useNext === null, 'Use next: null when best usable account < 10%');

  // Inactive / error status account is not usable
  const errorMembers: AccountFamilyMember[] = [
    {
      id: 'err1',
      name: 'Error Acct',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'error',
        buckets: [{ id: 'eb1', label: '5h', windowType: 'session_5h', remainingPercent: 95 }],
      },
    },
    {
      id: 'ok1',
      name: 'OK Acct',
      providerType: 'claude',
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok',
        buckets: [{ id: 'ob1', label: '5h', windowType: 'session_5h', remainingPercent: 50 }],
      },
    },
  ];
  const errorSummary = aggregateFamily('claude', errorMembers, 'equal', now);
  assert(errorSummary.useNext?.id === 'ok1', 'Use next: skips accounts with status !== ok');
}

// ----------------------------------------------------
// Suite 8: Group families & filtering
// ----------------------------------------------------
console.log('\nSuite 8: Group families & filtering');
{
  const accounts = [
    {
      id: 'c1',
      name: 'Claude 1',
      providerType: 'claude' as const,
      isActive: true,
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok' as const,
        buckets: [{ id: 'c1b', label: '5h', windowType: 'session_5h' as const, remainingPercent: 80 }],
      },
    },
    {
      id: 'c2_inactive',
      name: 'Claude 2 Inactive',
      providerType: 'claude' as const,
      isActive: false, // Inactive account should be skipped
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'ok' as const,
        buckets: [{ id: 'c2b', label: '5h', windowType: 'session_5h' as const, remainingPercent: 90 }],
      },
    },
    {
      id: 'g1_nodata',
      name: 'Gemini No Data',
      providerType: 'gemini' as const,
      isActive: true,
      latestSnapshot: {
        timestamp: new Date().toISOString(),
        status: 'not_configured' as const,
        buckets: [], // No buckets
      },
    },
  ];

  const families = groupFamilies(accounts);
  assert(families.length === 1, 'groupFamilies: exactly 1 family returned (gemini skipped due to no data)');
  assert(families[0].family === 'claude', 'groupFamilies: returned family is claude');
  assert(families[0].members.length === 1, 'groupFamilies: inactive account was excluded');
  assert(families[0].members[0].id === 'c1', 'groupFamilies: member is active c1');
}

// ----------------------------------------------------
// Suite 9: arcPath & familySlots geometry
// ----------------------------------------------------
console.log('\nSuite 9: arcPath & familySlots geometry');
{
  // arcPath for 90-degree quadrant (12 o'clock to 3 o'clock)
  // center 50, 50, r 40
  // startDeg 0 (12 o'clock) -> (50, 10)
  // endDeg 90 (3 o'clock) -> (90, 50)
  const arc90 = arcPath(50, 50, 40, 0, 90);
  assert(arc90.startsWith('M 50.000 10.000 A 40 40 0 0 1 90.000 50.000'), 'arcPath: 90 degree quadrant path is exact');

  // Full circle clamp (sweep < 360)
  const fullCircle = arcPath(50, 50, 40, 0, 360);
  assert(fullCircle.includes('A 40 40 0 1 1'), 'arcPath: full circle sets large-arc flag 1');

  // familySlots with 3 equal members
  const members = [
    { weight: 1, effective: 30, id: 's1' },
    { weight: 1, effective: 25, id: 's2' },
    { weight: 1, effective: 15, id: 's3' },
  ];
  const slots = familySlots(members, 3);
  assert(slots.length === 3, 'familySlots: 3 slots generated');

  // 360 / 3 = 120 span per member.
  // gap 3 -> 1.5 padding on each side.
  // slot 0: start = 1.5, end = 118.5
  // slot 1: start = 121.5, end = 238.5
  // slot 2: start = 241.5, end = 358.5
  assert(approxEqual(slots[0].start, 1.5), 'familySlots: slot 0 start is 1.5');
  assert(approxEqual(slots[0].end, 118.5), 'familySlots: slot 0 end is 118.5');
  // fill: (118.5 - 1.5) * 0.30 = 117 * 0.30 = 35.1 -> fillEnd = 1.5 + 35.1 = 36.6
  assert(approxEqual(slots[0].fillEnd, 36.6), 'familySlots: slot 0 fillEnd is 36.6');

  // Single member -> gapDeg should be 0 (no gap)
  const singleSlot = familySlots([{ weight: 1, effective: 50, id: 'single' }], 3);
  assert(singleSlot[0].start === 0, 'familySlots: single member start is 0 (gap is 0)');
  assert(singleSlot[0].end === 360, 'familySlots: single member end is 360');
  assert(singleSlot[0].fillEnd === 180, 'familySlots: single member 50% fillEnd is 180');

  // a11y label
  const dRing: any = {
    inner: { remaining: 60, short: '5h' },
    outer: { remaining: 85, short: '7d' },
    binding: { remaining: 60, short: '5h' },
  };
  const label = ringA11yLabel(dRing);
  assert(label.includes('5-hour 60% left'), 'ringA11yLabel: includes 5-hour');
  assert(label.includes('weekly 85% left'), 'ringA11yLabel: includes weekly');
  assert(label.includes('binding: 5h'), 'ringA11yLabel: includes binding');
}

console.log(`\n========================================`);
console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
console.log(`========================================\n`);

if (failedTests > 0) {
  process.exit(1);
}
