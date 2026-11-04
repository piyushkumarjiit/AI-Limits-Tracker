import type { Store } from './store';
import type { CpaTransport } from '../../src/services/cpa/CpaTransport';
import type { CpaCredential, LinkRoutingState } from '../../src/services/cpa/types';
import type { WeightPlan, RoutingConfig } from '../../src/services/cpa/routingPlanner';
import {
  computeWatermarkTargets,
  type EngineState,
  type WatermarkSnapshot,
  type WatermarkComputationResult,
  type WatermarkPolicyConfig,
} from './cpaWatermarkEngine';
import {
  CpaPolicyLoader,
  classifyAccount,
  type FullWatermarkPolicy,
} from './cpaWatermarkPolicy';
import { CpaWatermarkStore } from './cpaWatermarkStore';
import { dualRingData } from '../../src/services/capacity';
import { forecastWindow } from '../../src/services/stats';

export interface CpaWatermarkRunResult {
  mode: 'off' | 'shadow' | 'enforce';
  applied: boolean;
  plans: WeightPlan[];
  writes: number;
  blocked: string | null;
  readBackDiscrepancies?: number;
  engineResult?: WatermarkComputationResult;
}

export interface CpaWatermarkServiceOptions {
  store: Store;
  transport: CpaTransport;
  policyLoader?: CpaPolicyLoader;
  watermarkStore?: CpaWatermarkStore;
  now?: () => number;
}

/**
 * CpaWatermarkService (WP-3)
 * Orchestrates policy loading, snapshot computation, rate-limited and make-before-break
 * write execution, post-write read-back verification, and state persistence.
 */
export class CpaWatermarkService {
  private readonly store: Store;
  private readonly transport: CpaTransport;
  private readonly policyLoader: CpaPolicyLoader;
  private readonly watermarkStore: CpaWatermarkStore;
  private readonly now: () => number;

  private inFlightRun: Promise<CpaWatermarkRunResult> | null = null;
  private cachedStrategy: { value: string; expiresAt: number } | null = null;
  private lastPlansList: WeightPlan[] = [];
  private lastRunBlocked: string | null = null;
  private lastWritesCount = { ok: 0, error: 0, skipped: 0 };
  private activeWeightsMap: Record<string, number> = {};

  // Token bucket rate limiting
  private tokens: number;
  private lastTokenRefillTime: number;
  private bucketCapacity: number;

  // Engine state in memory, seeded from watermark store if available
  private engineState: EngineState;

  constructor(options: CpaWatermarkServiceOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());

    this.policyLoader = options.policyLoader ?? new CpaPolicyLoader();
    this.watermarkStore =
      options.watermarkStore ??
      this.store.watermarkStore ??
      new CpaWatermarkStore((this.store as any).db);

    // Initialize rate limiter token bucket
    const policy = this.policyLoader.getPolicy();
    const rateLimit = (policy as any).maxWritesPerMin ?? 30;
    this.bucketCapacity =
      typeof rateLimit === 'number' && rateLimit >= 1 && rateLimit <= 10000
        ? rateLimit
        : 30;
    this.tokens = this.bucketCapacity;
    this.lastTokenRefillTime = this.now();

