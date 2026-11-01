import type { AccountEntity, ProviderType, QuotaBucket, UsageSnapshot } from '../models/types';

export type Severity = 'healthy' | 'warning' | 'critical' | 'exhausted' | 'unknown';

/**
 * Severity rank from lowest to highest urgency/severity.
 * Useful for sorting or comparisons.
 * unknown (-1) < healthy (0) < warning (1) < critical (2) < exhausted (3)
 */
export function severityRank(s: Severity): number {
  switch (s) {
    case 'unknown':
      return -1;
    case 'healthy':
      return 0;
    case 'warning':
      return 1;
    case 'critical':
      return 2;
    case 'exhausted':
      return 3;
  }
}

/**
 * One scale for rings, pills and alerts (alerts fire at 20 / 10).
 * >35 healthy, 20-35 warning, 10-20 critical, <=10 or 0 exhausted, null unknown.
 */
export function severityOf(remaining: number | null): Severity {
  if (remaining === null || remaining === undefined || isNaN(remaining)) return 'unknown';
  if (remaining <= 10) return 'exhausted';
  if (remaining <= 20) return 'critical';
  if (remaining <= 35) return 'warning';
  return 'healthy';
}

export interface RingWindow {
  bucket: QuotaBucket;
  remaining: number; // 0-100
  short: string; // '5h' | '7d' | 'mo' | 'limit' | label
}

export interface DualRingData {
  outer: RingWindow | null; // longer window (weekly) - or the only window when single-bucket
  inner: RingWindow | null; // 5h session, only when both exist
  binding: RingWindow | null; // window with min remaining (min(5h, weekly))
  effectiveRemaining: number | null; // min(outer, inner) remaining %
  severity: Severity;
  extras: RingWindow[]; // Antigravity non-primary families or extra windows
}

const has = (b: QuotaBucket) => b.remainingPercent !== null && b.remainingPercent !== undefined;

const win = (b: QuotaBucket, short: string): RingWindow => ({
  bucket: b,
  remaining: Math.max(0, Math.min(100, b.remainingPercent as number)),
  short,
});

const lowest = (bs: QuotaBucket[]) =>
  bs.reduce<QuotaBucket | undefined>((a, b) => (!a || (b.remainingPercent ?? 101) < (a.remainingPercent ?? 101) ? b : a), undefined);

/**
 * Resolves buckets for dual-ring rendering and capacity calculations.
 * Pure function; shared by web, RN and server.
 */
export function resolveRingWindows(buckets: QuotaBucket[] | undefined): DualRingData {
  const empty: DualRingData = {
    outer: null,
    inner: null,
    binding: null,
    effectiveRemaining: null,
    severity: 'unknown',
    extras: [],
  };
  if (!buckets || !buckets.length) return empty;

  let pool = buckets.filter(has);
  const extras: RingWindow[] = [];

  // Antigravity multi-family: rings use the first family present in order
  // gemini -> 3p -> argon -> other. Other families go to extras.
  const fam = (b: QuotaBucket) => (b.details?.family as string | undefined) ?? '';
  if (pool.some((b) => fam(b))) {
    const order = ['gemini', '3p', 'argon', 'other'];
    const primary = order.find((f) => pool.some((b) => fam(b) === f)) ?? fam(pool[0]);
    for (const f of order) {
      if (f === primary) continue;
      const bs = pool.filter((b) => fam(b) === f);
      const lo = lowest(bs);
      if (lo) {
        extras.push(win(lo, f === '3p' ? '3P' : f[0].toUpperCase() + f.slice(1)));
      }
    }
    pool = pool.filter((b) => fam(b) === primary);
  }

  const session = lowest(pool.filter((b) => b.windowType === 'session_5h'));
  const weekly = lowest(pool.filter((b) => b.windowType === 'weekly_7d'));

  let outer: RingWindow | null = null;
  let inner: RingWindow | null = null;

  if (session && weekly) {
    outer = win(weekly, '7d');
    inner = win(session, '5h');
  } else {
    // Single-ring fallbacks (sliding_window, single session_5h, single weekly_7d, monthly_30d, balance)
    const only =
      weekly ??
      session ??
      lowest(pool.filter((b) => b.windowType === 'sliding_window')) ??
      lowest(pool.filter((b) => b.windowType === 'monthly_30d' || b.windowType === 'balance'));

    if (only) {
      outer = win(
        only,
        only === weekly
          ? '7d'
          : only === session
          ? '5h'
          : only.windowType === 'monthly_30d'
          ? 'mo'
          : 'limit'
      );
    }
  }

  const binding =
    inner && outer ? (inner.remaining <= outer.remaining ? inner : outer) : outer;

  const effectiveRemaining = binding ? binding.remaining : null;
  const severity = severityOf(effectiveRemaining);

  return {
    outer,
    inner,
    binding,
    effectiveRemaining,
    severity,
    extras,
  };
}

