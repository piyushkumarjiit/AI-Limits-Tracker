import type { Store, CpaManualHoldRecord } from './store';
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
  statusLevelsOf,
  DEFAULT_ACCOUNT_CLASSIFICATION,
  type AccountClassification,
  type FullWatermarkPolicy,
} from './cpaWatermarkPolicy';
import { CpaWatermarkStore } from './cpaWatermarkStore';
import { dualRingData } from '../../src/services/capacity';
import { forecastWindow } from '../../src/services/stats';
import { applyDualBarrier } from './cpaSync';
import {
  type WatermarkAccountState,
  type WatermarkTierState,
  type WatermarkMode,
  type ManualHoldType,
  type WatermarkFleetOverview,
  type WatermarkAccountView,
  type WatermarkWindowView,
  effectiveAccountState,
} from './cpaWatermarkTypes';
import {
  DEFAULT_LEAD_TIME_SEC,
  DEFAULT_TAU_SEC,
  DEFAULT_T_DRAIN_SEC,
  DEFAULT_T_POLL_SEC,
  DEFAULT_COOLDOWN_SEC,
  evaluateAccountTripwire,
  applyFailClosedCollectiveFallback,
  computeDualWindowBurnRate,
  computeEwmaBurnRate,
  circuitBreakers,
  type WindowObservation,
  type TripwireEvaluation,
  type TripwireConfig,
} from './cpaTripwireEngine';
import type { Tracker } from './tracker';

