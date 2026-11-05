import type { WatermarkAccountState } from './cpaWatermarkTypes';

export const DEFAULT_TAU_SEC = 60;
export const DEFAULT_T_DRAIN_SEC = 30;
export const DEFAULT_T_POLL_SEC = 5;
/**
 * Lead time L = 5*tau + T_drain + T_poll = 5*60 + 30 + 5 = 335s (~5.58 minutes).
 */
export const DEFAULT_LEAD_TIME_SEC =
  5 * DEFAULT_TAU_SEC + DEFAULT_T_DRAIN_SEC + DEFAULT_T_POLL_SEC;

export const DEFAULT_EXHAUSTED_FLOOR_PCT = 5;
export const DEFAULT_TIGHT_FLOOR_PCT = 15;
export const DEFAULT_FAST_WINDOW_MIN = 2;
export const DEFAULT_SLOW_WINDOW_MIN = 10;
export const DEFAULT_COOLDOWN_SEC = 335;

export interface TripwireConfig {
  tauSec?: number;
  tDrainSec?: number;
  tPollSec?: number;
  leadTimeSec?: number;
  exhaustedFloorPct?: number;
  tightFloorPct?: number;
  fastWindowMin?: number;
  slowWindowMin?: number;
  burnRateMax?: number;
  collectiveFallbackMode?: 'single_tight' | 'airgap_pool';
}

export interface WindowObservation {
  key: string;
  utilizationPct: number | null;
  remainingPct: number | null;
  resetsAt?: string | null;
  history?: Array<{ t: number; value: number | null }>;
}

export interface TripwireEvaluation {
  accountId: string;
  provider: string;
  cpaName?: string;
  currentHeadroomPct: number;
  projectedHeadroomPct: number;
  burnRatePerMin: number;
  burnRateFast: number;
  burnRateSlow: number;
  leadTimeSec: number;
  bindingWindow: string;
  autoState: WatermarkAccountState;
  reason: string;
  targetWeight: number;
  disabled: boolean;
  isCooldown: boolean;
  runwayMinutes: number | null;
}

/**
 * Calculates lead time L = 5*tau + T_drain + T_poll.
 */
export function calculateLeadTimeSec(
  tauSec: number = DEFAULT_TAU_SEC,
  tDrainSec: number = DEFAULT_T_DRAIN_SEC,
  tPollSec: number = DEFAULT_T_POLL_SEC
): number {
  return 5 * tauSec + tDrainSec + tPollSec;
}

/**
 * Computes Exponential Weighted Moving Average (EWMA) burn rate (% per minute)
 * from historical usage measurements over a given time window.
 */
export function computeEwmaBurnRate(
  history: Array<{ t: number; value: number | null }>,
  windowMinutes: number,
  now: number = Date.now()
): number {
  if (!history || history.length < 2) return 0;

  const windowMs = windowMinutes * 60 * 1000;
  const cutoff = now - windowMs;

  // Filter valid points in window, plus the immediate preceding point for boundary slope
  const valid = history.filter((p) => p.value !== null && Number.isFinite(p.value));
  if (valid.length < 2) return 0;

  const inWindow = valid.filter((p) => p.t >= cutoff).sort((a, b) => a.t - b.t);
  const beforeWindow = valid.filter((p) => p.t < cutoff).sort((a, b) => a.t - b.t);

  const points: Array<{ t: number; value: number }> = [];
  if (beforeWindow.length > 0) {
    const lastBefore = beforeWindow[beforeWindow.length - 1];
    points.push({ t: lastBefore.t, value: lastBefore.value! });
  }
  for (const p of inWindow) {
    points.push({ t: p.t, value: p.value! });
  }

  if (points.length < 2) return 0;

  let ewma = 0;
  let initialized = false;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dtMin = (curr.t - prev.t) / 60000;
    if (dtMin <= 0) continue;

    // Handle window resets: if usage drops, consider increase from reset or 0
    const deltaU = curr.value >= prev.value ? curr.value - prev.value : curr.value;
    const instRate = Math.max(0, deltaU / dtMin);

    if (!initialized) {
      ewma = instRate;
      initialized = true;
    } else {
      const alpha = 1 - Math.exp(-dtMin / windowMinutes);
      ewma = alpha * instRate + (1 - alpha) * ewma;
    }
  }

  // Also calculate total window linear slope as a guard for sparse updates
  const first = points[0];
  const last = points[points.length - 1];
  const totalDtMin = (last.t - first.t) / 60000;
  const totalDeltaU = Math.max(0, last.value - first.value);
  const linearRate = totalDtMin > 0 ? totalDeltaU / totalDtMin : 0;

  const burnRate = Math.max(ewma, linearRate);
  return Math.max(0, Number.isFinite(burnRate) ? burnRate : 0);
}

/**
 * Computes dual-window EWMA burn rate: b = max(b_fast, b_slow).
 */
