import { createHash } from 'node:crypto';
import type { ServerAccount } from './store';
import type { QuotaBucket } from '../../src/models/types';
import type { RoutingConfig, WeightPlan } from '../../src/services/cpa/routingPlanner';
import { headroom } from '../../src/services/cpa/routingPlanner';
import { dualRingData } from '../../src/services/capacity';
import { forecastWindow, type StatPoint } from '../../src/services/stats';
import type { CpaLink } from '../../src/services/cpa/reconcile';
import type { CpaSyncStatus } from './cpaSync';

export interface QuotaContext {
  intervalSec?: number;
  cpaStatus?: CpaSyncStatus | null;
  cpaLinks?: CpaLink[];
  cpaRouting?: {
    config?: RoutingConfig;
    activeWeights?: Record<string, number>;
    plans?: WeightPlan[];
    writesCount?: { ok: number; error: number; skipped: number };
    blockedReason?: string | null;
  };
  getHistory?: (accountId: string) => StatPoint[];
}

export interface QuotaQuery {
  provider?: string[]; // repeatable: claude, chatgpt, antigravity
  source?: 'cpa' | 'native' | 'all';
}

export interface QuotaWindowItem {
  id: string;
  type: string;
  usedPct: number | null;
  remainingPct: number | null;
  resetsAt: string | null;
  resetInSec: number | null;
  burnPctPerHour: number | null;
  exhaustAt: string | null;
  exhausted: boolean;
  severity: string;
}

export interface QuotaCpaAccountInfo {
  authIndex: string | null;
  name: string;
  linkState: string;
}

export interface QuotaRoutingAccountInfo {
  planned: number | null;
  applied: number | null;
  managed: boolean;
  cooldown: boolean;
  reason: string;
}

export interface QuotaAccountItem {
  id: string;
  name: string;
  provider: string;
  source: 'cpa' | 'native';
  cpa: QuotaCpaAccountInfo | null;
  email: string | null;
  plan: string;
  status: string;
  error: string | null;
  fetchedAt: string | null;
  ageSeconds: number;
  stale: boolean;
  headroom: number | null;
  effectiveRemainingPct: number | null;
  windows: QuotaWindowItem[];
  routing: QuotaRoutingAccountInfo;
}

export interface QuotaView {
  version: 1;
  generatedAt: string;
  intervalSec: number;
  cpa: {
    enabled: boolean;
    lastDiscoveryAt: string | null;
    lastDiscoveryOk: boolean;
    routingMode: string;
    routingBlocked: string | null;
  };
  accounts: QuotaAccountItem[];
}

/**
 * Maps bucket id/window to canonical window label/name per §5.4:
 * five_hour, seven_day, monthly, or antigravity family + _ + suffix
 */
export function canonicalWindowName(bucket: QuotaBucket, provider: string): string {
  if (provider === 'antigravity') {
    const family = (bucket.details?.family || 'gemini').toLowerCase();
    if (bucket.id.includes('5h') || bucket.windowType === 'session_5h') return `${family}_5h`;
    if (bucket.id.includes('weekly') || bucket.windowType === 'weekly_7d') return `${family}_weekly`;
    return `${family}_quota`;
  }
  // Disambiguate multi-model windows and non-primary buckets per §5.4 / B5
  if (bucket.id === 'seven_day_opus') return 'seven_day_opus';
  if (bucket.id === 'seven_day_sonnet') return 'seven_day_sonnet';
  if (bucket.id === 'code_review') return 'code_review';
  if (bucket.id === 'extra_usage') return 'extra_usage';

  if (bucket.id === 'primary' || bucket.id === 'five_hour' || bucket.windowType === 'session_5h') return 'five_hour';
  if (bucket.id === 'secondary' || bucket.id === 'seven_day' || bucket.windowType === 'weekly_7d') return 'seven_day';
  if (bucket.windowType === 'monthly_30d') return 'monthly';
  return bucket.id;
}

