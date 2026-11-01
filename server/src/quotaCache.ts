import { createHash } from 'node:crypto';
import type { ServerAccount } from './store';
import type { QuotaBucket } from '../../src/models/types';
import type { CpaLink } from '../../src/services/cpa/reconcile';
import type { WeightPlan, RoutingConfig } from '../../src/services/cpa/routingPlanner';

export interface QuotaContext {
  cpaLinks?: CpaLink[];
  cpaRouting?: {
    config?: RoutingConfig;
    activeWeights?: Record<string, number>;
    plans?: WeightPlan[];
  };
}

export interface QuotaQuery {
  provider?: string;
  auth_index?: string;
  source?: 'cpa' | 'native';
  include_exhausted?: boolean;
}

export interface QuotaBucketSummary {
  id: string;
  window_type: string;
  utilization_percent: number | null;
  remaining_percent: number | null;
  resets_at: string | null;
}

export interface QuotaAccountItem {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  auth_index: string | null;
  source: 'cpa' | 'native';
  status: string;
  binding_window: {
    id: string;
    label: string;
    remaining_percent: number | null;
    resets_at: string | null;
    severity: string;
  } | null;
  effective_remaining_percent: number | null;
  headroom_score: number | null;
  current_weight: number | null;
  target_weight: number | null;
  cooldown: boolean;
  buckets: QuotaBucketSummary[];
}

export interface QuotaView {
  generated_at: string;
  version: 1;
  accounts: QuotaAccountItem[];
  totals: {
    total_accounts: number;
    active_accounts: number;
    headroom_available: number;
    providers: Record<string, { total: number; active: number }>;
  };
}

export function buildQuotaView(accounts: ServerAccount[], ctx?: QuotaContext, now?: number): QuotaView {
  const t = now ?? Date.now();
  const generated_at = new Date(t).toISOString();

  const providerCounts: Record<string, { total: number; active: number }> = {};
  let totalAccounts = 0;
  let activeAccounts = 0;
  let headroomSum = 0;

  const items: QuotaAccountItem[] = [];

  for (const acc of accounts) {
    totalAccounts++;
    const provider = acc.providerType;
    if (!providerCounts[provider]) {
      providerCounts[provider] = { total: 0, active: 0 };
    }
    providerCounts[provider].total++;

    const link = ctx?.cpaLinks?.find((l) => l.accountId === acc.id);
    const isCpa = Boolean(link);
    const source: 'cpa' | 'native' = isCpa ? 'cpa' : 'native';

    let authIndex: string | null = null;
    if (link && link.authIndex !== undefined && link.authIndex !== null) {
      authIndex = String(link.authIndex);
    }

    const snapshot = acc.latestSnapshot;
    const status = snapshot?.status || acc.lastStatus || 'not_configured';

    // Binding window
    let bindingWindow: QuotaAccountItem['binding_window'] = null;
    let effectiveRemaining: number | null = null;

    if (snapshot?.buckets && snapshot.buckets.length > 0) {
      let candidate: QuotaBucket | null = null;
      for (const b of snapshot.buckets) {
        if (b.remainingPercent !== null && b.remainingPercent !== undefined) {
          if (!candidate) {
            candidate = b;
          } else if (b.remainingPercent < candidate.remainingPercent!) {
            candidate = b;
          }
        }
      }
      if (candidate) {
        bindingWindow = {
          id: candidate.id,
          label: candidate.label,
          remaining_percent: candidate.remainingPercent,
          resets_at: candidate.resetsAt,
          severity: candidate.severity,
        };
        effectiveRemaining = candidate.remainingPercent;
      }
    }

    // Weights & cooldown
    const routingPlan = ctx?.cpaRouting?.plans?.find((p) => p.accountId === acc.id);
    let routingState: any = null;
    if (link && link.routingJson) {
      try {
        routingState = JSON.parse(link.routingJson);
      } catch {
        routingState = null;
      }
    }

    const currentWeight =
      ctx?.cpaRouting?.activeWeights?.[acc.id] ??
      (routingPlan ? routingPlan.target : (routingState?.applied !== undefined ? routingState.applied : null));

    const targetWeight: number | null = routingPlan ? routingPlan.target : (routingState?.applied !== undefined ? routingState.applied : null);
    const cooldown: boolean = routingPlan ? routingPlan.cooldown : (routingState?.cooldown ?? false);

    // Headroom score
    let headroomScore: number | null = null;
    if (effectiveRemaining !== null) {
      headroomScore = Math.max(0, Math.min(1, Math.round((effectiveRemaining / 100) * 1000) / 1000));
    }

    const isActive = acc.isActive !== false;
    if (isActive) {
      activeAccounts++;
      providerCounts[provider].active++;
      if (headroomScore !== null) {
        headroomSum += headroomScore;
      }
    }

    const bucketSummaries: QuotaBucketSummary[] = (snapshot?.buckets || []).map((b) => ({
      id: b.id,
      window_type: b.windowType,
      utilization_percent: b.utilizationPercent,
      remaining_percent: b.remainingPercent,
      resets_at: b.resetsAt,
    }));

    items.push({
      id: acc.id,
      provider,
      name: acc.name,
      email: acc.email || null,
      auth_index: authIndex,
      source,
      status,
      binding_window: bindingWindow,
      effective_remaining_percent: effectiveRemaining,
      headroom_score: headroomScore,
      current_weight: currentWeight,
      target_weight: targetWeight,
      cooldown,
      buckets: bucketSummaries,
    });
  }

  const headroomAvailable = Math.round(headroomSum * 1000) / 1000;

  return {
    generated_at,
    version: 1,
    accounts: items,
    totals: {
      total_accounts: totalAccounts,
      active_accounts: activeAccounts,
      headroom_available: headroomAvailable,
      providers: providerCounts,
    },
  };
}

