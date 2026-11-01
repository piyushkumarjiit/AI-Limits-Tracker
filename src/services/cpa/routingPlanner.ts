import type { QuotaBucket, UsageSnapshot } from '../../models/types';
import { forecastWindow, type StatPoint } from '../stats';
import { planWeight } from '../capacity';

export interface RoutingConfig {
  mode: 'off' | 'shadow' | 'enforce';
  wBase: number;
  gamma: number;
  coolRemainingPct: number;
  coolExhaustHours: number;
  releaseRemainingPct: number;
  minDeltaRatio: number;
  minWriteIntervalSec: number;
  maxWritesPerMin: number;
}

export const DEFAULT_ROUTING: RoutingConfig = {
  mode: 'shadow',
  wBase: 100,
  gamma: 1.5,
  coolRemainingPct: 3,
  coolExhaustHours: 0.25,
  releaseRemainingPct: 10,
  minDeltaRatio: 0.25,
  minWriteIntervalSec: 300,
  maxWritesPerMin: 30,
};

/**
 * Validates a routing config object, throwing Error if any value is out of bounds.
 * Valid ranges:
 * - mode: 'off' | 'shadow' | 'enforce'
 * - wBase: 1–10000
 * - gamma: 0.5–4
 * - coolRemainingPct: 0–50
 * - coolExhaustHours: 0–24
 * - releaseRemainingPct: 0–50
 * - minDeltaRatio: 0–1
 * - minWriteIntervalSec: >= 0
 * - maxWritesPerMin: >= 1
 */
export function validateRoutingConfig(x: unknown): RoutingConfig {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    throw new Error('Routing config must be an object');
  }

  const raw = x as Partial<RoutingConfig>;

  const mode = raw.mode !== undefined ? raw.mode : DEFAULT_ROUTING.mode;
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
    throw new Error(`Invalid routing mode: ${mode}`);
  }

  const wBase = raw.wBase !== undefined ? raw.wBase : DEFAULT_ROUTING.wBase;
  if (typeof wBase !== 'number' || !Number.isFinite(wBase) || wBase < 1 || wBase > 10000) {
    throw new Error(`wBase out of range [1, 10000]: ${wBase}`);
  }

  const gamma = raw.gamma !== undefined ? raw.gamma : DEFAULT_ROUTING.gamma;
  if (typeof gamma !== 'number' || !Number.isFinite(gamma) || gamma < 0.5 || gamma > 4) {
    throw new Error(`gamma out of range [0.5, 4]: ${gamma}`);
  }

  const coolRemainingPct =
    raw.coolRemainingPct !== undefined ? raw.coolRemainingPct : DEFAULT_ROUTING.coolRemainingPct;
  if (
    typeof coolRemainingPct !== 'number' ||
    !Number.isFinite(coolRemainingPct) ||
    coolRemainingPct < 0 ||
    coolRemainingPct > 50
  ) {
    throw new Error(`coolRemainingPct out of range [0, 50]: ${coolRemainingPct}`);
  }

  const coolExhaustHours =
    raw.coolExhaustHours !== undefined ? raw.coolExhaustHours : DEFAULT_ROUTING.coolExhaustHours;
  if (
    typeof coolExhaustHours !== 'number' ||
    !Number.isFinite(coolExhaustHours) ||
    coolExhaustHours < 0 ||
    coolExhaustHours > 24
  ) {
    throw new Error(`coolExhaustHours out of range [0, 24]: ${coolExhaustHours}`);
  }

  const releaseRemainingPct =
    raw.releaseRemainingPct !== undefined ? raw.releaseRemainingPct : DEFAULT_ROUTING.releaseRemainingPct;
  if (
    typeof releaseRemainingPct !== 'number' ||
    !Number.isFinite(releaseRemainingPct) ||
    releaseRemainingPct < 0 ||
    releaseRemainingPct > 50
  ) {
    throw new Error(`releaseRemainingPct out of range [0, 50]: ${releaseRemainingPct}`);
  }

  const minDeltaRatio =
    raw.minDeltaRatio !== undefined ? raw.minDeltaRatio : DEFAULT_ROUTING.minDeltaRatio;
  if (
    typeof minDeltaRatio !== 'number' ||
    !Number.isFinite(minDeltaRatio) ||
    minDeltaRatio < 0 ||
    minDeltaRatio > 1
  ) {
    throw new Error(`minDeltaRatio out of range [0, 1]: ${minDeltaRatio}`);
  }

  const minWriteIntervalSec =
    raw.minWriteIntervalSec !== undefined
      ? raw.minWriteIntervalSec
      : DEFAULT_ROUTING.minWriteIntervalSec;
  if (
    typeof minWriteIntervalSec !== 'number' ||
    !Number.isFinite(minWriteIntervalSec) ||
    minWriteIntervalSec < 0
  ) {
    throw new Error(`minWriteIntervalSec must be non-negative: ${minWriteIntervalSec}`);
  }

  const maxWritesPerMin =
    raw.maxWritesPerMin !== undefined ? raw.maxWritesPerMin : DEFAULT_ROUTING.maxWritesPerMin;
  if (
    typeof maxWritesPerMin !== 'number' ||
    !Number.isFinite(maxWritesPerMin) ||
    maxWritesPerMin < 1
  ) {
    throw new Error(`maxWritesPerMin must be at least 1: ${maxWritesPerMin}`);
  }

  return {
    mode,
    wBase,
    gamma,
    coolRemainingPct,
    coolExhaustHours,
    releaseRemainingPct,
    minDeltaRatio,
    minWriteIntervalSec,
    maxWritesPerMin,
  };
}