/**
 * Convenience alias for dual-ring data from a snapshot.
 */
export function dualRingData(snapshot: UsageSnapshot | undefined): DualRingData {
  return resolveRingWindows(snapshot?.buckets);
}

export type Weighting = 'equal' | 'plan';

export const PLAN_WEIGHTS: Record<string, number> = {
  'max 20x': 20,
  'max 5x': 5,
  max: 5,
  pro: 1,
  plus: 1,
};

const PLAN_WEIGHT_PATTERNS: Array<[RegExp, number]> = [
  [/max\s*20x/i, 20],
  [/max\s*5x|^max$/i, 5],
  [/\bpro\b/i, 1],
  [/plus/i, 1],
];

export function planWeight(planName: string | undefined | null): number {
  if (!planName) return 1;
  const normalized = planName.trim().toLowerCase();
  if (PLAN_WEIGHTS[normalized] !== undefined) {
    return PLAN_WEIGHTS[normalized];
  }
  for (const [re, w] of PLAN_WEIGHT_PATTERNS) {
    if (re.test(planName)) return w;
  }
  return 1;
}

export interface AccountFamilyMember {
  id: string;
  name: string;
  providerType: ProviderType;
  plan?: string | null;
  isActive?: boolean;
  latestSnapshot?: UsageSnapshot;
  effectiveRemaining?: number | null;
  weight?: number;
  bindingResetsAt?: string | null;
  usable?: boolean;
}

export interface FamilySummary {
  family: ProviderType;
  members: AccountFamilyMember[];
  /** Σ eff / 100 (equal) or Σ w·eff / 100 (plan; Pro-equivalents). */
  poolUnits: number;
  /** Σ units available when everything is full: n, or Σw. */
  poolMax: number;
  /** Honest pool percentage: poolUnits / poolMax * 100 */
  poolPct: number | null;
  earliestReset: { at: string; accountId: string } | null;
  nextFullRefill: { at: string; accountId: string } | null;
  useNext: AccountFamilyMember | null;
}

const future = (iso: string | null | undefined, now: number) =>
  !!iso && new Date(iso).getTime() > now;

/**
 * Aggregates a list of account family members belonging to a provider family.
 * Pure function.
 */
export function aggregateFamily(
  family: ProviderType,
  members: AccountFamilyMember[],
  weighting: Weighting = 'equal',
  now = Date.now()
): FamilySummary {
  // Normalize each member with capacity calculations if not already populated
  const populatedMembers: AccountFamilyMember[] = members.map((m) => {
    if (m.effectiveRemaining !== undefined && m.usable !== undefined && m.weight !== undefined) {
      return m;
    }
    const d = resolveRingWindows(m.latestSnapshot?.buckets);
    const st = m.latestSnapshot?.status;
    const plan = m.latestSnapshot?.planName || m.plan;
    const weight = weighting === 'plan' ? planWeight(plan) : 1;
    const usable = (st === undefined || st === 'ok') && d.effectiveRemaining !== null;
    return {
      ...m,
      effectiveRemaining: d.effectiveRemaining,
      weight,
      bindingResetsAt: d.binding?.bucket.resetsAt ?? null,
      usable,
    };
  });

  const withData = populatedMembers.filter(
    (m) => m.effectiveRemaining !== null && m.effectiveRemaining !== undefined
  );

  const poolUnits = withData.reduce(
    (s, m) => s + ((m.weight ?? 1) * (m.effectiveRemaining as number)) / 100,
    0
  );
  const poolMax = withData.reduce((s, m) => s + (m.weight ?? 1), 0);
  const poolPct = poolMax > 0 ? (poolUnits / poolMax) * 100 : null;

  let earliestReset: FamilySummary['earliestReset'] = null;
  let nextFullRefill: FamilySummary['nextFullRefill'] = null;

  for (const m of populatedMembers) {
    for (const b of m.latestSnapshot?.buckets ?? []) {
      if ((b.remainingPercent ?? 100) >= 100 || !future(b.resetsAt, now)) continue;
      if (!earliestReset || b.resetsAt! < earliestReset.at) {
        earliestReset = { at: b.resetsAt!, accountId: m.id };
      }
    }
    if (
      future(m.bindingResetsAt, now) &&
      (!nextFullRefill || m.bindingResetsAt! < nextFullRefill.at)
    ) {
      nextFullRefill = { at: m.bindingResetsAt!, accountId: m.id };
    }
  }

  // "Use next" recommendation:
  // Active/usable accounts ranked by effective remaining descending,
  // then tie-broken by soonest binding reset.
  // Set only when family has >= 2 members and the top member has effective remaining >= 10.
  const ranked = populatedMembers
    .filter((m) => m.usable && m.effectiveRemaining !== null && m.effectiveRemaining !== undefined)
    .sort(
      (a, b) =>
        (b.effectiveRemaining! - a.effectiveRemaining!) ||
        ((a.bindingResetsAt ?? '\uffff') < (b.bindingResetsAt ?? '\uffff') ? -1 : 1)
    );

  const useNext =
    populatedMembers.length >= 2 && ranked[0] && ranked[0].effectiveRemaining! >= 10
      ? ranked[0]
      : null;

  return {
    family,
    members: populatedMembers,
    poolUnits,
    poolMax,
    poolPct: poolPct !== null ? Math.round(poolPct * 10) / 10 : null,
    earliestReset,
    nextFullRefill,
    useNext,
  };
}

