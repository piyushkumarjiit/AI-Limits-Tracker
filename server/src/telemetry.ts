/**
 * Passive / Read-only Telemetry Service
 *
 * Ingests proxy session telemetry from LiteLLM and CLIProxy without ever triggering
 * native token refreshes or probes against upstream provider APIs directly.
 * Gracefully degrades to "Standby (Direct Mode)" when proxy is unconfigured or unavailable.
 */

export interface AccountTelemetry {
  accountId: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  lastRoutedAt: string | null;
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
}

export interface TelemetryResponse {
  global: GlobalTelemetryStatus;
  accounts: Record<string, AccountTelemetry>;
}

export interface TelemetryConfig {
  liteLlmUrl?: string;
  liteLlmKey?: string;
  cliProxyPort?: number;
  cliProxyUrl?: string;
}

export class TelemetryService {
  private config: TelemetryConfig;
  private cache: TelemetryResponse | null = null;
  private cacheExpiresAt = 0;
  private readonly ttlMs: number;

  constructor(config: TelemetryConfig = {}, ttlMs = 60000) {
    this.config = {
      liteLlmUrl: config.liteLlmUrl || process.env.LITELLM_URL,
      liteLlmKey: config.liteLlmKey || process.env.LITELLM_KEY,
      cliProxyPort: config.cliProxyPort || Number(process.env.CLIPROXY_PORT) || 8317,
      cliProxyUrl: config.cliProxyUrl || process.env.CLIPROXY_URL || 'http://127.0.0.1:8317',
    };
    this.ttlMs = ttlMs;
  }

  /**
   * Passive fetch of telemetry with TTL caching and graceful fallback.
   * NEVER triggers native token refreshes.
   */
  async getTelemetry(accountIds: string[] = []): Promise<TelemetryResponse> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }

    let liteLlmConnected = false;
    let cliProxyConnected = false;
    const accountTelemetryMap: Record<string, AccountTelemetry> = {};

    // 1. Check CLIProxy telemetry passively (non-blocking, timeout 2s)
    if (this.config.cliProxyUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${this.config.cliProxyUrl}/v1/management/api_call`, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'Accept': 'application/json' },
        }).catch(() => null);
        clearTimeout(timeout);

        if (res && res.ok) {
          cliProxyConnected = true;
          const data: any = await res.json().catch(() => null);
          if (data && Array.isArray(data.sessions)) {
            for (const s of data.sessions) {
              const id = s.account_id || s.credential_name || s.auth_index;
              if (id) {
                accountTelemetryMap[id] = {
                  accountId: id,
                  totalTokens: Number(s.total_tokens) || (Number(s.prompt_tokens) || 0) + (Number(s.completion_tokens) || 0),
                  promptTokens: Number(s.prompt_tokens) || 0,
                  completionTokens: Number(s.completion_tokens) || 0,
                  requestCount: Number(s.request_count) || 1,
                  lastRoutedAt: s.last_routed_at || new Date().toISOString(),
                  proxySource: 'cliproxy',
                  slotId: s.slot_id || `${s.provider || 'proxy'}_slot_01`,
                  proxyPort: this.config.cliProxyPort,
                };
              }
            }
          }
        }
      } catch {
        // Passive fallback - ignore network/proxy errors
      }
    }

    // 2. Check LiteLLM telemetry passively if configured
    if (this.config.liteLlmUrl && this.config.liteLlmKey) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${this.config.liteLlmUrl}/spend/calculate`, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${this.config.liteLlmKey}`,
            'Accept': 'application/json',
          },
        }).catch(() => null);
        clearTimeout(timeout);

        if (res && res.ok) {
          liteLlmConnected = true;
          const data: any = await res.json().catch(() => null);
          if (data && typeof data === 'object') {
            for (const key of Object.keys(data)) {
              const val = data[key];
              if (val && typeof val === 'object') {
                const existing = accountTelemetryMap[key];
                accountTelemetryMap[key] = {
                  accountId: key,
                  totalTokens: (existing?.totalTokens || 0) + (Number(val.total_tokens) || 0),
                  promptTokens: (existing?.promptTokens || 0) + (Number(val.prompt_tokens) || 0),
                  completionTokens: (existing?.completionTokens || 0) + (Number(val.completion_tokens) || 0),
                  requestCount: (existing?.requestCount || 0) + (Number(val.request_count) || 0),
                  lastRoutedAt: val.last_routed_at || existing?.lastRoutedAt || new Date().toISOString(),
                  proxySource: 'litellm',
                  slotId: existing?.slotId || `litellm_slot_${key}`,
                  proxyPort: existing?.proxyPort,
                };
              }
            }
          }
        }
      } catch {
        // Fallback silently without throwing
      }
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
      },
      accounts: accountTelemetryMap,
    };

    this.cache = result;
    this.cacheExpiresAt = now + this.ttlMs;

    return result;
  }
}
