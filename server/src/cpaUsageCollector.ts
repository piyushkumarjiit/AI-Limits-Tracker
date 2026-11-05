import type { CpaTransport } from '../../src/services/cpa/CpaTransport';
import type { CpaUsageRow, Store } from './store';

/** CLIProxy keeps usage records for ~60s, so poll well inside that window. */
const DEFAULT_POLL_MS = 20_000;
const KEEP_MS = 30 * 86_400_000;

/** Converts one CLIProxy v8 usage-queue record; null when it lacks an id, account or model. */
export function toUsageRow(r: any): CpaUsageRow | null {
  const requestId = r?.request_id || r?.execution_id;
  const email = r?.source;
  const model = r?.model || r?.alias;
  if (typeof requestId !== 'string' || typeof email !== 'string' || typeof model !== 'string' || !requestId || !email || !model) {
    return null;
  }
  const ts = Date.parse(r.timestamp);
  return {
    requestId,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    email: email.toLowerCase(),
    model,
    inputTokens: Number(r.tokens?.input_tokens) || 0,
    outputTokens: Number(r.tokens?.output_tokens) || 0,
    totalTokens: Number(r.tokens?.total_tokens) || 0,
    failed: r.failed === true,
  };
}

/** Polls CLIProxy's short-lived usage queue and keeps each record once in the store. */
export class CpaUsageCollector {
  private timer: NodeJS.Timeout | null = null;
  private lastPrune = 0;
  private warned = false;

  constructor(
    private readonly store: Store,
    private readonly transport: CpaTransport,
    private readonly pollMs = Number(process.env.CPA_USAGE_POLL_SEC) * 1000 || DEFAULT_POLL_MS
  ) {}

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<number> {
    try {
      const rows = (await this.transport.getUsageQueue()).map(toUsageRow).filter((r): r is CpaUsageRow => r !== null);
      const added = rows.length ? this.store.addCpaUsage(rows) : 0;
      if (Date.now() - this.lastPrune > 3_600_000) {
        this.store.pruneCpaUsage(Date.now() - KEEP_MS);
        this.lastPrune = Date.now();
      }
      this.warned = false;
      return added;
    } catch (e) {
      // Older CLIProxy builds have no v8 usage queue, or usage statistics are switched off.
      if (!this.warned) console.warn('[cpa-usage] usage queue unavailable:', e instanceof Error ? e.message : e);
      this.warned = true;
      return 0;
    }
  }
}
