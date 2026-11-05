/**
 * Client Telemetry Service
 *
 * Interfaces with GET /api/telemetry or provides passive estimates.
 * Utilities for SI prefix formatting (780k, 1.24M).
 */

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

/** Formats token numbers cleanly with SI suffixes (e.g. 780k, 1.24M). */
export function formatTokenCount(num: number | null | undefined): string {
  if (num === null || num === undefined || isNaN(num)) return '0';
  if (num < 1000) return String(Math.round(num));
  if (num < 1_000_000) {
    const k = num / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = num / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(2).replace(/\.00$/, '').replace(/(\.[0-9])0$/, '$1')}M`;
}

/** Default fallback telemetry state when proxy is in Standby mode. */
export const DEFAULT_TELEMETRY_RESPONSE: TelemetryResponse = {
  global: {
    connected: false,
    mode: 'standby',
    statusText: 'Telemetry: Standby (Direct Mode)',
    providers: {
      litellm: false,
      cliproxy: false,
    },
    lastCheckedAt: new Date().toISOString(),
  },
  accounts: {},
};
