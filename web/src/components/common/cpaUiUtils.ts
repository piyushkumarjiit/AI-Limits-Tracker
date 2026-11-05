import type {
  WatermarkFleetOverview,
  WatermarkAccountView,
  WatermarkHistoryEntry,
  WatermarkShadowDecision,
  WatermarkAccountState,
  ManualHoldType,
} from '../../../../server/src/cpaWatermarkTypes';
import { effectiveAccountState } from '../../../../server/src/cpaWatermarkTypes';
import type { Account } from '../../api';

/* ---------------- 1. Fleet Banner & Pool Runway ---------------- */

export interface PoolSummary {
  name: string;
  provider: 'antigravity' | 'claude';
  headroomPct: number;
  runwayMinutes: number | null;
  activeCount: number;
  tightCount: number;
  exhaustedCount: number;
  quarantinedCount: number;
  totalCount: number;
}

export function formatRunway(minutes: number | null): { text: string; urgency: 'urgent' | 'warning' | 'safe' | 'nominal' } {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) {
    return { text: 'Nominal (No Burn)', urgency: 'nominal' };
  }
  if (minutes <= 60) {
    return { text: `${minutes}m runway`, urgency: 'urgent' };
  }
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 12) {
    return { text: `${hours}h ${remainingMins}m runway`, urgency: 'warning' };
  }
  if (hours < 48) {
    return { text: `${hours}h runway`, urgency: 'safe' };
  }
  const days = Math.floor(hours / 24);
  return { text: `${days}d ${hours % 24}h runway`, urgency: 'safe' };
}