export function buildQuotaView(
  accounts: ServerAccount[],
  ctx?: QuotaContext,
  now?: number
): QuotaView {
  const t = now ?? Date.now();
  const generatedAt = new Date(t).toISOString();
  const intervalSec = ctx?.intervalSec ?? 300;

  const cpaStatus = ctx?.cpaStatus;
  const routingCfg = ctx?.cpaRouting?.config;

  const cpaRoot = {
    enabled: Boolean(cpaStatus?.enabled),
    lastDiscoveryAt: cpaStatus?.lastDiscoveryAt ?? null,
    lastDiscoveryOk: Boolean(cpaStatus?.lastDiscoveryOk),
    routingMode: routingCfg?.mode ?? cpaStatus?.routingMode ?? 'off',
    routingBlocked: ctx?.cpaRouting?.blockedReason ?? null,
  };

  const accountItems: QuotaAccountItem[] = [];

  for (const acc of accounts) {
    const provider = acc.providerType;
    const link = ctx?.cpaLinks?.find((l) => l.accountId === acc.id);
    const isCpa = Boolean(link);
    const source: 'cpa' | 'native' = isCpa ? 'cpa' : 'native';

    let cpaInfo: QuotaCpaAccountInfo | null = null;
    if (link) {
      cpaInfo = {
        authIndex: link.authIndex !== undefined && link.authIndex !== null ? String(link.authIndex) : null,
        name: link.cpaName,
        linkState: link.state,
      };
    }

    const snapshot = acc.latestSnapshot;
    const fetchedAt = snapshot?.fetchedAt || acc.lastSyncAt || null;
    const fetchedAtMs = fetchedAt ? new Date(fetchedAt).getTime() : NaN;
    const ageSeconds = !Number.isNaN(fetchedAtMs)
      ? Math.max(0, Math.round((t - fetchedAtMs) / 1000))
      : 0;

    const isStale = Boolean(snapshot?.isStale);
    const stale = isStale || ageSeconds > 3 * intervalSec;

    const status = snapshot?.status || acc.lastStatus || 'not_configured';
    const error = snapshot?.errorMessage || acc.lastError || null;

    // Headroom calculation using §4.2 headroom function
    const history = ctx?.getHistory ? ctx.getHistory(acc.id) : [];
    let headroomScore: number | null = null;
    if (snapshot && snapshot.status === 'ok' && !stale) {
      headroomScore = headroom(snapshot, history, t);
    }

    // Effective remaining from dualRingData
    const dualRing = dualRingData(snapshot);
    const effectiveRemainingPct = dualRing.effectiveRemaining;

    // Windows
    const seenWindowIds = new Set<string>();
    const windows: QuotaWindowItem[] = (snapshot?.buckets || []).map((b) => {
      const remainingPct = b.remainingPercent !== undefined ? b.remainingPercent : null;
      const usedPct =
        b.utilizationPercent !== undefined && b.utilizationPercent !== null
          ? b.utilizationPercent
          : remainingPct !== null
          ? 100 - remainingPct
          : null;

      let resetInSec: number | null = null;
      if (b.resetsAt) {
        const resetMs = new Date(b.resetsAt).getTime();
        if (!Number.isNaN(resetMs)) {
          resetInSec = Math.max(0, Math.round((resetMs - t) / 1000));
        }
      }

      // Burn and forecast
      let burnPctPerHour: number | null = null;
      let exhaustAt: string | null = null;

      if (history.length > 0 && provider !== 'antigravity') {
        const points =
          b.windowType === 'session_5h'
            ? history
                .filter((p) => p.session !== null && p.session !== undefined)
                .map((p) => ({ t: p.t, value: p.session }))
            : b.windowType === 'weekly_7d'
            ? history
                .filter((p) => p.weekly !== null && p.weekly !== undefined)
                .map((p) => ({ t: p.t, value: p.weekly }))
            : [];

        if (points.length >= 2 && usedPct !== null) {
          const fc = forecastWindow(points, usedPct, b.resetsAt, { now: t });
          burnPctPerHour = fc.burnRatePerHour;
          exhaustAt = fc.exhaustAt ? new Date(fc.exhaustAt).toISOString() : null;
        }
      }

      let winId = canonicalWindowName(b, provider);
      if (seenWindowIds.has(winId)) {
        winId = `${winId}_${b.id}`;
        if (seenWindowIds.has(winId)) {
          let suffix = 2;
          while (seenWindowIds.has(`${winId}_${suffix}`)) {
            suffix++;
          }
          winId = `${winId}_${suffix}`;
        }
      }
      seenWindowIds.add(winId);

      return {
        id: winId,
        type: b.windowType,
        usedPct,
        remainingPct,
        resetsAt: b.resetsAt,
        resetInSec,
        burnPctPerHour,
        exhaustAt,
        exhausted: b.isExhausted,
        severity: b.severity,
      };
    });

    // Routing info
    const routingPlan = ctx?.cpaRouting?.plans?.find((p) => p.accountId === acc.id);
    let routingState: any = null;
    if (link && link.routingJson) {
      try {
        routingState = JSON.parse(link.routingJson);
      } catch {
        routingState = null;
      }
    }

    const applied =
      ctx?.cpaRouting?.activeWeights?.[acc.id] ??
      (routingState?.applied !== undefined ? routingState.applied : null);
    const planned = routingPlan ? routingPlan.target : applied;
    const managed = routingState?.managed ?? true;
    const cooldown = routingPlan ? routingPlan.cooldown : (routingState?.cooldown ?? false);
    const reason = routingPlan ? routingPlan.reason : (routingState?.reason ?? (cooldown ? 'exhausted' : 'headroom'));

    accountItems.push({
      id: acc.id,
      name: acc.name,
      provider,
      source,
      cpa: cpaInfo,
      email: acc.email || null,
      plan: acc.plan || snapshot?.planName || '',
      status,
      error,
      fetchedAt,
      ageSeconds,
      stale,
      headroom: headroomScore,
      effectiveRemainingPct,
      windows,
      routing: {
        planned,
        applied,
        managed,
        cooldown,
        reason,
      },
    });
  }

  return {
    version: 1,
    generatedAt,
    intervalSec,
    cpa: cpaRoot,
    accounts: accountItems,
  };
}

