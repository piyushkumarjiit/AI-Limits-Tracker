/**
 * Shared TypeScript contract types for FQD (Fleet Quota Display) Watermark & Anti-Flagging system.
 * Anchors the shared state model, overview API shape, and manual hold schemas across
 * server backend (WP-4A) and web panel frontend (WP-4B).
 */
import type { TieredStatusLevels } from '../../src/constants/statusLevels';

export type WatermarkAccountState =
  | 'healthy'
  | 'tight'
  | 'draining'
  | 'exhausted'
  | 'recovering'
  | 'probation'
  | 'quarantined'
  | 'airgapped';

export type WatermarkTierState = 'OPEN' | 'DEGRADED' | 'CLOSED';

export type WatermarkMode = 'off' | 'shadow' | 'enforce';

export type ManualHoldType = 'none' | 'quarantine' | 'airgap';

export type QuotaWindowKey = 'session_5h' | 'weekly_7d' | 'model_cap';

export const WATERMARK_ACCOUNT_STATES: readonly WatermarkAccountState[] = [
  'healthy',
  'tight',
  'draining',
  'exhausted',
  'recovering',
  'probation',
  'quarantined',
  'airgapped',
] as const;

export const WATERMARK_TIER_STATES: readonly WatermarkTierState[] = [
  'OPEN',
  'DEGRADED',
  'CLOSED',
] as const;

export const WATERMARK_MODES: readonly WatermarkMode[] = [
  'off',
  'shadow',
  'enforce',
] as const;

export const MANUAL_HOLD_TYPES: readonly ManualHoldType[] = [
  'none',
  'quarantine',
  'airgap',
] as const;

export const QUOTA_WINDOW_KEYS: readonly QuotaWindowKey[] = [
  'session_5h',
  'weekly_7d',
  'model_cap',
] as const;

export interface WatermarkWindowView {
  key: string;
  label: string;
  currentRemainingPct: number;
  projectedRemainingPct: number;
  /** Null when the provider did not report a reset time. */
  resetsAt: string | null;
  resetSecondsRemaining: number | null;
  isBinding: boolean;
}

export interface WatermarkAccountView {
  accountId: string;
  name: string;
  provider: string;
  email?: string;
  state: WatermarkAccountState;
  manualHold: ManualHoldType;
  currentWeight: number;
  targetWeight: number;
  readBackDrift: boolean;
  isQuarantined: boolean;
  isDisabled: boolean;
  bindingWindow: string;
  windows: WatermarkWindowView[];
  burnRatePerMin: number;
  runwayMinutes: number | null;
  recentRequests5m: number;
  recentErrors15m: {
    http429: number;
    http5xx: number;
  };
  /** Policy tier from classification rules (decides which levels apply). */
  tier?: 'pro' | 'non_pro';
  /** Whether the routing policy manages this account's weight. */
  managed?: boolean;
}

export interface WatermarkShadowDecision {
  at: number;
  accountId: string;
  currentWeight: number;
  proposedWeight: number;
  reason: string;
}

export interface WatermarkHistoryEntry {
  id?: number;
  recordedAt: number;
  eventType: string;
  generation: number;
  summary: string;
  stateJson: string;
}

export interface WatermarkFleetOverview {
  mode: WatermarkMode;
  routingStrategy: string;
  writesBlockedReason: string | null;
  tierState: WatermarkTierState;
  poolRunwayMinutes: number | null;
  healthyCount: number;
  tightCount: number;
  exhaustedCount: number;
  quarantinedCount: number;
  accounts: WatermarkAccountView[];
  recentShadowDecisions: Array<{
    at: number;
    accountId: string;
    currentWeight: number;
    proposedWeight: number;
    reason: string;
  }>;
  activeDangerAlerts: string[];
  /** Tight / exhausted levels from the active policy (drainPct / hardStopPct per tier). */
  statusLevels?: TieredStatusLevels;
}

export interface ManualHoldRequest {
  accountId?: string;
  hold: ManualHoldType;
  reason?: string;
  actor?: string;
  ttlSeconds?: number;
}

export interface PolicyOverrideRequest {
  key: string;
  value: number | string | boolean;
  actor: string;
  reason: string;
  ttlSeconds: number;
}

/**
 * Computes the effective account state taking manual operator holds into account.
 * Manual holds ('quarantine' or 'airgap') are strictly more restrictive than any
 * automated state (healthy, tight, draining, exhausted, recovering, probation).
 * Releasing a manual hold ('none') returns the automated autoState.
 */
export function effectiveAccountState(
  manualHold: ManualHoldType,
  autoState: WatermarkAccountState
): WatermarkAccountState {
  if (manualHold === 'airgap') {
    return 'airgapped';
  }
  if (manualHold === 'quarantine') {
    return 'quarantined';
  }
  return autoState;
}
