import { DatabaseSync } from 'node:sqlite';
import type { EngineState } from './cpaWatermarkEngine';
import { validateWatermarkPolicy, type FullWatermarkPolicy } from './cpaWatermarkPolicy';
import type { ManualHoldType } from './cpaWatermarkTypes';

/**
 * Historical audit event entry stored in cpa_watermark_history.
 */
export interface WatermarkHistoryEntry {
  id?: number;
  recordedAt: number;
  eventType: string;
  generation: number;
  summary: string;
  stateJson: string;
}

/**
 * Persisted manual operator hold record.
 */
export interface PersistedManualHold {
  accountId: string;
  hold: ManualHoldType;
  reason?: string;
  actor?: string;
  ttlSeconds?: number;
  createdAt: number;
  expiresAt?: number;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Validates deserialized EngineState schema to guard against corrupt or malformed DB records.
 */
function isValidEngineState(val: unknown): val is EngineState {
  if (!isObject(val)) return false;
  if (val.mode !== 'off' && val.mode !== 'shadow' && val.mode !== 'enforce') return false;
  if (!isObject(val.tierStates)) return false;
  if (!isObject(val.accountStates)) return false;
  if (typeof val.generation !== 'number' || !Number.isFinite(val.generation)) return false;
  if (val.tierStateEnteredAt !== undefined && !isObject(val.tierStateEnteredAt)) return false;
  if (val.rampStep !== undefined && !isObject(val.rampStep)) return false;
  return true;
}

/**
 * Persistent store for CPA Watermark Engine state and history snapshots.
 * Uses node:sqlite DatabaseSync for ACID-compliant atomic transactions.
 */
export class CpaWatermarkStore {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initTables();
  }

  /**
   * Initialize tables and indexes if they do not exist.
   */
  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cpa_watermark_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation INTEGER NOT NULL,
        policy_json TEXT,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cpa_watermark_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        generation INTEGER NOT NULL,
        summary TEXT,
        state_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cpa_watermark_history_recorded_at
        ON cpa_watermark_history (recorded_at);

      CREATE TABLE IF NOT EXISTS cpa_manual_holds (
        account_id TEXT PRIMARY KEY,
        hold TEXT NOT NULL,
        reason TEXT,
        actor TEXT,
        ttl_seconds INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
    `);
  }

  /**
   * Loads the current persisted EngineState, or null if no state has been saved yet or if corrupted.
   */
  public loadState(): { state: EngineState; generation: number; updatedAt: number; policy?: FullWatermarkPolicy } | null {
    const row = this.db
      .prepare('SELECT generation, policy_json, state_json, updated_at FROM cpa_watermark_state WHERE id = 1')
      .get() as { generation: number; policy_json: string | null; state_json: string; updated_at: number } | undefined;

    if (!row) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.state_json);
      if (!isValidEngineState(parsed)) {
        console.warn('[cpaWatermarkStore] Corrupted or invalid EngineState schema in cpa_watermark_state; ignoring');
        return null;
      }

      let policy: FullWatermarkPolicy | undefined;
      if (row.policy_json) {
        try {
          const rawPolicy = JSON.parse(row.policy_json);
          const validation = validateWatermarkPolicy(rawPolicy);
          if (validation.ok) {
            policy = validation.policy;
          } else {
            console.warn('[cpaWatermarkStore] Invalid persisted policy_json in cpa_watermark_state; setting policy = undefined');
            policy = undefined;
          }
        } catch {
          policy = undefined;
        }
      }

      return {
        state: parsed,
        generation: Number(row.generation),
        updatedAt: Number(row.updated_at),
        policy,
      };
    } catch (parseErr) {
      console.warn('[cpaWatermarkStore] JSON parse failure for state_json in cpa_watermark_state:', parseErr);
      return null;
    }
  }

  /**
   * Saves engine state atomically: updates state table and appends an audit history entry.
   * Releases savepoints on success and on error to prevent SQLite savepoint transaction leaks.
   */
  public saveState(
    state: EngineState,
    eventType: string = 'tick',
    policy?: FullWatermarkPolicy
  ): void {
    const now = Date.now();
    const stateJson = JSON.stringify(state);
    const policyJson = policy ? JSON.stringify(policy) : null;
    const generation = state.generation ?? 0;

    // Build short summary for history query convenience
    const summary = JSON.stringify({
      gen: generation,
      tiers: Object.keys(state.tierStates || {}).length,
      accounts: Object.keys(state.accountStates || {}).length,
      rampSteps: Object.keys(state.rampStep || {}).length,
    });

    this.db.exec('SAVEPOINT cpa_wm_save');
    try {
      this.db
        .prepare(`
          INSERT INTO cpa_watermark_state (id, generation, policy_json, state_json, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            generation = excluded.generation,
            policy_json = excluded.policy_json,
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
        `)
        .run(generation, policyJson, stateJson, now);

      this.db
        .prepare(`
          INSERT INTO cpa_watermark_history (recorded_at, event_type, generation, summary, state_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(now, eventType, generation, summary, stateJson);

      this.db.exec('RELEASE cpa_wm_save');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK TO cpa_wm_save');
        this.db.exec('RELEASE cpa_wm_save');
      } catch {
        // Rollback/release failed; swallow to rethrow original error
      }
      throw err;
    }
  }

