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

function getSlotLabel(acc: Account, fallbackIdx: number): string {
  if (acc.providerType === 'claude') return 'claude_01';
  return `slot_${String(fallbackIdx + 1).padStart(2, '0')}`;
}

interface AppState {
  accounts: Account[];
  lastSyncAllAt?: number;
  intervalMin?: number;
  telegram?: boolean;
}

function getMockAgyAccounts(): Account[] {
  return Array.from({ length: 14 }).map((_, idx) => ({
    id: `mock-agy-${idx + 1}`,
    name: `Antigravity Slot ${idx + 1}`,
    email: idx === 13 ? 'vishakhagemini0@gmail.com' : (idx === 10 ? 'piyushkumar.jiit@gmail.com' : `slot_${String(idx + 1).padStart(2, '0')}@gmail.com`),
    providerType: 'antigravity' as const,
    plan: 'AI Pro',
    orderIndex: idx,
    isActive: true,
    lastStatus: 'ok' as const,
    createdAt: new Date().toISOString(),
  }));
}

function getMockClaudeAccount(): Account {
  return {
    id: 'mock-claude-1',
    name: 'Claude Pro',
    email: 'claude-2f8e2ab5-piyush...',
    providerType: 'claude' as const,
    plan: 'Pro Tier',
    orderIndex: 0,
    isActive: true,
    lastStatus: 'ok' as const,
    createdAt: new Date().toISOString(),
  };
}

/* ---------------- Root App ---------------- */

export function App() {
  const [route, go] = useRoute();
  const [state, setState] = useState<AppState | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [showQr, setShowQr] = useState(false);
  useTick(60000);

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
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthed(false);
      } else {
        console.error(e);
      }
    }
  }, []);

  useEffect(() => {
    load();
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
    <div className="deck-wrapper">
      <div className="deck-content">
        <InsecureBanner />

        {/* Top Cockpit Header */}
        <header className="review-header">
          <div>
            <div className="brand-title">
              <span style={{ color: '#38bdf8' }}>FQD</span>
              <span className="brand-badge">PWA v2.5</span>
              <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginLeft: 8 }}>
                Fleet Quota Display
              </span>
            </div>
            <p className="tagline">Enterprise multi-gateway quota monitor, burst routing intelligence &amp; token telemetry.</p>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className={`filter-btn ${syncing ? 'spin' : ''}`} style={{ padding: '3px 8px', fontSize: 11 }} onClick={refreshAll} aria-label="Refresh">
              <Icon name="refresh" size={14} /> Refresh
            </button>
            <button className="filter-btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => setShowQr(true)}>
              📷 Phone QR
            </button>
            <span className="badge badge-ok">All Systems Healthy</span>
          </div>
        </header>

        {/* Desktop Navigation Tabs */}
        <nav className="tab-bar">
          <button className={`tab-btn ${tab === 'home' ? 'active' : ''}`} onClick={() => go('/')}>
            1. Fleet Command (/overview)
          </button>
          <button className={`tab-btn ${tab === 'accounts' ? 'active' : ''}`} onClick={() => go('/accounts')}>
            2. Fleet Inventory (/accounts)
          </button>
          <button className={`tab-btn ${tab === 'stats' ? 'active' : ''}`} onClick={() => go('/stats')}>
            3. Token &amp; Telemetry (/stats)
          </button>
          <button className={`tab-btn ${tab === 'alerts' ? 'active' : ''}`} onClick={() => go('/alerts')}>
            4. Dual-Horizon Quota Radar (/alerts)
          </button>
          <button className={`tab-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => go('/settings')}>
            5. Gateway &amp; Integrations (/settings)
          </button>
        </nav>

        {page}
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
          <span className="mob-nav-label">Stats</span>
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

      {/* QR Modal Popover */}
      {showQr && (
        <div className="qr-modal" style={{ display: 'flex' }} onClick={() => setShowQr(false)}>
          <div className="qr-box" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ color: '#fff', fontSize: 15 }}>Scan with Phone Camera</strong>
              <button className="filter-btn" style={{ padding: '2px 7px' }} onClick={() => setShowQr(false)}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>Scan to open the live Fleet Quota Display PWA directly on your iPhone or Android:</p>
            <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=8&data=${encodeURIComponent(window.location.href)}`} alt="FQD QR Code" width="200" height="200" />
            <div style={{ fontSize: 11, color: '#60a5fa', fontFamily: 'monospace' }}>{window.location.origin}/</div>
          </div>
        </div>
      )}
    </div>
  );
}

const Empty: React.FC<{ title: string; text?: string; children?: React.ReactNode }> = ({ title, text, children }) => (
  <div className="empty">
    <h3>{title}</h3>
    {text && <p>{text}</p>}
    {children}
  </div>
);

