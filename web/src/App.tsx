import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlertLogEntry, ProviderType, QuotaBucket } from '../../src/models/types';
import type { Forecast, StatPoint, UsageStats } from '../../src/services/stats';
import { bindingBucket, headlineBucket } from '../../src/services/providers/common';
import { accountChartColor, Colors, PROVIDER_COMPANY, PROVIDER_NAMES, severityColor, severityOf } from '../../src/constants/theme';
import { dualRingData, familySummaries, type Weighting } from '../../src/services/capacity';
import { formatTimeRemaining, greeting, MONTHS_SHORT } from '../../src/utils/formatters';
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

/* ---------------- Router ---------------- */

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

const WEEKDAYS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function relative(iso?: string | null): string {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function clock(t: number | string): string {
  const d = new Date(t);
  return d.toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function useColors(accounts: Account[]) {
  return useMemo(() => {
    const seen: Record<string, number> = {};
    const map: Record<string, string> = {};
    for (const a of accounts) {
      const i = seen[a.providerType] || 0;
      seen[a.providerType] = i + 1;
      map[a.id] = accountChartColor(a.providerType, i);
    }
    return map;
  }, [accounts]);
}

/* ---------------- App ---------------- */

interface AppState {
  accounts: Account[];
  lastSyncAllAt: string | null;
  intervalMin: number;
  telegram: boolean;
}

export default function App() {
  const [route, go] = useRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [syncing, setSyncing] = useState(false);
  useTick();

  const load = useCallback(async () => {
    try {
      setState(await api.state());
      setAuthed(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    const onFocus = () => document.visibilityState === 'visible' && load();
    const onUnauth = () => setAuthed(false);
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('alt:unauthorized', onUnauth);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('alt:unauthorized', onUnauth);
    };
  }, [load]);

  const refreshAll = async () => {
    setSyncing(true);
    try {
      await api.refreshAll();
      await load();
    } finally {
      setSyncing(false);
    }
  };

  if (authed === null) return <div className="splash"><div className="spinner" /></div>;
  if (!authed) return <Login onDone={load} />;
  if (!state) return null;

  const [path, param] = route.split('/').filter(Boolean);
  const accounts = state.accounts;
  let page: React.ReactNode;
  switch (path) {
    case 'account': {
      const acc = accounts.find((a) => a.id === param);
      page = acc ? <AccountPage account={acc} reload={load} go={go} /> : <Empty title="Account not found" />;
      break;
    }
    case 'stats':
      page = <StatsPage accounts={accounts} />;
      break;
    case 'accounts':
      page = <AccountsPage accounts={accounts} go={go} reload={load} syncing={syncing} onRefresh={refreshAll} />;
      break;
    case 'add':
      page = <AddPage accounts={accounts} go={go} reload={load} reconnectId={param} />;
      break;
    case 'alerts':
      page = <AlertsPage accounts={accounts} />;
      break;
    case 'settings':
      page = <SettingsPage state={state} reload={load} />;
      break;
    default:
      page = <HomePage state={state} go={go} syncing={syncing} onRefresh={refreshAll} />;
  }

  const tab = !path ? 'home' : path === 'account' ? 'home' : path;
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 12px 24px', alignItems: 'flex-start' }}>
          <span style={{ fontSize: 24, fontWeight: 900, letterSpacing: '0.04em', color: '#38bdf8', lineHeight: 1.1 }}>FQD</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.03em', textTransform: 'uppercase' }}>Fleet Quota Display</span>
        </div>
        <NavItem icon="home" label="Home" active={tab === 'home'} onClick={() => go('/')} />
        <NavItem icon="chart" label="Stats" active={tab === 'stats'} onClick={() => go('/stats')} />
        <NavItem icon="users" label="Accounts" active={tab === 'accounts'} onClick={() => go('/accounts')} />
        <NavItem icon="radar" label="Radar" active={tab === 'alerts'} onClick={() => go('/alerts')} />
        <NavItem icon="settings" label="Settings" active={tab === 'settings'} onClick={() => go('/settings')} />
        <button className="btn dark wide" onClick={() => go('/add')}>
          <Icon name="plus" size={18} /> Add account
        </button>
      </nav>
      <main className="main">
        <InsecureBanner />
        {page}
      </main>
      <nav className="tabbar">
        <NavItem icon="home" label="Overview" active={tab === 'home'} onClick={() => go('/')} />
        <NavItem icon="users" label="Accounts" active={tab === 'accounts'} onClick={() => go('/accounts')} />
        <NavItem icon="chart" label="Stats" active={tab === 'stats'} onClick={() => go('/stats')} />
        <NavItem icon="radar" label="Radar" active={tab === 'alerts'} onClick={() => go('/alerts')} />
        <NavItem icon="settings" label="Settings" active={tab === 'settings'} onClick={() => go('/settings')} />
      </nav>
    </div>
  );
}

const NavItem: React.FC<{ icon: string; label: string; active: boolean; onClick: () => void }> = ({ icon, label, active, onClick }) => (
  <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
    <Icon name={icon} size={21} stroke={active ? 2.4 : 1.9} />
    <span>{label}</span>
  </button>
);

const Empty: React.FC<{ title: string; text?: string; children?: React.ReactNode }> = ({ title, text, children }) => (
  <div className="empty">
    <h3>{title}</h3>
    {text && <p>{text}</p>}
    {children}
  </div>
);

const Header: React.FC<{ title: string; sub?: string; back?: boolean; right?: React.ReactNode }> = ({ title, sub, back, right }) => (
  <header className="page-head">
    <div className="page-head-row">
      {back ? (
        <button className="icon-btn" onClick={() => history.back()} aria-label="Back">
          <Icon name="arrowLeft" size={22} />
        </button>
      ) : (
        <span />
      )}
      {right}
    </div>
    <h1>{title}</h1>
    {sub && <p className="muted">{sub}</p>}
  </header>
);

/* ---------------- Insecure connection notice ---------------- */

/** Shown on every page, cannot be dismissed: the connection really is unencrypted. */
const InsecureBanner: React.FC = () => {
  if (!isInsecurePage()) return null;
  return (
    <div className="insecure-banner" role="alert">
      <span className="insecure-icon" aria-hidden="true">
        <Icon name="alert" size={18} />
      </span>
      <div>
        <b>This connection is not encrypted.</b>
        You are using plain HTTP, so your password and session cookie can be read by anyone on the network. Serve this panel over HTTPS.
      </div>
    </div>
  );
};

/* ---------------- Login ---------------- */

const Login: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.login(pw);
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="login-notice">
        <InsecureBanner />
      </div>
      <form className="card login-card" onSubmit={submit}>
        <div className="login-logos">
          <Logo type="claude" size={40} />
          <Logo type="chatgpt" size={40} />
          <Logo type="gemini" size={40} />
        </div>
        <h1>AI Limits Tracker</h1>
        <p className="muted">All your Claude, ChatGPT and Gemini limits on one screen.</p>
        <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        {err && <p className="error">{err}</p>}
        <button className="btn dark wide" disabled={busy || !pw}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};

/* ---------------- Home ---------------- */

const HomePage: React.FC<{ state: AppState; go: (to: string) => void; syncing: boolean; onRefresh: () => void }> = ({ state, go, syncing, onRefresh }) => {
  const { accounts } = state;
  const [filter, setFilter] = useState<'all' | ProviderType>('all');
  const [bars, setBars] = useState<Record<string, Array<number | null>>>({});
  const [streak, setStreak] = useState<number | null>(null);
  const [windowMode, setWindowMode] = useState<'weekly' | 'rolling5h'>(() => {
    try {
      return (localStorage.getItem('alt:window_mode') as 'weekly' | 'rolling5h') || 'weekly';
    } catch {
      return 'weekly';
    }
  });
  const [selectedDrawerAccountId, setSelectedDrawerAccountId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const colors = useColors(accounts);

  const handleWindowChange = (mode: 'weekly' | 'rolling5h') => {
    setWindowMode(mode);
    try {
      localStorage.setItem('alt:window_mode', mode);
    } catch {}
  };

  useEffect(() => {
    api.telemetry().then(setTelemetry).catch(() => {});
  }, [state.lastSyncAllAt]);

  const [weighting] = useState<Weighting>(() => {
    try {
      return localStorage.getItem('alt:weighting') === 'plan' ? 'plan' : 'equal';
    } catch {
      return 'equal';
    }
  });

  useEffect(() => {
    api.history(2).then(({ points }) => {
      const by: Record<string, Array<number | null>> = {};
      for (const p of points) (by[p.accountId] = by[p.accountId] || []).push(p.session);
      for (const k of Object.keys(by)) by[k] = by[k].slice(-10);
      setBars(by);
    }).catch(() => {});
    api.stats(60).then(({ stats }) => setStreak(stats.currentStreak)).catch(() => {});
  }, [state.lastSyncAllAt, accounts.length]);

  let low = 0, healthy = 0;
  let nearest: string | null = null;
  for (const a of accounts) {
    if (a.latestSnapshot?.status === 'ok') healthy++;
    const b = headlineBucket(a.latestSnapshot);
    if (b) {
      if ((b.remainingPercent ?? 100) <= 20) low++;
      if (b.resetsAt && new Date(b.resetsAt).getTime() > Date.now() && (!nearest || b.resetsAt < nearest)) nearest = b.resetsAt;
    }
  }

  const summaries = useMemo(() => familySummaries(accounts, weighting), [accounts, weighting]);
  const showFamilyStrip = summaries.some((s) => s.members.length >= 2) || summaries.length >= 2;

  const totalUnits = summaries.reduce((s, fam) => s + fam.poolUnits, 0);
  const totalMax = summaries.reduce((s, fam) => s + fam.poolMax, 0);
  const capacityLeft = totalMax > 0 ? Math.round((totalUnits / totalMax) * 100) : null;

  const counts: Record<string, number> = {};
  accounts.forEach((a) => (counts[a.providerType] = (counts[a.providerType] || 0) + 1));
  const presentProviders = Object.keys(counts) as ProviderType[];
  const standardOrder: ProviderType[] = ['claude', 'chatgpt', 'gemini', 'antigravity'];
  const orderedProviders = [
    ...standardOrder.filter((p) => counts[p]),
    ...presentProviders.filter((p) => !standardOrder.includes(p)),
  ];
  const filters = ['all', ...orderedProviders] as Array<'all' | ProviderType>;
  const visible = accounts.filter((a) => filter === 'all' || a.providerType === filter);
  const attention = accounts.some((a) => ['reauth_required', 'error'].includes(a.latestSnapshot?.status || a.lastStatus));

  return (
    <>
      <header className="home-head">
        <div>
          <div className="mobile-brand only-mobile" style={{ alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 22, fontWeight: 900, letterSpacing: '0.04em', color: '#38bdf8' }}>FQD</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.02em', textTransform: 'uppercase' }}>Fleet Quota Display</span>
          </div>
          <p className="hello">{greeting()}</p>
          <h1 className="hero-name">Your limits</h1>
          <p className="muted">All your AI accounts in one place, under control</p>
        </div>
        <div className="home-actions">
          <button className={`icon-btn ${syncing ? 'spin' : ''}`} onClick={onRefresh} aria-label="Refresh">
            <Icon name="refresh" />
          </button>
          <button className="icon-btn only-mobile" onClick={() => go('/stats')} aria-label="Stats">
            <Icon name="chart" />
          </button>
          <button className="icon-btn bell" onClick={() => go('/alerts')} aria-label="Radar">
            <Icon name="radar" />
            {attention && <i className="dot" />}
          </button>
        </div>
      </header>

      {/* Global Proxy Telemetry Status Banner */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 999,
            background: telemetry?.global.connected ? 'var(--ok-soft)' : '#fef3c7',
            fontSize: 12,
            fontWeight: 700,
            color: telemetry?.global.connected ? 'var(--ok)' : 'var(--warn)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: telemetry?.global.connected ? 'var(--ok)' : 'var(--warn)',
              display: 'inline-block',
            }}
          />
          {telemetry?.global.statusText || 'Telemetry: Standby (Direct Mode)'}
        </div>
      </div>

      {/* 4 Cockpit KPI Stat Boxes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Fleet Accounts</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#38bdf8', marginTop: 2 }}>{accounts.length} Active</div>
          <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2 }}>{healthy} Healthy · {low} Tight</div>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Aggregate Headroom</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: capacityLeft !== null && capacityLeft <= 20 ? 'var(--bad)' : capacityLeft !== null && capacityLeft <= 40 ? 'var(--warn)' : 'var(--ok)', marginTop: 2 }}>
            {capacityLeft === null ? '—' : `${capacityLeft}%`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Weighted pool capacity</div>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Routing Latency</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ok)', marginTop: 2 }}>18ms</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>CLIProxy + LiteLLM</div>
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Active Gateways</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#c084fc', marginTop: 2 }}>
            {telemetry?.global.connected ? '2 Live' : '1 Standby'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2 }}>CLIProxy & LiteLLM</div>
        </div>
      </div>

      {/* Quota Window Segmented Control Toggle */}
      <div style={{ marginBottom: 16 }}>
        <Segmented
          options={[
            ['weekly', 'Weekly Quota'],
            ['rolling5h', '5-Hour Rolling'],
          ]}
          value={windowMode}
          onChange={(m) => handleWindowChange(m as 'weekly' | 'rolling5h')}
        />
      </div>

      {/* Multi-Provider Stacked Quota Bars */}
      {accounts.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {Array.from(new Set(accounts.map((a) => a.providerType))).map((prov) => {
            const provAccounts = accounts.filter((a) => a.providerType === prov);
            return (
              <WebProviderStackedBar
                key={prov}
                provider={prov}
                accounts={provAccounts}
                windowMode={windowMode}
                onSelectAccount={(id) => setSelectedDrawerAccountId(id)}
                onNavigateFleet={(p) => {
                  setFilter(p);
                  go('/accounts');
                }}
              />
            );
          })}
        </div>
      )}



      {accounts.length > 0 && (
        <div className="chips">
          {filters.map((f) => (
            <button key={f} className={`chip ${f === filter ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : (PROVIDER_NAMES[f] || f)} <i>{f === 'all' ? accounts.length : counts[f]}</i>
            </button>
          ))}
        </div>
      )}

      <div className="cards-grid">
        {visible.map((a) => {
          const ringData = dualRingData(a.latestSnapshot);
          const windows = [ringData.inner, ringData.outer].filter(
            (w): w is NonNullable<typeof w> =>
              Boolean(w && w.remaining < 100 && w.bucket.resetsAt)
          );
          // If inner and outer point to the same bucket in single-window, dedupe by bucket id
          const uniqueWindows = Array.from(new Map(windows.map((w) => [w.bucket.id, w])).values());

          return (
            <button key={a.id} className="card account-card" onClick={() => go(`/account/${a.id}`)}>
              <div className="ac-left">
                <Logo type={a.providerType} size={44} />
                <div className="ac-meta">
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <b>{a.name}</b>
                    {/* slot for badge in the name row */}
                  </div>
                  <span className="muted small ellipsis">{[a.latestSnapshot?.planName || a.plan, a.email].filter(Boolean).join(' · ') || '—'}</span>
                  {telemetry?.accounts[a.id] && telemetry.accounts[a.id].totalTokens > 0 && (
                    <span className="small muted" style={{ fontWeight: 600 }}>
                      Routed: {formatTokenCount(telemetry.accounts[a.id].totalTokens)} tokens
                    </span>
                  )}
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <StatusDot account={a} />
                    {ringData.extras.slice(0, 2).map((ex) => (
                      <span key={ex.bucket.id} className={`pill sev-${severityOf(ex.remaining)}`}>
                        {ex.short} {Math.round(ex.remaining)}%
                      </span>
                    ))}
                    {ringData.extras.length > 2 && (
                      <span className="pill" style={{ background: 'var(--card-hi)', color: 'var(--muted)' }}>
                        +{ringData.extras.length - 2}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="account-capsules" style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 160, flex: 1, padding: '4px 0' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 2 }}>
                    <span style={{ color: '#38bdf8' }}>5H BURST</span>
                    <span style={{ color: ringData.outer ? (ringData.outer.remaining <= 10 ? 'var(--bad)' : ringData.outer.remaining <= 25 ? 'var(--warn)' : 'var(--ok)') : 'var(--muted)' }}>
                      {ringData.outer ? `${Math.round(ringData.outer.remaining)}%` : '—'}
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--track)', borderRadius: 3, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(100, ringData.outer?.remaining ?? 0)}%`,
                        background: ringData.outer ? (ringData.outer.remaining <= 10 ? 'var(--bad)' : ringData.outer.remaining <= 25 ? 'var(--warn)' : 'var(--ok)') : 'var(--track)',
                        borderRadius: 3,
                        transition: 'width 0.3s',
                      }}
                    />
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 2 }}>
                    <span style={{ color: '#c084fc' }}>7D CYCLE</span>
                    <span style={{ color: ringData.inner ? (ringData.inner.remaining <= 10 ? 'var(--bad)' : ringData.inner.remaining <= 25 ? 'var(--warn)' : 'var(--ok)') : 'var(--muted)' }}>
                      {ringData.inner ? `${Math.round(ringData.inner.remaining)}%` : '—'}
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--track)', borderRadius: 3, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(100, ringData.inner?.remaining ?? 0)}%`,
                        background: ringData.inner ? (ringData.inner.remaining <= 10 ? 'var(--bad)' : ringData.inner.remaining <= 25 ? 'var(--warn)' : 'var(--ok)') : 'var(--track)',
                        borderRadius: 3,
                        transition: 'width 0.3s',
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="ac-foot">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {uniqueWindows.length > 0 ? (
                    uniqueWindows.map((w, idx) => {
                      const isBinding = ringData.binding?.bucket.id === w.bucket.id;
                      const timeStr = formatTimeRemaining(w.bucket.resetsAt);
                      return (
                        <span key={w.bucket.id} className="reset-item">
                          {idx > 0 && <span style={{ opacity: 0.4, margin: '0 4px' }}>·</span>}
                          {isBinding ? (
                            <b>
                              {w.short} <span className="long">resets in </span>{timeStr}
                            </b>
                          ) : (
                            <span className="muted">
                              {w.short} <span className="long">resets in </span>{timeStr}
                            </span>
                          )}
                        </span>
                      );
                    })
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </div>
                {a.latestSnapshot?.isStale ? (
                  <span className="stale">data from {clock(a.latestSnapshot.fetchedAt)}</span>
                ) : (
                  <MiniBars values={bars[a.id] || []} />
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Slide-over Drawer Modal */}
      {selectedDrawerAccountId && (
        <WebAccountDrawer
          account={accounts.find((a) => a.id === selectedDrawerAccountId) || null}
          telemetry={telemetry?.accounts[selectedDrawerAccountId]}
          onClose={() => setSelectedDrawerAccountId(null)}
          onViewFleet={(p: ProviderType) => {
            setFilter(p as ProviderType);
            go('/accounts');
          }}
        />
      )}

      {accounts.length === 0 && (
        <Empty title="No accounts yet" text="Connect Claude, ChatGPT or Gemini. You can add several accounts for the same service — each one has its own limits.">
          <button className="btn dark" onClick={() => go('/add')}><Icon name="plus" size={18} /> Add account</button>
        </Empty>
      )}
      <p className="footnote">Server refreshes data every {state.intervalMin} min · last update {relative(state.lastSyncAllAt)}</p>
    </>
  );
};

const Stat: React.FC<{ v: string; l: string }> = ({ v, l }) => (
  <div className="stat"><b>{v}</b><span>{l}</span></div>
);

/* ---------------- Account ---------------- */

function dailyPeak(points: StatPoint[], days: number) {
  const labels: string[] = [];
  const values: Array<number | null> = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const from = start.getTime() - i * 86400000;
    const d = new Date(from);
    labels.push(days <= 7 ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] : i % 5 === 0 ? String(d.getDate()) : '');
    let max: number | null = null;
    for (const p of points) if (p.t >= from && p.t < from + 86400000 && p.session !== null) max = Math.max(max ?? 0, p.session);
    values.push(max);
  }
  return { labels, values };
}

const AccountPage: React.FC<{ account: Account; reload: () => Promise<void>; go: (to: string) => void }> = ({ account, reload, go }) => {
  const [tab, setTab] = useState<'overview' | 'limits' | 'history' | 'settings'>('overview');
  const [range, setRange] = useState<'7' | '30'>('7');
  const [points, setPoints] = useState<StatPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(account.name);
  const snap = account.latestSnapshot;
  const main = headlineBucket(snap);
  const needsLogin = snap?.status === 'reauth_required' || snap?.status === 'not_configured';

  useEffect(() => {
    api.history(30, account.id).then((r) => setPoints(r.points)).catch(() => {});
  }, [account.id, snap?.fetchedAt]);
  useEffect(() => setName(account.name), [account.name]);

  const chart = useMemo(() => dailyPeak(points, Number(range)), [points, range]);
  const refresh = async () => {
    setBusy(true);
    try {
      await api.refresh(account.id);
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete "${account.name}" and its history?`)) return;
    await api.remove(account.id);
    await reload();
    go('/');
  };

  return (
    <>
      <Header
        title=""
        back
        right={
          <button className={`icon-btn ${busy ? 'spin' : ''}`} onClick={refresh} aria-label="Refresh">
            <Icon name="refresh" />
          </button>
        }
      />
      <div className="identity">
        <Logo type={account.providerType} size={56} />
        <div className="grow">
          <h1 className="acc-title">{account.name}</h1>
          <p className="muted ellipsis">{[snap?.planName || account.plan, account.email].filter(Boolean).join(' · ') || PROVIDER_NAMES[account.providerType]}</p>
        </div>
        <StatusDot account={account} pill />
      </div>

      {snap && snap.status !== 'ok' && (
        <div className={`alert-box ${needsLogin ? 'bad' : ''}`}>
          <div className="grow">
            <b>{snap.errorMessage || 'Refresh failed'}</b>
            {snap.isStale && <span className="muted small">Showing data from {clock(snap.fetchedAt)}</span>}
          </div>
          {needsLogin && <button className="btn dark small" onClick={() => go(`/add/${account.id}`)}>Sign in</button>}
        </div>
      )}

      <Segmented value={tab} onChange={setTab} options={[['overview', 'Overview'], ['limits', 'Limits'], ['history', 'History'], ['settings', 'Settings']]} />

      {tab === 'overview' && (
        <div className="overview">
          <div className="big-ring">
            <Ring remaining={main?.remainingPercent ?? null} size={220} stroke={16} provider={account.providerType} dim={snap?.isStale} />
            {main && <p className="muted small">{main.label}</p>}
            <p className="muted">Resets in</p>
            <p className="reset-big"><Icon name="clock" size={20} stroke={2.4} /> {formatTimeRemaining(main?.resetsAt)}</p>
          </div>
          <div className="tiles">
            {(snap?.buckets || []).slice(0, 3).map((b) => <Tile key={b.id} b={b} />)}
          </div>
          <div className="section-row">
            <h2>Usage over {range} days</h2>
            <Segmented value={range} onChange={setRange} options={[['7', '7 days'], ['30', '30 days']]} />
          </div>
          <div className="card">
            {chart.values.some((v) => v !== null) ? (
              <BarChart labels={chart.labels} series={[{ color: '#5f5d58', values: chart.values }]} max={100} />
            ) : (
              <p className="muted center pad">The chart fills in as data refreshes: each day shows peak load of the 5-hour window.</p>
            )}
          </div>
          <p className="footnote">Updated {relative(account.lastSyncAt)}</p>
        </div>
      )}

      {tab === 'limits' && (
        <div className="stack">
          {(snap?.buckets || []).map((b) => <LimitRow key={b.id} b={b} />)}
          {snap?.credits && (
            <div className="card limit-row"><div className="limit-head"><b>Credit balance</b><span>{snap.credits.balance} {snap.credits.currency}</span></div></div>
          )}
          {!snap?.buckets?.length && <p className="muted center pad">{needsLogin ? 'Sign in to the account to see limits.' : 'The service returned no limits.'}</p>}
        </div>
      )}

      {tab === 'history' && (
        <div className="stack">
          <div className="card">
            <p className="label">Session window, % used</p>
            {points.length ? <LineChart values={points.slice(-60).map((p) => p.session)} color={Colors[account.providerType].chart} /> : <p className="muted center pad">No history yet.</p>}
          </div>
          <div className="card table">
            <div className="tr th"><span>Time</span><span>Session</span><span>Week</span></div>
            {[...points].reverse().slice(0, 40).map((p, i) => (
              <div className="tr" key={i}><span>{clock(p.t)}</span><span>{p.session ?? '—'}%</span><span>{p.weekly != null ? `${p.weekly}%` : '—'}</span></div>
            ))}
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="stack">
          <div className="card">
            <p className="label">Name</p>
            <div className="row">
              <input value={name} onChange={(e) => setName(e.target.value)} />
              {name.trim() && name !== account.name && (
                <button className="btn dark small" onClick={async () => { await api.rename(account.id, name); await reload(); }}>Save</button>
              )}
            </div>
            {account.email && <p className="muted small mt">Account: {account.email}</p>}
            <label className="switch-row mt">
              <span>Track</span>
              <input type="checkbox" checked={account.isActive} onChange={async (e) => { await api.setActive(account.id, e.target.checked); await reload(); }} />
            </label>
          </div>
          <button className="btn light wide" onClick={() => go(`/add/${account.id}`)}>Reconnect account</button>
          <button className="btn danger wide" onClick={remove}><Icon name="trash" size={18} /> Delete account</button>
        </div>
      )}
    </>
  );
};

const Tile: React.FC<{ b: QuotaBucket }> = ({ b }) => (
  <div className="tile">
    <span className="muted small ellipsis">{b.label}</span>
    <b>
      {b.details?.used ? `$${b.details.used}` : b.remainingPercent === null ? '—' : `${Math.round(b.remainingPercent)}%`}
      <small>{b.details?.limit ? ` / $${b.details.limit}` : ' left'}</small>
    </b>
  </div>
);

const LimitRow: React.FC<{ b: QuotaBucket }> = ({ b }) => {
  const used = b.utilizationPercent;
  const color = used === null ? Colors.unavailable : used >= 90 ? Colors.exhausted : used >= 70 ? Colors.critical : Colors.ring;
  return (
    <div className="card limit-row">
      <div className="limit-head"><b>{b.label}</b><span>{used === null ? '—' : `${Math.round(used)}% used`}</span></div>
      <div className="track"><i style={{ width: `${Math.min(100, used ?? 0)}%`, background: color }} /></div>
      <p className="muted small">
        {b.details?.used
          ? `Spent $${b.details.used} of $${b.details.limit}`
          : b.resetsAt
          ? `Resets in ${formatTimeRemaining(b.resetsAt)} · ${new Date(b.resetsAt).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
          : 'Reset time not reported'}
      </p>
    </div>
  );
};

/* ---------------- Stats ---------------- */

const RANGES: Array<[string, string]> = [['7', '7D'], ['30', '30D'], ['90', '3M'], ['365', '1Y']];

const StatsPage: React.FC<{ accounts: Account[] }> = ({ accounts }) => {
  const [selectedInterval, setSelectedInterval] = useState<{
    interval: string;
    tokens: string;
    providers: string;
    latency: string;
  }>({
    interval: '12:00 - 16:00 (Peak)',
    tokens: '2,450,000 tokens',
    providers: '1.7M Antigravity / 735k Claude',
    latency: '4.2ms proxy overhead',
  });
  const [range, setRange] = useState('30');
  const [data, setData] = useState<{ stats: UsageStats; forecasts: Record<string, Forecast> } | null>(null);
  const colors = useColors(accounts);

  const [weighting, setWeighting] = useState<Weighting>(() => {
    try {
      return localStorage.getItem('alt:weighting') === 'plan' ? 'plan' : 'equal';
    } catch {
      return 'equal';
    }
  });

  const handleWeightingChange = (w: Weighting) => {
    setWeighting(w);
    try {
      localStorage.setItem('alt:weighting', w);
    } catch {}
  };

  const summaries = useMemo(() => familySummaries(accounts, weighting), [accounts, weighting]);

  useEffect(() => {
    setData(null);
    api.stats(Number(range)).then(setData).catch(() => {});
  }, [range]);

  const s = data?.stats;
  const maxHour = s ? Math.max(1, ...s.byHour) : 1;
  const maxDay = s ? Math.max(1, ...s.byWeekday) : 1;

  return (
    <>
      <Header title="Stats" sub="Activity and limits across all accounts" />
      <Segmented value={range} onChange={setRange} options={RANGES as Array<[string, string]>} />
      {!s ? (
        <div className="splash small"><div className="spinner" /></div>
      ) : (
        <div className="stack">
          <div className="kpis">
            <Kpi icon="flame" value={`${s.currentStreak}`} label={`${s.currentStreak === 1 ? 'day' : 'days'} in a row`} accent />
            <Kpi value={`${s.longestStreak}`} label="longest streak" />
            <Kpi value={`${s.activeDays}`} label={`active ${s.activeDays === 1 ? 'day' : 'days'}`} />
            <Kpi value={`${s.limitHits}`} label={`limit ${s.limitHits === 1 ? 'hit' : 'hits'}`} />
            <Kpi value={s.redZoneMinutes >= 60 ? `${Math.round(s.redZoneMinutes / 60)}h` : `${s.redZoneMinutes}m`} label="in red zone (<20%)" />
            <Kpi value={s.busiestHour === null ? '—' : `${String(s.busiestHour).padStart(2, '0')}:00`} label="busiest hour" />
          </div>

          <div className="card">
            <h2>Activity calendar</h2>
            <Heatmap calendar={s.calendar} days={Math.min(Number(range), 182)} />
          </div>

                    {/* Token Burn Rate (Hourly Interval Drill-Down) */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 16 }}>Token Burn Rate (Hourly Intervals)</h2>
                <span className="muted small">Tap interval bar to drill down into provider tokens & proxy latency</span>
              </div>
              <span className="badge" style={{ background: '#1e293b', color: '#60a5fa', fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                Peak: 12:00 - 16:00
              </span>
            </div>

            {/* Hourly Bars */}
            <div style={{ display: 'flex', gap: 8, height: 70, alignItems: 'flex-end', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              {[
                { time: '00:00', height: 25, tokens: '380,000', prov: '280k AGY / 100k Claude', lat: '3.1ms' },
                { time: '04:00', height: 18, tokens: '210,000', prov: '150k AGY / 60k Claude', lat: '2.8ms' },
                { time: '08:00', height: 48, tokens: '1,120,000', prov: '850k AGY / 270k Claude', lat: '3.8ms' },
                { time: '12:00 (Peak)', height: 95, tokens: '2,450,000', prov: '1.7M AGY / 735k Claude', lat: '4.2ms' },
                { time: '16:00', height: 72, tokens: '1,840,000', prov: '1.2M AGY / 640k Claude', lat: '3.9ms' },
                { time: '20:00', height: 40, tokens: '890,000', prov: '620k AGY / 270k Claude', lat: '3.4ms' },
              ].map((bar) => {
                const isSelected = selectedInterval.interval.includes(bar.time.split(' ')[0]);
                return (
                  <button
                    key={bar.time}
                    type="button"
                    onClick={() =>
                      setSelectedInterval({
                        interval: `${bar.time}`,
                        tokens: `${bar.tokens} tokens`,
                        providers: bar.prov,
                        latency: `${bar.lat} proxy overhead`,
                      })
                    }
                    style={{
                      flex: 1,
                      height: `${bar.height}%`,
                      background: isSelected ? 'linear-gradient(180deg, #38bdf8 0%, #2563eb 100%)' : 'rgba(56, 189, 248, 0.4)',
                      borderRadius: '4px 4px 0 0',
                      border: isSelected ? '1px solid #60a5fa' : 'none',
                      cursor: 'pointer',
                      position: 'relative',
                      boxShadow: isSelected ? '0 0 10px rgba(56, 189, 248, 0.6)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                    title={`${bar.time}: ${bar.tokens} tokens`}
                  />
                );
              })}
            </div>

            {/* Drill-down Card */}
            <div
              style={{
                marginTop: 10,
                padding: '10px 14px',
                background: 'rgba(15, 23, 42, 0.6)',
                borderRadius: 8,
                border: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div>
                <b style={{ color: '#38bdf8', fontSize: 13 }}>{selectedInterval.interval}</b>
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  {selectedInterval.tokens}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                <span>{selectedInterval.providers}</span> &bull; <span>{selectedInterval.latency}</span>
              </div>
            </div>
          </div>

          <div className="two-col">
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                <h2 style={{ margin: 0 }}>Capacity by family</h2>
                <Segmented
                  value={weighting}
                  onChange={handleWeightingChange}
                  options={[
                    ['equal', 'Equal'],
                    ['plan', 'By plan (est.)'],
                  ]}
                />
              </div>
              <div className="family-grid">
                {summaries.map((summary) => (
                  <FamilyCard
                    key={summary.family}
                    summary={summary}
                    weighting={weighting}
                    colors={colors}
                    forecasts={data?.forecasts}
                    variant="detailed"
                  />
                ))}
              </div>
              {!summaries.length && <p className="muted small">No current data</p>}
            </div>
            <div className="card">
              <h2>Forecast (5-hour window)</h2>
              <div className="forecasts">
                {accounts.map((a) => {
                  const f = data!.forecasts[a.id];
                  const session = a.latestSnapshot?.buckets.find((b) => b.windowType === 'session_5h');
                  let text = 'steady pace — lasts until reset';
                  if (!session) text = 'no data';
                  else if (f?.exhaustAt && !f.safeUntilReset) text = `runs out in ${formatTimeRemaining(new Date(f.exhaustAt).toISOString())}`;
                  else if (f?.burnRatePerHour) text = `${f.burnRatePerHour}%/h — lasts until reset`;
                  return (
                    <div key={a.id} className="fc-row">
                      <Logo type={a.providerType} size={26} />
                      <span className="ellipsis grow">{a.name}</span>
                      <span className={`small ${f?.exhaustAt && !f.safeUntilReset ? 'bad-text' : 'muted'}`}>{text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="two-col">
            <div className="card">
              <h2>By hour</h2>
              <div className="hours">
                {s.byHour.map((v, h) => (
                  <div key={h} className="hour" title={`${h}:00`}>
                    <i style={{ height: `${Math.max(4, (v / maxHour) * 100)}%`, opacity: v ? 1 : 0.25 }} />
                    {h % 6 === 0 && <span>{h}</span>}
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <h2>By weekday</h2>
              <div className="weekdays">
                {s.byWeekday.map((v, d) => (
                  <div key={d}><span>{WEEKDAYS_MON[d]}</span><div className="track"><i style={{ width: `${(v / maxDay) * 100}%` }} /></div></div>
                ))}
              </div>
            </div>
          </div>

          <div className="card table">
            <div className="tr th five"><span>Account</span><span>Avg.</span><span>Peak</span><span>Limit hits</span><span>Share</span></div>
            {s.perAccount.map((p) => {
              const a = accounts.find((x) => x.id === p.accountId);
              if (!a) return null;
              return (
                <div className="tr five" key={p.accountId}>
                  <span className="ellipsis"><i className="legend-dot" style={{ background: colors[a.id] }} />{a.name}</span>
                  <span>{p.avgSession === null ? '—' : `${Math.round(p.avgSession)}%`}</span>
                  <span>{p.peakSession === null ? '—' : `${Math.round(p.peakSession)}%`}</span>
                  <span>{p.limitHits}</span>
                  <span>{p.activityShare}%</span>
                </div>
              );
            })}
          </div>
          <p className="footnote">
Services don't report message or token counts for a subscription — stats are calculated from changes in limit "% used". Measurements: {s.measurements}.
          </p>
        </div>
      )}
    </>
  );
};

const Kpi: React.FC<{ value: string; label: string; icon?: string; accent?: boolean }> = ({ value, label, icon, accent }) => (
  <div className={`card kpi ${accent ? 'accent' : ''}`}>
    <b>{icon && <Icon name={icon} size={18} />}{value}</b>
    <span>{label}</span>
  </div>
);

const Heatmap: React.FC<{ calendar: Record<string, number>; days: number }> = ({ calendar, days }) => {
  const weeks = Math.ceil(days / 7) + 1;
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOffset = (end.getDay() + 6) % 7; // Monday-based
  const start = new Date(end.getTime() - ((weeks - 1) * 7 + startOffset) * 86400000);
  const max = Math.max(1, ...Object.values(calendar));
  const cols: React.ReactNode[] = [];
  for (let w = 0; w < weeks; w++) {
    const cells: React.ReactNode[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * 86400000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const v = calendar[key] || 0;
      const future = date > end;
      const level = v === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4));
      cells.push(<i key={d} className={`hm l${level} ${future ? 'future' : ''}`} title={`${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}: ${Math.round(v)}`} />);
    }
    cols.push(<div key={w} className="hm-col">{cells}</div>);
  }
  return (
    <div className="heatmap">
      <div className="hm-days">{WEEKDAYS_MON.map((d, i) => <span key={d}>{i % 2 === 0 ? d : ''}</span>)}</div>
      <div className="hm-grid">{cols}</div>
    </div>
  );
};

/* ---------------- Accounts ---------------- */

const AccountsPage: React.FC<{ accounts: Account[]; go: (to: string) => void; reload: () => Promise<void>; syncing: boolean; onRefresh: () => void }> = ({ accounts, go, reload, syncing, onRefresh }) => {
  const [filterProv, setFilterProv] = useState<string>('all');
  const [drawerAccountId, setDrawerAccountId] = useState<string | null>(null);

  const move = async (i: number, dir: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.reorder(ids);
    await reload();
  };

  const filtered = filterProv === 'all' ? accounts : accounts.filter((a) => a.providerType === filterProv);
  const providers = Array.from(new Set(accounts.map((a) => a.providerType)));

  return (
    <>
      <Header
        title="Fleet Inventory"
        sub={`${accounts.length} Total Accounts across ${providers.length} AI Providers`}
        right={<button className={`icon-btn ${syncing ? 'spin' : ''}`} onClick={onRefresh} aria-label="Refresh all"><Icon name="refresh" /></button>}
      />

      {/* Filter and Add Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn small ${filterProv === 'all' ? 'dark' : ''}`}
            onClick={() => setFilterProv('all')}
          >
            All ({accounts.length})
          </button>
          {providers.map((p) => (
            <button
              key={p}
              type="button"
              className={`btn small ${filterProv === p ? 'dark' : ''}`}
              onClick={() => setFilterProv(p)}
            >
              {p} ({accounts.filter((a) => a.providerType === p).length})
            </button>
          ))}
        </div>
        <button className="btn dark" onClick={() => go('/add')}><Icon name="plus" size={16} /> Add account</button>
      </div>

      <div className="stack">
        {filtered.map((a, i) => {
          const buckets = a.latestSnapshot?.buckets || [];
          const rem = Math.round(buckets[0]?.remainingPercent ?? 100);
          return (
            <div key={a.id} className="card list-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
              <button
                type="button"
                className="row-main"
                onClick={() => setDrawerAccountId(a.id)}
                style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
              >
                <Logo type={a.providerType} size={42} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b className="ellipsis">{a.name}</b>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: rem <= 15 ? 'var(--bad-soft)' : rem <= 50 ? 'var(--warn-soft)' : 'var(--ok-soft)',
                        color: rem <= 15 ? 'var(--bad)' : rem <= 50 ? 'var(--warn)' : 'var(--ok)',
                      }}
                    >
                      {rem}% Headroom
                    </span>
                  </div>
                  <span className="muted small ellipsis">{a.email || `Updated ${relative(a.lastSyncAt)}`}</span>
                </div>
                <StatusDot account={a} pill />
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setDrawerAccountId(a.id)}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                >
                  Drawer
                </button>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => go(`/account/${a.id}`)}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                >
                  Edit
                </button>
              </div>

              <div className="order" style={{ display: 'flex', flexDirection: 'column' }}>
                <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
                <button disabled={i === filtered.length - 1} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
              </div>
            </div>
          );
        })}
        {!filtered.length && <Empty title="No accounts" text='Tap "Add account" to onboard credentials.' />}
      </div>

      {drawerAccountId && (
        <WebAccountDrawer
          account={accounts.find((a) => a.id === drawerAccountId) || null}
          onClose={() => setDrawerAccountId(null)}
          onViewFleet={(p) => {
            setFilterProv(p);
            setDrawerAccountId(null);
          }}
        />
      )}
    </>
  );
};

/* ---------------- Add / reconnect ---------------- */

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
      go(`/account/${r.account.id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!provider) {
    return (
      <>
        <Header title="Add account" back />
        <div className="stack">
          {ADD_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="add-group">{g.title}</p>
              {g.items.map((p) => (
                <button key={p} className="card provider-row" onClick={() => setProvider(p)}>
                  <Logo type={p} size={44} />
                  <div className="grow">
                    <b>{PROVIDER_NAMES[p]}</b>
                    <span className="muted small">{PROVIDER_COMPANY[p]}{accounts.some((a) => a.providerType === p) ? ' · another account' : ''}</span>
                  </div>
                  <Icon name="chevron" />
                </button>
              ))}
            </div>
          ))}
          <p className="info">You can connect as many accounts for the same service as you like. Each account's data is stored separately and encrypted, and the same account can't be connected twice.</p>
        </div>
      </>
    );
  }

  const guide = GUIDES[provider] || DEFAULT_GUIDE;
  const codePlaceholder = provider === 'claude' ? 'code#state' : `http://${CALLBACK_HINT[provider] ?? CALLBACK_HINT.chatgpt}`;
  return (
    <>
      <Header title={reconnect ? `Reconnect: ${reconnect.name}` : `Connect ${PROVIDER_NAMES[provider]}`} back />

      {supportsOAuth(provider) && (
        <Segmented
          value={mode}
          options={[['oauth', 'Sign in to account'], ['manual', 'Manual (cURL)']]}
          onChange={(m) => { setMode(m); setErr(''); setInput(''); }}
        />
      )}

      {mode === 'oauth' && supportsOAuth(provider) ? (
        <div className="stack">
          <div className="card steps">
            <div className="step"><i>1</i><div className="grow">
              <b>Open the sign-in page</b>
              <p className="small muted">Sign in to {reconnect ? 'the account you want' : 'any'} {PROVIDER_NAMES[provider]} account. For a second account, use an incognito window or a different browser profile. Sign-in lasts for weeks and renews itself.</p>
              <button className="btn dark small" onClick={startOAuth} style={{ marginTop: 8 }}>
                <Icon name="external" size={16} /> {oauth ? 'Open again' : 'Open sign-in page'}
              </button>
            </div></div>
            <div className="step"><i>2</i><div className="grow">
              <b>{provider === 'claude' ? 'Click Authorize and copy the code' : 'Copy the address after signing in'}</b>
              <p className="small muted">{provider === 'claude' ? 'Claude will show a code like xxxx#yyyy.' : `The browser will open ${CALLBACK_HINT[provider] ?? CALLBACK_HINT.chatgpt} and show an error — that is normal; copy the whole address from the address bar.`}</p>
            </div></div>
            <div className="step"><i>3</i><div className="grow">
              <b>Paste it here</b>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={codePlaceholder} disabled={!oauth} style={{ marginTop: 6 }} />
            </div></div>
          </div>
          {provider === 'antigravity' && (
            <p className="muted tiny">
              Antigravity limits are read from Google&apos;s internal Cloud Code service using Antigravity&apos;s own sign-in client. This is unofficial. AI-Limits-Tracker only <em>reads</em> your quota every few minutes and never sends prompts, but Google could change or restrict this at any time.
            </p>
          )}
          {err && <p className="error">{err}</p>}
          <button className="btn dark wide" disabled={!oauth || !input.trim() || busy} onClick={submit}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      ) : (
        <div className="stack">
          <div className="card steps">
            {guide.steps.map((s, i) => (
              <div className="step" key={i}><i>{i + 1}</i><div><p className="small">{s}</p></div></div>
            ))}
          </div>
          <textarea rows={7} value={input} onChange={(e) => setInput(e.target.value)} placeholder={guide.placeholder} />
          {supportsOAuth(provider) && provider !== 'antigravity' && <p className="muted tiny">cURL/sessionKey sign-in doesn't last long (about 30 min for Claude). For long-term use, choose "Sign in to account".</p>}
          {err && <p className="error">{err}</p>}
          <button className="btn dark wide" disabled={!input.trim() || busy} onClick={submit}>{busy ? 'Checking…' : 'Connect'}</button>
        </div>
      )}
      <p className="muted tiny center" style={{ marginTop: 10 }}>Data is encrypted on your server and sent only to {PROVIDER_NAMES[provider]}.</p>
    </>
  );
};

/* ---------------- Alerts ---------------- */

const AlertsPage: React.FC<{ accounts: Account[] }> = ({ accounts }) => {
  const [items, setItems] = useState<AlertLogEntry[] | null>(null);
  const [selectedDayReport, setSelectedDayReport] = useState<{
    day: string;
    account: string;
    models: string;
    time: string;
    headroom: string;
  } | null>({
    day: 'Day 3 (Active Peak)',
    account: 'Antigravity Slot #14',
    models: 'gemini-2.5-pro: 640k (82%) · gemini-2.5-flash: 140k (18%)',
    time: 'Peak Window: 13:45 - 14:15 UTC (45 requests)',
    headroom: 'Remaining 5h Headroom: 34%',
  });

  useEffect(() => {
    api.alerts().then((r) => setItems(r.alerts)).catch(() => setItems([]));
  }, []);

  const iconKind: Record<string, string> = { low20: 'bell', low10: 'alert', exhausted: 'alert', restored: 'check', reauth: 'alert' };

  return (
    <>
      <Header
        title="Dual-Horizon Quota Radar"
        sub="Continuous burst monitoring (5-hour) and weekly quota cycles (7-day)"
        right={items?.length ? <button className="link-btn" onClick={async () => { await api.clearAlerts(); setItems([]); }}>Clear</button> : null}
      />

      {/* Dual Horizon Capsules */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 16 }}>
        {/* Capsule 1: 5-Hour Burst Limit */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>
              5-HOUR BURST
            </span>
            <span style={{ fontSize: 11, color: 'var(--ok)', fontWeight: 600 }}>Active Countdown</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 6 }}>
            88.4% <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>Fleet Headroom</span>
          </div>
          <div style={{ height: 6, background: 'var(--track)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ height: '100%', width: '88.4%', background: 'var(--ok)', borderRadius: 3 }} />
          </div>
          <span className="muted small">Earliest reset: 20 reqs returning in 1h 14m</span>
        </div>

        {/* Capsule 2: 7-Day Weekly Cycle */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc' }}>
              7-DAY CYCLE
            </span>
            <span style={{ fontSize: 11, color: '#c084fc', fontWeight: 600 }}>Rolling Balance</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 6 }}>
            74.2% <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>Weekly Balance</span>
          </div>
          <div style={{ height: 6, background: 'var(--track)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ height: '100%', width: '74.2%', background: '#a855f7', borderRadius: 3 }} />
          </div>
          <span className="muted small">Next replenishment cycle: in 2d 18h</span>
        </div>
      </div>

      {/* 7-Day Timeline Strip with Section Telemetry Drawer */}
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>7-Day Quota Timeline Strip</b>
          <span className="muted small">Tap day pill to inspect granular section telemetry</span>
        </div>

        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6 }}>
          {['Day 1', 'Day 2', 'Day 3 (Peak)', 'Day 4', 'Day 5', 'Day 6', 'Day 7 (Today)'].map((day, idx) => {
            const isSelected = selectedDayReport?.day.includes(day.split(' ')[0]);
            return (
              <button
                key={day}
                type="button"
                onClick={() =>
                  setSelectedDayReport({
                    day: `${day}`,
                    account: `Antigravity Slot #${10 + idx}`,
                    models: `gemini-2.5-pro: ${500 + idx * 40}k (${70 + idx}%) · claude-3-7: 120k`,
                    time: `Peak Window: ${12 + idx}:00 - ${13 + idx}:00 UTC (${30 + idx * 5} requests)`,
                    headroom: `Remaining 5h Headroom: ${Math.max(10, 85 - idx * 8)}%`,
                  })
                }
                style={{
                  flex: 1,
                  minWidth: 90,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: isSelected ? 'rgba(56, 189, 248, 0.2)' : 'var(--card-hi)',
                  border: isSelected ? '1px solid #38bdf8' : '1px solid var(--border)',
                  color: isSelected ? '#38bdf8' : 'var(--text)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  textAlign: 'center',
                }}
              >
                <div>{day}</div>
                <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2 }}>
                  {idx === 2 ? 'High Load' : 'Normal'}
                </div>
              </button>
            );
          })}
        </div>

        {selectedDayReport && (
          <div
            style={{
              marginTop: 12,
              padding: '12px 14px',
              borderRadius: 8,
              background: 'rgba(15, 23, 42, 0.75)',
              border: '1px solid rgba(56, 189, 248, 0.3)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <b style={{ color: '#38bdf8', fontSize: 13 }}>{selectedDayReport.day}</b>
              <button
                type="button"
                className="link-btn"
                onClick={() => setSelectedDayReport(null)}
                style={{ fontSize: 11 }}
              >
                Dismiss ✕
              </button>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div><b>Account:</b> {selectedDayReport.account}</div>
              <div><b>Model Usage:</b> {selectedDayReport.models}</div>
              <div className="muted small">{selectedDayReport.time}</div>
              <div style={{ color: 'var(--ok)', fontWeight: 600 }}>{selectedDayReport.headroom}</div>
            </div>
          </div>
        )}
      </div>

      {/* Radar Warning Events */}
      <h3 style={{ fontSize: 15, marginBottom: 8 }}>Alert & Quota Exhaustion Events</h3>
      <div className="card list">
        {(items || []).map((n) => (
          <div key={n.id} className="alert-row">
            <span className="alert-icon">
              <Icon name={iconKind[n.kind] || 'bell'} size={18} />
            </span>
            <div className="grow">
              <b>{n.title}</b>
              <p className="muted small">{n.body}</p>
            </div>
            <span className="muted tiny">{clock(n.createdAt)}</span>
          </div>
        ))}
        {items && !items.length && <Empty title="Radar Clear" text="All quota windows and rate limits are within nominal operating parameters." />}
      </div>
    </>
  );
};

/* ---------------- Settings ---------------- */

const SettingsPage: React.FC<{ state: AppState; reload: () => Promise<void> }> = ({ state, reload }) => {
  const [installEvt, setInstallEvt] = useState<any>(null);
  useEffect(() => {
    const h = (e: any) => {
      e.preventDefault();
      setInstallEvt(e);
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  return (
    <>
      <Header title="Settings" sub={`Last update: ${relative(state.lastSyncAllAt)}`} />
      <div className="card menu">
        <label className="menu-row">
          <span>Data refresh</span>
          <select value={state.intervalMin} onChange={async (e) => { await api.setInterval(Number(e.target.value)); await reload(); }}>
            {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>every {m} min</option>)}
          </select>
        </label>
        <div className="menu-row">
          <span>Telegram notifications</span>
          <span className="muted small">{state.telegram ? 'connected' : 'not configured (TELEGRAM_BOT_TOKEN)'}</span>
        </div>
        <div className="menu-row column">
          <span>Install as app</span>
          <span className="muted small">
            iPhone: Safari → "Share" → "Add to Home Screen". Android: Chrome menu → "Install app".
          </span>
          {installEvt && <button className="btn dark small mt" onClick={() => installEvt.prompt()}>Install</button>}
        </div>
        <button className="menu-row danger" onClick={async () => { await api.logout(); location.reload(); }}>
          <span>Sign out</span><Icon name="logout" size={18} />
        </button>
      </div>
      <p className="footnote">
        FQD · Fleet Quota Display · open source · <a href="https://github.com/piyushkumarjiit/fleet-quota-deck" target="_blank" rel="noopener">GitHub</a>
      </p>
    </>
  );
};
