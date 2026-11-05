import React from 'react';
import type { ProviderType, QuotaBucket } from '../../../../src/models/types';
import type { WatermarkAccountView, WatermarkFleetOverview } from '../../../../server/src/cpaWatermarkTypes';
import type { TelemetryResponse } from '../../../../src/services/telemetryService';
import { DEFAULT_STATUS_LEVELS, levelsForTier, type StatusLevels, type TieredStatusLevels } from '../../../../src/constants/statusLevels';
import { LAB_BRAND_PALETTES, PROVIDER_NAMES } from '../../../../src/constants/theme';
import { accountFamily } from '../../../../src/services/liteLlmUsage';
import { href, setParams } from '../../route';
import type { Account } from '../../api';
import { accountStatus, quotaWindows, ACCOUNT_STATUS_LABEL, type AccountStatus } from './cpaUiUtils';

/* ---------------- data shared by every page ---------------- */

export interface PanelData {
  accounts: Account[];
  overview: WatermarkFleetOverview | null;
  telemetry: TelemetryResponse | null;
  levels: TieredStatusLevels;
  gateways: { cliproxyUrl: string | null; litellmUrl: string | null };
  intervalMin: number;
  telegram: boolean;
}

export function viewOf(data: PanelData, accountId: string): WatermarkAccountView | null {
  return data.overview?.accounts.find((v) => v.accountId === accountId) ?? null;
}

export function statusOf(data: PanelData, a: Account): AccountStatus {
  return accountStatus(a, viewOf(data, a.id), data.levels);
}

/** Levels that apply to one account (its policy tier; Pro when unknown). */
export function levelsOf(data: PanelData, a: Account): StatusLevels {
  return levelsForTier(data.levels, viewOf(data, a.id)?.tier);
}

/** Slot number shown next to accounts: their position in the account list. */
export function slotOf(data: PanelData, a: Account): string {
  return String(data.accounts.findIndex((x) => x.id === a.id) + 1).padStart(2, '0');
}

export const familyOf = (a: Account): string => accountFamily(a.providerType);
export const providerName = (p: ProviderType | string): string => PROVIDER_NAMES[p as ProviderType] ?? String(p);
/** Brand colour for a provider; near-black brands (e.g. Cursor) use a neutral grey so they stay visible on the dark theme. */
export const providerColor = (p: ProviderType | string): string => {
  const hex = LAB_BRAND_PALETTES[p as ProviderType]?.primary;
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 'var(--muted)';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r + g + b < 150 ? 'var(--muted)' : hex;
};

/** The window that decides status, and its reset time. */
export function bindingOf(a: Account): { label: string; remaining: number; resetsAt: string | null } | null {
  const b = quotaWindows(a).binding;
  return b ? { label: b.bucket.label, remaining: Math.round(b.remaining), resetsAt: b.bucket.resetsAt } : null;
}

/** One plain sentence explaining an account's status. */
export function reasonOf(data: PanelData, a: Account): string {
  const st = statusOf(data, a);
  const b = bindingOf(a);
  const lv = levelsOf(data, a);
  const back = b?.resetsAt ? ` Resets in ${untilText(b.resetsAt)}.` : '';
  if (st === 'cooldown') {
    const hold = viewOf(data, a.id)?.manualHold;
    return hold && hold !== 'none'
      ? 'Taken out of rotation by an admin. Not receiving traffic.'
      : 'Taken out of rotation by the routing policy. Not receiving traffic.';
  }
  if (a.latestSnapshot?.status === 'rate_limited') return `The provider is rate-limiting this account, so callers may get 429 errors.${back}`;
  if (!b) return 'The provider has not reported any quota for this account yet.';
  if (st === 'exhausted') return `${b.label} at ${b.remaining}%, at or below the policy hard stop (${lv.exhaustedPct}%). Callers routed here may get 429 errors.${back}`;
  if (st === 'tight') return `${b.label} at ${b.remaining}%, at or below the policy drain level (${lv.tightPct}%).${back}`;
  return `Lowest quota: ${b.label} at ${b.remaining}%.`;
}