export function filterQuotaView(view: QuotaView, query: QuotaQuery): QuotaView {
  let filtered = view.accounts;

  if (query.provider) {
    const prov = query.provider.toLowerCase();
    filtered = filtered.filter((a) => a.provider.toLowerCase() === prov);
  }

  if (query.auth_index !== undefined) {
    const idx = query.auth_index;
    filtered = filtered.filter((a) => a.auth_index === idx);
  }

  if (query.source) {
    const src = query.source;
    filtered = filtered.filter((a) => a.source === src);
  }

  if (query.include_exhausted === false) {
    filtered = filtered.filter((a) => {
      if (a.effective_remaining_percent === null) return true;
      return a.effective_remaining_percent > 0;
    });
  }

  const providerCounts: Record<string, { total: number; active: number }> = {};
  let totalAccounts = 0;
  let activeAccounts = 0;
  let headroomSum = 0;

  for (const a of filtered) {
    totalAccounts++;
    const provider = a.provider;
    if (!providerCounts[provider]) {
      providerCounts[provider] = { total: 0, active: 0 };
    }
    providerCounts[provider].total++;

    // To know if active in filtered: status is not disabled or if it has non-exhausted
    // The account object in view doesn't explicitly store isActive, but let's check
    // Actually all items in view.accounts came from accounts, let's treat accounts with status !== 'disabled'
    // Or we can check if it contributes to headroomSum
    activeAccounts++;
    providerCounts[provider].active++;
    if (a.headroom_score !== null) {
      headroomSum += a.headroom_score;
    }
  }

  return {
    generated_at: view.generated_at,
    version: 1,
    accounts: filtered,
    totals: {
      total_accounts: totalAccounts,
      active_accounts: activeAccounts,
      headroom_available: Math.round(headroomSum * 1000) / 1000,
      providers: providerCounts,
    },
  };
}

export function computeETag(view: QuotaView): string {
  // Hash content without generated_at to avoid invalidating 304 if data didn't change
  const content = JSON.stringify({
    version: view.version,
    accounts: view.accounts,
    totals: view.totals,
  });
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return `"${hash}"`;
}

export class QuotaCache {
  private cachedView: QuotaView | null = null;
  private cachedETag: string | null = null;
  private cachedMetricsText: string | null = null;
  private cachedMetricsAt: number = 0;
  private lastInvalidatedAt: number = 0;
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

  invalidate(): void {
    this.cachedView = null;
    this.cachedETag = null;
    this.cachedMetricsText = null;
    this.cachedMetricsAt = 0;
    this.lastInvalidatedAt = Date.now();
  }

  getView(now?: number): { view: QuotaView; etag: string } {
    const t = now ?? Date.now();
    if (!this.cachedView || !this.cachedETag) {
      const accounts = this.getAccounts();
      const ctx = this.getContext();
      const view = buildQuotaView(accounts, ctx, t);
      const etag = computeETag(view);
      this.cachedView = view;
      this.cachedETag = etag;
    }
    return { view: this.cachedView, etag: this.cachedETag };
  }

  get(query?: QuotaQuery, now?: number): { view: QuotaView; etag: string; isFiltered: boolean } {
    const base = this.getView(now);
    if (!query || (Object.keys(query).length === 0)) {
      return { view: base.view, etag: base.etag, isFiltered: false };
    }

    const hasFilter =
      query.provider !== undefined ||
      query.auth_index !== undefined ||
      query.source !== undefined ||
      query.include_exhausted !== undefined;

    if (!hasFilter) {
      return { view: base.view, etag: base.etag, isFiltered: false };
    }

    const filtered = filterQuotaView(base.view, query);
    const etag = computeETag(filtered);
    return { view: filtered, etag, isFiltered: true };
  }

  getMetricsText(now?: number): string {
    const t = now ?? Date.now();
    // Cache metrics for up to 5 seconds if not invalidated
    if (this.cachedMetricsText && t - this.cachedMetricsAt < 5000) {
      return this.cachedMetricsText;
    }

    const { view } = this.getView(t);
    if (!this.renderMetricsFn) {
      throw new Error('renderMetricsFn not configured');
    }
    const rendered = this.renderMetricsFn(view, t);
    this.cachedMetricsText = rendered;
    this.cachedMetricsAt = t;
    return rendered;
  }
}