  /**
   * Retrieves recent watermark history snapshots in reverse chronological order.
   */
  public getHistory(limit: number = 50): WatermarkHistoryEntry[] {
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const rows = this.db
      .prepare(`
        SELECT id, recorded_at, event_type, generation, summary, state_json
        FROM cpa_watermark_history
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
      `)
      .all(safeLimit) as Array<{
        id: number;
        recorded_at: number;
        event_type: string;
        generation: number;
        summary: string | null;
        state_json: string;
      }>;

    return rows.map((r) => ({
      id: Number(r.id),
      recordedAt: Number(r.recorded_at),
      eventType: String(r.event_type),
      generation: Number(r.generation),
      summary: r.summary || '',
      stateJson: r.state_json,
    }));
  }

  /**
   * Prunes history records older than retentionMs (default 7 days).
   * Returns number of pruned rows.
   */
  public pruneHistory(retentionMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - retentionMs;
    const result = this.db
      .prepare('DELETE FROM cpa_watermark_history WHERE recorded_at < ?')
      .run(cutoff);
    return Number(result.changes || 0);
  }

  /**
   * Clears state and history tables (useful for tests or operational reset).
   * Releases savepoint on both success and failure.
   */
  public clear(): void {
    this.db.exec('SAVEPOINT cpa_wm_clear');
    try {
      this.db.exec('DELETE FROM cpa_watermark_state');
      this.db.exec('DELETE FROM cpa_watermark_history');
      this.db.exec('DELETE FROM cpa_manual_holds');
      this.db.exec('RELEASE cpa_wm_clear');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK TO cpa_wm_clear');
        this.db.exec('RELEASE cpa_wm_clear');
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  /**
   * Sets or clears a manual hold for an account.
   * If hold is 'none', the active hold is deleted.
   */
  public setManualHold(
    accountId: string,
    hold: ManualHoldType,
    reason?: string,
    actor?: string,
    ttlSeconds?: number
  ): PersistedManualHold {
    const now = Date.now();
    if (hold === 'none') {
      this.db.prepare('DELETE FROM cpa_manual_holds WHERE account_id = ?').run(accountId);
      this.db
        .prepare(`
          INSERT INTO cpa_watermark_history (recorded_at, event_type, generation, summary, state_json)
          VALUES (?, ?, 0, ?, ?)
        `)
        .run(
          now,
          'manual_hold_cleared',
          JSON.stringify({ accountId, actor: actor || 'operator', reason: reason || 'Hold cleared' }),
          JSON.stringify({ accountId, hold: 'none', clearedAt: now })
        );
      return {
        accountId,
        hold: 'none',
        reason,
        actor,
        createdAt: now,
      };
    }

    const defaultTtl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 86400; // default 24h
    const expiresAt = now + defaultTtl * 1000;

    this.db
      .prepare(`
        INSERT INTO cpa_manual_holds (account_id, hold, reason, actor, ttl_seconds, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          hold = excluded.hold,
          reason = excluded.reason,
          actor = excluded.actor,
          ttl_seconds = excluded.ttl_seconds,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `)
      .run(accountId, hold, reason ?? null, actor ?? 'operator', defaultTtl, now, expiresAt);

    this.db
      .prepare(`
        INSERT INTO cpa_watermark_history (recorded_at, event_type, generation, summary, state_json)
        VALUES (?, ?, 0, ?, ?)
      `)
      .run(
        now,
        `manual_hold_${hold}`,
        JSON.stringify({ accountId, hold, actor: actor || 'operator', reason: reason || `Manual ${hold} hold`, expiresAt }),
        JSON.stringify({ accountId, hold, reason, actor, ttlSeconds: defaultTtl, expiresAt })
      );

    return {
      accountId,
      hold,
      reason,
      actor,
      ttlSeconds: defaultTtl,
      createdAt: now,
      expiresAt,
    };
  }

  /**
   * Retrieves active manual hold for an account, pruning if expired.
   */
  public getManualHold(accountId: string): PersistedManualHold | null {
    const now = Date.now();
    const row = this.db
      .prepare('SELECT account_id, hold, reason, actor, ttl_seconds, created_at, expires_at FROM cpa_manual_holds WHERE account_id = ?')
      .get(accountId) as {
        account_id: string;
        hold: string;
        reason: string | null;
        actor: string | null;
        ttl_seconds: number | null;
        created_at: number;
        expires_at: number | null;
      } | undefined;

    if (!row) return null;

    if (row.expires_at && row.expires_at < now) {
      this.db.prepare('DELETE FROM cpa_manual_holds WHERE account_id = ?').run(accountId);
      return null;
    }

    return {
      accountId: row.account_id,
      hold: row.hold as ManualHoldType,
      reason: row.reason ?? undefined,
      actor: row.actor ?? undefined,
      ttlSeconds: row.ttl_seconds ?? undefined,
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
    };
  }

  /**
   * Lists all currently active manual holds, pruning any expired ones.
   */
  public listManualHolds(): PersistedManualHold[] {
    const now = Date.now();
    this.db.prepare('DELETE FROM cpa_manual_holds WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);

    const rows = this.db
      .prepare('SELECT account_id, hold, reason, actor, ttl_seconds, created_at, expires_at FROM cpa_manual_holds')
      .all() as Array<{
        account_id: string;
        hold: string;
        reason: string | null;
        actor: string | null;
        ttl_seconds: number | null;
        created_at: number;
        expires_at: number | null;
      }>;

    return rows.map((r) => ({
      accountId: r.account_id,
      hold: r.hold as ManualHoldType,
      reason: r.reason ?? undefined,
      actor: r.actor ?? undefined,
      ttlSeconds: r.ttl_seconds ?? undefined,
      createdAt: Number(r.created_at),
      expiresAt: r.expires_at ? Number(r.expires_at) : undefined,
    }));
  }

  /**
   * Clears a manual hold explicitly.
   */
  public clearManualHold(accountId: string): void {
    this.setManualHold(accountId, 'none');
  }
}