export interface PlannerInput {
  accountId: string;
  provider: string;
  cpaName: string;
  plan: string;
  snapshot?: UsageSnapshot;
  history: StatPoint[];
  currentWeight: number | null;
  prev?: { applied: number; at: number; cooldown: boolean };
  managed: boolean;
}

export interface WeightPlan {
  accountId: string;
  cpaName: string;
  headroom: number;
  target: number;
  cooldown: boolean;
  reason:
    | 'headroom'
    | 'exhausted'
    | 'near_exhaust'
    | 'released'
    | 'starvation_guard'
    | 'unmanaged'
    | 'stale';
  write: boolean;
}

interface WindowDetail {
  bucket: QuotaBucket;
  r: number;
  h: number;
  burn: number;
  e: number;
  score: number;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function getCandidateBuckets(snapshot: UsageSnapshot): QuotaBucket[] {
  const buckets = snapshot.buckets || [];
  const withRemaining = buckets.filter(
    (b) => b.remainingPercent !== null && b.remainingPercent !== undefined
  );
  if (!withRemaining.length) return [];

  const isAgy = snapshot.providerType === 'antigravity';
  if (isAgy) {
    return withRemaining;
  }

  const standard = withRemaining.filter(
    (b) => b.windowType === 'session_5h' || b.windowType === 'weekly_7d'
  );
  if (standard.length > 0) {
    return standard;
  }

  // Fallback if provider only has sliding_window, balance, or monthly_30d
  return withRemaining;
}

function evaluateWindows(
  snapshot: UsageSnapshot | undefined,
  history: StatPoint[],
  now: number
): WindowDetail[] {
  if (!snapshot || snapshot.status !== 'ok' || snapshot.isStale === true) {
    return [];
  }

  const candidateBuckets = getCandidateBuckets(snapshot);
  if (!candidateBuckets.length) {
    return [];
  }

  const isAgy = snapshot.providerType === 'antigravity';

  return candidateBuckets.map((bucket) => {
    const r = Math.max(0, Math.min(100, bucket.remainingPercent as number));
    const resetsAt = bucket.resetsAt;
    const resetMs = resetsAt ? new Date(resetsAt).getTime() : NaN;
    const h = !isNaN(resetMs) ? Math.max(0, (resetMs - now) / 3600000) : 0;

    let burn = 0;
    if (!isAgy && history && history.length > 0) {
      if (bucket.windowType === 'session_5h') {
        const points = history
          .filter((p) => p.session !== null && p.session !== undefined)
          .map((p) => ({ t: p.t, value: p.session }));
        const currentUsed =
          bucket.utilizationPercent ?? (bucket.remainingPercent !== null ? 100 - r : null);
        const fc = forecastWindow(points, currentUsed, resetsAt, {
          now,
          lookbackMs: 90 * 60 * 1000,
        });
        burn = fc.burnRatePerHour !== null && fc.burnRatePerHour > 0 ? fc.burnRatePerHour : 0;
      } else if (bucket.windowType === 'weekly_7d') {
        const points = history
          .filter((p) => p.weekly !== null && p.weekly !== undefined)
          .map((p) => ({ t: p.t, value: p.weekly }));
        const currentUsed =
          bucket.utilizationPercent ?? (bucket.remainingPercent !== null ? 100 - r : null);
        const fc = forecastWindow(points, currentUsed, resetsAt, {
          now,
          lookbackMs: 90 * 60 * 1000,
        });
        burn = fc.burnRatePerHour !== null && fc.burnRatePerHour > 0 ? fc.burnRatePerHour : 0;
      }
    }

    const e = burn > 0 ? r / burn : Infinity;
    const paceFactor = e >= h ? 1 : clamp01(e / Math.max(h, 0.25));
    const score = clamp01(r / 100) * paceFactor;

    return {
      bucket,
      r,
      h,
      burn,
      e,
      score,
    };
  });
}

function selectBindingWindow(windows: WindowDetail[]): WindowDetail | null {
  if (!windows.length) return null;

  return windows.reduce((best, curr) => {
    if (curr.score < best.score) return curr;
    if (curr.score > best.score) return best;
    // Tie breaker 1: lower remaining percent
    if (curr.r < best.r) return curr;
    if (curr.r > best.r) return best;
    // Tie breaker 2: earlier reset (smaller h)
    if (curr.h < best.h) return curr;
    return best;
  });
}

function getEarliestResetTime(snapshot: UsageSnapshot | undefined): number {
  if (!snapshot || !snapshot.buckets) return Infinity;
  let minReset = Infinity;
  for (const b of snapshot.buckets) {
    if (b.resetsAt) {
      const t = new Date(b.resetsAt).getTime();
      if (!isNaN(t) && t < minReset) {
        minReset = t;
      }
    }
  }
  return minReset;
}

/**
 * Computes account headroom score H (0..1) as the minimum headroom score across windows.
 * §4.2: score_w = clamp01( r/100 ) * ( e >= h ? 1 : clamp01(e / max(h, 0.25)) )
 */
export function headroom(
  snapshot: UsageSnapshot | undefined,
  history: StatPoint[],
  now: number
): number {
  const windows = evaluateWindows(snapshot, history, now);
  const binding = selectBindingWindow(windows);
  if (!binding) return 0;
  return clamp01(binding.score);
}

/**
 * Pure predictive routing planner.
 * Given planner inputs and configuration, computes the target weight, cooldown state,
 * routing reason, and write flag for each account credential.
 */
export function planWeights(
  inputs: PlannerInput[],
  cfg: RoutingConfig,
  now: number
): WeightPlan[] {
  if (cfg.mode === 'off') {
    return [];
  }

  interface Intermediate {
    input: PlannerInput;
    plan: WeightPlan;
    bindingWindow: WindowDetail | null;
    isStale: boolean;
  }

  const intermediates: Intermediate[] = inputs.map((input) => {
    const isStale =
      !input.snapshot ||
      input.snapshot.status !== 'ok' ||
      input.snapshot.isStale === true ||
      (input.snapshot.buckets || []).length === 0;

    if (!input.managed) {
      const windows = evaluateWindows(input.snapshot, input.history, now);
      const binding = selectBindingWindow(windows);
      const hScore = binding ? clamp01(binding.score) : 0;
      const p = planWeight(input.plan);
      const rawTarget = Math.round(cfg.wBase * p * Math.pow(hScore, cfg.gamma));
      const target = isStale ? 0 : Math.max(rawTarget, 1);
      return {
        input,
        bindingWindow: binding,
        isStale,
        plan: {
          accountId: input.accountId,
          cpaName: input.cpaName,
          headroom: hScore,
          target,
          cooldown: false,
          reason: 'unmanaged',
          write: false,
        },
      };
    }

    if (isStale) {
      return {
        input,
        bindingWindow: null,
        isStale: true,
        plan: {
          accountId: input.accountId,
          cpaName: input.cpaName,
          headroom: 0,
          target: 0,
          cooldown: false,
          reason: 'stale',
          write: false,
        },
      };
    }

    const windows = evaluateWindows(input.snapshot, input.history, now);
    const binding = selectBindingWindow(windows);
    const hScore = binding ? clamp01(binding.score) : 0;
    const p = planWeight(input.plan);
    const rawTarget = Math.round(cfg.wBase * p * Math.pow(hScore, cfg.gamma));

    const bindingR = binding ? binding.r : 0;
    const bindingE = binding ? binding.e : Infinity;
    const bindingResetsAt = binding?.bucket.resetsAt ?? null;
    const bindingResetMs = bindingResetsAt ? new Date(bindingResetsAt).getTime() : NaN;

    const anyBucketExhausted = (input.snapshot?.buckets || []).some(
      (b) =>
        b.isExhausted === true ||
        (b.remainingPercent !== null && b.remainingPercent !== undefined && b.remainingPercent <= 0) ||
        (b.utilizationPercent !== null && b.utilizationPercent !== undefined && b.utilizationPercent >= 100)
    );

    const isExhausted = anyBucketExhausted || hScore <= 0 || bindingR <= 0;
    const isNearExhaust =
      !isExhausted &&
      (bindingR < cfg.coolRemainingPct ||
        bindingE < cfg.coolExhaustHours ||
        windows.some((w) => w.r < cfg.coolRemainingPct || w.e < cfg.coolExhaustHours));

    const wasInCooldown =
      input.prev !== undefined ? input.prev.cooldown : input.currentWeight === 0;

    let target: number;
    let cooldown: boolean;
    let reason: WeightPlan['reason'];

    if (wasInCooldown) {
      const isReset = !isNaN(bindingResetMs) && now >= bindingResetMs;
      const isAboveReleasePct = bindingR >= cfg.releaseRemainingPct;

      if (!isReset && !isAboveReleasePct) {
        // Cooldown remains active
        target = 0;
        cooldown = true;
        reason = isExhausted ? 'exhausted' : 'near_exhaust';
      } else {
        // Cooldown release allowed if not currently exhausted or near exhaustion
        if (isExhausted) {
          target = 0;
          cooldown = true;
          reason = 'exhausted';
        } else if (isNearExhaust) {
          target = 0;
          cooldown = true;
          reason = 'near_exhaust';
        } else {
          target = Math.max(rawTarget, 1);
          cooldown = false;
          reason = 'released';
        }
      }
    } else {
      if (isExhausted) {
        target = 0;
        cooldown = true;
        reason = 'exhausted';
      } else if (isNearExhaust) {
        target = 0;
        cooldown = true;
        reason = 'near_exhaust';
      } else {
        target = Math.max(rawTarget, 1);
        cooldown = false;
        reason = 'headroom';
      }
    }

    return {
      input,
      bindingWindow: binding,
      isStale: false,
      plan: {
        accountId: input.accountId,
        cpaName: input.cpaName,
        headroom: hScore,
        target,
        cooldown,
        reason,
        write: false,
      },
    };
  });

  // Starvation guard (§4.3):
  // If applying the plan would set all linked credentials of one provider to 0,
  // the tracker sets the one with the earliest reset to weight 1 instead.
  const byProvider = new Map<string, Intermediate[]>();
  for (const item of intermediates) {
    const list = byProvider.get(item.input.provider) || [];
    list.push(item);
    byProvider.set(item.input.provider, list);
  }

  for (const [, providerItems] of byProvider) {
    if (providerItems.length > 0 && providerItems.every((it) => it.plan.target === 0)) {
      const eligible = providerItems.filter((it) => it.input.managed && !it.isStale);
      const pool = eligible.length > 0 ? eligible : providerItems;

      let chosen = pool[0];
      let earliestReset = getEarliestResetTime(chosen.input.snapshot);

      for (let i = 1; i < pool.length; i++) {
        const item = pool[i];
        const rTime = getEarliestResetTime(item.input.snapshot);
        if (rTime < earliestReset) {
          chosen = item;
          earliestReset = rTime;
        } else if (rTime === earliestReset) {
          if (item.input.accountId.localeCompare(chosen.input.accountId) < 0) {
            chosen = item;
            earliestReset = rTime;
          }
        }
      }

      chosen.plan.target = 1;
      chosen.plan.reason = 'starvation_guard';
      chosen.plan.cooldown = false;
    }
  }

  // Calculate write flag (§4.4 Hysteresis and write budget)
  for (const item of intermediates) {
    const { input, plan, isStale } = item;

    if (!input.managed || isStale) {
      plan.write = false;
      continue;
    }

    const current = input.currentWeight;
    const target = plan.target;

    if (current === null) {
      plan.write = true;
      continue;
    }

    if (target === current) {
      plan.write = false;
      continue;
    }

    const isCrossingZero = (current === 0 && target > 0) || (current > 0 && target === 0);
    const delta = Math.abs(target - current);
    const deltaRatio = delta / Math.max(current, 1);
    const deltaOk = isCrossingZero || deltaRatio >= cfg.minDeltaRatio;

    if (!deltaOk) {
      plan.write = false;
      continue;
    }

    // Minimum interval between writes per credential, except transitions to 0
    const isTransitionToZero = current > 0 && target === 0;
    if (isTransitionToZero) {
      plan.write = true;
      continue;
    }

    if (input.prev && typeof input.prev.at === 'number') {
      const nowMs = now > 1e11 ? now : now * 1000;
      const prevMs = input.prev.at > 1e11 ? input.prev.at : input.prev.at * 1000;
      const elapsedSec = (nowMs - prevMs) / 1000;
      if (elapsedSec < cfg.minWriteIntervalSec) {
        plan.write = false;
        continue;
      }
    }

    plan.write = true;
  }

  return intermediates.map((it) => it.plan);
}
