import type {
  WatermarkFleetOverview,
  WatermarkAccountView,
  WatermarkAccountState,
  ManualHoldType,
} from '../../../../server/src/cpaWatermarkTypes';
import { effectiveAccountState } from '../../../../server/src/cpaWatermarkTypes';
import type { Account } from '../../api';
import { dualRingData, type RingWindow } from '../../../../src/services/capacity';
import { DEFAULT_STATUS_LEVELS, levelsForTier, type TieredStatusLevels } from '../../../../src/constants/statusLevels';

/* ---------------- 2. Invariant Violation Detection ---------------- */

export interface InvariantViolation {
  id: string;
  accountId: string;
  accountName: string;
  provider: string;
  type: 'leaked_weight' | 'not_disabled' | 'unairgapped_429';
  message: string;
  currentWeight: number;
  upstreamState: string;
  recent429Count: number;
}

export function detectInvariantViolations(
  overview: WatermarkFleetOverview | null,
  fallbackAccounts: Account[] = [],
  levels: TieredStatusLevels = DEFAULT_STATUS_LEVELS
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const accountViews = overview?.accounts || [];

  if (accountViews.length > 0) {
    for (const acc of accountViews) {
      const isExhaustedOrQuarantined =
        acc.state === 'exhausted' ||
        acc.state === 'quarantined' ||
        acc.manualHold === 'quarantine' ||
        acc.manualHold === 'airgap';

      if (isExhaustedOrQuarantined && acc.currentWeight > 0) {
        violations.push({
          id: `inv-weight-${acc.accountId}`,
          accountId: acc.accountId,
          accountName: acc.name,
          provider: acc.provider,
          type: 'leaked_weight',
          message: `Account marked upstream as ${acc.state.toUpperCase()} but still has active routing weight ${acc.currentWeight} > 0. Traffic is leaking to an unviable credential!`,
          currentWeight: acc.currentWeight,
          upstreamState: acc.state,
          recent429Count: acc.recentErrors15m?.http429 || 0,
        });
      }

      const strikes = acc.recentErrors15m?.http429 || 0;
      // Quarantine and airgap both take the account out of CLIProxy (weight 0, disabled).
      const outOfPool = acc.state === 'airgapped' || acc.state === 'quarantined' || acc.manualHold !== 'none';
      if (strikes > 0 && !outOfPool) {
        violations.push({
          id: `inv-429-${acc.accountId}`,
          accountId: acc.accountId,
          accountName: acc.name,
          provider: acc.provider,
          type: 'unairgapped_429',
          message: `${strikes} HTTP 429 rate limit strike(s) logged on this account within the last 15m. Put it in cooldown to take it out of the pool.`,
          currentWeight: acc.currentWeight,
          upstreamState: acc.state,
          recent429Count: strikes,
        });
      }
    }
  } else if (fallbackAccounts.length > 0) {
    for (const a of fallbackAccounts) {
      const buckets = a.latestSnapshot?.buckets || [];
      const lowest = buckets.length > 0
        ? Math.min(...buckets.map((b) => b.remainingPercent ?? 100))
        : 100;
      const is429 = a.latestSnapshot?.status === 'rate_limited';
      const isExhausted = is429 || lowest <= levels.pro.exhaustedPct;

      if (isExhausted && a.isActive) {
        violations.push({
          id: `inv-fb-${a.id}`,
          accountId: a.id,
          accountName: a.name,
          provider: a.providerType,
          type: is429 ? 'unairgapped_429' : 'leaked_weight',
          message: is429
            ? 'Account suffered 429 rate limit strikes but remains active in routing pool!'
            : `Account exhausted (${lowest}% headroom) but still enabled and active!`,
          currentWeight: 100,
          upstreamState: is429 ? 'rate_limited' : 'exhausted',
          recent429Count: is429 ? 1 : 0,
        });
      }
    }
  }

  return violations;
}

/* ---------------- 3. Routing State ---------------- */

