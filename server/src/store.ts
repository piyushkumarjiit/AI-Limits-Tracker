import { DatabaseSync } from 'node:sqlite';
import { CpaWatermarkStore } from './cpaWatermarkStore';
import type { ManualHoldType } from './cpaWatermarkTypes';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { AccountCredentials, AccountEntity, AlertKind, AlertLogEntry, UsageSnapshot } from '../../src/models/types';
import type { StatPoint } from '../../src/services/stats';
import type { CpaLink } from '../../src/services/cpa/reconcile';
import type { LinkRoutingState } from '../../src/services/cpa/types';
import {
  DEFAULT_ROUTING,
  type RoutingConfig,
  validateRoutingConfig,
} from '../../src/services/cpa/routingPlanner';

export interface ServerAccount extends AccountEntity {
  latestSnapshot?: UsageSnapshot;
}

export interface CpaManualHoldRecord {
  accountId: string;
  holdType: ManualHoldType;
  reason?: string;
  createdAt: number;
  expiresAt?: number | null;
}

/**
 * Narrows a file or directory mode, best effort: some filesystems (network
 * mounts, Windows-backed volumes) refuse chmod, and that must not stop startup.
 */
function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (e) {
    console.warn(`[store] could not set mode ${mode.toString(8)} on ${path}: ${(e as Error).message}`);
  }
}