/**
 * Filter QuotaView by repeatable provider and source.
 * Dynamically re-evaluates ageSeconds and stale at request time.
 */
export function filterQuotaView(view: QuotaView, query?: QuotaQuery, now?: number): QuotaView {
  const t = now ?? Date.now();
  let accounts = view.accounts.map((a) => {
    const fetchedAtMs = a.fetchedAt ? new Date(a.fetchedAt).getTime() : NaN;
    const ageSeconds = !Number.isNaN(fetchedAtMs)
      ? Math.max(0, Math.round((t - fetchedAtMs) / 1000))
      : a.ageSeconds;
    const stale = a.stale || ageSeconds > 3 * view.intervalSec;
    return { ...a, ageSeconds, stale };
  });

  if (query?.provider && query.provider.length > 0) {
    const allowed = new Set(query.provider.map((p) => p.toLowerCase()));
    accounts = accounts.filter((a) => allowed.has(a.provider.toLowerCase()));
  }

  if (query?.source && query.source !== 'all') {
    accounts = accounts.filter((a) => a.source === query.source);
  }

  return {
    ...view,
    accounts,
  };
}

export class QuotaCache {
  private version: number = 1;
  private cachedView: QuotaView | null = null;
  private cachedMetricsText: string | null = null;
  private cachedMetricsVersion: number = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private getAccounts: () => ServerAccount[];
  private getContext: () => QuotaContext | undefined;
  private renderMetricsFn?: (view: QuotaView, now: number) => string;

  constructor(
    getAccounts: () => ServerAccount[],
    getContext?: () => QuotaContext | undefined,
    renderMetricsFn?: (view: QuotaView, now: number) => string
  ) {
    this.getAccounts = getAccounts;
    this.getContext = getContext || (() => undefined);
    this.renderMetricsFn = renderMetricsFn;
  }

  setRenderMetrics(fn: (view: QuotaView, now: number) => string): void {
    this.renderMetricsFn = fn;
  }

  /**
   * Debounced 250ms invalidation per §5.2
   */
  invalidate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.doInvalidate();
      this.debounceTimer = null;
    }, 250);
  }

  /**
   * Immediate invalidation without debounce (useful for tests and shutdown)
   */
  invalidateImmediate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.doInvalidate();
  }

  private doInvalidate(): void {
    this.cachedView = null;
    this.cachedMetricsText = null;
    this.version++;
  }

  getVersion(): number {
    return this.version;
  }

  getETag(): string {
    return `W/"${this.version}"`;
  }

  getView(now?: number): { view: QuotaView; version: number; etag: string } {
    const t = now ?? Date.now();
    if (!this.cachedView) {
      const accounts = this.getAccounts();
      const ctx = this.getContext();
      this.cachedView = buildQuotaView(accounts, ctx, t);
    }
    return {
      view: this.cachedView,
      version: this.version,
      etag: this.getETag(),
    };
  }

  get(query?: QuotaQuery, now?: number): { view: QuotaView; version: number; etag: string } {
    const base = this.getView(now);
    const filtered = filterQuotaView(base.view, query, now);
    return {
      view: filtered,
      version: this.version,
      etag: this.getETag(),
    };
  }

  metricsText(now?: number): string {
    const t = now ?? Date.now();
    if (this.cachedMetricsText && this.cachedMetricsVersion === this.version) {
      return this.cachedMetricsText;
    }

    const { view } = this.getView(t);
    if (!this.renderMetricsFn) {
      throw new Error('renderMetricsFn not configured');
    }
    const rendered = this.renderMetricsFn(view, t);
    this.cachedMetricsText = rendered;
    this.cachedMetricsVersion = this.version;
    return rendered;
  }
}