    // Restore persisted state or start fresh
    const loaded = this.watermarkStore.loadState();
    if (loaded && loaded.state) {
      this.engineState = loaded.state;
    } else {
      this.engineState = {
        generation: 0,
        mode: policy.mode,
        tierStates: {},
        accountStates: {},
        tierStateEnteredAt: {},
        rampStep: {},
      };
    }
  }

  public getPolicyLoader(): CpaPolicyLoader {
    return this.policyLoader;
  }

  public getWatermarkStore(): CpaWatermarkStore {
    return this.watermarkStore;
  }

  public getEngineState(): EngineState {
    return structuredClone(this.engineState);
  }

  public lastPlans(): WeightPlan[] {
    return this.lastPlansList;
  }

  public getRoutingContext(): {
    config: RoutingConfig;
    activeWeights: Record<string, number>;
    plans: WeightPlan[];
    writesCount: { ok: number; error: number; skipped: number };
    blockedReason: string | null;
  } {
    const policy = this.policyLoader.getPolicy();
    const legacyCfg = this.store.getCpaRoutingConfig();

    return {
      config: {
        ...legacyCfg,
        mode: policy.mode ?? legacyCfg.mode ?? 'shadow',
        maxWritesPerMin: (policy as any).maxWritesPerMin ?? legacyCfg.maxWritesPerMin ?? 30,
        minWriteIntervalSec: (policy as any).intervalSec ?? legacyCfg.minWriteIntervalSec ?? 60,
      },
      activeWeights: { ...this.activeWeightsMap },
      plans: this.lastPlansList,
      writesCount: { ...this.lastWritesCount },
      blockedReason: this.lastRunBlocked,
    };
  }

  private refillTokens(capacity: number, currentNow: number): void {
    this.bucketCapacity =
      typeof capacity === 'number' && capacity >= 1 && capacity <= 10000
        ? capacity
        : 30;

    const elapsed = Math.max(0, currentNow - this.lastTokenRefillTime);
    const refillRate = this.bucketCapacity / 60000;
    this.tokens = Math.min(this.bucketCapacity, this.tokens + elapsed * refillRate);
    this.lastTokenRefillTime = currentNow;
  }

  /**
   * Main entry point to evaluate watermarks and conditionally dispatch writes.
   * Single-flight concurrency guarantee: overlapping calls share the active in-flight run.
   */
  public async run(
    entries?: CpaCredential[],
    simulatedNow?: number
  ): Promise<CpaWatermarkRunResult> {
    if (this.inFlightRun) {
      return this.inFlightRun;
    }

    const runPromise = this.executeRun(entries, simulatedNow);
    this.inFlightRun = runPromise;
    try {
      return await runPromise;
    } finally {
      this.inFlightRun = null;
    }
  }

  private async executeRun(
    entries?: CpaCredential[],
    simulatedNow?: number
  ): Promise<CpaWatermarkRunResult> {
    const currentNow = simulatedNow ?? this.now();
    const policy = this.policyLoader.getPolicy();
    const mode = policy.mode ?? 'shadow';

    if (mode === 'off') {
      this.lastPlansList = [];
      this.lastRunBlocked = null;
      this.lastWritesCount = { ok: 0, error: 0, skipped: 0 };
      return { mode: 'off', applied: false, plans: [], writes: 0, blocked: null };
    }

    let blocked: string | null = null;
    let effectiveMode = mode;

    // Verify WRR routing strategy in enforce mode
    if (mode === 'enforce') {
      let strategy: string;
      if (this.cachedStrategy && currentNow < this.cachedStrategy.expiresAt) {
        strategy = this.cachedStrategy.value;
      } else {
        try {
          strategy = await this.transport.getRoutingStrategy();
          this.cachedStrategy = {
            value: strategy,
            expiresAt: currentNow + 5 * 60 * 1000,
          };
        } catch (err) {
          console.error('[cpaWatermarkService] Failed to query routing strategy:', err);
          strategy = 'unknown';
        }
      }

      if (strategy !== 'weighted-round-robin') {
        blocked = 'strategy';
        effectiveMode = 'shadow';
      }
    }
    this.lastRunBlocked = blocked;

    // Fetch CPA credentials
    let cpaEntries: CpaCredential[];
    if (entries) {
      cpaEntries = entries;
    } else {
      try {
        const listRes = await this.transport.listCredentials();
        cpaEntries = Array.isArray(listRes) ? listRes : (listRes?.files ?? []);
      } catch (err) {
        console.error('[cpaWatermarkService] Failed to list CPA credentials:', err);
        return {
          mode,
          applied: false,
          plans: [],
          writes: 0,
          blocked: 'list_failed',
        };
      }
    }

    // Build snapshots
    const snapshots = this.buildSnapshots(cpaEntries, policy, currentNow);

    // Adapt policy config for the engine
    const enginePolicyCfg: WatermarkPolicyConfig = {
      mode: effectiveMode,
      pro: policy.pro,
      nonPro: policy.nonPro,
      burnRateMax: policy.burnRateMax ?? 15,
      intervalSec: policy.intervalSec ?? 60,
      applyLatencySec: policy.applyLatencySec ?? 5,
    };

    // Run pure computation engine
    const computation = computeWatermarkTargets(
      snapshots,
      enginePolicyCfg,
      this.engineState,
      currentNow
    );

    // Update in-memory engine state
    this.engineState = computation.nextState;

    // Translate computation targets to WeightPlan[] for UI / telemetry compatibility
    const plans = this.buildWeightPlans(snapshots, computation, currentNow);
    this.lastPlansList = plans;

    // If shadow mode or blocked, persist state audit and return without executing writes
    if (effectiveMode !== 'enforce' || blocked !== null) {
      try {
        this.watermarkStore.saveState(this.engineState, 'eval', policy);
      } catch (err) {
        console.error('[cpaWatermarkService] Failed to save watermark state:', err);
      }
      this.lastWritesCount = { ok: 0, error: 0, skipped: 0 };
      return {
        mode,
        applied: false,
        plans,
        writes: 0,
        blocked,
        engineResult: computation,
      };
    }

    // Step 5: Execute writes in enforce mode
    const rateLimit = (policy as any).maxWritesPerMin ?? 30;
    this.refillTokens(rateLimit, currentNow);

    const writeResult = await this.executeWriteBatch(
      computation.writeBatch,
      cpaEntries,
      plans,
      currentNow
    );

    // Step 6: Post-write read-back verification
    let discrepancies = 0;
    if (writeResult.successfulPatches.size > 0) {
      discrepancies = await this.verifyReadBack(writeResult.successfulPatches);
    }

    // Persist final state
    try {
      this.watermarkStore.saveState(this.engineState, 'write_batch', policy);
    } catch (err) {
      console.error('[cpaWatermarkService] Failed to save watermark state after writes:', err);
    }

    return {
      mode,
      applied: writeResult.writes > 0,
      plans,
      writes: writeResult.writes,
      blocked,
      readBackDiscrepancies: discrepancies,
      engineResult: computation,
    };
  }

  private buildSnapshots(
    cpaEntries: CpaCredential[],
    policy: FullWatermarkPolicy,
    currentNow: number
  ): WatermarkSnapshot[] {
    const links = this.store.listCpaLinks().filter((l) => l.state === 'linked');
    const snapshots: WatermarkSnapshot[] = [];

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

      const currentEntryWeight: number | null =
        typeof entry?.weight === 'number' ? entry.weight : null;

      // Human edit detection: if entry.weight !== link.routing?.applied, mark unmanaged
      if (
        entry &&
        routing.applied != null &&
        currentEntryWeight !== routing.applied
      ) {
        routing.managed = false;
        this.store.updateCpaLinkRouting(link.accountId, routing);
      }

      const isManaged = routing.managed !== false;

      // Classify account using policy rules
      const classification = classifyAccount(
        link.cpaName,
        policy.classificationRules
      );

      // Compute dual ring effective remaining percentage
      const snapshot = account.latestSnapshot;
      const dualRing = dualRingData(snapshot);
      const quotaEffectivePct =
        typeof dualRing.effectiveRemaining === 'number'
          ? dualRing.effectiveRemaining
          : 100;

      // Compute burn rate per minute from history
      const history = this.store.history(currentNow - 2 * 3600 * 1000, link.accountId);
      let burnRatePerMin = 0;
      if (account.providerType !== 'antigravity' && history.length > 0 && snapshot?.buckets) {
        for (const bucket of snapshot.buckets) {
          if (bucket.windowType === 'session_5h' || bucket.windowType === 'weekly_7d') {
            const points = history
              .filter((p) => (bucket.windowType === 'session_5h' ? p.session != null : p.weekly != null))
              .map((p) => ({ t: p.t, value: bucket.windowType === 'session_5h' ? p.session : p.weekly }));
            const usedPct =
              bucket.utilizationPercent ??
              (bucket.remainingPercent != null ? 100 - bucket.remainingPercent : null);
            const fc = forecastWindow(points, usedPct, bucket.resetsAt, {
              now: currentNow,
              lookbackMs: 90 * 60 * 1000,
            });
            if (fc.burnRatePerHour !== null && fc.burnRatePerHour > 0) {
              const perMin = fc.burnRatePerHour / 60;
              if (perMin > burnRatePerMin) {
                burnRatePerMin = perMin;
              }
            }
          }
        }
      }

      // Compute staleness in seconds
      let stalenessSec = 0;
      if (snapshot?.fetchedAt) {
        const fetchedMs = new Date(snapshot.fetchedAt).getTime();
        if (!Number.isNaN(fetchedMs)) {
          stalenessSec = Math.max(0, Math.round((currentNow - fetchedMs) / 1000));
        }
      } else {
        stalenessSec = 9999;
      }

      const isCooldown = Boolean(routing.cooldown);

      const snapProvider = (
        ['antigravity', 'claude', 'codex', 'deepseek'].includes(classification.provider)
          ? classification.provider
          : ['antigravity', 'claude', 'codex', 'deepseek'].includes(account.providerType)
          ? account.providerType
          : 'claude'
      ) as 'antigravity' | 'claude' | 'codex' | 'deepseek';

      snapshots.push({
        cpaName: link.cpaName,
        accountId: link.accountId,
        provider: snapProvider,
        tier: classification.tier,
        modality: classification.modality,
        quotaEffectivePct,
        burnRatePerMin,
        stalenessSec,
        isCooldown,
        currentWeight: currentEntryWeight,
        managed: isManaged && classification.managed,
      });

      if (currentEntryWeight !== null) {
        this.activeWeightsMap[link.accountId] = currentEntryWeight;
      }
    }

    return snapshots;
  }

  private buildWeightPlans(
    snapshots: WatermarkSnapshot[],
    computation: WatermarkComputationResult,
    currentNow: number
  ): WeightPlan[] {
    const plans: WeightPlan[] = [];

    for (const snap of snapshots) {
      const decision = computation.targets.get(snap.cpaName);
      const target = decision ? decision.targetWeight : (snap.currentWeight ?? 100);
      const isCooldown = snap.isCooldown || decision?.reason === 'cooldown';

      let reason: WeightPlan['reason'] = 'headroom';
      if (decision?.reason === 'hard_stop' || isCooldown) {
        reason = 'exhausted';
      } else if (decision?.reason === 'drain') {
        reason = 'near_exhaust';
      } else if (decision?.reason === 'drain_recovery' || decision?.reason === 'hard_stop_recovery') {
        reason = 'released';
      }

      const willWrite = computation.writeBatch.some((wb) => wb.name === snap.cpaName);

      plans.push({
        accountId: snap.accountId,
        cpaName: snap.cpaName,
        headroom: snap.quotaEffectivePct / 100,
        target,
        cooldown: isCooldown,
        reason,
        write: willWrite,
      });
    }

    return plans;
  }

  /**
   * Dispatches writeBatch with make-before-break ordering (promotions before demotions),
   * token bucket gating, and emergency zeroing bypass.
   */
  private async executeWriteBatch(
    writeBatch: Array<{ name: string; weight: number; isEmergency: boolean }>,
    cpaEntries: CpaCredential[],
    plans: WeightPlan[],
    currentNow: number
  ): Promise<{
    writes: number;
    successfulPatches: Map<string, number>;
  }> {
    let writes = 0;
    let okCount = 0;
    let errCount = 0;
    let skippedCount = 0;
    const successfulPatches = new Map<string, number>();

    // Make-before-break: separate promotions from demotions
    const promotions: Array<{ name: string; weight: number; isEmergency: boolean }> = [];
    const demotions: Array<{ name: string; weight: number; isEmergency: boolean }> = [];

    for (const item of writeBatch) {
      const entry = cpaEntries.find((e) => e.name === item.name);
      const curWeight = typeof entry?.weight === 'number' ? entry.weight : 0;
      if (item.weight >= curWeight) {
        promotions.push(item);
      } else {
        demotions.push(item);
      }
    }

    // Promotions execute first, then demotions
    const orderedBatch = [...promotions, ...demotions];

    for (const item of orderedBatch) {
      // Must be present in CPA entries
      const hasEntry = cpaEntries.some((e) => e.name === item.name);
      if (!hasEntry) {
        skippedCount++;
        continue;
      }

      // Check token bucket rate limit: emergency zeroing/drain bypasses rate limits
      if (this.tokens < 1 && !item.isEmergency) {
        skippedCount++;
        continue;
      }

      const plan = plans.find((p) => p.cpaName === item.name);
      const accountId = plan?.accountId;

      try {
        if (typeof (this.transport as any).patchCredentialWeight === 'function') {
          await (this.transport as any).patchCredentialWeight(item.name, item.weight);
        } else {
          await this.transport.patchFields({
            name: item.name,
            weight: item.weight,
            alt_managed_weight: true,
          });
        }

        if (this.tokens >= 1) {
          this.tokens -= 1;
        }
        writes++;
        okCount++;
        successfulPatches.set(item.name, item.weight);

        if (accountId) {
          this.activeWeightsMap[accountId] = item.weight;
          const existingRouting = this.store.getCpaLinkRouting(accountId) || {};
          const updatedRouting: LinkRoutingState = {
            ...existingRouting,
            applied: item.weight,
            at: currentNow,
            cooldown: plan?.cooldown ?? false,
            managed: true,
            reason: plan?.reason,
          };
          this.store.updateCpaLinkRouting(accountId, updatedRouting);
        }
      } catch (err) {
        errCount++;
        console.error('[cpaWatermarkService] Failed to patch credential weight for %s:', item.name, err);
        const status = (err as any)?.status;
        if (status === 400 && accountId) {
          const existingRouting = this.store.getCpaLinkRouting(accountId) || {};
          const updatedRouting: LinkRoutingState = {
            ...existingRouting,
            managed: false,
          };
          this.store.updateCpaLinkRouting(accountId, updatedRouting);
        }
      }
    }

    this.lastWritesCount = { ok: okCount, error: errCount, skipped: skippedCount };
    return { writes, successfulPatches };
  }

  /**
   * Post-write read-back verification: reads credentials back from CPA
   * and reports discrepancies where CPA weight does not match the patched target weight.
   */
  private async verifyReadBack(
    expectedWeights: Map<string, number>
  ): Promise<number> {
    try {
      const listRes = await this.transport.listCredentials();
      const freshEntries = Array.isArray(listRes) ? listRes : (listRes?.files ?? []);
      let discrepancies = 0;

      for (const [name, targetWeight] of expectedWeights.entries()) {
        const found = freshEntries.find((e) => e.name === name);
        if (!found || found.weight !== targetWeight) {
          discrepancies++;
          console.warn(
            '[cpaWatermarkService] Read-back verification mismatch for %s: expected %d, got %s',
            name,
            targetWeight,
            found ? found.weight : 'missing'
          );
        }
      }

      return discrepancies;
    } catch (err) {
      console.error('[cpaWatermarkService] Read-back list credentials failed:', err);
      return expectedWeights.size;
    }
  }
}
