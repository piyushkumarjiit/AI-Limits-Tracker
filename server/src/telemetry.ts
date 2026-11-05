/**
 * Passive / Read-only Telemetry Service
 *
 * Ingests proxy session telemetry from LiteLLM and CLIProxy without ever triggering
 * native token refreshes or probes against upstream provider APIs directly.
 * Gracefully degrades to "Standby (Direct Mode)" when proxy is unconfigured or unavailable.
 */

import { isAllowedHttpHost } from './config';
import type { CpaUsageSummaryRow } from './store';
import { LiteLlmUsageService, type UsageReport } from '../../src/services/liteLlmUsage';

export interface AccountTelemetry {
  accountId: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  lastRoutedAt: string | null;
  /** Successful requests CLIProxy has routed through this credential since it started. */
  successCount?: number;
  failedCount?: number;
  /** Requests in the last hour (CLIProxy's recent 10-minute buckets). */
  requestsLastHour?: number;
  failedLastHour?: number;
  /** CLIProxy has this credential disabled (out of the routing pool). */
  disabled?: boolean;
  proxyStatus?: string | null;
  /** Token usage by model over the last 24 hours, from CLIProxy's usage feed. */
  models?: ModelUsage[];
  proxySource?: 'litellm' | 'cliproxy' | 'local_estimate';
  slotId?: string;
  proxyPort?: number;
}

export interface GlobalTelemetryStatus {
  connected: boolean;
  mode: 'connected' | 'standby';
  statusText: string;
  providers: {
    litellm: boolean;
    cliproxy: boolean;
  };
  lastCheckedAt: string;
  /** Why a source is not contributing data, in plain words. */
  notes?: string[];
}

/** Per-model usage over the last 24 hours, from CLIProxy's usage feed. */
export interface ModelUsage {
  model: string;
  requests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}


export interface TelemetryResponse {
  global: GlobalTelemetryStatus;
  accounts: Record<string, AccountTelemetry>;
  models?: ModelUsage[];
}

export interface TelemetryConfig {
  /** Reads 24h CLIProxy usage collected by CpaUsageCollector. */
  usageSummary?: (sinceMs: number) => CpaUsageSummaryRow[];
  liteLlmUrl?: string;
  liteLlmKey?: string;
  cliProxyPort?: number;
  cliProxyUrl?: string;
  cliProxyKey?: string;
}

/**
 * Validates a telemetry service base URL against SSRF threats.
 *
 * Rules:
 * 1. Must be a valid parseable absolute URL.
 * 2. Protocol must be strictly http: or https:.
 * 3. Credentials in the URL (username/password) are forbidden.
 * 4. Plain http: is restricted strictly to loopback and RFC1918 private network hosts.
 * 5. Link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10, 0.0.0.0/8) are blocked.
 */
export function validateTelemetryBaseUrl(rawUrl: string | undefined | null): URL | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // Strict protocol check: only http: and https: are allowed
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  // Reject credentials in URL
  if (parsed.username || parsed.password) {
    return null;
  }

  // Normalize hostname
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) {
    return null;
  }

  // Block link-local and cloud metadata addresses
  const ipv4Parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Parts) {
    const a = Number(ipv4Parts[1]);
    const b = Number(ipv4Parts[2]);
    if (a === 169 && b === 254) return null; // Link-local / AWS / GCP metadata
    if (a === 0) return null; // 0.0.0.0/8
  }
  if (host.startsWith('fe80:') || host === '::' || host === '0:0:0:0:0:0:0:0') {
    return null;
  }

  // Plain http: is strictly restricted to allowed loopback or RFC1918 private network hosts
  if (parsed.protocol === 'http:' && !isAllowedHttpHost(host)) {
    return null;
  }

  return parsed;
}

export class TelemetryService {
  private config: TelemetryConfig;
  private cache: TelemetryResponse | null = null;
  private cacheExpiresAt = 0;
  private readonly ttlMs: number;
  private liteLlm: LiteLlmUsageService;

  constructor(config: TelemetryConfig = {}, ttlMs = 60000) {
    this.config = {
      liteLlmUrl: config.liteLlmUrl || process.env.LITELLM_URL,
      liteLlmKey: config.liteLlmKey || process.env.LITELLM_KEY,
      cliProxyPort: config.cliProxyPort || Number(process.env.CLIPROXY_PORT) || 8317,
      cliProxyUrl: config.cliProxyUrl || process.env.CLIPROXY_URL || process.env.CPA_BASE_URL || 'http://127.0.0.1:8317',
      cliProxyKey: config.cliProxyKey || process.env.CLIPROXY_KEY || process.env.CPA_MANAGEMENT_KEY,
      usageSummary: config.usageSummary,
    };
    this.ttlMs = ttlMs;
    const liteBase = validateTelemetryBaseUrl(this.config.liteLlmUrl);
    this.liteLlm = new LiteLlmUsageService(
      async (path, timeoutMs) => (liteBase && this.config.liteLlmKey ? this.getJson(liteBase, path, this.config.liteLlmKey, timeoutMs) : null),
      (since) => (this.config.usageSummary ? this.config.usageSummary(since) : [])
    );
  }

  /** LiteLLM usage by alias, model and provider family over 1, 7 or 30 days. */
  usage(days: number, idByEmail: Map<string, string>): Promise<UsageReport> {
    return this.liteLlm.get(days, idByEmail);
  }