export function calculatePoolSummary(
  provider: 'antigravity' | 'claude',
  accountViews: WatermarkAccountView[],
  fallbackAccounts: Account[]
): PoolSummary {
  const filteredViews = accountViews.filter((a) => a.provider === provider);
  const filteredAccounts = fallbackAccounts.filter((a) => a.providerType === provider);

  if (filteredViews.length > 0) {
    let headroomSum = 0;
    let burnSum = 0;
    let active = 0;
    let tight = 0;
    let exhausted = 0;
    let quarantined = 0;

    for (const a of filteredViews) {
      const bindingWin = a.windows.find((w) => w.isBinding) || a.windows[0];
      const rem = bindingWin ? bindingWin.currentRemainingPct : 100;
      headroomSum += rem;
      burnSum += a.burnRatePerMin || 0;

      if (a.state === 'healthy' || a.state === 'recovering') active++;
      else if (a.state === 'tight' || a.state === 'draining' || a.state === 'probation') tight++;
      else if (a.state === 'exhausted') exhausted++;
      else if (a.state === 'quarantined' || a.state === 'airgapped') quarantined++;
    }

    const avgHeadroom = Math.round(headroomSum / filteredViews.length);
    const runway = burnSum > 0 ? Math.round(avgHeadroom / burnSum) : null;

    return {
      name: provider === 'antigravity' ? 'Google Antigravity' : 'Anthropic Claude',
      provider,
      headroomPct: avgHeadroom,
      runwayMinutes: runway,
      activeCount: active,
      tightCount: tight,
      exhaustedCount: exhausted,
      quarantinedCount: quarantined,
      totalCount: filteredViews.length,
    };
  }

  let headroomSum = 0;
  let active = 0;
  let tight = 0;
  let exhausted = 0;

  for (const a of filteredAccounts) {
    const buckets = a.latestSnapshot?.buckets || [];
    const lowest = buckets.length > 0
      ? Math.min(...buckets.map((b) => b.remainingPercent ?? 100))
      : 100;
    headroomSum += lowest;
    if (a.latestSnapshot?.status === 'rate_limited' || lowest <= 10) exhausted++;
    else if (lowest <= 35) tight++;
    else active++;
  }

  const avgHeadroom = filteredAccounts.length > 0
    ? Math.round(headroomSum / filteredAccounts.length)
    : 100;

  return {
    name: provider === 'antigravity' ? 'Google Antigravity' : 'Anthropic Claude',
    provider,
    headroomPct: avgHeadroom,
    runwayMinutes: filteredAccounts.length > 0 ? (avgHeadroom <= 35 ? 180 : 720) : null,
    activeCount: active,
    tightCount: tight,
    exhaustedCount: exhausted,
    quarantinedCount: 0,
    totalCount: filteredAccounts.length,
  };
}

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
  fallbackAccounts: Account[] = []
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
      if (strikes > 0 && acc.state !== 'airgapped' && acc.manualHold !== 'airgap') {
        violations.push({
          id: `inv-429-${acc.accountId}`,
          accountId: acc.accountId,
          accountName: acc.name,
          provider: acc.provider,
          type: 'unairgapped_429',
          message: `${strikes} HTTP 429 rate limit strike(s) logged on this account within the last 15m. It must be airgapped immediately to prevent upstream anti-flagging penalties.`,
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
      const isExhausted = is429 || lowest <= 10;

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

  if (overview?.activeDangerAlerts && overview.activeDangerAlerts.length > 0 && violations.length === 0) {
    for (let i = 0; i < overview.activeDangerAlerts.length; i++) {
      const alertMsg = overview.activeDangerAlerts[i];
      violations.push({
        id: `inv-alert-${i}`,
        accountId: '',
        accountName: 'Fleet Pool Invariant',
        provider: 'fleet',
        type: 'leaked_weight',
        message: alertMsg,
        currentWeight: 1,
        upstreamState: 'violation',
        recent429Count: 0,
      });
    }
  }

  return violations;
}

/* ---------------- 3. Dual Indicators ---------------- */

export function deriveUpstreamQuota(
  account: Account,
  accountView?: WatermarkAccountView | null
): {
  headroomPct: number;
  bindingWindow: '5h' | '7d' | 'model' | 'session';
  burnRateHourly: number;
  burnRateDisplay: string;
  severity: 'healthy' | 'warning' | 'exhausted';
} {
  if (accountView) {
    const binding = accountView.windows.find((w) => w.isBinding) || accountView.windows[0];
    const headroom = binding ? binding.currentRemainingPct : 100;
    const is5h = accountView.bindingWindow.includes('5h') || accountView.bindingWindow.includes('session');
    const bindingWindow = is5h ? '5h' : '7d';
    const burnRateHourly = Math.round((accountView.burnRatePerMin * 60) * 100) / 100;
    const burnRateDisplay = burnRateHourly > 0
      ? `$${(burnRateHourly * 0.15).toFixed(2)}/hr`
      : '$0.00/hr';

    const severity = headroom <= 10 ? 'exhausted' : headroom <= 35 ? 'warning' : 'healthy';

    return {
      headroomPct: headroom,
      bindingWindow,
      burnRateHourly,
      burnRateDisplay,
      severity,
    };
  }

  const buckets = account.latestSnapshot?.buckets || [];
  const session5h = buckets.find((b) => b.windowType === 'session_5h');
  const weekly7d = buckets.find((b) => b.windowType === 'weekly_7d') || buckets[0];

  const rem5h = session5h?.remainingPercent ?? 100;
  const rem7d = weekly7d?.remainingPercent ?? 100;

  const is5hBinding = rem5h <= rem7d;
  const headroom = Math.round(is5hBinding ? rem5h : rem7d);
  const is429 = account.latestSnapshot?.status === 'rate_limited';

  const severity = (is429 || headroom <= 10) ? 'exhausted' : headroom <= 35 ? 'warning' : 'healthy';

  return {
    headroomPct: headroom,
    bindingWindow: is5hBinding ? '5h' : '7d',
    burnRateHourly: headroom < 100 ? 0.25 : 0,
    burnRateDisplay: headroom < 100 ? '$0.38/hr' : '$0.00/hr',
    severity,
  };
}

export function deriveRoutingEnforcement(
  account: Account,
  accountView?: WatermarkAccountView | null
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
    if (account.latestSnapshot?.status === 'rate_limited' || lowest <= 10) {
      autoState = 'exhausted';
    } else if (lowest <= 35) {
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

/* ---------------- 4. Audit Feed Parsing ---------------- */

export interface AuditItem {
  id: string;
  timestamp: number;
  timeFormatted: string;
  accountId: string;
  type: 'tripwire' | 'leadtime' | '429' | 'hold';
  typeLabel: string;
  oldWeight?: number;
  newWeight?: number;
  reason: string;
  details?: string;
}

export function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return String(ts);
  }
}

export function parseAuditItems(
  overview: WatermarkFleetOverview | null,
  historyEntries: WatermarkHistoryEntry[] = []
): AuditItem[] {
  const items: AuditItem[] = [];

  if (overview?.recentShadowDecisions) {
    for (let i = 0; i < overview.recentShadowDecisions.length; i++) {
      const d: WatermarkShadowDecision = overview.recentShadowDecisions[i];
      const r = d.reason || '';

      let type: 'tripwire' | 'leadtime' | '429' | 'hold' = 'tripwire';
      let typeLabel = 'Tripwire Transition';

      if (r.includes('429') || r.includes('rate_limit')) {
        type = '429';
        typeLabel = '429 Pre-Tripwire';
      } else if (r.includes('lead_time') || r.includes('projection') || r.includes('forecast')) {
        type = 'leadtime';
        typeLabel = 'Lead-Time Projection';
      } else if (r.includes('manual') || r.includes('hold') || r.includes('airgap')) {
        type = 'hold';
        typeLabel = 'Manual Intervention';
      }

      items.push({
        id: `shadow-${d.at}-${i}`,
        timestamp: d.at,
        timeFormatted: formatTime(d.at),
        accountId: d.accountId,
        type,
        typeLabel,
        oldWeight: d.currentWeight,
        newWeight: d.proposedWeight,
        reason: d.reason || 'Watermark recalculation',
      });
    }
  }

  for (const h of historyEntries) {
    let summary: any = {};
    try {
      summary = JSON.parse(h.summary || '{}');
    } catch {}

    const eventType = h.eventType || 'event';
    let type: 'tripwire' | 'leadtime' | '429' | 'hold' = 'tripwire';
    let typeLabel = 'System Event';

    if (eventType.startsWith('manual_hold')) {
      type = 'hold';
      typeLabel = eventType.includes('airgap')
        ? 'Manual Airgap Enforced'
        : eventType.includes('quarantine')
        ? 'Manual Quarantine Enforced'
        : 'Manual Hold Cleared';
    } else if (eventType.includes('429')) {
      type = '429';
      typeLabel = '429 Prevention Event';
    } else if (eventType.includes('projection') || eventType.includes('leadtime')) {
      type = 'leadtime';
      typeLabel = 'Lead-Time Projection';
    } else if (eventType.includes('tick') || eventType.includes('tripwire')) {
      type = 'tripwire';
      typeLabel = 'Tripwire State Transition';
    }

    const accountId = summary.accountId || `gen-${h.generation}`;
    items.push({
      id: `hist-${h.id || h.recordedAt}`,
      timestamp: h.recordedAt,
      timeFormatted: formatTime(h.recordedAt),
      accountId,
      type,
      typeLabel,
      oldWeight: summary.oldWeight ?? summary.currentWeight,
      newWeight: summary.newWeight ?? summary.proposedWeight,
      reason: summary.reason || (summary.tiers ? `Generation ${h.generation} evaluated ${summary.tiers} tiers, ${summary.accounts} accounts` : eventType),
      details: summary.actor ? `Actor: ${summary.actor}` : undefined,
    });
  }

  return items.sort((a, b) => b.timestamp - a.timestamp);
}
