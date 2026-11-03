import { DatabaseSync } from 'node:sqlite';
import type { EngineState } from './cpaWatermarkEngine';
import type { FullWatermarkPolicy } from './cpaWatermarkPolicy';

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
    `);
  }

  /**
   * Loads the current persisted EngineState, or null if no state has been saved yet.
   */
  public loadState(): { state: EngineState; generation: number; updatedAt: number; policy?: FullWatermarkPolicy } | null {
    const row = this.db
      .prepare('SELECT generation, policy_json, state_json, updated_at FROM cpa_watermark_state WHERE id = 1')
      .get() as { generation: number; policy_json: string | null; state_json: string; updated_at: number } | undefined;

    if (!row) {
      return null;
    }

    try {
      const state = JSON.parse(row.state_json) as EngineState;
      let policy: FullWatermarkPolicy | undefined;
      if (row.policy_json) {
        policy = JSON.parse(row.policy_json) as FullWatermarkPolicy;
      }
      return {
        state,
        generation: Number(row.generation),
        updatedAt: Number(row.updated_at),
        policy,
      };
    } catch {
      return null;
    }
  }

  /**
   * Saves engine state atomically: updates state table and appends an audit history entry.
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
      } catch {
        // Rollback failed; swallow rollback error to rethrow original
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
   */
  public clear(): void {
    this.db.exec('SAVEPOINT cpa_wm_clear');
    try {
      this.db.exec('DELETE FROM cpa_watermark_state');
      this.db.exec('DELETE FROM cpa_watermark_history');
      this.db.exec('RELEASE cpa_wm_clear');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK TO cpa_wm_clear');
      } catch {
        // Ignore
      }
      throw err;
    }
  }
}
