import { DEFAULT_WATERMARK_POLICY } from './cpaWatermarkPolicy';
export interface WatermarkPolicyConfig {
  mode?: 'off' | 'shadow' | 'enforce';
  intervalSec?: number;
  applyLatencySec?: number;
  burnRateMax?: number; // default 15
  pro?: {
    drainPct?: number; // default: DEFAULT_WATERMARK_POLICY.pro
    drainRecoveryPct?: number;
    hardStopPct?: number;
    hardStopRecoveryPct?: number;
    fallbackMinDwellSec?: number; // default 600 (10 mins)
    recoveryDwellSec?: number; // default 600 (10 mins)
  };
  nonPro?: {
    drainPct?: number; // default: DEFAULT_WATERMARK_POLICY.nonPro
    drainRecoveryPct?: number;
    hardStopPct?: number;
    hardStopRecoveryPct?: number;
  };
}

export interface WatermarkSnapshot {
  cpaName: string;
  accountId: string;
  provider: 'antigravity' | 'claude' | 'codex' | 'deepseek';
  tier: 'pro' | 'non_pro';
  modality: 'subscription_pool' | 'budgeted_allowance' | 'direct_api';
  quotaEffectivePct: number;
  burnRatePerMin: number;
  stalenessSec: number;
  isCooldown: boolean;
  currentWeight: number | null;
  managed: boolean;
}

export type AccountEngineStateKind =
  | 'healthy'
  | 'drain'
  | 'hard_stop'
  | 'cooldown'
  | 'unknown'
  | 'unmanaged'
  | 'ramping';

export interface AccountEngineState {
  state: AccountEngineStateKind;
  enteredAt: number;
  targetWeight: number;
}

export interface EngineState {
  mode: 'off' | 'shadow' | 'enforce';
  tierStates: Record<string, 'normal' | 'collective_fallback' | 'fail_static'>;
  accountStates: Record<string, AccountEngineState>;
  generation: number;
  tierStateEnteredAt?: Record<string, number>;
  rampStep?: Record<string, number>;
}

/**
 * Watermark decision for an individual account slot.
 */
export interface WatermarkDecision {
  targetWeight: number;
  reason: string;
  isEmergency?: boolean;
}

export interface InvariantViolation {
  accountId: string;
  invariant: string;
  reason: string;
  action: string;
}

export interface WatermarkComputationResult {
  targets: Map<string, WatermarkDecision>;
  nextState: EngineState;
  writeBatch: Array<{ name: string; weight: number; isEmergency: boolean }>;
  invariantViolations: InvariantViolation[];
}

export type WatermarkEngineResult = WatermarkComputationResult;

const DEFAULT_BURN_RATE_MAX = 15;
const DEFAULT_INTERVAL_SEC = 60;
const DEFAULT_APPLY_LATENCY_SEC = 5;
const DEFAULT_HORIZON_SEC = 65; // 60 + 5

// Single source for threshold defaults: the policy module's built-in policy.
const PRO_DEFAULTS = DEFAULT_WATERMARK_POLICY.pro;
const NON_PRO_DEFAULTS = DEFAULT_WATERMARK_POLICY.nonPro;

function clamp(val: number, min: number, max: number): number {
  if (Number.isNaN(val)) return min;
  return Math.min(Math.max(val, min), max);
}

/**
 * Predicate determining if an account participates in watermark management and write batches.
 * Only managed accounts belonging to the subscription_pool modality are watermark-managed.
 * Direct API and budgeted allowance accounts are unmanaged by watermark targeting.
 */
export function isWatermarkManaged(snap: WatermarkSnapshot): boolean {
  return Boolean(snap.managed) && snap.modality === 'subscription_pool';
}

/**
 * Velocity projection estimating effective quota percentage after evaluating horizon
 * (evaluation interval + write application latency) and account telemetry staleness delay.
 */
export function projectQuota(
  quotaEff: number,
  burnRatePerMin: number,
  stalenessSec: number,
  horizonSec: number,
  burnRateMax: number
): number {
  const clampedBurn = clamp(burnRatePerMin, 0, burnRateMax);
  return quotaEff - clampedBurn * ((horizonSec + stalenessSec) / 60);
}

/**
 * Two-stage hysteresis evaluation for hard stop condition.
 * Enters hard stop when effective or projected quota drops to or below hardFloorPct.
 * Recovers from hard stop only when effective quota rises strictly above hardFloorRecoveryPct.
 */
export function evalHardStop(
  quotaEff: number,
  quotaProj: number,
  hardFloorPct: number,
  hardFloorRecoveryPct: number,
  wasInHardStop: boolean
): boolean {
  return wasInHardStop
    ? quotaEff < hardFloorRecoveryPct
    : quotaEff <= hardFloorPct || quotaProj <= hardFloorPct;
}

