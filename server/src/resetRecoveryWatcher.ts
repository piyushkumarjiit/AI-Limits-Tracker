import type { Store } from './store';
import type { Tracker } from './tracker';
import { CpaPolicyLoader, classifyAccount } from './cpaWatermarkPolicy';
import { holdOwner } from './cpaHoldState';
import { dualRingData, type RingWindow } from '../../src/services/capacity';

export interface ResetRecoveryConfig {
  tickSec: number; // 30
  clockSkewBufferSec: number; // 60: allowance for a provider applying the reset late
  minPollGapSec: number; // 60: at most one watcher-requested full poll per minute
  retryLadderSec: number[]; // [120, 300, 900]; after that, normal polling only
}

export const DEFAULT_RESET_RECOVERY_CONFIG: ResetRecoveryConfig = {
  tickSec: 30,
  clockSkewBufferSec: 60,
  minPollGapSec: 60,
  retryLadderSec: [120, 300, 900],
};

interface RetryState {
  attempt: number;
  nextAt: number;
}

function sanitizeLog(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\x00-\x1f\x7f-\x9f]/g, '');
}

export class ResetRecoveryWatcher {
  private readonly store: Store;
  private readonly tracker: Tracker;
  private readonly policyLoader: CpaPolicyLoader;
  private readonly now: () => number;
  private readonly config: ResetRecoveryConfig;

  private timer: NodeJS.Timeout | null = null;
  private isTicking: boolean = false;
  private lastPollAt: number = 0;
  private retries = new Map<string, RetryState>();
  private exhausted = new Map<string, number>();

