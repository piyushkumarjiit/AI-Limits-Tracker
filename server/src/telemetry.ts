/**
 * Passive / Read-only Telemetry Service
 *
 * Ingests proxy session telemetry from LiteLLM and CLIProxy without ever triggering
 * native token refreshes or probes against upstream provider APIs directly.
 * Gracefully degrades to "Standby (Direct Mode)" when proxy is unconfigured or unavailable.
 */

import { isAllowedHttpHost } from './config';

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

/** Per-model usage over the last 24 hours, from LiteLLM spend logs. */
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
  /** A day of LiteLLM spend logs can be tens of MB, so the model table refreshes less often than the rest. */
  private modelsCache: { models: ModelUsage[]; expiresAt: number } | null = null;
  private static readonly MODELS_TTL_MS = 10 * 60 * 1000;

  constructor(config: TelemetryConfig = {}, ttlMs = 60000) {
    this.config = {
      liteLlmUrl: config.liteLlmUrl || process.env.LITELLM_URL,
      liteLlmKey: config.liteLlmKey || process.env.LITELLM_KEY,
      cliProxyPort: config.cliProxyPort || Number(process.env.CLIPROXY_PORT) || 8317,
      cliProxyUrl: config.cliProxyUrl || process.env.CLIPROXY_URL || process.env.CPA_BASE_URL || 'http://127.0.0.1:8317',
      cliProxyKey: config.cliProxyKey || process.env.CLIPROXY_KEY || process.env.CPA_MANAGEMENT_KEY,
    };
    this.ttlMs = ttlMs;
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
   * CLIProxy supplies per-credential request counts; LiteLLM spend logs supply per-model usage.
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

    // 2. LiteLLM: per-model usage over the last 24 hours from spend logs (needs an admin key)
    const liteLlmBase = validateTelemetryBaseUrl(this.config.liteLlmUrl);
    if (liteLlmBase && this.config.liteLlmKey && this.modelsCache && now < this.modelsCache.expiresAt) {
      liteLlmConnected = true;
      models = this.modelsCache.models;
    } else if (liteLlmBase && this.config.liteLlmKey) {
      const day = (t: number) => new Date(t).toISOString().slice(0, 10);
      const { status, body } = await this.getJson(
        liteLlmBase,
        `/spend/logs?summarize=false&start_date=${day(now - 86400000)}&end_date=${day(now + 86400000)}`,
        this.config.liteLlmKey,
        30000
      );
      if (status === 200 && Array.isArray(body)) {
        liteLlmConnected = true;
        const byModel = new Map<string, ModelUsage>();
        for (const log of body.slice(0, 50000)) {
          if (!log || typeof log.model !== 'string' || !log.model) continue;
          const startedAt = Date.parse(log.startTime ?? log.start_time ?? '');
          if (Number.isFinite(startedAt) && startedAt < now - 86400000) continue;
          const m = byModel.get(log.model) ?? { model: log.model, requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
          m.requests += 1;
          m.totalTokens += Number(log.total_tokens) || 0;
          m.promptTokens += Number(log.prompt_tokens) || 0;
          m.completionTokens += Number(log.completion_tokens) || 0;
          byModel.set(log.model, m);
        }
        models = [...byModel.values()].sort((x, y) => y.totalTokens - x.totalTokens);
        this.modelsCache = { models, expiresAt: now + TelemetryService.MODELS_TTL_MS };
      } else if (status === 401 || status === 403) {
        notes.push('LiteLLM key cannot read spend logs; per-model usage needs an admin (master) key in LITELLM_KEY.');
      } else if (status === 200) {
        notes.push('LiteLLM spend logs returned an unrecognized format.');
      } else {
        notes.push('LiteLLM did not answer in time or is not reachable (check LITELLM_URL).');
      }
    } else {
      notes.push('Per-model usage needs LiteLLM (set LITELLM_URL and an admin LITELLM_KEY).');
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