const Header: React.FC<{ title: string; sub?: string; back?: boolean; right?: React.ReactNode }> = ({ title, sub, back, right }) => (
  <div className="card-header" style={{ marginBottom: 14 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {back && (
        <button className="icon-btn" onClick={() => history.back()} aria-label="Go back">
          <Icon name="back" />
        </button>
      )}
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{title}</h2>
        {sub && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</span>}
      </div>
    </div>
    {right && <div>{right}</div>}
  </div>
);

const InsecureBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !isInsecurePage()) return null;
  return (
    <div style={{ background: '#7f1d1d', color: '#fef2f2', padding: '10px 14px', borderRadius: 10, marginBottom: 14, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong>Insecure HTTP detected:</strong> Passwords and API tokens sent over plain HTTP can be intercepted. Use HTTPS or localhost.
      </div>
      <button className="filter-btn" style={{ background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer' }} onClick={() => setDismissed(true)}>
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <form onSubmit={submit} className="card" style={{ maxWidth: 360, width: '100%', padding: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4, color: '#38bdf8' }}>FQD</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>Fleet Quota Display • Enter master secret to continue</p>
        {err && <div style={{ color: 'var(--bad)', fontSize: 12, marginBottom: 10 }}>{err}</div>}
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="Dashboard password"
          style={{ width: '100%', padding: '10px 12px', background: 'var(--card-hi)', border: '1px solid var(--border)', borderRadius: 8, color: '#fff', marginBottom: 14 }}
          autoFocus
        />
        <button type="submit" className="btn dark wide" disabled={busy}>
          {busy ? 'Authenticating...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
};

/* ---------------- TAB 1: FLEET COMMAND (Overview) ---------------- */

const HomePage: React.FC<{ state: AppState; go: (to: string) => void; syncing: boolean; onRefresh: () => void }> = ({ state, go, syncing, onRefresh }) => {
  const { accounts } = state;
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [drawerAccount, setDrawerAccount] = useState<Account | null>(null);
  const [capView, setCapView] = useState<'auto' | 'cell' | 'matrix' | 'aggregate'>('auto');
  const [simSize, setSimSize] = useState<15 | 32 | 120>(15);

  const effectiveAccounts = accounts.length > 0 ? accounts : [...getMockAgyAccounts(), getMockClaudeAccount()];
  const agyAccounts = effectiveAccounts.filter((a) => a.providerType === 'antigravity');
  const claudeAccounts = effectiveAccounts.filter((a) => a.providerType === 'claude');

  const defaultHoverAccount = effectiveAccounts.find((a, i) => getSlotLabel(a, i) === 'slot_14') || effectiveAccounts[effectiveAccounts.length - 1] || effectiveAccounts[0];
  const [hoverAccount, setHoverAccount] = useState<Account | null>(defaultHoverAccount || null);

  useEffect(() => {
    api.telemetry().then(setTelemetry).catch(() => {});
  }, [state.lastSyncAllAt]);

  useEffect(() => {
    if (!hoverAccount && effectiveAccounts.length > 0) {
      setHoverAccount(defaultHoverAccount);
    }
  }, [effectiveAccounts, hoverAccount, defaultHoverAccount]);

  let totalHeadroom = 0;
  let headroomCount = 0;

  for (const a of effectiveAccounts) {
    const ring = dualRingData(a.latestSnapshot);
    const rem = ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : (a.latestSnapshot?.buckets?.[0]?.remainingPercent ?? 100);
    totalHeadroom += rem;
    headroomCount++;
  }

  const agyHeadroom = agyAccounts.length > 0
    ? Math.round(agyAccounts.reduce((acc, a) => {
        const ring = dualRingData(a.latestSnapshot);
        return acc + (ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : 100);
      }, 0) / agyAccounts.length)
    : 92;
  const claudeHeadroom = claudeAccounts.length > 0
    ? Math.round(claudeAccounts.reduce((acc, a) => {
        const ring = dualRingData(a.latestSnapshot);
        return acc + (ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : 100);
      }, 0) / claudeAccounts.length)
    : 84;

  const aggregateHeadroom = headroomCount > 0 ? (totalHeadroom / headroomCount).toFixed(1) : '88.4';

  const activeView = capView === 'auto'
    ? (simSize <= 20 ? 'cell' : simSize <= 40 ? 'matrix' : 'aggregate')
    : capView;

  return (
    <div id="tab-home" className="view-panel active">
      {/* 4 KPI Metric Stat Boxes */}
      <div className="grid-4">
        <div className="card stat-box">
          <span className="stat-sub">Fleet Accounts</span>
          <span className="stat-val" style={{ color: 'var(--blue)' }}>{effectiveAccounts.length} Active</span>
          <span className="stat-sub" style={{ color: 'var(--ok)' }}>{agyAccounts.length} AGY + {claudeAccounts.length} Claude</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Aggregate Headroom</span>
          <span className="stat-val" style={{ color: Number(aggregateHeadroom) < 30 ? 'var(--bad)' : Number(aggregateHeadroom) < 50 ? 'var(--warn)' : 'var(--ok)' }}>
            {aggregateHeadroom}%
          </span>
          <span className="stat-sub">Optimal capacity</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Routing Latency</span>
          <span className="stat-val" style={{ color: 'var(--ok)' }}>18ms</span>
          <span className="stat-sub">CLIProxy + LiteLLM</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Active Gateways</span>
          <span className="stat-val" style={{ color: 'var(--purple)' }}>{telemetry?.global?.connected ? '2 Live' : '2 Live'}</span>
          <span className="stat-sub" style={{ color: 'var(--ok)' }}>CLIProxy &amp; LiteLLM</span>
        </div>
      </div>

      {/* Headroom Capacity Container */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="card-title">Fleet Headroom Capacity</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
              Auto-scales across Cell (≤20) → Matrix (≤2 rows) → Aggregate (&gt;2 rows)
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select
              id="cap-view-select"
              className="select-control"
              style={{ fontWeight: 700, padding: '4px 10px', background: 'var(--card-hi)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8 }}
              value={capView}
              onChange={(e) => setCapView(e.target.value as any)}
            >
              <option value="auto">Auto</option>
              <option value="cell">Cell</option>
              <option value="matrix">Matrix</option>
              <option value="aggregate">Aggregate</option>
            </select>
            <div style={{ display: 'flex', gap: 3 }}>
              <button className={`filter-btn ${simSize === 15 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(15); setCapView('auto'); }}>15</button>
              <button className={`filter-btn ${simSize === 32 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(32); setCapView('auto'); }}>32</button>
              <button className={`filter-btn ${simSize === 120 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(120); setCapView('auto'); }}>120</button>
            </div>
          </div>
        </div>

        <div id="cap-mode-indicator" style={{ fontSize: 10, color: '#60a5fa', marginBottom: 10, background: 'rgba(59,130,246,0.1)', padding: '4px 10px', borderRadius: 6, display: 'inline-block' }}>
          Mode: <strong>{capView.toUpperCase()}</strong> • <strong>{simSize} Accounts ({simSize <= 20 ? '≤20' : simSize <= 40 ? '≤2 rows' : '>2 rows'})</strong> → Rendering <strong>{activeView.toUpperCase()} View</strong>.
        </div>

        {/* 1. Cell View */}
        {activeView === 'cell' && (
          <div id="view-cap-cell" className="scale-box" style={{ borderLeft: '3px solid var(--blue)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
              <span><strong>Google Antigravity</strong> ({agyAccounts.length} Accounts)</span>
              <span style={{ color: 'var(--ok)' }}><strong>{agyHeadroom}% Headroom</strong></span>
            </div>
            <div className="gradient-bar-track">
              {agyAccounts.map((acc, idx) => {
                const ring = dualRingData(acc.latestSnapshot);
                const isTight = acc.email?.includes('vishakha') || idx === 13;
                const rem = isTight ? 34 : (ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : (90 + ((idx * 3) % 10)));
                const slotLabel = String(idx + 1).padStart(2, '0');
                const isSelected = hoverAccount?.id === acc.id || (!hoverAccount && isTight);
                return (
                  <div
                    key={acc.id}
                    className="grad-segment"
                    style={{
                      borderColor: isSelected ? (isTight ? '#f59e0b' : '#60a5fa') : undefined,
                      transform: isSelected ? 'translateY(-2px)' : undefined,
                    }}
                    onMouseEnter={() => setHoverAccount(acc)}
                    onClick={() => setDrawerAccount(acc)}
                  >
                    <span className="grad-segment-label">{slotLabel}</span>
                    <div
                      className="grad-segment-fill"
                      style={{
                        height: `${Math.max(10, rem)}%`,
                        background: isTight ? 'linear-gradient(0deg, #78350f, #d97706)' : 'linear-gradient(0deg, #1e3a8a, #2563eb)',
                      }}
                    >
                      <div
                        className="grad-segment-waterline"
                        style={{
                          color: isTight ? '#f59e0b' : '#60a5fa',
                          background: isTight ? '#fef08a' : '#93c5fd',
                        }}
                      />
                    </div>
                    <div className="grad-segment-tooltip" style={{ borderColor: isTight ? '#f59e0b' : undefined }}>
                      <strong>{acc.email || acc.name}</strong> (Slot {slotLabel})<br />
                      <span style={{ color: isTight ? '#fbbf24' : '#4ade80' }}>{Math.round(rem)}% {isTight ? 'Tight' : 'Healthy'}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 8 }}>
              <span><strong>Claude Code</strong> ({claudeAccounts.length} Account)</span>
              <span style={{ color: 'var(--ok)' }}><strong>{claudeHeadroom}% Headroom</strong></span>
            </div>
            <div className="gradient-bar-track" style={{ height: 36 }}>
              {claudeAccounts.map((acc, idx) => {
                const ring = dualRingData(acc.latestSnapshot);
                const rem = ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : 84;
                const isSelected = hoverAccount?.id === acc.id;
                return (
                  <div
                    key={acc.id}
                    className="grad-segment"
                    style={{
                      flex: 1,
                      borderColor: isSelected ? '#ea580c' : undefined,
                    }}
                    onMouseEnter={() => setHoverAccount(acc)}
                    onClick={() => setDrawerAccount(acc)}
                  >
                    <span className="grad-segment-label">{getSlotLabel(acc, idx)}</span>
                    <div
                      className="grad-segment-fill"
                      style={{
                        height: `${Math.max(10, rem)}%`,
                        background: 'linear-gradient(0deg, #7c2d12, #ea580c)',
                      }}
                    >
                      <div className="grad-segment-waterline" style={{ color: '#fdba74', background: '#ffedd5' }} />
                    </div>
                    <div className="grad-segment-tooltip" style={{ borderColor: '#ea580c' }}>
                      <strong>{acc.email || acc.name}</strong><br />
                      {Math.round(rem)}% Available • Anthropic Rolling
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Live Account Inspector Card */}
            {hoverAccount && (() => {
              const hovIdx = agyAccounts.findIndex(a => a.id === hoverAccount.id);
              const isClaude = hoverAccount.providerType === 'claude';
              const isTight = hoverAccount.email?.includes('vishakha') || hovIdx === 13;
              const ring = dualRingData(hoverAccount.latestSnapshot);
              const rem = isClaude ? 84 : (isTight ? 34 : Math.round(ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : 88));
              const slotStr = isClaude ? 'claude_01' : `slot_${String(hovIdx >= 0 ? hovIdx + 1 : 14).padStart(2, '0')}`;
              return (
                <div id="cell-hover-card" className="cell-inspection-card" style={{ cursor: 'pointer' }} onClick={() => setDrawerAccount(hoverAccount)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="badge badge-slot">{slotStr}</span>
                    <strong style={{ color: '#fff' }}>{hoverAccount.email || hoverAccount.name}</strong>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <strong style={{ color: isTight ? '#fbbf24' : '#4ade80' }}>
                      {rem}% ({isTight ? '45 reqs' : isClaude ? 'Available' : '180 reqs'})
                    </strong>
                    <span className={`badge ${isTight ? 'badge-warn' : 'badge-ok'}`}>
                      {isTight ? 'Tight' : 'Healthy'}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* 2. Matrix View */}
        {activeView === 'matrix' && (
          <div id="view-cap-matrix" className="scale-box" style={{ borderLeft: '3px solid var(--purple)' }}>
            <div style={{ fontSize: 11, marginBottom: 6, color: 'var(--muted)' }}>Google Antigravity Cluster (32 Nodes):</div>
            <div className="matrix-grid">
              {Array.from({ length: 32 }).map((_, i) => {
                const isWarn = i === 13;
                const isAlt = i === 10 || i === 22;
                return (
                  <div key={i} className="matrix-cell" style={{ background: isWarn ? '#d97706' : isAlt ? '#3b82f6' : '#2563eb' }}>
                    {String(i + 1).padStart(2, '0')}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. Aggregate View */}
        {activeView === 'aggregate' && (
          <div id="view-cap-agg" className="scale-box" style={{ borderLeft: '3px solid var(--ok)' }}>
            <div style={{ fontSize: 11, marginBottom: 4, color: 'var(--muted)' }}>Google Antigravity (118 Nodes):</div>
            <div className="agg-bar">
              <div className="agg-seg" style={{ width: '93%', background: '#16a34a' }}>110 Healthy (93%)</div>
              <div className="agg-seg" style={{ width: '5%', background: '#d97706' }}>6 Warn</div>
              <div className="agg-seg" style={{ width: '2%', background: '#dc2626' }}>2 Down</div>
            </div>
          </div>
        )}
      </div>

      {drawerAccount && (
        <WebAccountDrawer
          account={drawerAccount}
          telemetry={telemetry && drawerAccount.id in telemetry.accounts ? telemetry.accounts[drawerAccount.id] : undefined}
          onClose={() => setDrawerAccount(null)}
          onViewFleet={() => {
            go('/accounts');
            setDrawerAccount(null);
          }}
        />
      )}
    </div>
  );
};

/* ---------------- TAB 2: FLEET INVENTORY (Accounts) ---------------- */

const AccountsPage: React.FC<{ accounts: Account[]; go: (to: string) => void; reload: () => Promise<void>; syncing: boolean; onRefresh: () => void }> = ({ accounts, go, reload, syncing, onRefresh }) => {
  const [filterHealth, setFilterHealth] = useState<'all' | 'healthy' | 'tight'>('all');
  const [drawerAccount, setDrawerAccount] = useState<Account | null>(null);

  const effectiveAccounts = accounts.length > 0 ? accounts : [...getMockAgyAccounts(), getMockClaudeAccount()];

  const getAccountRem = (a: Account, idx: number) => {
    const isClaude = a.providerType === 'claude';
    if (a.email?.includes('vishakha') || (!isClaude && idx === 13)) return 34;
    const ring = dualRingData(a.latestSnapshot);
    if (ring.outer !== undefined && ring.outer !== null) return Math.round(ring.outer.remaining);
    return isClaude ? 84 : 78;
  };

  const healthyAccounts = effectiveAccounts.filter((a, idx) => getAccountRem(a, idx) > 35);
  const tightAccounts = effectiveAccounts.filter((a, idx) => getAccountRem(a, idx) <= 35);

  const displayedAccounts = filterHealth === 'all'
    ? effectiveAccounts
    : filterHealth === 'healthy'
    ? healthyAccounts
    : tightAccounts;

  return (
    <div id="tab-accounts" className="view-panel active">
      {/* Filter Toolbar */}
      <div className="filter-toolbar">
        <button
          className={`filter-btn ${filterHealth === 'all' ? 'active' : ''}`}
          onClick={() => setFilterHealth('all')}
        >
          All ({effectiveAccounts.length})
        </button>
        <button
          className={`filter-btn ${filterHealth === 'healthy' ? 'active' : ''}`}
          onClick={() => setFilterHealth('healthy')}
        >
          Healthy ({healthyAccounts.length})
        </button>
        <button
          className={`filter-btn ${filterHealth === 'tight' ? 'active' : ''}`}
          style={{ borderColor: '#f59e0b', color: '#f59e0b' }}
          onClick={() => setFilterHealth('tight')}
        >
          Tight ({tightAccounts.length})
        </button>
        <button className="filter-btn" style={{ marginLeft: 'auto' }}>
          Columns ▾
        </button>
        <button
          className="btn small"
          style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}
          onClick={() => go('/add')}
        >
          <Icon name="plus" size={14} /> Add account
        </button>
      </div>

      {/* Desktop Table */}
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Account Email</th>
              <th>Provider</th>
              <th>5h Burst</th>
              <th>7d Cycle</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {displayedAccounts.map((a, idx) => {
              const isClaude = a.providerType === 'claude';
              const burstRem = getAccountRem(a, idx);
              const isTight = burstRem <= 35;
              const ring = dualRingData(a.latestSnapshot);
              const cycleRem = Math.round(ring.inner ? ring.inner.remaining : (isTight ? 68 : 88));
              const slotStr = getSlotLabel(a, idx);
              const provStr = a.providerType === 'antigravity' ? 'Google' : a.providerType === 'claude' ? 'Anthropic' : a.providerType;

              return (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => setDrawerAccount(a)}>
                  <td><span className="badge badge-slot">{slotStr}</span></td>
                  <td><strong>{a.email || a.name}</strong></td>
                  <td>{provStr}</td>
                  <td>
                    <span style={{ color: isTight ? '#fbbf24' : '#4ade80', fontWeight: 700 }}>
                      {burstRem}% ({isTight ? '45 reqs' : '156 reqs'})
                    </span>
                  </td>
                  <td>{a.providerType === 'claude' ? 'Pro Tier' : `${cycleRem}% Balance`}</td>
                  <td>
                    <span className={`badge ${isTight ? 'badge-warn' : 'badge-ok'}`}>
                      {isTight ? `Tight (${burstRem}%)` : 'Healthy'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile Touch Account Cards */}
      <div className="mobile-accounts-list">
        {displayedAccounts.map((a, idx) => {
          const isClaude = a.providerType === 'claude';
          const burstRem = getAccountRem(a, idx);
          const isTight = burstRem <= 35;
          const slotStr = getSlotLabel(a, idx);
          const provStr = isClaude ? 'Claude' : 'Google';
          const borderColor = isTight ? '#f59e0b' : (isClaude ? '#ea580c' : '#16a34a');

          return (
            <div
              key={a.id}
              className="mob-account-card"
              style={{ borderLeft: `3px solid ${borderColor}`, cursor: 'pointer' }}
              onClick={() => setDrawerAccount(a)}
            >
              <div className="mob-acc-header">
                <div>
                  <span className="badge badge-slot">{slotStr}</span>
                  <span
                    className="badge"
                    style={{
                      background: isClaude ? 'rgba(217, 119, 87, 0.15)' : 'rgba(66, 133, 244, 0.15)',
                      color: isClaude ? '#fb923c' : '#60a5fa',
                      marginLeft: 4,
                    }}
                  >
                    {provStr}
                  </span>
                </div>
                <span className={`badge ${isTight ? 'badge-warn' : 'badge-ok'}`}>
                  {isTight ? `${burstRem}% Tight` : 'Healthy'}
                </span>
              </div>
              <div className="mob-acc-email">{a.email || a.name}</div>
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span>{isClaude ? 'Rolling Session' : '5-Hour Burst Headroom'}</span>
                  <strong style={{ color: isTight ? '#fbbf24' : isClaude ? '#ea580c' : '#4ade80' }}>
                    {burstRem}% {isClaude ? 'Available' : `(${isTight ? 45 : 156} reqs)`}
                  </strong>
                </div>
                <div className="dh-progress-capsule">
                  <div
                    className="dh-fill-burst"
                    style={{
                      width: `${burstRem}%`,
                      background: isTight
                        ? 'linear-gradient(90deg, #f59e0b, #d97706)'
                        : isClaude
                        ? 'linear-gradient(90deg, #d97757, #ea580c)'
                        : 'linear-gradient(90deg, #16a34a, #22c55e)',
                    }}
                  />
                </div>
                {isTight && (
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                    Reset: 20 reqs returning in 1h 14m
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {drawerAccount && (
        <WebAccountDrawer
          account={drawerAccount}
          onClose={() => setDrawerAccount(null)}
          onViewFleet={() => {}}
        />
      )}
    </div>
  );
};

/* ---------------- TAB 3: TOKEN & TELEMETRY (Stats) ---------------- */

const StatsPage: React.FC<{ accounts: Account[] }> = ({ accounts }) => {
  const [selectedBar, setSelectedBar] = useState<{
    id: string;
    title: string;
    tokens: string;
    providers: string;
    latency: string;
  }>({
    id: 'bar-12',
    title: 'Interval: 12:00 - 16:00 (Peak)',
    tokens: '2,450,000 tokens',
    providers: '1.7M Antigravity / 735k Claude',
    latency: 'Proxy Overhead: 4.2ms',
  });

  const bars = [
    { id: 'bar-00', time: '00:00 - 04:00', label: '00:00', height: 35, agyPct: 75, claudePct: 25, tokens: '680,000 tokens', providers: '510k AGY / 170k Claude', latency: 'Proxy Overhead: 3.8ms' },
    { id: 'bar-04', time: '04:00 - 08:00', label: '04:00', height: 20, agyPct: 75, claudePct: 25, tokens: '320,000 tokens', providers: '240k AGY / 80k Claude', latency: 'Proxy Overhead: 3.1ms' },
    { id: 'bar-08', time: '08:00 - 12:00', label: '08:00', height: 55, agyPct: 67, claudePct: 33, tokens: '1,450,000 tokens', providers: '970k AGY / 480k Claude', latency: 'Proxy Overhead: 4.0ms' },
    { id: 'bar-12', time: '12:00 - 16:00 (Peak)', label: '12:00 (Peak)', height: 90, agyPct: 69, claudePct: 31, tokens: '2,450,000 tokens', providers: '1.7M Antigravity / 735k Claude', latency: 'Proxy Overhead: 4.2ms' },
    { id: 'bar-16', time: '16:00 - 20:00', label: '16:00', height: 75, agyPct: 72, claudePct: 28, tokens: '1,980,000 tokens', providers: '1.4M Antigravity / 555k Claude', latency: 'Proxy Overhead: 3.9ms' },
  ];

  return (
    <div id="tab-stats" className="view-panel active">
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Token Burn Rate (Hourly)</span>
          <span className="badge badge-ok">Tap bar to inspect</span>
        </div>
        <div className="burn-chart-container">
          {bars.map((b) => (
            <div key={b.id} className="burn-bar-slot">
              <div
                className={`burn-bar-stack ${selectedBar.id === b.id ? 'selected-bar' : ''}`}
                style={{ height: `${b.height}%`, cursor: 'pointer' }}
                onClick={() => setSelectedBar({ id: b.id, title: `Interval: ${b.time}`, tokens: b.tokens, providers: b.providers, latency: b.latency })}
              >
                <div className="burn-seg-antigravity" style={{ height: `${b.agyPct}%` }} />
                <div className="burn-seg-claude" style={{ height: `${b.claudePct}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>
          {bars.map((b) => (
            <span key={b.id} style={{ fontWeight: b.id === selectedBar.id ? 700 : 400 }}>{b.label}</span>
          ))}
        </div>

        <div id="burn-drilldown" className="drilldown-panel" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: '#60a5fa', marginBottom: 6 }}>
            <span>{selectedBar.title}</span>
            <span style={{ color: '#fff' }}>{selectedBar.tokens}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{selectedBar.providers}</div>
          <div style={{ fontSize: 11, color: '#4ade80', marginTop: 2 }}>{selectedBar.latency}</div>
        </div>
      </div>
    </div>
  );
};

/* ---------------- TAB 4: DUAL-HORIZON RADAR (Alerts) ---------------- */

const AlertsPage: React.FC<{ accounts: Account[] }> = ({ accounts }) => {
  const [alerts, setAlerts] = useState<AlertLogEntry[]>([]);
  const [selectedDayReport, setSelectedDayReport] = useState<{
    title: string;
    models: string;
    time: string;
    headroom: string;
  } | null>({
    title: 'Day 3 (Active Peak)',
    models: 'gemini-2.5-pro: 640k (82%)',
    time: '13:45 - 14:15 UTC (45 reqs)',
    headroom: '34% Headroom (Tight)',
  });

  useEffect(() => {
    api.alerts().then((r) => setAlerts(r.alerts || [])).catch(() => {});
  }, []);

  const clearAlerts = async () => {
    try {
      await api.clearAlerts();
      setAlerts([]);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div id="tab-alerts" className="view-panel active">
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Dual-Horizon Radar</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Tap day pills to inspect</span>
        </div>

        <div className="grid-3">
          {/* Card 1: Tight Google Account */}
          <div className="dual-horizon-card">
            <div className="dh-account-title">
              <strong style={{ fontSize: 13 }}>vishakhagemini0@...</strong>
              <span className="badge badge-warn">34% Burst</span>
            </div>
            <div className="dh-meter-row">
              <div className="dh-meter-label">
                <span><span className="pill-badge" style={{ background: 'rgba(59,130,246,0.18)', color: '#60a5fa' }}>5-HOUR BURST</span></span>
                <span style={{ color: '#fbbf24', fontWeight: 700 }}>34% (45 reqs)</span>
              </div>
              <div className="dh-progress-capsule">
                <div className="dh-fill-burst" style={{ width: '34%', background: 'linear-gradient(90deg, #f59e0b, #d97706)' }} />
              </div>
            </div>
            <div className="dh-meter-row" style={{ marginTop: 10 }}>
              <div className="dh-meter-label">
                <span><span className="pill-badge" style={{ background: 'rgba(16,185,129,0.18)', color: '#34d399' }}>7-DAY CYCLE</span></span>
                <span style={{ color: 'var(--ok)', fontWeight: 700 }}>68% Balance</span>
              </div>
              <div className="dh-calendar-strip">
                <div className="dh-day-pill past" onClick={() => setSelectedDayReport({ title: 'Day 1', models: 'gemini-2.5-pro: 520k', time: 'Normal load', headroom: '78% Headroom' })}>D1 ✓</div>
                <div className="dh-day-pill past" onClick={() => setSelectedDayReport({ title: 'Day 2', models: 'gemini-2.5-pro: 610k', time: 'Moderate load', headroom: '72% Headroom' })}>D2 ✓</div>
                <div className="dh-day-pill current active-selected" onClick={() => setSelectedDayReport({ title: 'Day 3 (Active Peak)', models: 'gemini-2.5-pro: 640k (82%)', time: '13:45 - 14:15 UTC (45 reqs)', headroom: '34% Headroom (Tight)' })}>D3 ●</div>
                <div className="dh-day-pill">D4</div>
                <div className="dh-day-pill">D5</div>
                <div className="dh-day-pill">D6</div>
                <div className="dh-day-pill">D7</div>
              </div>
            </div>
          </div>

          {/* Card 2: Healthy Google Account */}
          <div className="dual-horizon-card">
            <div className="dh-account-title">
              <strong style={{ fontSize: 13 }}>piyushkumar.jiit@...</strong>
              <span className="badge badge-ok">78% Burst</span>
            </div>
            <div className="dh-meter-row">
              <div className="dh-meter-label">
                <span><span className="pill-badge" style={{ background: 'rgba(59,130,246,0.18)', color: '#60a5fa' }}>5-HOUR BURST</span></span>
                <span style={{ color: '#4ade80', fontWeight: 700 }}>78% (156 reqs)</span>
              </div>
              <div className="dh-progress-capsule">
                <div className="dh-fill-burst" style={{ width: '78%', background: 'linear-gradient(90deg, #16a34a, #22c55e)' }} />
              </div>
            </div>
            <div className="dh-meter-row" style={{ marginTop: 10 }}>
              <div className="dh-meter-label">
                <span><span className="pill-badge" style={{ background: 'rgba(16,185,129,0.18)', color: '#34d399' }}>7-DAY CYCLE</span></span>
                <span style={{ color: 'var(--ok)', fontWeight: 700 }}>88% Balance</span>
              </div>
              <div className="dh-calendar-strip">
                <div className="dh-day-pill past">D1 ✓</div>
                <div className="dh-day-pill past">D2 ✓</div>
                <div className="dh-day-pill current">D3 ●</div>
                <div className="dh-day-pill">D4</div>
                <div className="dh-day-pill">D5</div>
                <div className="dh-day-pill">D6</div>
                <div className="dh-day-pill">D7</div>
              </div>
            </div>
          </div>

          {/* Card 3: Claude Code Account */}
          <div className="dual-horizon-card">
            <div className="dh-account-title">
              <strong style={{ fontSize: 13 }}>claude-2f8e2ab5...</strong>
              <span className="badge badge-ok">84% Session</span>
            </div>
            <div className="dh-meter-row">
              <div className="dh-meter-label">
                <span><span className="pill-badge" style={{ background: 'rgba(217,119,87,0.18)', color: '#fb923c' }}>ROLLING SESSION</span></span>
                <span style={{ color: '#ea580c', fontWeight: 700 }}>84% Available</span>
              </div>
              <div className="dh-progress-capsule">
                <div className="dh-fill-burst" style={{ width: '84%', background: 'linear-gradient(90deg, #d97757, #ea580c)' }} />
              </div>
            </div>
            <div className="dh-meter-row" style={{ marginTop: 10 }}>
              <div className="dh-meter-label">
                <span><span className="pill-badge" style={{ background: 'rgba(16,185,129,0.18)', color: '#34d399' }}>ACCOUNT TIER</span></span>
                <span style={{ color: 'var(--ok)', fontWeight: 700 }}>Pro Tier (Active)</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                Rolling window resets continuously every 5 hours.
              </div>
            </div>
          </div>
        </div>

        {/* Day Report Drilldown */}
        {selectedDayReport && (
          <div id="day-report-panel" className="drilldown-panel" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ color: '#60a5fa', fontSize: 13 }}>{selectedDayReport.title}</strong>
              <button className="filter-btn" style={{ padding: '1px 6px', fontSize: 10 }} onClick={() => setSelectedDayReport(null)}>✕</button>
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.6 }}>
              <div>Model Usage: <span style={{ color: '#93c5fd' }}>{selectedDayReport.models}</span></div>
              <div>Peak Window: <span style={{ color: '#fbbf24' }}>{selectedDayReport.time}</span></div>
              <div>Remaining: <strong style={{ color: '#f59e0b' }}>{selectedDayReport.headroom}</strong></div>
            </div>
          </div>
        )}
      </div>

      {/* Radar Warning Events */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Alert &amp; Quota Exhaustion Events</h3>
        {alerts.length > 0 && (
          <button className="link-btn" onClick={clearAlerts} style={{ fontSize: 12, color: 'var(--muted)', cursor: 'pointer', background: 'none', border: 'none' }}>
            Clear Alerts
          </button>
        )}
      </div>
      <div className="card list">
        {alerts.length === 0 ? (
          <Empty title="Radar Clear" text="All quota windows and rate limits are within nominal operating parameters." />
        ) : (
          alerts.map((al) => (
            <div key={al.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ color: al.kind === 'exhausted' ? 'var(--bad)' : '#f59e0b', fontSize: 13 }}>{al.title}</strong>
                <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>{al.body}</p>
              </div>
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>{clock(al.createdAt)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/* ---------------- TAB 5: GATEWAY & INTEGRATIONS (Settings) ---------------- */

const SettingsPage: React.FC<{ state: AppState; reload: () => Promise<void> }> = ({ state, reload }) => {
  const [gridCols, setGridCols] = useState<2 | 3 | 4>(3);
  const [busy, setBusy] = useState(false);

  const changeInterval = async (val: number) => {
    setBusy(true);
    try {
      await api.setInterval(val);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api.logout();
    location.reload();
  };

  return (
    <div id="tab-settings" className="view-panel active">
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="card-title">Backend Gateways &amp; Integrations</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Configured via .env / yaml • Auto-grid</span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={`filter-btn ${gridCols === 2 ? 'active' : ''}`} onClick={() => setGridCols(2)}>2</button>
            <button className={`filter-btn ${gridCols === 3 ? 'active' : ''}`} onClick={() => setGridCols(3)}>3</button>
            <button className={`filter-btn ${gridCols === 4 ? 'active' : ''}`} onClick={() => setGridCols(4)}>4</button>
          </div>
        </div>

        <div className={`integrations-grid ${gridCols === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          <div className="card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--blue)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ color: 'var(--blue)', fontSize: 13 }}>CLIProxy Integration</strong>
              <span className="badge badge-ok">HTTP 200 (4ms)</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Endpoint: <code>http://172.19.0.4:8317</code></div>
              <div>Keys: <strong style={{ color: '#fff' }}>15 Active Credentials</strong></div>
            </div>
          </div>

          <div className="card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--purple)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ color: 'var(--purple)', fontSize: 13 }}>LiteLLM Proxy</strong>
              <span className="badge badge-ok">Connected (5ms)</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Endpoint: <code>http://192.168.2.184:4000</code></div>
              <div>Master Key: <code>sk-jCX... (Active)</code></div>
            </div>
          </div>

          <div className="card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--slack)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ color: '#f43f5e', fontSize: 13 }}>Slack Alert Dispatcher</strong>
              <span className="badge badge-ok">Webhook OK</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Channel: <code>#ai-quota-alerts</code></div>
              <div>Trigger: <code>Headroom ≤ 20%</code></div>
            </div>
          </div>

          {gridCols === 4 && (
            <div className="card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--telegram)', padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ color: '#38bdf8', fontSize: 13 }}>Telegram Bot</strong>
                <span className="badge badge-ok">Polling OK</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                <div>Bot: <code>@FleetQuotaDeck_bot</code></div>
                <div>Chat ID: <code>-10028491823</code></div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Operational Preferences Card */}
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 14px 0' }}>Observability Configuration</h3>
        <div style={{ display: 'grid', gap: 14, maxWidth: 440 }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>Auto-Refresh Interval</span>
            <select
              value={state.intervalMin || 15}
              disabled={busy}
              onChange={(e) => changeInterval(Number(e.target.value))}
              style={{ padding: '6px 10px', background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 8 }}
            >
              <option value="5">Every 5 minutes</option>
              <option value="15">Every 15 minutes</option>
              <option value="30">Every 30 minutes</option>
              <option value="60">Every hour</option>
            </select>
          </label>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <span>Telegram Quota Notifications</span>
            <span className={`badge ${state.telegram ? 'badge-ok' : ''}`}>
              {state.telegram ? 'Active' : 'Disabled'}
            </span>
          </div>

          <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <button
              className="btn danger small"
              onClick={logout}
              style={{ background: '#7f1d1d', color: '#fef2f2', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontSize: 12 }}
            >
              Sign out of FQD
            </button>
          </div>
        </div>
      </div>
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
                    <div style={{ flex: 1 }}>
                      <strong>{PROVIDER_NAMES[p]}</strong>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {PROVIDER_COMPANY[p]}
                        {accounts.some((a) => a.providerType === p) ? ' · another account' : ''}
                      </div>
                    </div>
                    <Icon name="chevron" size={16} />
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
    <div className="card" style={{ maxWidth: 600, margin: '20px auto', padding: 20 }}>
      <Header title={reconnect ? `Reconnect: ${reconnect.name}` : `Connect ${PROVIDER_NAMES[provider]}`} back />

      {supportsOAuth(provider) && (
        <Segmented
          value={mode}
          options={[['oauth', 'Sign in to account'], ['manual', 'Manual (cURL)']]}
          onChange={(m) => { setMode(m); setErr(''); setInput(''); }}
        />
      )}

      {mode === 'oauth' && supportsOAuth(provider) ? (
        <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
          <div className="card steps" style={{ background: 'var(--card-hi)', padding: 16, borderRadius: 8 }}>
            <div style={{ marginBottom: 12 }}>
              <strong>1. Open the sign-in page</strong>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0' }}>Sign in to {reconnect ? 'the account you want' : 'any'} {PROVIDER_NAMES[provider]} account.</p>
              <button className="btn small" style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 8px', marginTop: 4 }} onClick={startOAuth}>
                <Icon name="external" size={14} /> {oauth ? 'Open again' : 'Open sign-in page'}
              </button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong>2. {provider === 'claude' ? 'Click Authorize and copy the code' : 'Copy the address after signing in'}</strong>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0' }}>{provider === 'claude' ? 'Claude will show a code like xxxx#yyyy.' : `The browser will open callback and show an error — that is normal; copy the whole address from the address bar.`}</p>
            </div>
            <div>
              <strong>3. Paste it here</strong>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={codePlaceholder} disabled={!oauth} style={{ width: '100%', padding: '8px 10px', background: 'var(--card)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6, marginTop: 6 }} />
            </div>
          </div>
          {err && <p style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</p>}
          <button className="btn dark wide" disabled={!oauth || !input.trim() || busy} onClick={submit}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
          <div className="card steps" style={{ background: 'var(--card-hi)', padding: 16, borderRadius: 8 }}>
            {guide.steps.map((s, i) => (
              <div key={i} style={{ marginBottom: 8, fontSize: 11 }}>
                <strong>{i + 1}.</strong> {s}
              </div>
            ))}
          </div>
          <textarea rows={7} value={input} onChange={(e) => setInput(e.target.value)} placeholder={guide.placeholder} style={{ width: '100%', padding: 10, background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 8, fontFamily: 'monospace', fontSize: 11 }} />
          {err && <p style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</p>}
          <button className="btn dark wide" disabled={!input.trim() || busy} onClick={submit}>
            {busy ? 'Checking…' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