export {
  DEFAULT_LEAD_TIME_SEC,
  DEFAULT_TAU_SEC,
  DEFAULT_T_DRAIN_SEC,
  DEFAULT_T_POLL_SEC,
  DEFAULT_COOLDOWN_SEC,
  evaluateAccountTripwire,
  applyFailClosedCollectiveFallback,
  computeDualWindowBurnRate,
  computeEwmaBurnRate,
  circuitBreakers,
  type WindowObservation,
  type TripwireEvaluation,
  type TripwireConfig,
};

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
  tracker?: Tracker;
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

    if (options.tracker) {
      options.tracker.setReactive429Handler((accountId) => this.handleReactive429(accountId));
    }

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
        if (typeof (this.transport as any).patchCredentialDualBarrier === 'function') {
          await (this.transport as any).patchCredentialDualBarrier(item.name, item.weight === 0, item.weight);
        } else if (typeof this.transport.patchFields === 'function') {
          await this.transport.patchFields({
            name: item.name,
            weight: item.weight,
            disabled: item.weight === 0,
            alt_managed_weight: true,
          });
        } else if (typeof (this.transport as any).patchCredentialWeight === 'function') {
          await (this.transport as any).patchCredentialWeight(item.name, item.weight);
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

  /**
   * Reactive circuit breaker handler: Upstream 429 immediately transitions
   * account to exhausted and executes dual-barrier airgap (weight 0, disabled true)
   * without waiting for scheduled sync.
   */
  public async handleReactive429(
    accountId: string,
    options?: { cooldownMs?: number; reason?: string }
  ): Promise<void> {
    const now = this.now();
    const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_SEC * 1000;
    const reason = options?.reason ?? 'upstream_429';

    // 1. Record error in circuit breaker registry
    circuitBreakers.recordError(accountId, '429', now, cooldownMs);

    // 2. Immediately update account status in store
    const account = this.store.getAccount(accountId);
    if (account) {
      this.store.upsertAccount({
        ...account,
        lastStatus: 'rate_limited',
        lastError: 'HTTP 429 Rate Limited (circuit breaker tripped)',
      });
    }

    // 3. Find CPA link and dispatch immediate dual-barrier write
    const link = this.store.getCpaLink(accountId);
    if (link) {
      const routing = this.store.getCpaLinkRouting(accountId) || {};
      this.store.updateCpaLinkRouting(accountId, {
        ...routing,
        applied: 0,
        cooldown: true,
        reason,
        at: now,
      });
      this.activeWeightsMap[accountId] = 0;

      try {
        await applyDualBarrier(this.transport, link.cpaName, 'exhausted', 0);
      } catch (err) {
        console.error('[cpaWatermarkService] Failed dual-barrier write on reactive 429 for %s:', link.cpaName, err);
      }
    }

    // 4. Update in-memory engine state for account
    if (link) {
      this.engineState.accountStates[link.cpaName] = {
        state: 'cooldown',
        enteredAt: now,
        targetWeight: 0,
      };
    }
  }

  /**
   * Sets or releases an operator manual hold.
   * Holds cannot be cleared by automation and support an expiration TTL (default 24h).
   */
  public async setManualHold(
    accountId: string,
    hold: ManualHoldType,
    reason?: string,
    ttlSeconds?: number
  ): Promise<{
    hold: CpaManualHoldRecord;
    effectiveState: WatermarkAccountState;
  }> {
    const now = this.now();
    const expiresAt =
      hold === 'none'
        ? null
        : ttlSeconds !== undefined
        ? now + ttlSeconds * 1000
        : now + 24 * 3600 * 1000;

    this.store.setManualHold(accountId, hold, reason, expiresAt, now);

    const link = this.store.getCpaLink(accountId);
    if (link) {
      if (hold === 'quarantine' || hold === 'airgap') {
        // Immediate dual-barrier write: weight 0 AND disabled true
        await applyDualBarrier(this.transport, link.cpaName, hold === 'airgap' ? 'airgapped' : 'quarantined', 0);
        this.activeWeightsMap[accountId] = 0;
      } else if (hold === 'none') {
        // Released hold: restore healthy weight
        await applyDualBarrier(this.transport, link.cpaName, 'healthy', 1);
        this.activeWeightsMap[accountId] = 1;
      }
    }

    const holdRecord: CpaManualHoldRecord = {
      accountId,
      holdType: hold,
      reason,
      createdAt: now,
      expiresAt,
    };

    const autoState: WatermarkAccountState = 'healthy';
    const effectiveState = effectiveAccountState(hold, autoState);

    return { hold: holdRecord, effectiveState };
  }

  /**
   * Builds the comprehensive WatermarkFleetOverview telemetry snapshot for GET /api/cpa/watermarks.
   */
  public async getFleetOverview(simulatedNow?: number): Promise<WatermarkFleetOverview> {
    const currentNow = simulatedNow ?? this.now();
    const policy = this.policyLoader.getPolicy();
    const mode = policy.mode ?? 'shadow';

    // 1. Query routing strategy
    let routingStrategy = 'weighted-round-robin';
    if (this.cachedStrategy && currentNow < this.cachedStrategy.expiresAt) {
      routingStrategy = this.cachedStrategy.value;
    } else {
      try {
        routingStrategy = await this.transport.getRoutingStrategy();
        this.cachedStrategy = { value: routingStrategy, expiresAt: currentNow + 5 * 60 * 1000 };
      } catch {
        routingStrategy = 'weighted-round-robin';
      }
    }

    // 2. Fetch CPA credentials
    let cpaEntries: CpaCredential[] = [];
    try {
      const listRes = await this.transport.listCredentials();
      cpaEntries = Array.isArray(listRes) ? listRes : (listRes?.files ?? []);
    } catch {
      cpaEntries = [];
    }

    // 3. Gather accounts and evaluate tripwires
    const links = this.store.listCpaLinks().filter((l) => l.state === 'linked');
    const evaluationsByPool = new Map<string, TripwireEvaluation[]>();
    const classifications = new Map<string, AccountClassification>();

    for (const link of links) {
      const account = this.store.getAccount(link.accountId);
      if (!account || !account.isActive) continue;

      const snapshot = account.latestSnapshot;
      const history = this.store.history(currentNow - 2 * 3600 * 1000, link.accountId);

      const windowObs: WindowObservation[] = [];
      if (snapshot?.buckets) {
        for (const b of snapshot.buckets) {
          const isSession = b.windowType === 'session_5h';
          const isWeekly = b.windowType === 'weekly_7d';
          const winHistory = history
            .filter((p) => (isSession ? p.session != null : isWeekly ? p.weekly != null : false))
            .map((p) => ({ t: p.t, value: isSession ? p.session : p.weekly }));

          windowObs.push({
            key: b.windowType ?? b.id,
            utilizationPct: b.utilizationPercent ?? null,
            remainingPct: b.remainingPercent ?? (b.utilizationPercent != null ? 100 - b.utilizationPercent : null),
            resetsAt: b.resetsAt,
            history: winHistory,
          });
        }
      }

      // Tight / exhausted levels come from the policy for this account's tier.
      const classification = classifyAccount(link.cpaName, policy.classificationRules);
      const levels = classification.tier === 'non_pro' ? policy.nonPro : policy.pro;
      classifications.set(link.accountId, classification);

      const evalResult = evaluateAccountTripwire(
        link.accountId,
        account.providerType,
        windowObs,
        {
          exhaustedFloorPct: levels.hardStopPct,
          tightFloorPct: levels.drainPct,
          leadTimeSec: (policy as any).leadTimeSec ?? DEFAULT_LEAD_TIME_SEC,
          tauSec: policy.intervalSec ?? DEFAULT_TAU_SEC,
          tDrainSec: DEFAULT_T_DRAIN_SEC,
          tPollSec: policy.applyLatencySec ?? DEFAULT_T_POLL_SEC,
          burnRateMax: policy.burnRateMax ?? 15,
        },
        currentNow
      );
      evalResult.cpaName = link.cpaName;

      // Check reactive circuit breaker cooldown
      if (circuitBreakers.isCooldownActive(link.accountId, currentNow)) {
        evalResult.autoState = 'exhausted';
        evalResult.reason = 'circuit_breaker_429';
        evalResult.targetWeight = 0;
        evalResult.disabled = true;
        evalResult.isCooldown = true;
      }

      const poolKey = account.providerType;
      const poolList = evaluationsByPool.get(poolKey) ?? [];
      poolList.push(evalResult);
      evaluationsByPool.set(poolKey, poolList);
    }

    // Apply fail-closed collective fallback per pool
    const finalEvaluations = new Map<string, TripwireEvaluation>();
    let collectiveFallbackActive = false;

    for (const [, poolAccounts] of evaluationsByPool.entries()) {
      const fallbackResult = applyFailClosedCollectiveFallback(poolAccounts, {
        mode: (policy as any).collectiveFallbackMode ?? 'single_tight',
      });
      if (fallbackResult.fallbackActive) {
        collectiveFallbackActive = true;
      }
      for (const ev of fallbackResult.evaluations) {
        finalEvaluations.set(ev.accountId, ev);
      }
    }

    // Assemble WatermarkAccountView array
    const accountViews: WatermarkAccountView[] = [];
    let totalRunwayMinutes: number | null = null;
    let healthyCount = 0;
    let tightCount = 0;
    let exhaustedCount = 0;
    let quarantinedCount = 0;

    for (const link of links) {
      const account = this.store.getAccount(link.accountId);
      if (!account || !account.isActive) continue;

      const entry = cpaEntries.find((e) => e.name === link.cpaName || e.auth_index === link.authIndex);
      let routing: LinkRoutingState = {};
      if (link.routingJson) {
        try { routing = JSON.parse(link.routingJson); } catch {}
      }

      const evalResult = finalEvaluations.get(link.accountId);
      let autoState: WatermarkAccountState = evalResult?.autoState ?? 'healthy';
      // For accounts the routing engine manages, report the engine's own state so the
      // status always matches what FQD does (or, in shadow mode, would do) in CLIProxy.
      const engineAccount = this.engineState.accountStates?.[link.cpaName];
      if (engineAccount && evalResult?.reason !== 'circuit_breaker_429') {
        if (engineAccount.state === 'hard_stop') autoState = 'exhausted';
        else if (engineAccount.state === 'drain') autoState = 'draining';
        else if (engineAccount.state === 'healthy' || engineAccount.state === 'ramping') autoState = 'healthy';
      }
      const classification = classifications.get(link.accountId) ?? DEFAULT_ACCOUNT_CLASSIFICATION;

      // Operator manual hold
      const holdRecord = this.store.getManualHold(link.accountId, currentNow);
      const manualHold: ManualHoldType = holdRecord ? holdRecord.holdType : 'none';

      // Effective state: most_restrictive(ManualHold, AutoState)
      let effectiveState = effectiveAccountState(manualHold, autoState);
      if (account.lastStatus === 'quarantined') {
        effectiveState = 'quarantined';
      }

      const currentWeight = typeof entry?.weight === 'number' ? entry.weight : (routing.applied ?? 0);
      let targetWeight = evalResult?.targetWeight ?? 100;
      let isDisabled = Boolean(entry?.disabled);

      if (effectiveState === 'quarantined' || effectiveState === 'airgapped') {
        targetWeight = 0;
        isDisabled = true;
      }

      const windows: WatermarkWindowView[] = [];
      const snapshot = account.latestSnapshot;
      if (snapshot?.buckets) {
        for (const b of snapshot.buckets) {
          const curRemaining =
            b.remainingPercent ??
            (b.utilizationPercent != null ? 100 - b.utilizationPercent : 100);
          const burnRate = evalResult?.burnRatePerMin ?? 0;
          const leadMin = (evalResult?.leadTimeSec ?? DEFAULT_LEAD_TIME_SEC) / 60;
          const projRemaining = Math.max(0, Math.round((curRemaining - burnRate * leadMin) * 10) / 10);
          const resetsAt = b.resetsAt ?? '';
          const resetSecondsRemaining = resetsAt
            ? Math.max(0, Math.round((new Date(resetsAt).getTime() - currentNow) / 1000))
            : 0;

          windows.push({
            key: b.windowType ?? b.id,
            label: b.label ?? b.windowType ?? b.id,
            currentRemainingPct: curRemaining,
            projectedRemainingPct: projRemaining,
            resetsAt,
            resetSecondsRemaining,
            isBinding: (evalResult?.bindingWindow ?? '') === (b.windowType ?? b.id),
          });
        }
      }

      const errs15m = circuitBreakers.getErrors15m(link.accountId, currentNow);
      const readBackDrift = routing.applied != null && currentWeight !== routing.applied;

      const view: WatermarkAccountView = {
        accountId: link.accountId,
        name: account.name,
        provider: account.providerType,
        email: account.email,
        state: effectiveState,
        manualHold,
        currentWeight,
        targetWeight,
        readBackDrift,
        isQuarantined: effectiveState === 'quarantined',
        isDisabled,
        bindingWindow: evalResult?.bindingWindow ?? 'unknown',
        windows,
        burnRatePerMin: evalResult?.burnRatePerMin ?? 0,
        runwayMinutes: evalResult?.runwayMinutes ?? null,
        recentRequests5m: 0,
        recentErrors15m: errs15m,
        tier: classification.tier,
        managed: classification.managed && routing.managed !== false,
      };

      accountViews.push(view);

      if (effectiveState === 'healthy') healthyCount++;
      else if (effectiveState === 'tight' || effectiveState === 'draining') tightCount++;
      else if (effectiveState === 'exhausted') exhaustedCount++;
      else if (effectiveState === 'quarantined' || effectiveState === 'airgapped') quarantinedCount++;

      if (view.runwayMinutes != null && view.runwayMinutes > 0) {
        if (totalRunwayMinutes === null || view.runwayMinutes < totalRunwayMinutes) {
          totalRunwayMinutes = view.runwayMinutes;
        }
      }
    }

    let tierState: WatermarkTierState = 'OPEN';
    if (accountViews.length > 0 && healthyCount === 0 && tightCount === 0) {
      tierState = 'CLOSED';
    } else if (tightCount > 0 || (accountViews.length > 0 && healthyCount < accountViews.length)) {
      tierState = 'DEGRADED';
    }

    const activeDangerAlerts: string[] = [];
    if (collectiveFallbackActive) {
      activeDangerAlerts.push('Collective quota fallback active: pool degraded or airgapped');
    }
    const has429 = accountViews.some((a) => a.recentErrors15m.http429 > 0);
    if (has429) {
      activeDangerAlerts.push('Upstream HTTP 429 rate limit errors detected');
    }
    if (quarantinedCount > 0) {
      activeDangerAlerts.push(`${quarantinedCount} account(s) under operator hold or quarantine`);
    }
    if (totalRunwayMinutes !== null && totalRunwayMinutes < 120) {
      activeDangerAlerts.push(`Fleet pool runway < 2h (${totalRunwayMinutes}m remaining)`);
    }

    return {
      mode,
      routingStrategy,
      writesBlockedReason: this.lastRunBlocked,
      tierState,
      poolRunwayMinutes: totalRunwayMinutes,
      healthyCount,
      tightCount,
      exhaustedCount,
      quarantinedCount,
      accounts: accountViews,
      recentShadowDecisions: [],
      activeDangerAlerts,
      statusLevels: statusLevelsOf(policy),
    };
  }
}