/* ---------------- formatting ---------------- */

export function untilText(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const sec = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (isNaN(sec)) return 'unknown';
  if (sec <= 0) return 'now';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const fmtNum = (n: number): string => Math.round(n).toLocaleString();
export const fmtCompact = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
export const fmtSpend = (n: number): string => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ---------------- small components ---------------- */

export const STATUS_COLOR: Record<AccountStatus, string> = {
  healthy: 'var(--ok)',
  tight: 'var(--warn)',
  exhausted: 'var(--bad)',
  cooldown: 'var(--cool)',
};

export const Badge: React.FC<{ status: AccountStatus }> = ({ status }) => (
  <span className={`badge b-${status}`}>{ACCOUNT_STATUS_LABEL[status]}</span>
);

export const Dot: React.FC<{ color: string }> = ({ color }) => <span className="dot" style={{ background: color }} />;

/** Colour of a remaining percentage against the policy levels. */
export function levelColor(v: number | null | undefined, levels: StatusLevels = DEFAULT_STATUS_LEVELS.pro): string {
  if (v === null || v === undefined) return 'var(--muted)';
  return v <= levels.exhaustedPct ? 'var(--bad)' : v <= levels.tightPct ? 'var(--warn)' : 'var(--ok)';
}

export const Meter: React.FC<{ value: number | null | undefined; levels?: StatusLevels }> = ({ value, levels }) => {
  if (value === null || value === undefined) return <span className="muted small">not reported</span>;
  const v = Math.round(value);
  const color = levelColor(v, levels);
  return (
    <div className="meter">
      <div className="track">
        <div className="fill" style={{ width: `${Math.max(v, 2)}%`, background: color }} />
      </div>
      <span className="v" style={{ color }}>{v}%</span>
    </div>
  );
};

/** One labelled bar for a quota window as the provider reports it. */
export const BucketBar: React.FC<{ bucket: QuotaBucket; levels: StatusLevels }> = ({ bucket, levels }) => (
  <div style={{ marginBottom: 10 }}>
    <div className="mlabel">
      <span>{bucket.label}</span>
      <span>{bucket.resetsAt ? `resets in ${untilText(bucket.resetsAt)}` : ''}</span>
    </div>
    <Meter value={bucket.remainingPercent} levels={levels} />
  </div>
);

/** Shows how the user got to a filtered view, with each filter removable. */
export const ContextBar: React.FC<{ from: string | null; chips: Array<[string, string]>; clearKeys: string[] }> = ({ from, chips, clearKeys }) => {
  if (!from && chips.length === 0) return null;
  return (
    <div className="context">
      {from && (
        <>
          <a className="link" href={href(from)}>Back to Overview</a>
          <span className="muted">·</span>
        </>
      )}
      <span className="muted">{chips.length ? 'Showing' : 'All results'}</span>
      {chips.map(([key, label]) => (
        <span className="chip" key={key}>
          {label}
          <button className="chip-x" aria-label={`Remove filter ${label}`} onClick={() => setParams(key === 'sort' ? { sort: null, dir: null } : { [key]: null })}>
            remove
          </button>
        </span>
      ))}
      {chips.length > 0 && (
        <button className="link" onClick={() => setParams(Object.fromEntries(clearKeys.map((k) => [k, null])))}>
          Clear filters
        </button>
      )}
    </div>
  );
};

/* ---------------- line icons ---------------- */

const svg = (path: React.ReactNode, size = 14) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

export const CloseIcon = () => svg(<path d="M6 6l12 12M18 6L6 18" />);
export const PencilIcon = () => svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
export const NAV_ICONS: Record<string, React.ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  accounts: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  usage: <><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
};
export const NavIcon: React.FC<{ name: string }> = ({ name }) => svg(NAV_ICONS[name], 20);