/**
 * Groups raw accounts by providerType into FamilySummaries.
 * Pure function.
 */
export function groupFamilies(
  accounts: Array<{
    id: string;
    name: string;
    providerType: ProviderType;
    plan?: string | null;
    isActive?: boolean;
    latestSnapshot?: UsageSnapshot;
  }>,
  weighting: Weighting = 'equal',
  now = Date.now()
): FamilySummary[] {
  const groups = new Map<ProviderType, AccountFamilyMember[]>();
  for (const a of accounts) {
    if (a.isActive === false) continue;
    const list = groups.get(a.providerType) ?? [];
    list.push(a);
    groups.set(a.providerType, list);
  }

  const out: FamilySummary[] = [];
  for (const [family, members] of groups) {
    const summary = aggregateFamily(family, members, weighting, now);
    // Families with no data accounts are omitted
    const hasData = summary.members.some(
      (m) => m.effectiveRemaining !== null && m.effectiveRemaining !== undefined
    );
    if (hasData) {
      out.push(summary);
    }
  }
  return out;
}

/** Backward compatibility alias for familySummaries */
export const familySummaries = (
  accounts: AccountEntity[],
  weighting: Weighting = 'equal',
  now = Date.now()
) => groupFamilies(accounts, weighting, now);

/**
 * Calculates SVG arc path string for a ring slot.
 * Angles in degrees, 0 = 12 o'clock, clockwise.
 */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number
): string {
  const sweep = Math.min(359.999, Math.max(0, endDeg - startDeg));
  const a0 = ((startDeg - 90) * Math.PI) / 180;
  const a1 = ((startDeg + sweep - 90) * Math.PI) / 180;
  const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`;
  return `M ${p(a0)} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${p(a1)}`;
}

/**
 * Computes slot angles and fill endpoints for a segmented family donut.
 */
export function familySlots(
  members: Array<{ weight?: number; effective?: number | null; effectiveRemaining?: number | null; id?: string }>,
  gapDeg = 3
): Array<{ id: string; start: number; end: number; fillEnd: number }> {
  const total = members.reduce((s, m) => s + (m.weight ?? 1), 0) || 1;
  const gap = members.length > 1 ? gapDeg : 0;
  let at = 0;
  return members.map((m, idx) => {
    const w = m.weight ?? 1;
    const eff = m.effectiveRemaining !== undefined ? m.effectiveRemaining : m.effective ?? null;
    const span = (w / total) * 360;
    const start = at + gap / 2;
    const end = at + span - gap / 2;
    at += span;
    const fill =
      eff === null
        ? 0
        : (end - start) * (Math.max(0, Math.min(100, eff)) / 100);
    return {
      id: m.id ?? String(idx),
      start,
      end,
      fillEnd: start + fill,
    };
  });
}

/** Accessible label for screen readers on DualRing components */
export function ringA11yLabel(data: DualRingData): string {
  if (!data.outer && !data.inner) return 'No limit data';
  const parts: string[] = [];
  if (data.inner) {
    parts.push(`5-hour ${Math.round(data.inner.remaining)}% left`);
  }
  if (data.outer) {
    const label = data.outer.short === '7d' ? 'weekly' : data.outer.short;
    parts.push(`${label} ${Math.round(data.outer.remaining)}% left`);
  }
  if (data.binding) {
    parts.push(`binding: ${data.binding.short}`);
  }
  return parts.join(', ');
}
