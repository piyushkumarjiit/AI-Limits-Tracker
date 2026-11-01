import { Store, ServerAccount } from './store';
import { Tracker } from './tracker';
import { CpaTransport } from '../../src/services/cpa/CpaTransport';
import { CpaCredential, CpaListResponse } from '../../src/services/cpa/types';
import { CpaLink, ReconcileAction, reconcile } from '../../src/services/cpa/reconcile';
import type { AccountCredentials } from '../../src/models/types';
import type { CpaRoutingExecutor } from './cpaRouting';

export interface CpaSyncEngineConfig {
  syncIntervalSec?: number;
  purgeDays?: number;
  adoptExisting?: boolean;
}

export interface CpaSyncStatus {
  enabled: boolean;
  lastDiscoveryAt: string | null;
  lastDiscoveryOk: boolean;
  routingMode?: string;
}

export class CpaSyncEngine {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<ReconcileAction[]> | null = null;
  private lastDiscoveryAt: string | null = null;
  private lastDiscoveryOk: boolean = false;
  private emptyStreak: number = 0;
  private routingExecutor?: CpaRoutingExecutor;
  private trackerHookRegistered: boolean = false;

  readonly syncIntervalSec: number;
  readonly purgeDays: number;
  readonly adoptExisting: boolean;

  constructor(
    private store: Store,
    private tracker: Tracker,
    private t: CpaTransport,
    cfg?: CpaSyncEngineConfig,
    routingExecutor?: CpaRoutingExecutor
  ) {
    this.syncIntervalSec = cfg?.syncIntervalSec ?? 60;
    this.purgeDays = cfg?.purgeDays ?? 30;
    this.adoptExisting = cfg?.adoptExisting ?? true;
    this.routingExecutor = routingExecutor;
    this.hookTrackerSync();
  }

  private hookTrackerSync(): void {
    if (this.trackerHookRegistered) return;
    if (typeof this.tracker.onSyncAll === 'function') {
      this.trackerHookRegistered = true;
      this.tracker.onSyncAll(() => {
        if (this.routingExecutor) {
          this.routingExecutor.run().catch((err) => {
            console.error('[cpaSync] routingExecutor.run after tracker sync failed:', err);
          });
        }
      });
    }
  }

  setRoutingExecutor(executor: CpaRoutingExecutor): void {
    this.routingExecutor = executor;
    this.hookTrackerSync();
  }

  getRoutingExecutor(): CpaRoutingExecutor | undefined {
    return this.routingExecutor;
  }

  start(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        console.error('[cpaSync] periodic discovery failed:', err);
      });
    }, this.syncIntervalSec * 1000);
    if (this.timer.unref) this.timer.unref();

    this.runOnce().catch((err) => {
      console.error('[cpaSync] initial discovery failed:', err);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): CpaSyncStatus {
    const routingCfg = this.store.getCpaRoutingConfig();
    return {
      enabled: true,
      lastDiscoveryAt: this.lastDiscoveryAt,
      lastDiscoveryOk: this.lastDiscoveryOk,
      routingMode: routingCfg.mode,
    };
  }

  async runOnce(): Promise<ReconcileAction[]> {
    if (this.inFlight) return this.inFlight;
    const p = this.doRunOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async doRunOnce(): Promise<ReconcileAction[]> {
    let res: CpaListResponse | CpaCredential[];
    try {
      res = await this.t.listCredentials();
      this.lastDiscoveryAt = new Date().toISOString();
      this.lastDiscoveryOk = true;
    } catch (err) {
      this.lastDiscoveryAt = new Date().toISOString();
      this.lastDiscoveryOk = false;
      throw err;
    }

    const entries: CpaCredential[] = Array.isArray(res) ? res : (res?.files ?? []);
    if (entries.length === 0) {
      this.emptyStreak++;
    } else {
      this.emptyStreak = 0;
    }

    const links = this.store.listCpaLinks();
    const accounts = this.store.listAccounts();
    const now = Date.now();

    const credMap = new Map<string, AccountCredentials>();
    for (const a of accounts) {
      const c = this.store.getCredentials(a.id);
      if (c) credMap.set(a.id, c);
    }

    const result = reconcile(
      entries,
      links,
      accounts,
      now,
      {
        purgeDays: this.purgeDays,
        adoptExisting: this.adoptExisting,
        emptyStreak: this.emptyStreak,
      },
      credMap
    );

    // Apply DB updates atomically in a transaction
    this.store.transaction(() => {
      // Apply deletes first (account, history, cpa_link)
      for (const delId of result.deletes) {
        this.store.deleteAccount(delId);
        this.store.deleteCpaLink(delId);
      }

      // Apply account upserts
      for (const acc of result.accountUpserts) {
        this.store.upsertAccount(acc);
      }

      // Apply credential upserts
      for (const [accId, creds] of result.credUpserts) {
        this.store.setCredentials(accId, creds);
      }

      // Apply links upserts
      for (const link of result.links) {
        this.store.upsertCpaLink(link);
      }
    });

    // Trigger tracker.sync(id) for newly created/relinked/adopted accounts
    const syncPromises: Promise<void>[] = [];
    for (const a of result.actions) {
      if (a.kind === 'created' || a.kind === 'relinked' || a.kind === 'adopted') {
        syncPromises.push(
          this.tracker.sync(a.accountId).catch((err) => {
            console.error('[cpaSync] tracker.sync failed for', a.accountId, err);
          })
        );
      }
    }
    await Promise.allSettled(syncPromises);

    // Invoke routing write-back executor after discovery pass
    if (this.routingExecutor) {
      try {
        await this.routingExecutor.run(entries);
      } catch (err) {
        console.error('[cpaSync] routingExecutor.run after discovery failed:', err);
      }
    }

    return result.actions;
  }
}