export function deriveRoutingEnforcement(
  account: Account,
  accountView?: WatermarkAccountView | null,
  levels: TieredStatusLevels = DEFAULT_STATUS_LEVELS
): {
  effectiveState: 'Active' | 'Tight' | 'Quarantined' | 'Airgapped';
  origin: 'manual' | 'auto';
  originLabel: string;
  weight: number;
  badgeClass: string;
} {
  const manualHold: ManualHoldType = accountView?.manualHold || 'none';
  let autoState: WatermarkAccountState = 'healthy';

  if (accountView) {
    autoState = accountView.state;
  } else {
    const buckets = account.latestSnapshot?.buckets || [];
    const lowest = buckets.length > 0
      ? Math.min(...buckets.map((b) => b.remainingPercent ?? 100))
      : 100;
    const lv = levelsForTier(levels, null);
    if (account.latestSnapshot?.status === 'rate_limited' || lowest <= lv.exhaustedPct) {
      autoState = 'exhausted';
    } else if (lowest <= lv.tightPct) {
      autoState = 'tight';
    }
  }

  const effective = effectiveAccountState(manualHold, autoState);
  const isManual = manualHold !== 'none';
  const origin: 'manual' | 'auto' = isManual ? 'manual' : 'auto';
  const originLabel = isManual
    ? `MANUAL HOLD (${manualHold.toUpperCase()})`
    : 'AUTO-TRIPWIRE';

  let effectiveLabel: 'Active' | 'Tight' | 'Quarantined' | 'Airgapped' = 'Active';
  let badgeClass = 'cpa-indicator-pill--route-active';

  if (effective === 'airgapped') {
    effectiveLabel = 'Airgapped';
    badgeClass = 'cpa-indicator-pill--route-airgapped';
  } else if (effective === 'quarantined') {
    effectiveLabel = 'Quarantined';
    badgeClass = 'cpa-indicator-pill--route-quarantined';
  } else if (effective === 'tight' || effective === 'draining' || effective === 'probation') {
    effectiveLabel = 'Tight';
    badgeClass = 'cpa-indicator-pill--route-tight';
  } else if (effective === 'exhausted') {
    effectiveLabel = 'Quarantined';
    badgeClass = 'cpa-indicator-pill--route-quarantined';
  }

  const weight = accountView?.currentWeight ?? (effectiveLabel === 'Airgapped' || effectiveLabel === 'Quarantined' ? 0 : 100);

  return {
    effectiveState: effectiveLabel,
    origin,
    originLabel,
    weight,
    badgeClass,
  };
}

/* ---------------- 4. Account Status ---------------- */

export type AccountStatus = 'cooldown' | 'exhausted' | 'healthy' | 'tight';


export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  cooldown: 'Cooldown',
  exhausted: 'Exhausted',
  healthy: 'Healthy',
  tight: 'Tight',
};

export const ACCOUNT_STATUS_BADGE: Record<AccountStatus, string> = {
  cooldown: 'badge-cool',
  exhausted: 'badge-bad',
  healthy: 'badge-ok',
  tight: 'badge-warn',
};

/** The 5-hour and weekly windows of an account, each null when the provider does not report it. */
export function quotaWindows(account: Account): { fiveHour: RingWindow | null; weekly: RingWindow | null; binding: RingWindow | null } {
  const ring = dualRingData(account.latestSnapshot);
  const all = [ring.outer, ring.inner].filter((w): w is RingWindow => Boolean(w));
  return {
    fiveHour: all.find((w) => w.short === '5h') ?? null,
    weekly: all.find((w) => w.short === '7d') ?? null,
    binding: ring.binding,
  };
}

/**
 * The status shown for an account, one rule for every page.
 * Cooldown: FQD or an admin took the account out of the CLIProxy pool.
 * Exhausted / Tight: for CLIProxy accounts, the state the server reports from the routing
 * policy; otherwise the tightest window against the policy levels for the account's tier.
 */
export function accountStatus(
  account: Account,
  accountView?: WatermarkAccountView | null,
  levels: TieredStatusLevels = DEFAULT_STATUS_LEVELS
): AccountStatus {
  if (
    accountView &&
    (accountView.manualHold !== 'none' ||
      accountView.isDisabled ||
      accountView.state === 'quarantined' ||
      accountView.state === 'airgapped')
  ) {
    return 'cooldown';
  }
  if (account.latestSnapshot?.status === 'rate_limited') return 'exhausted';
  if (accountView) {
    if (accountView.state === 'exhausted') return 'exhausted';
    if (accountView.state === 'tight' || accountView.state === 'draining') return 'tight';
    return 'healthy';
  }
  const lv = levelsForTier(levels, null);
  const binding = dualRingData(account.latestSnapshot).binding;
  if (binding && binding.remaining <= lv.exhaustedPct) return 'exhausted';
  if (binding && binding.remaining <= lv.tightPct) return 'tight';
  return 'healthy';
}