export function computeDualWindowBurnRate(
  history: Array<{ t: number; value: number | null }>,
  now: number = Date.now(),
  fastMin: number = DEFAULT_FAST_WINDOW_MIN,
  slowMin: number = DEFAULT_SLOW_WINDOW_MIN,
  burnRateMax: number = 15
): { b: number; bFast: number; bSlow: number } {
  const bFast = computeEwmaBurnRate(history, fastMin, now);
  const bSlow = computeEwmaBurnRate(history, slowMin, now);
  const rawMax = Math.max(bFast, bSlow);
  const b = Math.min(rawMax, burnRateMax);
  return { b, bFast, bSlow };
}

/**
 * Evaluates the Predictive Lead-Time Tripwire for an account across windows (e.g. 5h session vs 7d weekly).
 */
export function evaluateAccountTripwire(
  accountId: string,
  provider: string,
  windows: WindowObservation[],
  config: TripwireConfig = {},
  now: number = Date.now()
): TripwireEvaluation {
  const leadTimeSec =
    config.leadTimeSec ??
    calculateLeadTimeSec(config.tauSec, config.tDrainSec, config.tPollSec);
  const leadTimeMin = leadTimeSec / 60;
  const exhaustedFloor = config.exhaustedFloorPct ?? DEFAULT_EXHAUSTED_FLOOR_PCT;
  const tightFloor = config.tightFloorPct ?? DEFAULT_TIGHT_FLOOR_PCT;
  const fastMin = config.fastWindowMin ?? DEFAULT_FAST_WINDOW_MIN;
  const slowMin = config.slowWindowMin ?? DEFAULT_SLOW_WINDOW_MIN;
  const burnRateMax = config.burnRateMax ?? 15;

  if (windows.length === 0) {
    return {
      accountId,
      provider,
      currentHeadroomPct: 100,
      projectedHeadroomPct: 100,
      burnRatePerMin: 0,
      burnRateFast: 0,
      burnRateSlow: 0,
      leadTimeSec,
      bindingWindow: 'unknown',
      autoState: 'healthy',
      reason: 'no_windows',
      targetWeight: 100,
      disabled: false,
      isCooldown: false,
      runwayMinutes: null,
    };
  }

  // Evaluate each window: headroom H_w(t) = 100 - u_w(t), b_w, H_proj,w = H_w(t) - b_w * L
  let minProjectedHeadroom = 100;
  let minCurrentHeadroom = 100;
  let selectedBindingKey = windows[0].key;
  let maxBurn = 0;
  let maxFast = 0;
  let maxSlow = 0;

  for (const win of windows) {
    const curHeadroom =
      win.remainingPct != null
        ? win.remainingPct
        : win.utilizationPct != null
        ? Math.max(0, 100 - win.utilizationPct)
        : 100;

    const { b, bFast, bSlow } = computeDualWindowBurnRate(
      win.history ?? [],
      now,
      fastMin,
      slowMin,
      burnRateMax
    );

    const projectedHeadroom = curHeadroom - b * leadTimeMin;

    if (
      projectedHeadroom < minProjectedHeadroom ||
      (projectedHeadroom === minProjectedHeadroom && curHeadroom < minCurrentHeadroom)
    ) {
      minProjectedHeadroom = projectedHeadroom;
      minCurrentHeadroom = curHeadroom;
      selectedBindingKey = win.key;
      maxBurn = b;
      maxFast = bFast;
      maxSlow = bSlow;
    }
  }

  // Tripwire state determination:
  // If projected headroom <= H_exhausted (5%) OR current H(t) <= H_exhausted -> exhausted
  // If projected headroom <= H_tight (15%) OR current H(t) <= H_tight -> tight
  // Otherwise -> healthy
  let autoState: WatermarkAccountState = 'healthy';
  let reason = 'headroom_healthy';
  let targetWeight = 100;
  let disabled = false;

  if (minCurrentHeadroom <= exhaustedFloor || minProjectedHeadroom <= exhaustedFloor) {
    autoState = 'exhausted';
    reason =
      minCurrentHeadroom <= exhaustedFloor
        ? 'tripwire_current_exhausted'
        : 'tripwire_predictive_exhausted';
    targetWeight = 0;
    disabled = true;
  } else if (minCurrentHeadroom <= tightFloor || minProjectedHeadroom <= tightFloor) {
    autoState = 'tight';
    reason =
      minCurrentHeadroom <= tightFloor
        ? 'tripwire_current_tight'
        : 'tripwire_predictive_tight';
    targetWeight = 1;
    disabled = false;
  }

  const runwayMinutes =
    maxBurn > 0 && minCurrentHeadroom > 0
      ? Math.round(minCurrentHeadroom / maxBurn)
      : null;

  return {
    accountId,
    provider,
    currentHeadroomPct: Math.round(minCurrentHeadroom * 10) / 10,
    projectedHeadroomPct: Math.round(minProjectedHeadroom * 10) / 10,
    burnRatePerMin: Math.round(maxBurn * 100) / 100,
    burnRateFast: Math.round(maxFast * 100) / 100,
    burnRateSlow: Math.round(maxSlow * 100) / 100,
    leadTimeSec,
    bindingWindow: selectedBindingKey,
    autoState,
    reason,
    targetWeight,
    disabled,
    isCooldown: autoState === 'exhausted',
    runwayMinutes,
  };
}