  /** GET a JSON document from a validated proxy base; returns the HTTP status and body (null on failure). */
  private async getJson(base: URL, path: string, key: string | undefined, timeoutMs = 5000): Promise<{ status: number; body: any }> {
    const target = new URL(path, base);
    if (
      !(target.protocol === 'http:' || target.protocol === 'https:') ||
      (target.protocol === 'http:' && !isAllowedHttpHost(target.hostname)) ||
      target.username ||
      target.password
    ) {
      return { status: 0, body: null };
    }
    try {
      const res = await fetch(target, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        redirect: 'error',
      });
      return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
    } catch {
      return { status: 0, body: null };
    }
  }

  /**
   * Passive, read-only fetch of proxy telemetry with TTL caching.
   * CLIProxy supplies per-credential request counts and per-model tokens; LiteLLM supplies alias usage.
   * NEVER triggers native token refreshes.
   */
  async getTelemetry(accounts: Array<string | { id: string; email?: string | null }> = []): Promise<TelemetryResponse> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }

    const notes: string[] = [];
    let liteLlmConnected = false;
    let cliProxyConnected = false;
    const accountTelemetryMap: Record<string, AccountTelemetry> = {};
    let models: ModelUsage[] | undefined;

    // FQD accounts are matched to CLIProxy credentials by email.
    const idByEmail = new Map<string, string>();
    for (const acc of accounts) {
      if (typeof acc !== 'string' && acc.email) idByEmail.set(acc.email.toLowerCase(), acc.id);
    }

    // 1. CLIProxy: per-credential request counters from the management API
    const cliProxyBase = validateTelemetryBaseUrl(this.config.cliProxyUrl);
    if (cliProxyBase) {
      const { status, body } = await this.getJson(cliProxyBase, '/v0/management/auth-files', this.config.cliProxyKey);
      if (status === 200 && body && Array.isArray(body.files)) {
        cliProxyConnected = true;
        for (const file of body.files) {
          const email = String(file.email || file.account || '').toLowerCase();
          const id = idByEmail.get(email);
          if (!id) continue;
          const recent: any[] = Array.isArray(file.recent_requests) ? file.recent_requests.slice(-6) : [];
          const success = Number(file.success) || 0;
          const failed = Number(file.failed) || 0;
          accountTelemetryMap[id] = {
            accountId: id,
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            requestCount: success + failed,
            successCount: success,
            failedCount: failed,
            requestsLastHour: recent.reduce((n, r) => n + (Number(r?.success) || 0) + (Number(r?.failed) || 0), 0),
            failedLastHour: recent.reduce((n, r) => n + (Number(r?.failed) || 0), 0),
            disabled: file.disabled === true,
            proxyStatus: typeof file.status === 'string' ? file.status : null,
            lastRoutedAt: null,
            proxySource: 'cliproxy',
          };
        }
      } else if (status === 401 || status === 403) {
        notes.push('CLIProxy rejected the management key (set CPA_MANAGEMENT_KEY).');
      } else {
        notes.push('CLIProxy management API is not reachable (set CPA_BASE_URL).');
      }
    }

    // 1b. CLIProxy usage feed: tokens per account and model over the last 24 hours
    const usage = this.config.usageSummary ? this.config.usageSummary(now - 86400000) : [];
    const cliProxyModels = new Map<string, ModelUsage>();
    for (const u of usage) {
      const add = (m: ModelUsage) => {
        m.requests += u.requests;
        m.promptTokens += u.inputTokens;
        m.completionTokens += u.outputTokens;
        m.totalTokens += u.totalTokens;
      };
      const fleet = cliProxyModels.get(u.model) ?? { model: u.model, requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
      add(fleet);
      cliProxyModels.set(u.model, fleet);
      const id = idByEmail.get(u.email.toLowerCase());
      const acc = id ? accountTelemetryMap[id] : undefined;
      if (!acc) continue;
      acc.totalTokens += u.totalTokens;
      acc.promptTokens += u.inputTokens;
      acc.completionTokens += u.outputTokens;
      const perModel = { model: u.model, requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
      add(perModel);
      (acc.models ??= []).push(perModel);
    }
    for (const acc of Object.values(accountTelemetryMap)) acc.models?.sort((x, y) => y.totalTokens - x.totalTokens);

    // 2. LiteLLM: daily aggregated usage by alias (see liteLlmUsage.ts)
    const liteReport = await this.usage(1, idByEmail);
    liteLlmConnected = liteReport.connected;
    notes.push(...liteReport.notes);

    if (!models?.length && cliProxyModels.size) {
      models = [...cliProxyModels.values()].sort((x, y) => y.totalTokens - x.totalTokens);
    }

    const connected = liteLlmConnected || cliProxyConnected;
    const mode = connected ? 'connected' : 'standby';
    let statusText = 'Telemetry: Standby (Direct Mode)';
    if (liteLlmConnected && cliProxyConnected) {
      statusText = 'Proxy Telemetry: LiteLLM & CLIProxy Connected';
    } else if (cliProxyConnected) {
      statusText = 'Proxy Telemetry: CLIProxy Connected';
    } else if (liteLlmConnected) {
      statusText = 'Proxy Telemetry: LiteLLM Connected';
    }

    const result: TelemetryResponse = {
      global: {
        connected,
        mode,
        statusText,
        providers: {
          litellm: liteLlmConnected,
          cliproxy: cliProxyConnected,
        },
        lastCheckedAt: new Date().toISOString(),
        notes,
      },
      accounts: accountTelemetryMap,
      models,
    };

    this.cache = result;
    this.cacheExpiresAt = now + this.ttlMs;

    return result;
  }
}