/** Credentials are encrypted at rest with AES-256-GCM; the key comes from APP_SECRET. */
class Vault {
  private key: Buffer;
  /** Pre-scrypt key (plain SHA-256); kept only to read records written by older versions. */
  private legacyKey: Buffer;
  constructor(secret: string) {
    this.key = scryptSync(secret, 'ai-limits-vault-v2', 32);
    this.legacyKey = createHash('sha256').update(`ai-limits-vault:${secret}`).digest();
  }
  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return 'v2.' + [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }
  decrypt<T>(payload: string | null): T | null {
    if (!payload) return null;
    try {
      const isV2 = payload.startsWith('v2.');
      const [iv, tag, data] = (isV2 ? payload.slice(3) : payload).split('.').map((s) => Buffer.from(s, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', isV2 ? this.key : this.legacyKey, iv, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  }
  isLegacy(payload: string | null): boolean {
    return Boolean(payload) && !payload!.startsWith('v2.');
  }
}

export interface CpaUsageRow {
  requestId: string;
  ts: number;
  email: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failed: boolean;
}

export interface CpaUsageSummaryRow {
  email: string;
  model: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export class Store {
  private db: DatabaseSync;
  private vault: Vault;
  /**
   * Persistent store for CPA watermark engine state and audit history.
   */
  public readonly watermarkStore: CpaWatermarkStore;

  constructor(baseDir: string, fileName: string, secret: string) {
    const base = resolve(baseDir);
    const path = resolve(base, fileName);
    // Confine the database file to the data directory (no traversal, no null bytes)
    if (`${baseDir}${fileName}`.includes('\0') || !path.startsWith(base + sep)) throw new Error('Invalid database path');
    const dir = dirname(path);
    // The database holds encrypted credentials, so keep it private to the user
    // running the server. `mode` only applies on creation, so narrow an existing
    // directory too.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    restrict(dir, 0o700);
    this.db = new DatabaseSync(path);
    this.vault = new Vault(secret);
    this.watermarkStore = new CpaWatermarkStore(this.db);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT '',
        email TEXT,
        order_index INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        created_at TEXT NOT NULL,
        credentials TEXT,
        latest_snapshot TEXT
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        t INTEGER NOT NULL,
        session REAL,
        weekly REAL
      );
      CREATE INDEX IF NOT EXISTS idx_history ON history(account_id, t);
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_state (
        account_id TEXT PRIMARY KEY,
        armed20 INTEGER NOT NULL DEFAULT 1,
        armed10 INTEGER NOT NULL DEFAULT 1,
        armed0 INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cpa_links (
        account_id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL UNIQUE,
        cpa_name TEXT NOT NULL,
        auth_index TEXT NOT NULL,
        state TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        unlinked_at INTEGER,
        routing_json TEXT
      );
      CREATE TABLE IF NOT EXISTS cpa_usage (
        request_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        email TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        failed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cpa_usage_ts ON cpa_usage (ts);
      CREATE TABLE IF NOT EXISTS cpa_manual_holds (
        account_id TEXT PRIMARY KEY,
        hold_type TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
    `);
    // SQLite creates these with the process umask; the WAL/SHM siblings appear
    // once the journal is enabled. Tighten whichever exist now.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) restrict(file, 0o600);
    }
  }

  private rowToAccount(r: any): ServerAccount {
    return {
      id: r.id,
      name: r.name,
      providerType: r.provider_type,
      plan: r.plan,
      email: r.email || undefined,
      orderIndex: r.order_index,
      isActive: Boolean(r.is_active),
      lastSyncAt: r.last_sync_at || undefined,
      lastStatus: r.last_status,
      lastError: r.last_error || undefined,
      createdAt: r.created_at,
      latestSnapshot: r.latest_snapshot ? JSON.parse(r.latest_snapshot) : undefined,
    };
  }

  listAccounts(): ServerAccount[] {
    return this.db
      .prepare('SELECT * FROM accounts ORDER BY order_index ASC, created_at ASC')
      .all()
      .map((r) => this.rowToAccount(r));
  }

  getAccount(id: string): ServerAccount | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return r ? this.rowToAccount(r) : null;
  }

  upsertAccount(a: ServerAccount): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, name, provider_type, plan, email, order_index, is_active, last_sync_at, last_status, last_error, created_at, latest_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider_type=excluded.provider_type, plan=excluded.plan,
           email=excluded.email, order_index=excluded.order_index, is_active=excluded.is_active,
           last_sync_at=excluded.last_sync_at, last_status=excluded.last_status, last_error=excluded.last_error,
           latest_snapshot=excluded.latest_snapshot`
      )
      .run(
        a.id,
        a.name,
        a.providerType,
        a.plan || '',
        a.email ?? null,
        a.orderIndex,
        a.isActive ? 1 : 0,
        a.lastSyncAt ?? null,
        a.lastStatus ?? 'idle',
        a.lastError ?? null,
        a.createdAt,
        a.latestSnapshot ? JSON.stringify(a.latestSnapshot) : null
      );
  }

  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM history WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM alerts WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM alert_state WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM cpa_links WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM cpa_manual_holds WHERE account_id = ?').run(id);
  }

  private rowToCpaLink(r: any): CpaLink {
    return {
      accountId: r.account_id,
      identityKey: r.identity_key,
      cpaName: r.cpa_name,
      authIndex: r.auth_index,
      state: r.state as 'linked' | 'unlinked',
      lastSeenAt: Number(r.last_seen_at),
      unlinkedAt: r.unlinked_at != null ? Number(r.unlinked_at) : null,
      routingJson: r.routing_json ?? null,
    };
  }

  /** Saves CLIProxy usage records once each (keyed by request id); returns how many were new. */
  addCpaUsage(rows: CpaUsageRow[]): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO cpa_usage (request_id, ts, email, model, input_tokens, output_tokens, total_tokens, failed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let added = 0;
    for (const r of rows) {
      added += Number(stmt.run(r.requestId, r.ts, r.email, r.model, r.inputTokens, r.outputTokens, r.totalTokens, r.failed ? 1 : 0).changes);
    }
    return added;
  }

  /** Token and request totals per account email and model since `sinceMs`. */
  cpaUsageSummary(sinceMs: number): CpaUsageSummaryRow[] {
    return (
      this.db
        .prepare(
          'SELECT email, model, COUNT(*) AS requests, SUM(failed) AS failed, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(total_tokens) AS total_tokens FROM cpa_usage WHERE ts >= ? GROUP BY email, model'
        )
        .all(sinceMs) as any[]
    ).map((r) => ({
      email: r.email,
      model: r.model,
      requests: Number(r.requests),
      failed: Number(r.failed),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      totalTokens: Number(r.total_tokens),
    }));
  }

  pruneCpaUsage(beforeMs: number): void {
    this.db.prepare('DELETE FROM cpa_usage WHERE ts < ?').run(beforeMs);
  }

  getCpaLink(accountId: string): CpaLink | null {
    const r = this.db.prepare('SELECT * FROM cpa_links WHERE account_id = ?').get(accountId);
    return r ? this.rowToCpaLink(r) : null;
  }

  listCpaLinks(): CpaLink[] {
    const rows = this.db.prepare('SELECT * FROM cpa_links').all() as any[];
    return rows.map((r) => this.rowToCpaLink(r));
  }

  upsertCpaLink(link: CpaLink): void {
    this.db
      .prepare(
        `INSERT INTO cpa_links (account_id, identity_key, cpa_name, auth_index, state, last_seen_at, unlinked_at, routing_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           identity_key = excluded.identity_key,
           cpa_name = excluded.cpa_name,
           auth_index = excluded.auth_index,
           state = excluded.state,
           last_seen_at = excluded.last_seen_at,
           unlinked_at = excluded.unlinked_at,
           routing_json = excluded.routing_json`
      )
      .run(
        link.accountId,
        link.identityKey,
        link.cpaName,
        link.authIndex ?? null,
        link.state,
        link.lastSeenAt ?? Date.now(),
        link.unlinkedAt ?? null,
        link.routingJson ?? null
      );
  }

  deleteCpaLink(accountId: string): void {
    this.db.prepare('DELETE FROM cpa_links WHERE account_id = ?').run(accountId);
  }

  getCredentials(id: string): AccountCredentials | null {
    const r = this.db.prepare('SELECT credentials FROM accounts WHERE id = ?').get(id) as any;
    const creds = this.vault.decrypt<AccountCredentials>(r?.credentials ?? null);
    // Transparent migration: re-encrypt records written with the legacy key
    if (creds && this.vault.isLegacy(r.credentials)) this.setCredentials(id, creds);
    return creds;
  }

  setCredentials(id: string, creds: AccountCredentials): void {
    this.db.prepare('UPDATE accounts SET credentials = ? WHERE id = ?').run(this.vault.encrypt(creds), id);
  }

  /** Stores a point only when the numbers changed or 30 min passed — keeps a year of history small. */
  addHistory(accountId: string, t: number, session: number | null, weekly: number | null): void {
    const last = this.db
      .prepare('SELECT t, session, weekly FROM history WHERE account_id = ? ORDER BY t DESC LIMIT 1')
      .get(accountId) as any;
    if (last && last.session === session && last.weekly === weekly && t - last.t < 30 * 60 * 1000) return;
    this.db.prepare('INSERT INTO history (account_id, t, session, weekly) VALUES (?, ?, ?, ?)').run(accountId, t, session, weekly);
  }

  history(sinceMs: number, accountId?: string): StatPoint[] {
    const rows = accountId
      ? this.db.prepare('SELECT account_id, t, session, weekly FROM history WHERE t >= ? AND account_id = ? ORDER BY t').all(sinceMs, accountId)
      : this.db.prepare('SELECT account_id, t, session, weekly FROM history WHERE t >= ? ORDER BY t').all(sinceMs);
    return (rows as any[]).map((r) => ({ accountId: r.account_id, t: r.t, session: r.session, weekly: r.weekly }));
  }

  pruneHistory(beforeMs: number): void {
    this.db.prepare('DELETE FROM history WHERE t < ?').run(beforeMs);
  }

  logAlert(accountId: string, kind: AlertKind, title: string, body: string): void {
    this.db
      .prepare('INSERT INTO alerts (account_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, kind, title, body, new Date().toISOString());
  }

  alerts(limit = 100): AlertLogEntry[] {
    return (this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({
      id: r.id,
      accountId: r.account_id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  clearAlerts(): void {
    this.db.prepare('DELETE FROM alerts').run();
  }

  alertState(accountId: string): { armed20: boolean; armed10: boolean; armed0: boolean } {
    const r = this.db.prepare('SELECT * FROM alert_state WHERE account_id = ?').get(accountId) as any;
    return r
      ? { armed20: !!r.armed20, armed10: !!r.armed10, armed0: !!r.armed0 }
      : { armed20: true, armed10: true, armed0: true };
  }

  setAlertState(accountId: string, s: { armed20: boolean; armed10: boolean; armed0: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO alert_state (account_id, armed20, armed10, armed0) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET armed20=excluded.armed20, armed10=excluded.armed10, armed0=excluded.armed0`
      )
      .run(accountId, s.armed20 ? 1 : 0, s.armed10 ? 1 : 0, s.armed0 ? 1 : 0);
  }

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getCpaRoutingConfig(): RoutingConfig {
    const raw = this.getSetting('cpa_routing');
    if (raw) {
      try {
        return validateRoutingConfig(JSON.parse(raw));
      } catch {
        // Fall back to default
      }
    }
    const envMode = process.env.CPA_ROUTING_MODE?.trim();
    if (envMode === 'off' || envMode === 'shadow' || envMode === 'enforce') {
      return { ...DEFAULT_ROUTING, mode: envMode };
    }
    return { ...DEFAULT_ROUTING };
  }

  setCpaRoutingConfig(cfg: RoutingConfig): void {
    const validated = validateRoutingConfig(cfg);
    this.setSetting('cpa_routing', JSON.stringify(validated));
  }

  updateCpaLinkRouting(accountId: string, routing: LinkRoutingState | null): void {
    const json = routing ? JSON.stringify(routing) : null;
    this.db
      .prepare('UPDATE cpa_links SET routing_json = ? WHERE account_id = ?')
      .run(json, accountId);
  }

  getCpaLinkRouting(accountId: string): LinkRoutingState | null {
    const link = this.getCpaLink(accountId);
    if (!link || !link.routingJson) return null;
    try {
      return JSON.parse(link.routingJson) as LinkRoutingState;
    } catch {
      return null;
    }
  }

  setCpaLinkManaged(accountId: string, managed: boolean): void {
    const routing = this.getCpaLinkRouting(accountId) || {};
    routing.managed = managed;
    this.updateCpaLinkRouting(accountId, routing);
  }

  getManualHold(accountId: string, now: number = Date.now()): CpaManualHoldRecord | null {
    const row = this.db
      .prepare('SELECT account_id, hold_type, reason, created_at, expires_at FROM cpa_manual_holds WHERE account_id = ?')
      .get(accountId) as { account_id: string; hold_type: string; reason: string | null; created_at: number; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at != null && row.expires_at <= now) {
      this.db.prepare('DELETE FROM cpa_manual_holds WHERE account_id = ?').run(accountId);
      return null;
    }
    return {
      accountId: row.account_id,
      holdType: row.hold_type as ManualHoldType,
      reason: row.reason || undefined,
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at != null ? Number(row.expires_at) : null,
    };
  }

  setManualHold(
    accountId: string,
    holdType: ManualHoldType,
    reason?: string,
    expiresAt?: number | null,
    now: number = Date.now()
  ): void {
    if (holdType === 'none') {
      this.db.prepare('DELETE FROM cpa_manual_holds WHERE account_id = ?').run(accountId);
      return;
    }
    const effectiveExpiresAt = expiresAt === undefined ? now + 24 * 3600 * 1000 : expiresAt;
    this.db
      .prepare(
        `INSERT INTO cpa_manual_holds (account_id, hold_type, reason, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           hold_type = excluded.hold_type,
           reason = excluded.reason,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`
      )
      .run(accountId, holdType, reason || null, now, effectiveExpiresAt ?? null);
  }

  deleteManualHold(accountId: string): void {
    this.db.prepare('DELETE FROM cpa_manual_holds WHERE account_id = ?').run(accountId);
  }

  listManualHolds(now: number = Date.now()): CpaManualHoldRecord[] {
    const rows = this.db
      .prepare('SELECT account_id, hold_type, reason, created_at, expires_at FROM cpa_manual_holds')
      .all() as Array<{ account_id: string; hold_type: string; reason: string | null; created_at: number; expires_at: number | null }>;
    const active: CpaManualHoldRecord[] = [];
    for (const r of rows) {
      if (r.expires_at != null && r.expires_at <= now) {
        this.db.prepare('DELETE FROM cpa_manual_holds WHERE account_id = ?').run(r.account_id);
      } else {
        active.push({
          accountId: r.account_id,
          holdType: r.hold_type as ManualHoldType,
          reason: r.reason || undefined,
          createdAt: Number(r.created_at),
          expiresAt: r.expires_at != null ? Number(r.expires_at) : null,
        });
      }
    }
    return active;
  }

  /** Flushes the write-ahead log into the database file (used on shutdown). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const res = fn();
      this.db.exec('COMMIT');
      return res;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}