/**
 * Two-stage hysteresis evaluation for proactive drain condition.
 * Enters drain when projected quota drops to or below drainPct.
 * Recovers from drain only when effective quota rises strictly above drainRecoveryPct.
 */
export function evalDrain(
  quotaEff: number,
  quotaProj: number,
  drainPct: number,
  drainRecoveryPct: number,
  wasInDrain: boolean
): boolean {
  return wasInDrain
    ? quotaEff < drainRecoveryPct
    : quotaProj <= drainPct;
}

/**
 * Pure calculation engine for CPA watermark targeting (WP-1).
 *
 * Evaluates multi-window quota velocity projection, two-stage watermark hysteresis,
 * collective degraded fallback, telemetry staleness freeze (fail_static), cross-tier
 * sequential sticky activation, anti-thundering-herd recovery ramping, and system
 * invariant guard rails (hard floor, cooldown isolation, no accidental blackout).
 *
 * Side-effect free: accepts current snapshots, configuration, previous state, and epoch timestamp;
 * returns computed targets, next state generation, invariant violations, and ordered write batch.
 */
export function computeWatermarkTargets(
  snapshots: WatermarkSnapshot[],
  policy: WatermarkPolicyConfig,
  prevState: EngineState,
  now: number
): WatermarkComputationResult {
  const mode = policy.mode ?? prevState?.mode ?? 'shadow';

  if (mode === 'off') {
    const emptyTargets = new Map<string, WatermarkDecision>();
    for (const snap of snapshots) {
      emptyTargets.set(snap.cpaName, { targetWeight: snap.currentWeight ?? 0, reason: 'mode_off' });
    }
    return {
      targets: emptyTargets,
      nextState: {
        mode: 'off',
        tierStates: { ...(prevState?.tierStates ?? {}) },
        tierStateEnteredAt: { ...(prevState?.tierStateEnteredAt ?? {}) },
        accountStates: { ...(prevState?.accountStates ?? {}) },
        rampStep: { ...(prevState?.rampStep ?? {}) },
        generation: (prevState?.generation ?? 0) + 1,
      },
      writeBatch: [],
      invariantViolations: [],
    };
  }

  const invariantViolations: InvariantViolation[] = [];

  const intervalSec = policy.intervalSec ?? DEFAULT_INTERVAL_SEC;
  const applyLatencySec = policy.applyLatencySec ?? DEFAULT_APPLY_LATENCY_SEC;
  const horizonSec = intervalSec + applyLatencySec;
  const burnRateMax = policy.burnRateMax ?? DEFAULT_BURN_RATE_MAX;

  const proCfg = { ...PRO_DEFAULTS, ...(policy.pro ?? {}) };
  const nonProCfg = { ...NON_PRO_DEFAULTS, ...(policy.nonPro ?? {}) };

  // Group snapshots by provider pool
  const providerPools = new Map<string, WatermarkSnapshot[]>();
  for (const snap of snapshots) {
    const list = providerPools.get(snap.provider) ?? [];
    list.push(snap);
    providerPools.set(snap.provider, list);
  }

  const targets = new Map<string, WatermarkDecision>();
  const nextAccountStates: Record<string, AccountEngineState> = {};
  const nextTierStates: Record<string, 'normal' | 'collective_fallback' | 'fail_static'> = {
    ...(prevState?.tierStates ?? {}),
  };
  const nextTierStateEnteredAt: Record<string, number> = {
    ...(prevState?.tierStateEnteredAt ?? {}),
  };
  const nextRampStep: Record<string, number> = {
    ...(prevState?.rampStep ?? {}),
  };

  for (const [provider, pool] of providerPools.entries()) {
    // 1. Direct API and budgeted allowance modality accounts are completely bypassed from watermark eviction
    const bypassedSnaps = pool.filter((s) => s.modality === 'direct_api' || s.modality === 'budgeted_allowance');
    for (const snap of bypassedSnaps) {
      targets.set(snap.cpaName, {
        targetWeight: snap.currentWeight ?? 100,
        reason: `${snap.modality}_bypass`,
      });
      nextAccountStates[snap.cpaName] = {
        state: 'unmanaged',
        enteredAt: prevState?.accountStates?.[snap.cpaName]?.enteredAt ?? now,
        targetWeight: snap.currentWeight ?? 100,
      };
    }

    const nonDirectPool = pool.filter((s) => s.modality !== 'direct_api' && s.modality !== 'budgeted_allowance');
    if (nonDirectPool.length === 0) continue;

    // 2. Telemetry staleness check for pool (all stale > 300s -> fail_static)
    const allStale = nonDirectPool.length > 0 && nonDirectPool.every((s) => s.stalenessSec > 300);
    const tierKey = `${provider}:pro`;

    if (allStale) {
      nextTierStates[tierKey] = 'fail_static';
      for (const snap of nonDirectPool) {
        if (!snap.managed) {
          targets.set(snap.cpaName, {
            targetWeight: snap.currentWeight ?? 0,
            reason: 'unmanaged',
          });
          nextAccountStates[snap.cpaName] = {
            state: 'unmanaged',
            enteredAt: prevState?.accountStates?.[snap.cpaName]?.enteredAt ?? now,
            targetWeight: snap.currentWeight ?? 0,
          };
          continue;
        }

        // Active cooldown or 429 forces W = 0
        if (snap.isCooldown) {
          targets.set(snap.cpaName, { targetWeight: 0, reason: 'cooldown' });
          nextAccountStates[snap.cpaName] = {
            state: 'cooldown',
            enteredAt: prevState?.accountStates?.[snap.cpaName]?.enteredAt ?? now,
            targetWeight: 0,
          };
          continue;
        }

        // Freeze telemetry-driven changes: keep previous target weight or current weight
        const prevTarget = prevState?.accountStates?.[snap.cpaName]?.targetWeight ?? snap.currentWeight ?? 0;
        const prevStateKind = prevState?.accountStates?.[snap.cpaName]?.state ?? 'unknown';
        targets.set(snap.cpaName, {
          targetWeight: prevTarget,
          reason: 'fail_static_hold',
        });
        nextAccountStates[snap.cpaName] = {
          state: prevStateKind,
          enteredAt: prevState?.accountStates?.[snap.cpaName]?.enteredAt ?? now,
          targetWeight: prevTarget,
        };
      }
      continue;
    }

    // Split pool by tier
    const proSnaps = nonDirectPool.filter((s) => s.tier === 'pro');
    const nonProSnaps = nonDirectPool.filter((s) => s.tier === 'non_pro');

    // Pre-calculate projected quotas and initial state evaluations for Pro
    const proAccountEval = new Map<
      string,
      {
        quotaProj: number;
        quotaEff: number;
        hardFloorPct: number;
        hardFloorRecoveryPct: number;
        drainPct: number;
        drainRecoveryPct: number;
        prevAccountState?: AccountEngineState;
        isHardFloorBreached: boolean;
        isStale: boolean;
        initialState: AccountEngineStateKind;
        initialReason: string;
      }
    >();

    for (const snap of proSnaps) {
      const prev = prevState?.accountStates?.[snap.cpaName];
      const hardFloorPct = proCfg.hardStopPct;
      const hardFloorRecoveryPct = proCfg.hardStopRecoveryPct;
      const drainPct = proCfg.drainPct;
      const drainRecoveryPct = proCfg.drainRecoveryPct;

      const quotaEff = snap.quotaEffectivePct;
      const quotaProj = projectQuota(quotaEff, snap.burnRatePerMin, snap.stalenessSec, horizonSec, burnRateMax);

      const isStale = snap.stalenessSec > 300;

      // Determine initial state based on precedence
      let st: AccountEngineStateKind = 'healthy';
      let rsn = 'healthy';

      if (!snap.managed) {
        st = 'unmanaged';
        rsn = 'unmanaged';
      } else if (snap.isCooldown) {
        st = 'cooldown';
        rsn = 'cooldown';
      } else {
        // Evaluate hard floor with hysteresis
        const wasInHardStop = prev?.state === 'hard_stop';
        const hardStopBreached = evalHardStop(
          quotaEff,
          quotaProj,
          hardFloorPct,
          hardFloorRecoveryPct,
          wasInHardStop
        );

        if (hardStopBreached) {
          st = 'hard_stop';
          rsn = 'hard_stop';
        } else if (isStale) {
          // Telemetry staleness table
          if (prev?.state === 'healthy' || prev?.state === 'ramping') {
            st = 'drain';
            rsn = 'stale_telemetry_drain';
          } else if (prev?.state === 'drain') {
            st = 'drain';
            rsn = 'stale_telemetry_drain_hold';
          } else if (prev?.state === 'hard_stop' || prev?.state === 'cooldown') {
            st = prev.state;
            rsn = 'stale_telemetry_hold';
          } else {
            st = 'unknown';
            rsn = 'stale_telemetry_unknown';
          }
        } else {
          // Two-stage drain with hysteresis
          const wasInDrain = prev?.state === 'drain';
          const inDrain = evalDrain(
            quotaEff,
            quotaProj,
            drainPct,
            drainRecoveryPct,
            wasInDrain
          );

          if (inDrain) {
            st = 'drain';
            rsn = 'drain';
          } else {
            st = 'healthy';
            rsn = 'healthy';
          }
        }
      }

      proAccountEval.set(snap.cpaName, {
        quotaProj,
        quotaEff,
        hardFloorPct,
        hardFloorRecoveryPct,
        drainPct,
        drainRecoveryPct,
        prevAccountState: prev,
        isHardFloorBreached: st === 'hard_stop',
        isStale,
        initialState: st,
        initialReason: rsn,
      });
    }

    // Collective degraded fallback evaluation for PRO
    // Eligible healthy: managed Pro accounts with initialState === 'healthy'
    const managedProSnaps = proSnaps.filter((s) => isWatermarkManaged(s));
    const N = managedProSnaps.length;
    const K = Math.max(2, Math.ceil(N / 3));

    let eligibleHealthyCount = 0;
    for (const snap of managedProSnaps) {
      const ev = proAccountEval.get(snap.cpaName)!;
      if (ev.initialState === 'healthy') {
        eligibleHealthyCount++;
      }
    }

    const prevTierState = prevState?.tierStates?.[tierKey] ?? 'normal';
    const prevTierEnteredAt = prevState?.tierStateEnteredAt?.[tierKey];
    const tierEnteredAt = prevTierEnteredAt ?? now;
    let nextTierState: 'normal' | 'collective_fallback' | 'fail_static' = prevTierState;

    if (prevTierState === 'collective_fallback') {
      // Exit condition: >= K accounts recover to >= 24% QuotaEffective AND minimum dwell time >= 600s
      // Exclude stale accounts (>300s) from recoveredCount
      let recoveredCount = 0;
      for (const snap of managedProSnaps) {
        const isStale = snap.stalenessSec > 300;
        if (!snap.isCooldown && !isStale && snap.quotaEffectivePct >= proCfg.drainRecoveryPct) {
          recoveredCount++;
        }
      }
      const dwellTimeSec = (now - tierEnteredAt) / 1000;
      if (dwellTimeSec >= proCfg.fallbackMinDwellSec && recoveredCount >= K) {
        nextTierState = 'normal';
        nextTierStateEnteredAt[tierKey] = now;
      } else {
        nextTierState = 'collective_fallback';
        nextTierStateEnteredAt[tierKey] = tierEnteredAt;
      }
    } else {
      // Enter condition: EligibleHealthy < K
      if (N > 0 && eligibleHealthyCount < K) {
        nextTierState = 'collective_fallback';
        nextTierStateEnteredAt[tierKey] = now;
      } else {
        nextTierState = 'normal';
        nextTierStateEnteredAt[tierKey] = tierEnteredAt;
      }
    }
    nextTierStates[tierKey] = nextTierState;

    // Assign Pro targets based on tier state and account states
    let proEligibleCount = 0; // count of Pro accounts eligible (not in hard_stop, cooldown, unknown, unmanaged)

    for (const snap of proSnaps) {
      const ev = proAccountEval.get(snap.cpaName)!;
      let targetWeight = 0;
      let reason = ev.initialReason;
      let finalState = ev.initialState;

      let isEmergency = false;
      if (!snap.managed) {
        targetWeight = snap.currentWeight ?? 0;
        reason = 'unmanaged';
      } else if (ev.initialState === 'cooldown') {
        targetWeight = 0;
        reason = 'cooldown';
        isEmergency = true;
        delete nextRampStep[snap.cpaName];
      } else if (ev.initialState === 'hard_stop') {
        targetWeight = 0;
        reason = 'hard_stop';
        isEmergency = true;
        delete nextRampStep[snap.cpaName];
      } else if (nextTierState === 'collective_fallback') {
        // Fallback: Staleness (#4) outranks Fallback (#5)
        // - Accounts in state 'unknown' (stale with no prior state) stay W=0
        // - Stale accounts holding drain (state 'drain', reason 'stale_telemetry_drain' or 'stale_telemetry_drain_hold')
        //   must hold W=1 and NOT be elevated to W=100
        // - Only non-stale, non-hardstop, non-cooldown accounts participate in collective fallback elevation to W=100
        if (ev.initialState === 'unknown') {
          targetWeight = 0;
          reason = ev.initialReason;
          delete nextRampStep[snap.cpaName];
        } else if (ev.isStale && ev.initialState === 'drain') {
          targetWeight = 1;
          reason = ev.initialReason;
          delete nextRampStep[snap.cpaName];
          proEligibleCount++;
        } else {
          targetWeight = 100;
          reason = 'collective_fallback';
          finalState = 'healthy';
          delete nextRampStep[snap.cpaName];
          proEligibleCount++;
        }
      } else {
        // Normal tier watermark / drain policy
        if (ev.initialState === 'drain') {
          targetWeight = 1;
          reason = ev.initialReason;
          delete nextRampStep[snap.cpaName];
          proEligibleCount++;
        } else if (ev.initialState === 'healthy') {
          // Anti-thundering herd recovery ramp check
          // If previous state was fallback, hard_stop, cooldown, or ramping
          const prevAcc = ev.prevAccountState;
          const wasDown =
            prevAcc?.state === 'hard_stop' ||
            prevAcc?.state === 'cooldown' ||
            prevTierState === 'collective_fallback' ||
            prevAcc?.state === 'ramping';

          if (wasDown) {
            // Ramping phase: 25 -> 50 -> 100
            const currentRamp = nextRampStep[snap.cpaName] ?? 0;
            if (currentRamp === 0) {
              targetWeight = 25;
              nextRampStep[snap.cpaName] = 1;
              finalState = 'ramping';
              reason = 'ramping_25';
            } else if (currentRamp === 1) {
              targetWeight = 50;
              nextRampStep[snap.cpaName] = 2;
              finalState = 'ramping';
              reason = 'ramping_50';
            } else {
              targetWeight = 100;
              delete nextRampStep[snap.cpaName];
              finalState = 'healthy';
              reason = 'healthy';
            }
          } else {
            targetWeight = 100;
            delete nextRampStep[snap.cpaName];
            finalState = 'healthy';
            reason = 'healthy';
          }
          proEligibleCount++;
        } else if (ev.initialState === 'unknown') {
          targetWeight = 0;
          reason = 'unknown_telemetry';
          delete nextRampStep[snap.cpaName];
        }
      }

      targets.set(snap.cpaName, { targetWeight, reason, isEmergency });
      const enteredAt =
        prevState?.accountStates?.[snap.cpaName]?.state === finalState
          ? prevState?.accountStates?.[snap.cpaName]?.enteredAt ?? now
          : now;

      nextAccountStates[snap.cpaName] = {
        state: finalState,
        enteredAt,
        targetWeight,
      };
    }

    // ----------------------------------------------------
    // Tier 2: NON-PRO Accounts (Sequential Sticky Fill-First)
    // ----------------------------------------------------
    // Non-Pro activates ONLY when 0 Pro accounts in provider pool are eligible.
    // Spec §3.4: When Pro recovers, Non-Pro accounts must remain active until >=1 Pro account has been healthy
    // or ramping continuously for >= recoveryDwellSec (default 600s).
    const nonProTierKey = `${provider}:non_pro`;
    const proHealthyKey = `${provider}:pro_healthy`;

    const proHasHealthyOrRamping = proSnaps.some((s) => {
      const st = nextAccountStates[s.cpaName]?.state;
      return st === 'healthy' || st === 'ramping';
    });

    let proHealthySince = prevState?.tierStateEnteredAt?.[proHealthyKey];
    if (proHasHealthyOrRamping) {
      if (proHealthySince === undefined) {
        proHealthySince = now;
      }
      nextTierStateEnteredAt[proHealthyKey] = proHealthySince;
    } else {
      delete nextTierStateEnteredAt[proHealthyKey];
      proHealthySince = undefined;
    }

    const proRecoveryDwellElapsed =
      proHealthySince !== undefined && (now - proHealthySince) / 1000 >= proCfg.recoveryDwellSec;

    const prevNonProTierState = prevState?.tierStates?.[nonProTierKey] ?? 'normal';
    const prevNonProTierEnteredAt = prevState?.tierStateEnteredAt?.[nonProTierKey];
    const nonProTierEnteredAt = prevNonProTierEnteredAt ?? now;
    nextTierStates[nonProTierKey] = 'normal';
    nextTierStateEnteredAt[nonProTierKey] =
      prevNonProTierState === 'normal' ? nonProTierEnteredAt : now;

    // Was Non-Pro previously active?
    const wasNonProActive = nonProSnaps.some(
      (s) => (prevState?.accountStates?.[s.cpaName]?.targetWeight ?? 0) > 0
    );

    // Non-Pro tier is active if:
    // 1. Pro has no eligible accounts (proEligibleCount === 0), OR
    // 2. Non-Pro was already active and Pro recovery dwell (10 min) has not yet elapsed.
    const keepNonProActive =
      proEligibleCount === 0 || (wasNonProActive && !proRecoveryDwellElapsed);

    if (keepNonProActive && nonProSnaps.length > 0) {
      // Non-Pro tier is active
      // Sequential Sticky Fill-First:
      // Prefer currently active candidate (prevAcc?.targetWeight === 100 && !drained && !hard_stop) over alphabetical sorting.
      let activeCandidateName: string | null = null;
      for (const snap of nonProSnaps) {
        if (!snap.managed || snap.isCooldown) continue;
        const prev = prevState?.accountStates?.[snap.cpaName];
        if (prev?.targetWeight === 100) {
          const quotaEff = snap.quotaEffectivePct;
          const quotaProj = projectQuota(quotaEff, snap.burnRatePerMin, snap.stalenessSec, horizonSec, burnRateMax);
          const wasHardStop = prev?.state === 'hard_stop';
          const hardStopBreached = evalHardStop(
            quotaEff,
            quotaProj,
            nonProCfg.hardStopPct,
            nonProCfg.hardStopRecoveryPct,
            wasHardStop
          );
          const isStale = snap.stalenessSec > 300;
          const wasDrain = prev?.state === 'drain';
          const inDrain = evalDrain(
            quotaEff,
            quotaProj,
            nonProCfg.drainPct,
            nonProCfg.drainRecoveryPct,
            wasDrain
          );

          if (!hardStopBreached && !isStale && !inDrain) {
            activeCandidateName = snap.cpaName;
            break;
          }
        }
      }

      if (!activeCandidateName) {
        const sortedNonPro = [...nonProSnaps].sort((a, b) => a.cpaName.localeCompare(b.cpaName));
        for (const snap of sortedNonPro) {
          if (!snap.managed || snap.isCooldown) continue;
          const prev = prevState?.accountStates?.[snap.cpaName];
          const quotaEff = snap.quotaEffectivePct;
          const quotaProj = projectQuota(quotaEff, snap.burnRatePerMin, snap.stalenessSec, horizonSec, burnRateMax);
          const wasHardStop = prev?.state === 'hard_stop';
          const hardStopBreached = evalHardStop(
            quotaEff,
            quotaProj,
            nonProCfg.hardStopPct,
            nonProCfg.hardStopRecoveryPct,
            wasHardStop
          );
          const isStale = snap.stalenessSec > 300;
          const wasDrain = prev?.state === 'drain';
          const inDrain = evalDrain(
            quotaEff,
            quotaProj,
            nonProCfg.drainPct,
            nonProCfg.drainRecoveryPct,
            wasDrain
          );

          if (!hardStopBreached && !isStale && !inDrain) {
            activeCandidateName = snap.cpaName;
            break;
          }
        }
      }

      for (const snap of nonProSnaps) {
        const prev = prevState?.accountStates?.[snap.cpaName];
        let targetWeight = 0;
        let reason = 'standby';
        let state: AccountEngineStateKind = 'healthy';
        let isEmergency = false;

        if (!snap.managed) {
          targetWeight = snap.currentWeight ?? 0;
          reason = 'unmanaged';
          state = 'unmanaged';
        } else if (snap.isCooldown) {
          targetWeight = 0;
          reason = 'cooldown';
          state = 'cooldown';
          isEmergency = true;
          delete nextRampStep[snap.cpaName];
        } else {
          const quotaEff = snap.quotaEffectivePct;
          const quotaProj = projectQuota(quotaEff, snap.burnRatePerMin, snap.stalenessSec, horizonSec, burnRateMax);

          const wasHardStop = prev?.state === 'hard_stop';
          const hardStopBreached = evalHardStop(
            quotaEff,
            quotaProj,
            nonProCfg.hardStopPct,
            nonProCfg.hardStopRecoveryPct,
            wasHardStop
          );

          if (hardStopBreached) {
            targetWeight = 0;
            reason = 'hard_stop';
            state = 'hard_stop';
            isEmergency = true;
            delete nextRampStep[snap.cpaName];
          } else if (snap.stalenessSec > 300) {
            targetWeight = 0;
            reason = 'stale_telemetry';
            state = 'unknown';
            delete nextRampStep[snap.cpaName];
          } else {
            // Non-Pro drain hand-off at the policy nonPro.drainPct (recovery at drainRecoveryPct)
            const wasDrain = prev?.state === 'drain';
            const inDrain = evalDrain(
              quotaEff,
              quotaProj,
              nonProCfg.drainPct,
              nonProCfg.drainRecoveryPct,
              wasDrain
            );

            if (inDrain) {
              targetWeight = 1;
              reason = 'drain';
              state = 'drain';
              delete nextRampStep[snap.cpaName];
            } else if (snap.cpaName === activeCandidateName) {
              // Active sticky candidate gets W = 100
              targetWeight = 100;
              reason = 'active_sticky';
              state = 'healthy';
            } else {
              // Other candidates remain on standby W = 0
              targetWeight = 0;
              reason = 'standby';
              state = 'healthy';
            }
          }
        }

        targets.set(snap.cpaName, { targetWeight, reason, isEmergency });
        const enteredAt =
          prev?.state === state ? prev?.enteredAt ?? now : now;
        nextAccountStates[snap.cpaName] = {
          state,
          enteredAt,
          targetWeight,
        };
      }
    } else if (nonProSnaps.length > 0) {
      // Pro HAS eligible accounts AND dwell has elapsed -> Non-Pro must step down
      // When Pro recovers, only accounts that were previously active (>0 weight) step down to drain W=1.
      // Standby accounts (targetWeight === 0) stay at W=0; do not oscillate 1,0,1,0.
      for (const snap of nonProSnaps) {
        const prev = prevState?.accountStates?.[snap.cpaName];
        let targetWeight = 0;
        let reason = 'standby_pro_active';
        let state: AccountEngineStateKind = 'healthy';
        let isEmergency = false;

        if (!snap.managed) {
          targetWeight = snap.currentWeight ?? 0;
          reason = 'unmanaged';
          state = 'unmanaged';
        } else if (snap.isCooldown) {
          targetWeight = 0;
          reason = 'cooldown';
          state = 'cooldown';
          isEmergency = true;
          delete nextRampStep[snap.cpaName];
        } else {
          const quotaEff = snap.quotaEffectivePct;
          const quotaProj = projectQuota(quotaEff, snap.burnRatePerMin, snap.stalenessSec, horizonSec, burnRateMax);

          const wasHardStop = prev?.state === 'hard_stop';
          const hardStopBreached = evalHardStop(
            quotaEff,
            quotaProj,
            nonProCfg.hardStopPct,
            nonProCfg.hardStopRecoveryPct,
            wasHardStop
          );

          if (hardStopBreached) {
            targetWeight = 0;
            reason = 'hard_stop';
            state = 'hard_stop';
            isEmergency = true;
            delete nextRampStep[snap.cpaName];
          } else if (snap.stalenessSec > 300) {
            targetWeight = 0;
            reason = 'stale_telemetry';
            state = 'unknown';
            delete nextRampStep[snap.cpaName];
          } else if (prev?.targetWeight === 100) {
            // Was active, transition through drain (W = 1) to allow in-flight turns to finish
            targetWeight = 1;
            reason = 'cross_tier_drain_stepdown';
            state = 'drain';
            delete nextRampStep[snap.cpaName];
          } else {
            // Standby accounts (targetWeight === 0) and stepped-down accounts stay at W = 0
            targetWeight = 0;
            reason = 'standby_pro_active';
            state = 'healthy';
          }
        }

        targets.set(snap.cpaName, { targetWeight, reason, isEmergency });
        const enteredAt = prev?.state === state ? prev?.enteredAt ?? now : now;
        nextAccountStates[snap.cpaName] = {
          state,
          enteredAt,
          targetWeight,
        };
      }
    }
  }

  // ----------------------------------------------------
  // System Invariant Guards & Write Batch Assembly
  // ----------------------------------------------------
  // Invariants evaluated strictly across managed accounts per provider pool
  for (const [provider, pool] of providerPools.entries()) {
    const managedPool = pool.filter((s) => isWatermarkManaged(s));
    if (managedPool.length === 0) continue;

    // Invariant 1: Hard Floor Invariant (No managed account with nominal or proj <= hardStopPct shall have W > 0)
    for (const snap of managedPool) {
      const decision = targets.get(snap.cpaName);
      if (!decision) continue;

      const prev = prevState?.accountStates?.[snap.cpaName];
      const wasInHardStop = prev?.state === 'hard_stop';
      const hardFloorPct = snap.tier === 'pro' ? proCfg.hardStopPct : nonProCfg.hardStopPct;
      const hardFloorRecoveryPct = snap.tier === 'pro' ? proCfg.hardStopRecoveryPct : nonProCfg.hardStopRecoveryPct;
      const quotaEff = snap.quotaEffectivePct;
      const quotaProj = projectQuota(quotaEff, snap.burnRatePerMin, snap.stalenessSec, horizonSec, burnRateMax);

      const hardStopBreached = evalHardStop(
        quotaEff,
        quotaProj,
        hardFloorPct,
        hardFloorRecoveryPct,
        wasInHardStop
      );

      if (hardStopBreached && decision.targetWeight > 0) {
        // Enforce invariant by forcing W = 0
        decision.targetWeight = 0;
        decision.reason = 'invariant_hard_floor_abort';
        decision.isEmergency = true;
        const oldState = nextAccountStates[snap.cpaName].state;
        if (oldState !== 'hard_stop') {
          nextAccountStates[snap.cpaName].enteredAt = now;
        }
        nextAccountStates[snap.cpaName].targetWeight = 0;
        nextAccountStates[snap.cpaName].state = 'hard_stop';
        delete nextRampStep[snap.cpaName];
        invariantViolations.push({
          accountId: snap.accountId,
          invariant: 'Invariant 1 (Hard Safety Floor)',
          reason: `Quota breached hard stop (eff=${quotaEff}%, proj=${quotaProj.toFixed(1)}%)`,
          action: 'force_zero_hard_stop',
        });
      }
    }

    // Invariant 2: Cooldown Invariant (No managed account in provider cooldown shall have W > 0)
    for (const snap of managedPool) {
      const decision = targets.get(snap.cpaName);
      if (!decision) continue;
      if (snap.isCooldown && decision.targetWeight > 0) {
        decision.targetWeight = 0;
        decision.reason = 'invariant_cooldown_abort';
        decision.isEmergency = true;
        const oldState = nextAccountStates[snap.cpaName].state;
        if (oldState !== 'cooldown') {
          nextAccountStates[snap.cpaName].enteredAt = now;
        }
        nextAccountStates[snap.cpaName].targetWeight = 0;
        nextAccountStates[snap.cpaName].state = 'cooldown';
        delete nextRampStep[snap.cpaName];
        invariantViolations.push({
          accountId: snap.accountId,
          invariant: 'Invariant 2 (Cooldown / 429 Isolation)',
          reason: 'Account is in cooldown or received 429',
          action: 'force_zero_cooldown',
        });
      }
    }

    // Invariant 3: No-Accidental-Blackout Invariant (sum W > 0 unless all managed accounts hard-stopped or in cooldown)
    let poolSumW = 0;
    for (const snap of managedPool) {
      poolSumW += targets.get(snap.cpaName)?.targetWeight ?? 0;
    }

    if (poolSumW === 0) {
      // Find eligible candidates to prevent accidental blackout.
      // Candidates for W=1 MUST EXCLUDE accounts in hard_stop, cooldown, or unknown
      const available = managedPool.filter((s) => {
        const accState = nextAccountStates[s.cpaName]?.state;
        return (
          accState !== 'hard_stop' &&
          accState !== 'cooldown' &&
          accState !== 'unknown' &&
          accState !== 'unmanaged'
        );
      });

      if (available.length > 0) {
        available.sort((a, b) => b.quotaEffectivePct - a.quotaEffectivePct);
        const best = available[0];
        const bestDecision = targets.get(best.cpaName)!;
        bestDecision.targetWeight = 1;
        bestDecision.reason = 'invariant_no_blackout_preserve';
        const oldState = nextAccountStates[best.cpaName].state;
        if (oldState !== 'drain') {
          nextAccountStates[best.cpaName].enteredAt = now;
        }
        nextAccountStates[best.cpaName].targetWeight = 1;
        nextAccountStates[best.cpaName].state = 'drain';
        invariantViolations.push({
          accountId: best.accountId,
          invariant: 'Invariant 3 (No Accidental Blackout)',
          reason: 'Pool sum(W) === 0 but eligible candidate available',
          action: 'assign_drain_weight',
        });
      }
    }
  }

  // Generate write batch with Make-Before-Break write ordering and Emergency Rate-Limiter Bypass
  // If policy.mode === 'shadow', return writeBatch: [] (decisions and state still calculated for observability).
  const writeBatch: Array<{ name: string; weight: number; isEmergency: boolean }> = [];

  if (mode !== 'shadow') {
    // Write batch ordering must be evaluated PER PROVIDER POOL, not globally.
    // A promotion in 'claude' must never delay an emergency demotion in 'antigravity'.
    for (const [, pool] of providerPools.entries()) {
      interface WriteOp {
        name: string;
        weight: number;
        currentWeight: number;
        isEmergency: boolean;
      }
      const poolUpdates: WriteOp[] = [];

      for (const snap of pool) {
        if (!isWatermarkManaged(snap)) continue;

        const decision = targets.get(snap.cpaName);
        if (!decision) continue;

        const currentW = snap.currentWeight ?? 0;
        const targetW = decision.targetWeight;

        if (currentW !== targetW) {
          poolUpdates.push({
            name: snap.cpaName,
            weight: targetW,
            currentWeight: currentW,
            isEmergency: Boolean(decision.isEmergency),
          });
        }
      }

      const poolIncreases = poolUpdates.filter((u) => u.weight > u.currentWeight);
      const poolEmergency = poolUpdates.filter((u) => u.weight < u.currentWeight && u.isEmergency);
      const poolDecreases = poolUpdates.filter((u) => u.weight < u.currentWeight && !u.isEmergency);

      const poolBatch =
        poolIncreases.length > 0
          ? [...poolIncreases, ...poolEmergency, ...poolDecreases]
          : [...poolEmergency, ...poolDecreases];

      for (const op of poolBatch) {
        writeBatch.push({
          name: op.name,
          weight: op.weight,
          isEmergency: op.isEmergency,
        });
      }
    }
  }

  return {
    targets,
    nextState: {
      mode,
      tierStates: nextTierStates,
      tierStateEnteredAt: nextTierStateEnteredAt,
      accountStates: nextAccountStates,
      rampStep: nextRampStep,
      generation: (prevState?.generation ?? 0) + 1,
    },
    writeBatch,
    invariantViolations,
  };
}
