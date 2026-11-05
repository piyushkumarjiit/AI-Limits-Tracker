import {
  ColumnPicker,
  FleetHeadroom,
  ActiveAttention,
  TelemetryVelocity,
  QuotaRadar,
  GatewaysSettings,
  AccountDrawer,
  CpaDangerAlert,
  accountStatus,
  quotaWindows,
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_STATUS_BADGE,
  type AccountStatus,
} from './components';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlertLogEntry, ProviderType, QuotaBucket } from '../../src/models/types';
import type { Forecast, StatPoint, UsageStats } from '../../src/services/stats';
import type {
  WatermarkFleetOverview,
  ManualHoldType,
} from '../../server/src/cpaWatermarkTypes';

type HoldRequest = { accountId: string; hold: ManualHoldType; reason?: string };
import { bindingBucket, headlineBucket } from '../../src/services/providers/common';
import { accountChartColor, Colors, PROVIDER_COMPANY, PROVIDER_NAMES, severityColor, severityOf } from '../../src/constants/theme';
import { dualRingData, familySummaries, type Weighting } from '../../src/services/capacity';
import { formatTimeRemaining, formatResetCountdown, greeting, MONTHS_SHORT } from '../../src/utils/formatters';
import { Account, api, ApiError } from './api';
import { isInsecurePage } from './session';
import {
  BarChart,
  Donut,
  DualRing,
  FamilyCard,
  Icon,
  LineChart,
  Logo,
  MiniBars,
  Ring,
  Segmented,
  StatusDot,
  WebAccountDrawer,
  WebProviderStackedBar,
} from './ui';
import type { TelemetryResponse } from '../../src/services/telemetryService';
import { formatTokenCount } from '../../src/services/telemetryService';

/* ---------------- Helpers ---------------- */

function useRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => {
      setRoute(location.hash.slice(1) || '/');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (to) => (location.hash = to)];
}

