export interface WatermarkPolicyConfig {
  mode?: 'off' | 'shadow' | 'enforce';
  intervalSec?: number;
  applyLatencySec?: number;
  burnRateMax?: number; // default 15
  pro?: {
    drainPct?: number; // default 20
    drainRecoveryPct?: number; // default 24
    hardStopPct?: number; // default 5
    hardStopRecoveryPct?: number; // default 8
    fallbackMinDwellSec?: number; // default 600 (10 mins)
    recoveryDwellSec?: number; // default 600 (10 mins)
  };
  nonPro?: {
    drainPct?: number; // default 40
    drainRecoveryPct?: number; // default 44
    hardStopPct?: number; // default 2
    hardStopRecoveryPct?: number; // default 5
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

export interface WatermarkComputationResult {
  targets: Map<string, { targetWeight: number; reason: string }>;
  nextState: EngineState;
  writeBatch: Array<{ name: string; weight: number; isEmergency: boolean }>;
}

const DEFAULT_BURN_RATE_MAX = 15;
const DEFAULT_INTERVAL_SEC = 60;
const DEFAULT_APPLY_LATENCY_SEC = 5;
const DEFAULT_HORIZON_SEC = 65; // 60 + 5

const PRO_DEFAULTS = {
  drainPct: 20,
  drainRecoveryPct: 24,
  hardStopPct: 5,
  hardStopRecoveryPct: 8,
  fallbackMinDwellSec: 600,
  recoveryDwellSec: 600,
};

const NON_PRO_DEFAULTS = {
  drainPct: 40,
  drainRecoveryPct: 44,
  hardStopPct: 2,
  hardStopRecoveryPct: 5,
};

function clamp(val: number, min: number, max: number): number {
  if (Number.isNaN(val)) return min;
  return Math.min(Math.max(val, min), max);
}

export function computeWatermarkTargets(
  snapshots: WatermarkSnapshot[],
  policy: WatermarkPolicyConfig,
  prevState: EngineState,
  now: number
): WatermarkComputationResult {
  const mode = policy.mode ?? prevState?.mode ?? 'shadow';

  if (mode === 'off') {
    const emptyTargets = new Map<string, { targetWeight: number; reason: string }>();
    for (const snap of snapshots) {
      emptyTargets.set(snap.cpaName, { targetWeight: snap.currentWeight ?? 0, reason: 'mode_off' });
    }
    return {
      targets: emptyTargets,
      nextState: {
        mode: 'off',
        tierStates: {},
        accountStates: {},
        generation: (prevState?.generation ?? 0) + 1,
      },
      writeBatch: [],
    };
  }

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

  const targets = new Map<string, { targetWeight: number; reason: string }>();
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
    // 1. Direct API modality accounts are completely bypassed from watermark eviction
    const directApiSnaps = pool.filter((s) => s.modality === 'direct_api');
    for (const snap of directApiSnaps) {
      targets.set(snap.cpaName, {
        targetWeight: snap.currentWeight ?? 100,
        reason: 'direct_api_bypass',
      });
      nextAccountStates[snap.cpaName] = {
        state: 'unmanaged',
        enteredAt: prevState?.accountStates?.[snap.cpaName]?.enteredAt ?? now,
        targetWeight: snap.currentWeight ?? 100,
      };
    }

    const nonDirectPool = pool.filter((s) => s.modality !== 'direct_api');
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
      const clampedBurn = clamp(snap.burnRatePerMin, 0, burnRateMax);
      const quotaProj = quotaEff - clampedBurn * ((horizonSec + snap.stalenessSec) / 60);

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
        const hardStopBreached = wasInHardStop
          ? quotaEff < hardFloorRecoveryPct
          : quotaProj <= hardFloorPct || quotaEff <= hardFloorPct;

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
          const inDrain = wasInDrain
            ? quotaEff < drainRecoveryPct
            : quotaProj <= drainPct;

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
    const managedProSnaps = proSnaps.filter((s) => s.managed);
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
    const tierEnteredAt = prevState?.tierStateEnteredAt?.[tierKey] ?? now;
    let nextTierState: 'normal' | 'collective_fallback' | 'fail_static' = prevTierState;

    if (prevTierState === 'collective_fallback') {
      // Exit condition: >= K accounts recover to >= 24% QuotaEffective AND minimum dwell time >= 600s
      let recoveredCount = 0;
      for (const snap of managedProSnaps) {
        if (!snap.isCooldown && snap.quotaEffectivePct >= proCfg.drainRecoveryPct) {
          recoveredCount++;
        }
      }
      const dwellTimeSec = (now - tierEnteredAt) / 1000;
      if (dwellTimeSec >= proCfg.fallbackMinDwellSec && recoveredCount >= K) {
        nextTierState = 'normal';
        nextTierStateEnteredAt[tierKey] = now;
      } else {
        nextTierState = 'collective_fallback';
      }
    } else {
      // Enter condition: EligibleHealthy < K
      if (N > 0 && eligibleHealthyCount < K) {
        nextTierState = 'collective_fallback';
        nextTierStateEnteredAt[tierKey] = now;
      } else {
        nextTierState = 'normal';
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

      if (!snap.managed) {
        targetWeight = snap.currentWeight ?? 0;
        reason = 'unmanaged';
      } else if (ev.initialState === 'cooldown') {
        targetWeight = 0;
        reason = 'cooldown';
      } else if (ev.initialState === 'hard_stop') {
        targetWeight = 0;
        reason = 'hard_stop';
      } else if (nextTierState === 'collective_fallback') {
        // Fallback: all managed accounts not in hard_stop or cooldown get W = 100
        targetWeight = 100;
        reason = 'collective_fallback';
        finalState = 'healthy';
        proEligibleCount++;
      } else {
        // Normal tier watermark / drain policy
        if (ev.initialState === 'drain') {
          targetWeight = 1;
          reason = ev.initialReason;
          proEligibleCount++;
        } else if (ev.initialState === 'healthy') {
          // Anti-thundering herd recovery ramp check
          // If previous state was fallback, hard_stop, or cooldown and now recovering
          const prevAcc = ev.prevAccountState;
          const wasDown =
            prevAcc?.state === 'hard_stop' ||
            prevAcc?.state === 'cooldown' ||
            prevTierState === 'collective_fallback';

          if (wasDown && prevAcc?.targetWeight !== 100) {
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
            finalState = 'healthy';
            reason = 'healthy';
          }
          proEligibleCount++;
        } else if (ev.initialState === 'unknown') {
          targetWeight = 0;
          reason = 'unknown_telemetry';
        }
      }

      targets.set(snap.cpaName, { targetWeight, reason });
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
    // Non-Pro activates ONLY when 0 Pro accounts in provider pool are eligible
    const nonProTierKey = `${provider}:non_pro`;
    const proHasEligible = proEligibleCount > 0;

    // Cross-tier recovery tracking:
    // When Pro recovers (>= 1 account healthy/ramping), Non-Pro transitions to drain (W = 1) before W = 0
    // Check if Pro has been healthy/ramping
    const proRecoveredDwellSec = proHasEligible ? (now - (nextTierStateEnteredAt[tierKey] ?? now)) / 1000 : 0;
    const proFullyRecovered = proHasEligible && proRecoveredDwellSec >= proCfg.recoveryDwellSec;

    if (!proHasEligible && nonProSnaps.length > 0) {
      // Non-Pro tier is active
      // Sequential Sticky Fill-First:
      // Sort standby accounts deterministically (by cpaName)
      const sortedNonPro = [...nonProSnaps].sort((a, b) => a.cpaName.localeCompare(b.cpaName));
      let activeCandidateFound = false;

      for (const snap of sortedNonPro) {
        const prev = prevState?.accountStates?.[snap.cpaName];
        let targetWeight = 0;
        let reason = 'standby';
        let state: AccountEngineStateKind = 'healthy';

        if (!snap.managed) {
          targetWeight = snap.currentWeight ?? 0;
          reason = 'unmanaged';
          state = 'unmanaged';
        } else if (snap.isCooldown) {
          targetWeight = 0;
          reason = 'cooldown';
          state = 'cooldown';
        } else {
          const quotaEff = snap.quotaEffectivePct;
          const clampedBurn = clamp(snap.burnRatePerMin, 0, burnRateMax);
          const quotaProj = quotaEff - clampedBurn * ((horizonSec + snap.stalenessSec) / 60);

          const wasHardStop = prev?.state === 'hard_stop';
          const hardStopBreached = wasHardStop
            ? quotaEff < nonProCfg.hardStopRecoveryPct
            : quotaProj <= nonProCfg.hardStopPct || quotaEff <= nonProCfg.hardStopPct;

          if (hardStopBreached) {
            targetWeight = 0;
            reason = 'hard_stop';
            state = 'hard_stop';
          } else if (snap.stalenessSec > 300) {
            targetWeight = 0;
            reason = 'stale_telemetry';
            state = 'unknown';
          } else {
            // Check drain threshold <= 40% (recovery >= 44%)
            const wasDrain = prev?.state === 'drain';
            const inDrain = wasDrain
              ? quotaEff < nonProCfg.drainRecoveryPct
              : quotaProj <= nonProCfg.drainPct;

            if (inDrain) {
              targetWeight = 1;
              reason = 'drain';
              state = 'drain';
            } else if (!activeCandidateFound) {
              // First non-exhausted candidate gets active W = 100
              targetWeight = 100;
              reason = 'active_sticky';
              state = 'healthy';
              activeCandidateFound = true;
            } else {
              // Other candidates remain on standby W = 0
              targetWeight = 0;
              reason = 'standby';
              state = 'healthy';
            }
          }
        }

        targets.set(snap.cpaName, { targetWeight, reason });
        const enteredAt =
          prev?.state === state ? prev?.enteredAt ?? now : now;
        nextAccountStates[snap.cpaName] = {
          state,
          enteredAt,
          targetWeight,
        };
      }
      nextTierStates[nonProTierKey] = 'normal';
    } else if (nonProSnaps.length > 0) {
      // Pro HAS eligible accounts -> Non-Pro must step down
      // When Pro recovers, Non-Pro transitions to drain (W = 1) before returning to standby (W = 0)
      for (const snap of nonProSnaps) {
        const prev = prevState?.accountStates?.[snap.cpaName];
        let targetWeight = 0;
        let reason = 'standby_pro_active';
        let state: AccountEngineStateKind = 'healthy';

        if (!snap.managed) {
          targetWeight = snap.currentWeight ?? 0;
          reason = 'unmanaged';
          state = 'unmanaged';
        } else if (snap.isCooldown) {
          targetWeight = 0;
          reason = 'cooldown';
          state = 'cooldown';
        } else if (prev?.targetWeight === 100 || prev?.state === 'healthy') {
          // Was active, transition through drain (W = 1) to allow in-flight turns to finish
          targetWeight = 1;
          reason = 'cross_tier_drain_stepdown';
          state = 'drain';
        } else {
          // Return to standby W = 0
          targetWeight = 0;
          reason = 'standby_pro_active';
          state = 'healthy';
        }

        targets.set(snap.cpaName, { targetWeight, reason });
        const enteredAt = prev?.state === state ? prev?.enteredAt ?? now : now;
        nextAccountStates[snap.cpaName] = {
          state,
          enteredAt,
          targetWeight,
        };
      }
      nextTierStates[nonProTierKey] = 'normal';
    }
  }

  // ----------------------------------------------------
  // System Invariant Guards & Write Batch Assembly
  // ----------------------------------------------------
  // Invariants evaluated strictly across managed accounts per provider pool
  const writeBatch: Array<{ name: string; weight: number; isEmergency: boolean }> = [];

  for (const [provider, pool] of providerPools.entries()) {
    const managedPool = pool.filter((s) => s.managed && s.modality !== 'direct_api');
    if (managedPool.length === 0) continue;

    // Invariant 1: Hard Floor Invariant (No managed account with nominal or proj <= hardStopPct shall have W > 0)
    for (const snap of managedPool) {
      const decision = targets.get(snap.cpaName);
      if (!decision) continue;

      const hardStopPct = snap.tier === 'pro' ? proCfg.hardStopPct : nonProCfg.hardStopPct;
      const clampedBurn = clamp(snap.burnRatePerMin, 0, burnRateMax);
      const quotaProj = snap.quotaEffectivePct - clampedBurn * ((horizonSec + snap.stalenessSec) / 60);

      if ((snap.quotaEffectivePct <= hardStopPct || quotaProj <= hardStopPct) && decision.targetWeight > 0) {
        // Enforce invariant by forcing W = 0
        decision.targetWeight = 0;
        decision.reason = 'invariant_hard_floor_abort';
        nextAccountStates[snap.cpaName].targetWeight = 0;
        nextAccountStates[snap.cpaName].state = 'hard_stop';
      }
    }

    // Invariant 2: Cooldown Invariant (No managed account in provider cooldown shall have W > 0)
    for (const snap of managedPool) {
      const decision = targets.get(snap.cpaName);
      if (!decision) continue;
      if (snap.isCooldown && decision.targetWeight > 0) {
        decision.targetWeight = 0;
        decision.reason = 'invariant_cooldown_abort';
        nextAccountStates[snap.cpaName].targetWeight = 0;
        nextAccountStates[snap.cpaName].state = 'cooldown';
      }
    }

    // Invariant 3: No-Accidental-Blackout Invariant (sum W > 0 unless all managed accounts hard-stopped or in cooldown)
    const allHardOrCooldown = managedPool.every((s) => {
      const hardStopPct = s.tier === 'pro' ? proCfg.hardStopPct : nonProCfg.hardStopPct;
      const clampedBurn = clamp(s.burnRatePerMin, 0, burnRateMax);
      const quotaProj = s.quotaEffectivePct - clampedBurn * ((horizonSec + s.stalenessSec) / 60);
      return s.isCooldown || s.quotaEffectivePct <= hardStopPct || quotaProj <= hardStopPct;
    });

    let poolSumW = 0;
    for (const snap of managedPool) {
      poolSumW += targets.get(snap.cpaName)?.targetWeight ?? 0;
    }

    if (poolSumW === 0 && !allHardOrCooldown) {
      // Find candidate with highest effective quota not in cooldown and assign W = 100 or W = 1
      const available = managedPool.filter((s) => !s.isCooldown);
      if (available.length > 0) {
        available.sort((a, b) => b.quotaEffectivePct - a.quotaEffectivePct);
        const best = available[0];
        const bestDecision = targets.get(best.cpaName)!;
        bestDecision.targetWeight = 1;
        bestDecision.reason = 'invariant_no_blackout_preserve';
        nextAccountStates[best.cpaName].targetWeight = 1;
      }
    }
  }

  // Generate write batch with Make-Before-Break write ordering and Emergency Rate-Limiter Bypass
  // Increases (W ↑) before Decreases (W ↓)
  // Emergency writes (hard floor breached or cooldown / 429) outrank make-before-break when demoting
  const increases: Array<{ name: string; weight: number; isEmergency: boolean }> = [];
  const decreases: Array<{ name: string; weight: number; isEmergency: boolean }> = [];
  const emergencies: Array<{ name: string; weight: number; isEmergency: boolean }> = [];

  for (const snap of snapshots) {
    if (!snap.managed || snap.modality === 'direct_api') continue;

    const decision = targets.get(snap.cpaName);
    if (!decision) continue;

    const currentW = snap.currentWeight ?? 0;
    const targetW = decision.targetWeight;

    if (currentW !== targetW) {
      const isEmergency =
        decision.reason === 'hard_stop' ||
        decision.reason === 'cooldown' ||
        decision.reason === 'invariant_hard_floor_abort' ||
        decision.reason === 'invariant_cooldown_abort';

      const writeOp = {
        name: snap.cpaName,
        weight: targetW,
        isEmergency,
      };

      if (isEmergency) {
        emergencies.push(writeOp);
      } else if (targetW > currentW) {
        increases.push(writeOp);
      } else {
        decreases.push(writeOp);
      }
    }
  }

  // As described in 4.2 Invariant 5:
  // Emergency demotions outrank make-before-break when no promotion candidate exists.
  // When promotions exist, make-before-break applies promotions first, but emergency demotions take immediate priority over normal demotions.
  // Order: emergencies -> increases -> decreases
  writeBatch.push(...emergencies, ...increases, ...decreases);

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
  };
}
