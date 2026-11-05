import type { AlertLogEntry, ProviderType } from '../../src/models/types';
import type { Forecast, StatPoint, UsageStats } from '../../src/services/stats';
import type { AccountEntity } from '../../src/models/types';
import type { TelemetryResponse } from '../../src/services/telemetryService';
import type { UsageReport } from '../../src/services/liteLlmUsage';
import type {
  WatermarkFleetOverview,
  WatermarkAccountState,
  ManualHoldType,
} from '../../server/src/cpaWatermarkTypes';

export type Account = AccountEntity;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  let data: any = null;
  try {
    data = await resp.json();
  } catch {}
  if (!resp.ok) {
    if (resp.status === 401) window.dispatchEvent(new Event('alt:unauthorized'));
    throw new ApiError(resp.status, data?.error || `HTTP ${resp.status}`);
  }
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  login: (password: string) => call<{ ok: true }>('/api/login', { method: 'POST', body: json({ password }) }),
  logout: () => call('/api/logout', { method: 'POST' }),
  state: () =>
    call<{ accounts: Account[]; lastSyncAllAt: string | null; intervalMin: number; telegram: boolean }>('/api/state'),
  refreshAll: () => call('/api/refresh', { method: 'POST' }),
  refresh: (id: string) => call<{ account: Account }>(`/api/accounts/${id}/refresh`, { method: 'POST' }),
  rename: (id: string, name: string) => call(`/api/accounts/${id}`, { method: 'PATCH', body: json({ name }) }),
  setActive: (id: string, isActive: boolean) => call(`/api/accounts/${id}`, { method: 'PATCH', body: json({ isActive }) }),
  remove: (id: string) => call(`/api/accounts/${id}`, { method: 'DELETE' }),
  reorder: (ids: string[]) => call('/api/accounts/reorder', { method: 'POST', body: json({ ids }) }),
  oauthStart: (provider: ProviderType, accountId?: string) =>
    call<{ authorizeUrl: string; state: string }>('/api/oauth/start', { method: 'POST', body: json({ provider, accountId }) }),
  oauthFinish: (state: string, input: string) =>
    call<{ ok: true; account: Account }>('/api/oauth/finish', { method: 'POST', body: json({ state, input }) }),
  manual: (provider: ProviderType, input: string, accountId?: string) =>
    call<{ ok: true; account: Account }>('/api/accounts/manual', { method: 'POST', body: json({ provider, input, accountId }) }),
  history: (days: number, accountId?: string) =>
    call<{ points: StatPoint[] }>(`/api/history?days=${days}${accountId ? `&accountId=${accountId}` : ''}`),
  stats: (days: number) =>
    call<{ stats: UsageStats; forecasts: Record<string, Forecast> }>(
      `/api/stats?days=${days}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
    ),
  alerts: () => call<{ alerts: AlertLogEntry[] }>('/api/alerts'),
  clearAlerts: () => call('/api/alerts', { method: 'DELETE' }),
  setInterval: (intervalMin: number) => call('/api/settings', { method: 'PUT', body: json({ intervalMin }) }),
  telemetry: () => call<TelemetryResponse>('/api/telemetry'),
  usage: (days: number) => call<UsageReport>(`/api/usage?days=${days}`),
  cpaStatus: () => call<{ enabled: boolean; lastDiscoveryAt: number | string | null; lastDiscoveryOk: boolean; routingMode?: string }>('/api/cpa/status'),
  telegramTest: () => call<{ ok: true }>('/api/telegram/test', { method: 'POST' }),
  cpaOverview: () => call<WatermarkFleetOverview>('/api/cpa/overview'),
  cpaHold: (req: { accountId: string; hold: ManualHoldType; reason?: string; ttlSeconds?: number; ttl?: number; actor?: string }) =>
    call<{
      ok: true;
      accountId: string;
      hold: ManualHoldType;
      reason?: string;
      actor?: string;
      ttlSeconds?: number;
      expiresAt?: number;
      effectiveState: WatermarkAccountState;
    }>('/api/cpa/hold', { method: 'POST', body: json(req) }),
};