/**
 * Fail-Closed Collective Quota Fallback:
 * If all accounts in a provider pool are exhausted or tight:
 * - If single_tight mode (default): keep single highest-headroom account active in tight mode (weight 1, disabled: false),
 *   while airgapping all other accounts (weight 0, disabled: true).
 * - If airgap_pool mode: airgap all accounts in the pool (weight 0, disabled: true).
 */
export function applyFailClosedCollectiveFallback(
  accounts: TripwireEvaluation[],
  config?: { mode?: 'single_tight' | 'airgap_pool' }
): {
  evaluations: TripwireEvaluation[];
  fallbackActive: boolean;
  activeSingleAccountId?: string;
} {
  if (accounts.length === 0) {
    return { evaluations: [], fallbackActive: false };
  }

  const mode = config?.mode ?? 'single_tight';
  const healthyCount = accounts.filter((a) => a.autoState === 'healthy').length;

  // Collective fallback triggers when NO account in the pool is healthy
  if (healthyCount > 0) {
    return { evaluations: accounts, fallbackActive: false };
  }

  const result = accounts.map((a) => ({ ...a }));

  if (mode === 'airgap_pool') {
    // Airgap entire pool
    for (const a of result) {
      a.autoState = 'exhausted';
      a.targetWeight = 0;
      a.disabled = true;
      a.reason = 'collective_fallback_pool_airgapped';
      a.isCooldown = true;
    }
    return { evaluations: result, fallbackActive: true };
  }

  // mode === 'single_tight': Keep single highest-headroom account in tight mode
  // Exception: accounts in active circuit breaker (reason === 'circuit_breaker_429') must remain exhausted
  const eligible = result
    .map((a, idx) => ({ a, idx }))
    .filter((item) => item.a.reason !== 'circuit_breaker_429');

  if (eligible.length === 0) {
    // If all accounts are in circuit breaker tripped state, airgap all
    for (const a of result) {
      a.autoState = 'exhausted';
      a.targetWeight = 0;
      a.disabled = true;
      a.reason = a.reason || 'collective_fallback_pool_airgapped';
      a.isCooldown = true;
    }
    return { evaluations: result, fallbackActive: true };
  }

  let bestIdx = eligible[0].idx;
  let bestHeadroom = -Infinity;
  for (const item of eligible) {
    if (item.a.currentHeadroomPct > bestHeadroom) {
      bestHeadroom = item.a.currentHeadroomPct;
      bestIdx = item.idx;
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (i === bestIdx) {
      result[i].autoState = 'tight';
      result[i].targetWeight = 1;
      result[i].disabled = false;
      result[i].reason = 'collective_fallback_single_tight';
      result[i].isCooldown = false;
    } else {
      result[i].autoState = 'exhausted';
      result[i].targetWeight = 0;
      result[i].disabled = true;
      result[i].reason = 'collective_fallback_airgapped';
      result[i].isCooldown = true;
    }
  }

  return {
    evaluations: result,
    fallbackActive: true,
    activeSingleAccountId: result[bestIdx]?.accountId,
  };
}

/**
 * In-memory Circuit Breaker Registry for Upstream 429 errors and cooldown tracking.
 */
export class CircuitBreakerRegistry {
  private cooldowns = new Map<string, { until: number; count: number; lastErrorAt: number }>();
  private errors15m = new Map<string, Array<{ t: number; type: '429' | '5xx' }>>();

  recordError(accountId: string, type: '429' | '5xx', now: number = Date.now(), cooldownDurationMs: number = DEFAULT_COOLDOWN_SEC * 1000): void {
    const list = this.errors15m.get(accountId) ?? [];
    list.push({ t: now, type });
    this.errors15m.set(accountId, list);

    if (type === '429') {
      const existing = this.cooldowns.get(accountId);
      const count = (existing?.count ?? 0) + 1;
      this.cooldowns.set(accountId, {
        until: now + cooldownDurationMs,
        count,
        lastErrorAt: now,
      });
    }
  }

  isCooldownActive(accountId: string, now: number = Date.now()): boolean {
    const rec = this.cooldowns.get(accountId);
    if (!rec) return false;
    if (now >= rec.until) {
      this.cooldowns.delete(accountId);
      return false;
    }
    return true;
  }

  getCooldownUntil(accountId: string, now: number = Date.now()): number | null {
    const rec = this.cooldowns.get(accountId);
    if (!rec || now >= rec.until) return null;
    return rec.until;
  }

  clearCooldown(accountId: string): void {
    this.cooldowns.delete(accountId);
  }

  getErrors15m(accountId: string, now: number = Date.now()): { http429: number; http5xx: number } {
    const cutoff = now - 15 * 60 * 1000;
    const list = (this.errors15m.get(accountId) ?? []).filter((e) => e.t >= cutoff);
    this.errors15m.set(accountId, list);
    let http429 = 0;
    let http5xx = 0;
    for (const e of list) {
      if (e.type === '429') http429++;
      else if (e.type === '5xx') http5xx++;
    }
    return { http429, http5xx };
  }
}

export const circuitBreakers = new CircuitBreakerRegistry();