function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function clock(t: number | string): string {
  const d = new Date(t);
  return d.toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function getSlotLabel(_acc: Account, fallbackIdx: number): string {
  return String(fallbackIdx + 1).padStart(2, '0');
}

function pct(w: { remaining: number } | null): string {
  return w ? `${Math.round(w.remaining)}%` : '-';
}

const STATUS_BADGE = ACCOUNT_STATUS_BADGE;

interface AppState {
  accounts: Account[];
  lastSyncAllAt?: number;
  intervalMin?: number;
  telegram?: boolean;
}

/* ---------------- Root App ---------------- */

/** Header badge summarising the fleet with the same four states the Accounts page uses. */
function fleetStatusBadge(accounts: Account[], overview: WatermarkFleetOverview | null): { className: string; text: string } {
  if (accounts.length === 0) return { className: 'badge-warn', text: 'No accounts yet' };
  const statuses = accounts.map((a) => accountStatus(a, overview?.accounts.find((v) => v.accountId === a.id) || null));
  const exhausted = statuses.filter((st) => st === 'exhausted').length;
  const attention = statuses.filter((st) => st === 'cooldown' || st === 'tight').length;
  if (exhausted > 0) return { className: 'badge-bad', text: `${exhausted} ${ACCOUNT_STATUS_LABEL.exhausted}` };
  if (attention > 0) return { className: 'badge-warn', text: `${attention} Need Attention` };
  return { className: 'badge-ok', text: 'All Accounts Healthy' };
}

export function App() {
  const [route, go] = useRoute();
  const [state, setState] = useState<AppState | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [cpaOverview, setCpaOverview] = useState<WatermarkFleetOverview | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  useTick(60000);

  const loadCpa = useCallback(async () => {
    try {
      const ov = await api.cpaOverview();
      setCpaOverview(ov);
    } catch {}
    try {
      setTelemetry(await api.telemetry());
    } catch {}
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.state();
      setState({
        accounts: res.accounts,
        lastSyncAllAt: res.lastSyncAllAt ? new Date(res.lastSyncAllAt).getTime() : undefined,
        intervalMin: res.intervalMin,
        telegram: res.telegram,
      });
      setAuthed(true);
      await loadCpa();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthed(false);
      } else {
        console.error(e);
      }
    }
  }, [loadCpa]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshAll = async () => {
    setSyncing(true);
    try {
      await api.refreshAll();
      await load();
      await loadCpa();
    } finally {
      setSyncing(false);
    }
  };

  const handleApplyHold = async (req: HoldRequest) => {
    await api.cpaHold(req);
    await loadCpa();
    await load();
  };

  if (authed === null) return <div className="splash"><div className="spinner" /></div>;
  if (!authed) return <Login onDone={load} />;
  if (!state) return null;

  const [path, param] = route.split('/').filter(Boolean);
  const accounts = state.accounts;
  const fleetBadge = fleetStatusBadge(accounts, cpaOverview);
  let page: React.ReactNode;
  switch (path) {
    case 'account': {
      const acc = accounts.find((a) => a.id === param);
      page = acc ? <AccountPage account={acc} reload={load} go={go} /> : <Empty title="Account not found" />;
      break;
    }
    case 'stats':
      page = <TelemetryVelocity accounts={accounts} telemetry={telemetry} />;
      break;
    case 'accounts':
      page = (
        <AccountsPage
          accounts={accounts}
          go={go}
          reload={load}
          syncing={syncing}
          onRefresh={refreshAll}
          overview={cpaOverview}
          telemetry={telemetry}
          onApplyHold={handleApplyHold}
        />
      );
      break;
    case 'add':
      page = <AddPage accounts={accounts} go={go} reload={load} reconnectId={param} />;
      break;
    case 'alerts':
      page = <QuotaRadar accounts={accounts} overview={cpaOverview} />;
      break;
    case 'settings':
      page = <GatewaysSettings state={state} reload={load} />;
      break;
    default:
      page = (
        <HomePage
          state={state}
          go={go}
          syncing={syncing}
          onRefresh={refreshAll}
          overview={cpaOverview}
          telemetry={telemetry}
          onApplyHold={handleApplyHold}
        />
      );
  }

  const tab = !path ? 'home' : path === 'account' ? 'home' : path;

  return (
    <div className="deck-wrapper">
      <div className="deck-content">
        <InsecureBanner />

        {/* Top Cockpit Header */}
        <header className="review-header">
          <div>
            <div className="brand-title">
              <span style={{ color: '#38bdf8' }}>FQD</span>
              <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginLeft: 8 }}>
                Fleet Quota Display
              </span>
            </div>
            <p className="tagline">Quota monitoring and routing control for CLIProxy and LiteLLM account fleets.</p>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className={`filter-btn ${syncing ? 'spin' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }} onClick={refreshAll} aria-label="Refresh">{syncing ? 'Refreshing…' : 'Refresh'}</button>
            <span className={`badge ${fleetBadge.className}`}>{fleetBadge.text}</span>
          </div>
        </header>

        {/* Desktop Navigation Tabs */}
        <nav className="tab-bar">
          <button className={`tab-btn ${tab === 'home' ? 'active' : ''}`} onClick={() => go('/')}>
            Overview
          </button>
          <button className={`tab-btn ${tab === 'accounts' ? 'active' : ''}`} onClick={() => go('/accounts')}>
            Accounts
          </button>
          <button className={`tab-btn ${tab === 'stats' ? 'active' : ''}`} onClick={() => go('/stats')}>
            Telemetry
          </button>
          <button className={`tab-btn ${tab === 'alerts' ? 'active' : ''}`} onClick={() => go('/alerts')}>
            Quota Radar
          </button>
          <button className={`tab-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => go('/settings')}>
            Gateways &amp; Settings
          </button>
        </nav>

        {page}

        {/* Footer */}
        <footer className="app-footer">
          <span>FQD · Fleet Quota Display</span>
          <span>•</span>
          <a href="https://github.com/piyushkumarjiit/FQD" target="_blank" rel="noreferrer">GitHub</a>
          <span>•</span>
          <a href="https://github.com/piyushkumarjiit/FQD#readme" target="_blank" rel="noreferrer">Documentation</a>
          <span>•</span>
          <span>MIT License</span>
        </footer>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="mobile-bottom-nav" id="pwa-bottom-bar">
        <div className={`mob-nav-item ${tab === 'home' ? 'active' : ''}`} onClick={() => go('/')}>
          <svg className="mob-nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <rect width="7" height="9" x="3" y="3" rx="1.5"/>
            <rect width="7" height="5" x="14" y="3" rx="1.5"/>
            <rect width="7" height="9" x="14" y="12" rx="1.5"/>
            <rect width="7" height="5" x="3" y="16" rx="1.5"/>
          </svg>
          <span className="mob-nav-label">Overview</span>
        </div>
        <div className={`mob-nav-item ${tab === 'accounts' ? 'active' : ''}`} onClick={() => go('/accounts')}>
          <svg className="mob-nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span className="mob-nav-label">Accounts</span>
        </div>
        <div className={`mob-nav-item ${tab === 'stats' ? 'active' : ''}`} onClick={() => go('/stats')}>
          <svg className="mob-nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <span className="mob-nav-label">Telemetry</span>
        </div>
        <div className={`mob-nav-item ${tab === 'alerts' ? 'active' : ''}`} onClick={() => go('/alerts')}>
          <svg className="mob-nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9"/>
            <circle cx="12" cy="12" r="4"/>
            <line x1="12" y1="3" x2="12" y2="12"/>
            <line x1="12" y1="12" x2="19" y2="7"/>
          </svg>
          <span className="mob-nav-label">Radar</span>
        </div>
        <div className={`mob-nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => go('/settings')}>
          <svg className="mob-nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="21" x2="4" y2="14"/>
            <line x1="4" y1="10" x2="4" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12" y2="3"/>
            <line x1="20" y1="21" x2="20" y2="16"/>
            <line x1="20" y1="12" x2="20" y2="3"/>
            <line x1="1" y1="14" x2="7" y2="14"/>
            <line x1="9" y1="8" x2="15" y2="8"/>
            <line x1="17" y1="16" x2="23" y2="16"/>
          </svg>
          <span className="mob-nav-label">Settings</span>
        </div>
      </nav>
    </div>
  );
}

const Empty: React.FC<{ title: string; text?: string; children?: React.ReactNode }> = ({ title, text, children }) => (
  <div className="card empty">
    <h3>{title}</h3>
    {text && <p className="muted small">{text}</p>}
    {children}
  </div>
);

const Header: React.FC<{ title: string; sub?: string; back?: boolean; right?: React.ReactNode }> = ({ title, sub, back, right }) => (
  <header className="page-header">
    <div>
      {back && (
        <a href="#/" className="back-link">
          ← Back
        </a>
      )}
      <h2>{title}</h2>
      {sub && <p className="muted small">{sub}</p>}
    </div>
    {right}
  </header>
);

const InsecureBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !isInsecurePage()) return null;
  return (
    <div className="banner warn">
      <span>FQD session cookies require HTTPS. Over plain HTTP, sign-in persists until the tab closes.</span>
      <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
};

const Login: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.login(pass);
      onDone();
    } catch (e: any) {
      setErr(e.message || 'Invalid password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-box">
      <div className="card">
        <h2>Fleet Quota Display</h2>
        <p className="muted small">Enter master key or master password</p>
        <form onSubmit={submit}>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Master password"
            autoFocus
          />
          {err && <div className="banner danger">{err}</div>}
          <button type="submit" className="btn full" disabled={busy || !pass}>
            {busy ? 'Authenticating…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
};

/* ---------------- TAB 1: FLEET COMMAND (Overview) ---------------- */

const HomePage: React.FC<{
  state: AppState;
  go: (to: string) => void;
  syncing: boolean;
  onRefresh: () => void;
  overview: WatermarkFleetOverview | null;
  telemetry: TelemetryResponse | null;
  onApplyHold: (req: HoldRequest) => Promise<void>;
}> = ({
  state,
  go,
  overview,
  telemetry,
  onApplyHold,
}) => {
  const { accounts } = state;
  const [drawerAccount, setDrawerAccount] = useState<Account | null>(null);

  const effectiveAccounts = accounts;
  const agyAccounts = effectiveAccounts.filter((a) => a.providerType === 'antigravity');
  const claudeAccounts = effectiveAccounts.filter((a) => a.providerType === 'claude');

  const defaultHoverAccount = effectiveAccounts[0];
  const [hoverAccount, setHoverAccount] = useState<Account | null>(defaultHoverAccount || null);

  useEffect(() => {
    if (!hoverAccount && effectiveAccounts.length > 0) {
      setHoverAccount(defaultHoverAccount);
    }
  }, [effectiveAccounts, hoverAccount, defaultHoverAccount]);

  const avg = (vals: number[]) => (vals.length ? String(Math.round(vals.reduce((x, y) => x + y, 0) / vals.length)) : '-');
  const avgWindow = (list: Account[], key: 'fiveHour' | 'weekly') =>
    avg(list.map((a) => quotaWindows(a)[key]?.remaining).filter((v): v is number => typeof v === 'number'));
  const bindingAvg = (list: Account[]) =>
    avg(list.map((a) => quotaWindows(a).binding?.remaining).filter((v): v is number => typeof v === 'number'));
  const agyHeadroom = bindingAvg(agyAccounts);
  const claudeHeadroom = bindingAvg(claudeAccounts);
  const fiveHourHeadroom = avgWindow(effectiveAccounts, 'fiveHour');
  const weeklyHeadroom = avgWindow(effectiveAccounts, 'weekly');
  const viewOf = (a: Account) => overview?.accounts.find((av) => av.accountId === a.id) || null;
  const countOf = (st: AccountStatus) => effectiveAccounts.filter((a) => accountStatus(a, viewOf(a)) === st).length;
  const headroomColor = (v: string) => (v === '-' ? 'var(--muted)' : Number(v) < 20 ? 'var(--bad)' : Number(v) <= 35 ? 'var(--warn)' : 'var(--ok)');

  return (
    <div id="tab-home" className="view-panel active">
      <CpaDangerAlert overview={overview} accounts={effectiveAccounts} />

      {/* 4 KPI Metric Stat Boxes */}
      <div className="grid-4">
        <div className="card stat-box">
          <span className="stat-sub">Fleet Accounts</span>
          <span className="stat-val" style={{ color: 'var(--blue)' }}>{effectiveAccounts.length} {effectiveAccounts.length === 1 ? 'Account' : 'Accounts'}</span>
          <span className="stat-sub">{agyAccounts.length} Antigravity · {claudeAccounts.length} Claude Code</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">5-Hour Headroom</span>
          <span className="stat-val" style={{ color: headroomColor(fiveHourHeadroom) }}>{fiveHourHeadroom === '-' ? '-' : `${fiveHourHeadroom}%`}</span>
          <span className="stat-sub">Fleet average</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Weekly Headroom</span>
          <span className="stat-val" style={{ color: headroomColor(weeklyHeadroom) }}>{weeklyHeadroom === '-' ? '-' : `${weeklyHeadroom}%`}</span>
          <span className="stat-sub">Fleet average</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Needs Attention</span>
          <span className="stat-val" style={{ color: countOf('exhausted') ? 'var(--bad)' : 'var(--ok)' }}>
            {countOf('exhausted')} {ACCOUNT_STATUS_LABEL.exhausted}
          </span>
          <span className="stat-sub">{countOf('cooldown')} in {ACCOUNT_STATUS_LABEL.cooldown} · {countOf('tight')} {ACCOUNT_STATUS_LABEL.tight}</span>
        </div>
      </div>

      <FleetHeadroom
        agyAccounts={agyAccounts}
        claudeAccounts={claudeAccounts}
        effectiveAccounts={effectiveAccounts}
        hoverAccount={hoverAccount}
        setHoverAccount={setHoverAccount}
        onSelectAccount={(acc) => setDrawerAccount(acc)}
        agyHeadroom={agyHeadroom}
        claudeHeadroom={claudeHeadroom}
      />

      <ActiveAttention
        accounts={effectiveAccounts}
        overview={overview}
        onSelectAccount={(acc) => setDrawerAccount(acc)}
      />

      {drawerAccount && (
        <AccountDrawer
          account={drawerAccount}
          accountView={overview?.accounts.find((av) => av.accountId === drawerAccount.id) || null}
          onApplyHold={onApplyHold}
          telemetry={telemetry?.accounts[drawerAccount.id] ?? null}
          telemetryNotes={telemetry?.global.notes}
          onClose={() => setDrawerAccount(null)}
          onViewFleet={() => {
            setDrawerAccount(null);
            go('/accounts');
          }}
        />
      )}
    </div>
  );
};

/* ---------------- TAB 2: FLEET INVENTORY (Accounts) ---------------- */

const AccountsPage: React.FC<{
  accounts: Account[];
  go: (to: string) => void;
  reload: () => Promise<void>;
  syncing: boolean;
  onRefresh: () => void;
  overview: WatermarkFleetOverview | null;
  telemetry: TelemetryResponse | null;
  onApplyHold: (req: HoldRequest) => Promise<void>;
}> = ({
  accounts,
  go,
  reload: _reload,
  syncing: _syncing,
  onRefresh: _onRefresh,
  overview,
  telemetry,
  onApplyHold,
}) => {
  const [filterHealth, setFilterHealth] = useState<'all' | AccountStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<'all' | 'antigravity' | 'claude'>('all');
  const [drawerAccount, setDrawerAccount] = useState<Account | null>(null);
  const [sortKey, setSortKey] = useState<string>('slot');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [visibleCols, setVisibleCols] = useState({
    slot: true,
    email: true,
    provider: true,
    burst: true,
    cycle: true,
    reset: true,
    status: true,
  });

  const effectiveAccounts = accounts;

  const viewOf = (a: Account) => overview?.accounts.find((av) => av.accountId === a.id) || null;
  const statusOf = (a: Account) => accountStatus(a, viewOf(a));
  const countOf = (st: AccountStatus) => effectiveAccounts.filter((a) => statusOf(a) === st).length;

  let filtered = filterHealth === 'all' ? effectiveAccounts : effectiveAccounts.filter((a) => statusOf(a) === filterHealth);

  if (providerFilter !== 'all') {
    filtered = filtered.filter(a => a.providerType === providerFilter);
  }

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter((a, idx) => {
      const slot = getSlotLabel(a, idx).toLowerCase();
      const email = (a.email || '').toLowerCase();
      const name = (a.name || '').toLowerCase();
      return slot.includes(q) || email.includes(q) || name.includes(q);
    });
  }

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedAccounts = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      const aIdx = effectiveAccounts.indexOf(a);
      const bIdx = effectiveAccounts.indexOf(b);
      let res = 0;
      switch (sortKey) {
        case 'slot':
          res = aIdx - bIdx;
          break;
        case 'email':
          res = (a.email || a.name).localeCompare(b.email || b.name);
          break;
        case 'provider':
          res = a.providerType.localeCompare(b.providerType);
          break;
        case 'burst':
          res = (quotaWindows(a).fiveHour?.remaining ?? 101) - (quotaWindows(b).fiveHour?.remaining ?? 101);
          break;
        case 'cycle':
          res = (quotaWindows(a).weekly?.remaining ?? 101) - (quotaWindows(b).weekly?.remaining ?? 101);
          break;
        case 'reset':
          res = String(quotaWindows(a).fiveHour?.bucket.resetsAt ?? '~').localeCompare(String(quotaWindows(b).fiveHour?.bucket.resetsAt ?? '~'));
          break;
        case 'status':
          res = statusOf(a).localeCompare(statusOf(b));
          break;
        default:
          res = 0;
      }
      return sortDir === 'asc' ? res : -res;
    });
    return list;
  }, [filtered, sortKey, sortDir, effectiveAccounts, overview]);

  const renderSortIndicator = (key: string) => {
    if (sortKey !== key) return <span className="sort-icon">↕</span>;
    return <span className="sort-icon">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  return (
    <div id="tab-accounts" className="view-panel active">
      <CpaDangerAlert overview={overview} accounts={effectiveAccounts} />

      {/* Filter Toolbar */}
      <div className="filter-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={`filter-btn ${filterHealth === 'all' ? 'active' : ''}`} onClick={() => setFilterHealth('all')}>
          All ({effectiveAccounts.length})
        </button>
        {(['cooldown', 'exhausted', 'healthy', 'tight'] as AccountStatus[]).map((st) => (
          <button key={st} className={`filter-btn ${filterHealth === st ? 'active' : ''}`} onClick={() => setFilterHealth(st)}>
            {ACCOUNT_STATUS_LABEL[st]} ({countOf(st)})
          </button>
        ))}

        {/* Provider Filter Dropdown */}
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value as any)}
          style={{
            background: 'var(--card-hi)',
            color: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 12,
          }}
        >
          <option value="all">All Providers</option>
          <option value="antigravity">Google Antigravity</option>
          <option value="claude">Claude Code</option>
        </select>

        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Search email, slot..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '6px 12px',
              background: 'var(--card-hi)',
              color: '#fff',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 12,
              minWidth: 200,
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: 8,
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              ✕
            </button>
          )}
        </div>

        <ColumnPicker
          columns={[
            { key: 'slot', label: 'Slot' },
            { key: 'email', label: 'Account Email' },
            { key: 'provider', label: 'Provider' },
            { key: 'burst', label: '5H Burst' },
            { key: 'cycle', label: '7D Cycle' },
            { key: 'reset', label: 'Next 5H Reset' },
            { key: 'status', label: 'Status' },
          ]}
          selectedCols={visibleCols}
          onToggleCol={(key) => setVisibleCols((prev: any) => ({ ...prev, [key]: !prev[key] }))}
        />
        <button
          className="btn small"
          style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}
          onClick={() => go('/add')}
        >
          <Icon name="plus" size={14} /> Add account
        </button>
      </div>

      {/* Desktop Table with Sortable Columns */}
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              {visibleCols.slot && (
                <th className={`sortable-th ${sortKey === 'slot' ? 'sort-active' : ''}`} onClick={() => handleSort('slot')}>
                  SLOT {renderSortIndicator('slot')}
                </th>
              )}
              {visibleCols.email && (
                <th className={`sortable-th ${sortKey === 'email' ? 'sort-active' : ''}`} onClick={() => handleSort('email')}>
                  ACCOUNT EMAIL {renderSortIndicator('email')}
                </th>
              )}
              {visibleCols.provider && (
                <th className={`sortable-th ${sortKey === 'provider' ? 'sort-active' : ''}`} onClick={() => handleSort('provider')}>
                  PROVIDER {renderSortIndicator('provider')}
                </th>
              )}
              {visibleCols.burst && (
                <th className={`sortable-th ${sortKey === 'burst' ? 'sort-active' : ''}`} onClick={() => handleSort('burst')}>
                  5H BURST {renderSortIndicator('burst')}
                </th>
              )}
              {visibleCols.cycle && (
                <th className={`sortable-th ${sortKey === 'cycle' ? 'sort-active' : ''}`} onClick={() => handleSort('cycle')}>
                  7D CYCLE {renderSortIndicator('cycle')}
                </th>
              )}
              {visibleCols.reset && (
                <th className={`sortable-th ${sortKey === 'reset' ? 'sort-active' : ''}`} onClick={() => handleSort('reset')}>
                  NEXT 5H RESET {renderSortIndicator('reset')}
                </th>
              )}
              {visibleCols.status && (
                <th className={`sortable-th ${sortKey === 'status' ? 'sort-active' : ''}`} onClick={() => handleSort('status')}>
                  STATUS {renderSortIndicator('status')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {sortedAccounts.map((a) => {
              const idx = effectiveAccounts.indexOf(a);
              const { fiveHour, weekly } = quotaWindows(a);
              const status = statusOf(a);
              const isTight = status !== 'healthy';
              const slotStr = `slot_${getSlotLabel(a, idx)}`;
              const provStr = a.providerType === 'antigravity' ? 'Google' : a.providerType === 'claude' ? 'Anthropic' : a.providerType;
              const resetStr = fiveHour?.bucket.resetsAt ? formatResetCountdown(fiveHour.bucket.resetsAt) : '-';

              return (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => setDrawerAccount(a)}>
                  {visibleCols.slot && <td><span className="badge badge-slot">{slotStr}</span></td>}
                  {visibleCols.email && <td><strong>{a.email || a.name}</strong></td>}
                  {visibleCols.provider && <td>{provStr}</td>}
                  {visibleCols.burst && (
                    <td>
                      <span style={{ color: (fiveHour?.remaining ?? 100) <= 35 ? '#fbbf24' : '#4ade80', fontWeight: 700 }}>
                        {pct(fiveHour)}
                      </span>
                    </td>
                  )}
                  {visibleCols.cycle && <td>{pct(weekly)}</td>}
                  {visibleCols.reset && (
                    <td>
                      <span style={{ color: isTight ? '#f59e0b' : 'var(--muted)', fontSize: 11 }}>
                        {resetStr}
                      </span>
                    </td>
                  )}
                  {visibleCols.status && (
                    <td>
                      <span className={`badge ${STATUS_BADGE[status]}`}>
                        {ACCOUNT_STATUS_LABEL[status]}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Slide-over Diagnostic Drawer */}
      {drawerAccount && (
        <AccountDrawer
          account={drawerAccount}
          accountView={overview?.accounts.find((av) => av.accountId === drawerAccount.id) || null}
          onApplyHold={onApplyHold}
          telemetry={telemetry?.accounts[drawerAccount.id] ?? null}
          telemetryNotes={telemetry?.global.notes}
          onClose={() => setDrawerAccount(null)}
          onViewFleet={() => setDrawerAccount(null)}
        />
      )}
    </div>
  );
};

/* ---------------- Subpages: AccountPage & AddPage ---------------- */

const AccountPage: React.FC<{ account: Account; reload: () => Promise<void>; go: (to: string) => void }> = ({ account, reload, go }) => {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(account.name);
  const snap = account.latestSnapshot;
  const ring = dualRingData(snap);

  const remove = async () => {
    if (!confirm(`Delete "${account.name}" and remove it from fleet monitoring?`)) return;
    setBusy(true);
    try {
      await api.remove(account.id);
      await reload();
      go('/accounts');
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    try {
      await api.refresh(account.id);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!name.trim() || name === account.name) return;
    setBusy(true);
    try {
      await api.rename(account.id, name.trim());
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 640, margin: '0 auto', padding: 20 }}>
      <Header
        title={account.name}
        sub={[account.providerType, account.email].filter(Boolean).join(' • ')}
        back
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            <button className={`btn small ${busy ? 'spin' : ''}`} style={{ background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }} disabled={busy} onClick={sync}>Sync</button>
            <button className="btn small danger" style={{ background: '#7f1d1d', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 8px' }} disabled={busy} onClick={remove}>Delete</button>
          </div>
        }
      />
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
          <span>Burst Remaining:</span>
          <strong>{ring.outer ? `${Math.round(ring.outer.remaining)}%` : '—'}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
          <span>7-Day Cycle Balance:</span>
          <strong>{ring.inner ? `${Math.round(ring.inner.remaining)}%` : '—'}</strong>
        </div>
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Slot Name</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ flex: 1, padding: '6px 10px', background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6 }}
            />
            <button className="btn small" style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px' }} disabled={busy || name === account.name} onClick={saveName}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---------------- Add / Connect Flow ---------------- */

const DEFAULT_GUIDE = {
  steps: [
    'Open the service website on your computer and sign in to the account you want.',
    'DevTools (F12) → Network → find the request that returns your limits.',
    'Right-click → Copy → Copy as cURL and paste it here.',
  ],
  placeholder: 'curl …',
};

const GUIDES: Partial<Record<ProviderType, { steps: string[]; placeholder: string }>> = {
  antigravity: {
    steps: [
      'Recommended: use "Sign in to account" instead.',
      'Otherwise paste a Google OAuth refresh token (starts with 1//) for the Google account you use in Antigravity.',
      'You can also paste a JSON file that contains "refresh_token".',
    ],
    placeholder: '1//0g…  or  {"refresh_token":"1//…"}',
  },
  claude: {
    steps: [
      'Open claude.ai on your computer and sign in to the account you want.',
      'DevTools (F12) → Application → Cookies → https://claude.ai.',
      'Copy the sessionKey cookie value (starts with sk-ant-sid…). You can also paste a full cURL: Network → any request to /api → Copy as cURL.',
    ],
    placeholder: 'sk-ant-sid01-…  or  curl …',
  },
  chatgpt: {
    steps: [
      'Open chatgpt.com on your computer and sign in to the account you want.',
      'DevTools (F12) → Network → any request to backend-api → Copy as cURL.',
      'Paste the cURL here — the server will take the session cookie and refresh access automatically.',
    ],
    placeholder: 'curl https://chatgpt.com/backend-api/…',
  },
  gemini: {
    steps: [
      'Open gemini.google.com on your computer and sign in to the Google account you want.',
      'DevTools (F12) → Network → send any message → batchexecute request → Copy as cURL.',
      'For a second Google account, use a separate browser profile.',
    ],
    placeholder: "curl 'https://gemini.google.com/_/BardChatUi/data/batchexecute…",
  },
  cursor: {
    steps: ['Open cursor.com/settings and sign in.', 'DevTools → Network → usage request → Copy as cURL.', 'Paste it here.'],
    placeholder: 'curl https://cursor.com/api/usage …',
  },
  custom: {
    steps: [
      'Open the service website and find the page with limits/quota.',
      'DevTools → Network → the request that returns limits → Copy as cURL.',
      'Paste it — the server will find the percentages and reset time in the response.',
    ],
    placeholder: 'curl … (any service)',
  },
};

const ADD_GROUPS: Array<{ title: string; items: ProviderType[] }> = [
  { title: 'Main', items: ['claude', 'chatgpt', 'gemini'] },
  { title: 'Coding', items: ['antigravity', 'cursor', 'copilot'] },
  { title: 'Chat assistants', items: ['perplexity', 'grok', 'mistral', 'deepseek', 'poe'] },
  { title: 'Any other service', items: ['custom'] },
];

const supportsOAuth = (p: ProviderType) => p === 'claude' || p === 'chatgpt' || p === 'antigravity';

const CALLBACK_HINT: Partial<Record<ProviderType, string>> = {
  chatgpt: 'localhost:1455/auth/callback?code=…',
  antigravity: 'localhost:51121/oauth-callback?code=…',
};

const AddPage: React.FC<{ accounts: Account[]; go: (to: string) => void; reload: () => Promise<void>; reconnectId?: string }> = ({ accounts, go, reload, reconnectId }) => {
  const reconnect = accounts.find((a) => a.id === reconnectId);
  const [provider, setProvider] = useState<ProviderType | null>(reconnect?.providerType ?? null);
  const [mode, setMode] = useState<'oauth' | 'manual'>('oauth');
  const [oauth, setOauth] = useState<{ authorizeUrl: string; state: string } | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setInput('');
    setErr('');
    setOauth(null);
    setMode(provider && supportsOAuth(provider) ? 'oauth' : 'manual');
  }, [provider]);

  const startOAuth = async () => {
    if (!provider) return;
    setErr('');
    try {
      const r = await api.oauthStart(provider, reconnect?.id);
      setOauth(r);
      window.open(r.authorizeUrl, '_blank', 'noopener');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const submit = async () => {
    if (!provider) return;
    setBusy(true);
    setErr('');
    try {
      const r =
        mode === 'oauth' && oauth
          ? await api.oauthFinish(oauth.state, input)
          : await api.manual(provider, input, reconnect?.id);
      await reload();
      go(`/accounts`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!provider) {
    return (
      <div className="card" style={{ maxWidth: 640, margin: '20px auto', padding: 20 }}>
        <Header title="Add Account to Fleet" back />
        <div style={{ display: 'grid', gap: 16 }}>
          {ADD_GROUPS.map((g) => (
            <div key={g.title}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>{g.title}</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {g.items.map((p) => (
                  <button
                    key={p}
                    className="card"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: 12,
                      background: 'var(--card-hi)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      color: '#fff',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onClick={() => setProvider(p)}
                  >
                    <Logo type={p} size={36} />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{PROVIDER_NAMES[p]}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{PROVIDER_COMPANY[p]}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const guide = GUIDES[provider] || DEFAULT_GUIDE;
  const codePlaceholder = provider === 'claude' ? 'code#state' : `http://${CALLBACK_HINT[provider] ?? CALLBACK_HINT.chatgpt}`;

  return (
    <div className="card" style={{ maxWidth: 640, margin: '20px auto', padding: 20 }}>
      <Header
        title={`Connect ${PROVIDER_NAMES[provider]}`}
        sub={reconnect ? `Updating credentials for ${reconnect.name}` : `Add new ${PROVIDER_COMPANY[provider]} account`}
        back
      />

      {supportsOAuth(provider) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
          <button
            className={`filter-btn ${mode === 'oauth' ? 'active' : ''}`}
            onClick={() => setMode('oauth')}
          >
            OAuth (Recommended)
          </button>
          <button
            className={`filter-btn ${mode === 'manual' ? 'active' : ''}`}
            onClick={() => setMode('manual')}
          >
            Manual Token / Cookie
          </button>
        </div>
      )}

      {mode === 'oauth' ? (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            Sign in through the provider to grant quota monitoring access.
          </p>
          {!oauth ? (
            <button
              className="btn primary"
              style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontWeight: 600, cursor: 'pointer' }}
              onClick={startOAuth}
            >
              Start Authorization ↗
            </button>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="banner ok" style={{ fontSize: 12 }}>
                Browser window opened. After authorizing, paste the callback URL or code here:
              </div>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={codePlaceholder}
                style={{ padding: '8px 12px', background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6 }}
              />
              <button
                className="btn primary"
                style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontWeight: 600, cursor: 'pointer' }}
                disabled={busy || !input.trim()}
                onClick={submit}
              >
                {busy ? 'Connecting…' : 'Finish Connection'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            <strong>Instructions:</strong>
            <ol style={{ paddingLeft: 18, marginTop: 4 }}>
              {guide.steps.map((s, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{s}</li>
              ))}
            </ol>
          </div>
          <textarea
            rows={4}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={guide.placeholder}
            style={{ padding: '8px 12px', background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}
          />
          <button
            className="btn primary"
            style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontWeight: 600, cursor: 'pointer' }}
            disabled={busy || !input.trim()}
            onClick={submit}
          >
            {busy ? 'Validating…' : 'Save Account'}
          </button>
        </div>
      )}

      {err && <div className="banner danger" style={{ marginTop: 12, fontSize: 12 }}>{err}</div>}
    </div>
  );
};

export default App;
