import type { Store } from './store';
import type { CpaTransport } from '../../src/services/cpa/CpaTransport';
import type { CpaCredential, LinkRoutingState } from '../../src/services/cpa/types';
import {
  planWeights,
  type PlannerInput,
  type WeightPlan,
  type RoutingConfig,
} from '../../src/services/cpa/routingPlanner';

export interface CpaRoutingRunResult {
  mode: 'off' | 'shadow' | 'enforce';
  applied: boolean;
  plans: WeightPlan[];
  writes: number;
  blocked: string | null;
}

export class CpaRoutingExecutor {
  private _lastPlans: WeightPlan[] = [];
  private cachedStrategy: { value: string; expiresAt: number } | null = null;
  private tokens: number;
  private lastTokenRefillTime: number;
  private bucketCapacity: number;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly t: CpaTransport,
    now?: () => number
  ) {
    this.now = now ?? (() => Date.now());
    const cfg = this.store.getCpaRoutingConfig();
    const maxWrites = cfg.maxWritesPerMin ?? 30;
    if (typeof maxWrites === 'number' && maxWrites >= 1 && maxWrites <= 10000) {
      this.bucketCapacity = maxWrites;
    } else {
      this.bucketCapacity = 30;
    }
    this.tokens = this.bucketCapacity;
    this.lastTokenRefillTime = this.now();
  }

  lastPlans(): WeightPlan[] {
    return this._lastPlans;
  }

  private refillTokens(cfg: RoutingConfig, currentNow: number): void {
    const maxWrites = cfg.maxWritesPerMin ?? 30;
    if (typeof maxWrites === 'number' && maxWrites >= 1 && maxWrites <= 10000) {
      this.bucketCapacity = maxWrites;
    } else {
      this.bucketCapacity = 30;
    }

    const elapsed = Math.max(0, currentNow - this.lastTokenRefillTime);
    const refillRate = this.bucketCapacity / 60000;
    this.tokens = Math.min(this.bucketCapacity, this.tokens + elapsed * refillRate);
    this.lastTokenRefillTime = currentNow;
  }

  async run(entries?: CpaCredential[], simulatedNow?: number): Promise<CpaRoutingRunResult> {
    const cfg = this.store.getCpaRoutingConfig();
    if (cfg.mode === 'off') {
      this._lastPlans = [];
      return { mode: 'off', applied: false, plans: [], writes: 0, blocked: null };
    }

    const currentNow = simulatedNow ?? this.now();
    let blocked: string | null = null;
    let effectiveMode = cfg.mode;

    // Step 2: In enforce mode, verify WRR routing strategy (cached for 5 min)
    if (cfg.mode === 'enforce') {
      let strategy: string;
      if (this.cachedStrategy && currentNow < this.cachedStrategy.expiresAt) {
        strategy = this.cachedStrategy.value;
      } else {
        try {
          strategy = await this.t.getRoutingStrategy();
          this.cachedStrategy = {
            value: strategy,
            expiresAt: currentNow + 5 * 60 * 1000,
          };
        } catch (err) {
          console.error('[cpaRouting] Failed to query routing strategy:', err);
          strategy = 'unknown';
        }
      }

      if (strategy !== 'weighted-round-robin') {
        blocked = 'strategy';
        effectiveMode = 'shadow';
      }
    }

    // Step 3: Fetch CPA credential entries if not provided
    let cpaEntries: CpaCredential[];
    if (entries) {
      cpaEntries = entries;
    } else {
      try {
        const listRes = await this.t.listCredentials();
        cpaEntries = Array.isArray(listRes) ? listRes : (listRes?.files ?? []);
      } catch (err) {
        console.error('[cpaRouting] Failed to list CPA credentials:', err);
        cpaEntries = [];
      }
    }

    const links = this.store.listCpaLinks().filter((l) => l.state === 'linked');
    const plannerInputs: PlannerInput[] = [];

    for (const link of links) {
      const account = this.store.getAccount(link.accountId);
      if (!account || !account.isActive) continue;

      const entry = cpaEntries.find(
        (e) => e.name === link.cpaName || e.auth_index === link.authIndex
      );

      let routing: LinkRoutingState = {};
      if (link.routingJson) {
        try {
          routing = JSON.parse(link.routingJson);
        } catch {
          routing = {};
        }
      }

      // Human edit detection: if entry.weight !== link.routing?.applied && link.routing?.applied != null,
      // mark managed = false. Persist that state in cpa_links.routing_json.
      const currentEntryWeight =
        typeof entry?.weight === 'number' ? entry.weight : (entry?.weight ?? null);

      if (
        entry &&
        routing.applied != null &&
        currentEntryWeight !== routing.applied
      ) {
        routing.managed = false;
        this.store.updateCpaLinkRouting(link.accountId, routing);
      }

      const isManaged = routing.managed !== false;

      const history = this.store.history(currentNow - 2 * 3600 * 1000, link.accountId);

      let prev: { applied: number; at: number; cooldown: boolean } | undefined;
      if (routing.applied != null && routing.at != null) {
        prev = {
          applied: routing.applied,
          at: routing.at,
          cooldown: Boolean(routing.cooldown),
        };
      }

      plannerInputs.push({
        accountId: link.accountId,
        provider: account.providerType,
        cpaName: link.cpaName,
        plan: account.plan || '',
        snapshot: account.latestSnapshot,
        history,
        currentWeight: typeof entry?.weight === 'number' ? entry.weight : null,
        prev,
        managed: isManaged,
      });
    }

    // Step 4: Call predictive routing planner
    const plans = planWeights(plannerInputs, cfg, currentNow);
    this._lastPlans = plans;

    // In shadow mode (or if blocked by strategy), do no writes
    if (effectiveMode !== 'enforce' || blocked !== null) {
      return { mode: cfg.mode, applied: false, plans, writes: 0, blocked };
    }

    // Step 5: Enforce mode writes with token-bucket rate limiting
    let writes = 0;
    this.refillTokens(cfg, currentNow);

    for (const plan of plans) {
      if (!plan.write) continue;

      if (this.tokens < 1) {
        // Token bucket exhausted for this window; skip write
        continue;
      }

      try {
        if (typeof (this.t as any).patchCredentialWeight === 'function') {
          await (this.t as any).patchCredentialWeight(plan.cpaName, plan.target);
        } else {
          await this.t.patchFields({
            name: plan.cpaName,
            weight: plan.target,
            alt_managed_weight: true,
          });
        }

        this.tokens -= 1;
        writes++;

        const existingRouting = this.store.getCpaLinkRouting(plan.accountId) || {};
        const updatedRouting: LinkRoutingState = {
          ...existingRouting,
          applied: plan.target,
          at: currentNow,
          cooldown: plan.cooldown,
          managed: true,
          reason: plan.reason,
        };
        this.store.updateCpaLinkRouting(plan.accountId, updatedRouting);
      } catch (err) {
        // Log cleanly without template literal in first argument
        console.error('[cpaRouting] Failed to patch credential weight for %s:', plan.cpaName, err);
        const status = (err as any)?.status;
        if (status === 400) {
          const existingRouting = this.store.getCpaLinkRouting(plan.accountId) || {};
          const updatedRouting: LinkRoutingState = {
            ...existingRouting,
            managed: false,
          };
          this.store.updateCpaLinkRouting(plan.accountId, updatedRouting);
        }
      }
    }

    const applied = effectiveMode === 'enforce' && !blocked && writes > 0;
    return { mode: cfg.mode, applied, plans, writes, blocked };
  }
}