  constructor(
    deps: {
      store: Store;
      tracker: Tracker;
      policyLoader: CpaPolicyLoader;
      now?: () => number;
    },
    config?: Partial<ResetRecoveryConfig>
  ) {
    this.store = deps.store;
    this.tracker = deps.tracker;
    this.policyLoader = deps.policyLoader;
    this.now = deps.now ?? (() => Date.now());
    this.config = { ...DEFAULT_RESET_RECOVERY_CONFIG, ...config };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[reset-probe] tick error:', err);
      });
    }, this.config.tickSec * 1000);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      await this.doTick();
    } catch (err) {
      console.error('[reset-probe] tick exception:', err);
    } finally {
      this.isTicking = false;
    }
  }

  private async doTick(): Promise<void> {
    const currentNow = this.now();
    const policy = this.policyLoader.getPolicy();
    const links = this.store.listCpaLinks().filter((l) => l.state === 'linked');

    type DueAccount = {
      accountId: string;
      cpaName: string;
      recoveryAt: number;
      pointType: '429 cooldown' | 'hold ended' | 'reset';
      thresholdPct: number;
    };
    const dueAccounts: DueAccount[] = [];

    for (const link of links) {
      const account = this.store.getAccount(link.accountId);
      if (!account || !account.isActive) continue;
      if (holdOwner(this.store, link.accountId, currentNow) !== 'fqd') continue;

      const routing = this.store.getCpaLinkRouting(link.accountId);
      if (!routing) continue;

      const snapshot = account.latestSnapshot;
      const fetchedAtMs = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt).getTime() : 0;

      const cls = classifyAccount(link.cpaName, policy.classificationRules);
      const tierPolicy = cls.tier === 'non_pro' ? policy.nonPro : policy.pro;
      const thresholdPct = tierPolicy.hardStopRecoveryPct ?? (cls.tier === 'non_pro' ? 8 : 5);

      let recoveryAt: number | undefined;
      let pointType: '429 cooldown' | 'hold ended' | 'reset' = 'reset';

      // Rule 1: reactive_429 cooldown
      if (
        routing.disabledBy === 'reactive_429' &&
        routing.cooldownUntil &&
        fetchedAtMs < routing.cooldownUntil
      ) {
        recoveryAt = routing.cooldownUntil;
        pointType = '429 cooldown';
      }
      // Rule 2: holdEndedAt
      else if (
        routing.holdEndedAt &&
        fetchedAtMs < routing.holdEndedAt
      ) {
        recoveryAt = routing.holdEndedAt;
        pointType = 'hold ended';
      }
      // Rule 3: Quota reset
      else {
        const ring = dualRingData(snapshot);
        const blocking = [ring.inner, ring.outer].filter(
          (w): w is RingWindow => w !== null && w.remaining < thresholdPct
        );
        if (
          blocking.length > 0 &&
          blocking.every((w) => Boolean(w.bucket?.resetsAt) && !Number.isNaN(new Date(w.bucket.resetsAt!).getTime()))
        ) {
          const resetTimes = blocking.map((w) => new Date(w.bucket.resetsAt!).getTime());
          const latestReset = Math.max(...resetTimes);
          recoveryAt = latestReset + this.config.clockSkewBufferSec * 1000;
          pointType = 'reset';
        }
      }

      if (recoveryAt === undefined) continue;

      const exhaustedAt = this.exhausted.get(link.accountId);
      if (exhaustedAt !== undefined) {
        if (exhaustedAt === recoveryAt) {
          continue;
        }
        this.exhausted.delete(link.accountId);
      }

      const retry = this.retries.get(link.accountId);
      const effectiveAt = Math.max(recoveryAt, retry?.nextAt ?? 0);
      const isDue = currentNow >= effectiveAt && (fetchedAtMs < recoveryAt || retry !== undefined);

      if (isDue) {
        dueAccounts.push({
          accountId: link.accountId,
          cpaName: link.cpaName,
          recoveryAt,
          pointType,
          thresholdPct,
        });
      }
    }

    if (dueAccounts.length === 0) return;

    const gapMs = this.config.minPollGapSec * 1000;
    if (this.lastPollAt > 0 && currentNow - this.lastPollAt < gapMs) {
      return;
    }

    console.log(`[reset-probe] poll for ${dueAccounts.length} account(s)`);
    this.lastPollAt = currentNow;
    await this.tracker.syncAll();
    const postPollNow = this.now();

    for (const due of dueAccounts) {
      const account = this.store.getAccount(due.accountId);
      const snap = account?.latestSnapshot;
      const fetchedAtMs = snap?.fetchedAt ? new Date(snap.fetchedAt).getTime() : 0;
      const retry = this.retries.get(due.accountId);
      const attempt = retry?.attempt ?? 0;

      let resultSummary = '';
      let nextIso = 'none';

      // 1. Terminal auth / quarantine errors
      if (snap?.status === 'reauth_required' || account?.lastStatus === 'quarantined') {
        resultSummary = `error: ${snap?.status === 'reauth_required' ? 'reauth_required' : 'quarantined'}`;
        this.retries.delete(due.accountId);
        this.exhausted.set(due.accountId, due.recoveryAt);
      }
      // 2. Probe failed: fetchedAt predates recoveryAt or error/rate_limited status
      else if (
        fetchedAtMs < due.recoveryAt ||
        snap?.status === 'error' ||
        snap?.status === 'rate_limited'
      ) {
        const errDetail = snap?.errorMessage || account?.lastError || snap?.status || 'probe failed';
        resultSummary = `error: ${errDetail}`;
        if (attempt < this.config.retryLadderSec.length) {
          const delaySec = this.config.retryLadderSec[attempt];
          const nextAt = postPollNow + delaySec * 1000;
          this.retries.set(due.accountId, { attempt: attempt + 1, nextAt });
          nextIso = new Date(nextAt).toISOString();
        } else {
          this.retries.delete(due.accountId);
          this.exhausted.set(due.accountId, due.recoveryAt);
        }
      }
      // 3. Reset-based rule check
      else if (due.pointType === 'reset') {
        const ring = dualRingData(snap);
        const blocking = [ring.inner, ring.outer].filter(
          (w): w is RingWindow => w !== null && w.remaining < due.thresholdPct
        );
        if (blocking.length > 0) {
          resultSummary = 'still exhausted';
          const resetTimes = blocking
            .filter((w) => Boolean(w.bucket?.resetsAt))
            .map((w) => new Date(w.bucket.resetsAt!).getTime());
          const latestReset = resetTimes.length > 0 ? Math.max(...resetTimes) : 0;

          if (latestReset <= postPollNow) {
            // Provider applied reset late, use retry ladder
            if (attempt < this.config.retryLadderSec.length) {
              const delaySec = this.config.retryLadderSec[attempt];
              const nextAt = postPollNow + delaySec * 1000;
              this.retries.set(due.accountId, { attempt: attempt + 1, nextAt });
              nextIso = new Date(nextAt).toISOString();
            } else {
              this.retries.delete(due.accountId);
              this.exhausted.set(due.accountId, due.recoveryAt);
            }
          } else {
            // Reset now in the future -> clear retry state, new reset gives next recovery point
            this.retries.delete(due.accountId);
            this.exhausted.delete(due.accountId);
            nextIso = new Date(latestReset + this.config.clockSkewBufferSec * 1000).toISOString();
          }
        } else {
          // Recovered!
          resultSummary = 'recovered';
          this.retries.delete(due.accountId);
          this.exhausted.delete(due.accountId);
        }
      }
      // 4. Status ok otherwise (429 cooldown or hold ended)
      else {
        const ring = dualRingData(snap);
        const blocking = [ring.inner, ring.outer].filter(
          (w): w is RingWindow => w !== null && w.remaining < due.thresholdPct
        );
        if (blocking.length > 0) {
          resultSummary = 'still exhausted';
        } else {
          resultSummary = 'recovered';
        }
        this.retries.delete(due.accountId);
        this.exhausted.delete(due.accountId);
      }

      const safeName = sanitizeLog(due.cpaName);
      const safePointType = sanitizeLog(due.pointType);
      const safeResult = sanitizeLog(resultSummary);
      const safeNext = sanitizeLog(nextIso);
      console.log(
        `[reset-probe] ${safeName}: recovery point ${new Date(due.recoveryAt).toISOString()} (${safePointType}), result ${safeResult}, next ${safeNext}`
      );
    }
  }
}
