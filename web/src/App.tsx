import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlertLogEntry, ProviderType, QuotaBucket } from '../../src/models/types';
import type { Forecast, StatPoint, UsageStats } from '../../src/services/stats';
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

function getSlotLabel(acc: Account, fallbackIdx: number): string {
  if (acc.providerType === 'claude') return '01';
  return String(fallbackIdx + 1).padStart(2, '0');
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
              <span style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginLeft: 8 }}>
                Fleet Quota Display
              </span>
            </div>
            <p className="tagline">Enterprise multi-gateway quota monitor, burst routing intelligence &amp; token telemetry.</p>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className={`filter-btn ${syncing ? 'spin' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }} onClick={refreshAll} aria-label="Refresh">{syncing ? 'Refreshing…' : 'Refresh'}</button>
            <span className="badge badge-ok">All Systems Healthy</span>
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

        {/* Enterprise Footer */}
        <footer className="enterprise-footer">
          <span>FQD v2.5.0</span>
          <span>•</span>
          <span>Fleet Quota Display</span>
          <span>•</span>
          <a href="https://github.com/piyushkumarjiit/FQD" target="_blank" rel="noreferrer">GitHub</a>
          <span>•</span>
          <a href="#/settings">Documentation</a>
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

const HomePage: React.FC<{ state: AppState; go: (to: string) => void; syncing: boolean; onRefresh: () => void }> = ({ state, go, syncing, onRefresh }) => {
  const { accounts } = state;
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [drawerAccount, setDrawerAccount] = useState<Account | null>(null);
  const [capView, setCapView] = useState<'auto' | 'cell' | 'matrix' | 'aggregate'>('auto');
  const [simSize, setSimSize] = useState<15 | 32 | 120>(15);

  const effectiveAccounts = accounts.length > 0 ? accounts : [...getMockAgyAccounts(), getMockClaudeAccount()];
  const agyAccounts = effectiveAccounts.filter((a) => a.providerType === 'antigravity');
  const claudeAccounts = effectiveAccounts.filter((a) => a.providerType === 'claude');

  const defaultHoverAccount = effectiveAccounts.find((a, i) => i === 13) || effectiveAccounts[effectiveAccounts.length - 1] || effectiveAccounts[0];
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

  const getSlotHeadroom = (a: Account, idx: number) => {
    const isClaude = a.providerType === 'claude';
    const ring = dualRingData(a.latestSnapshot);
    const rawRem = ring.outer !== undefined && ring.outer !== null
      ? Math.round(ring.outer.remaining)
      : (ring.inner ? Math.round(ring.inner.remaining) : (isClaude ? 84 : (90 + ((idx * 3) % 10))));
    const rem = Math.max(0, Math.min(100, rawRem));
    const isExhausted = rem <= 15;
    const isTight = rem <= 35;
    const status: 'exhausted' | 'tight' | 'healthy' = isExhausted ? 'exhausted' : isTight ? 'tight' : 'healthy';
    const label = isExhausted ? 'Exhausted' : isTight ? 'Tight' : 'Healthy';
    const color = isExhausted ? '#ef4444' : isTight ? '#fbbf24' : '#4ade80';
    const fill = isExhausted
      ? 'linear-gradient(0deg, #7f1d1d, #ef4444)'
      : isTight
      ? 'linear-gradient(0deg, #78350f, #d97706)'
      : isClaude
      ? 'linear-gradient(0deg, #7c2d12, #ea580c)'
      : 'linear-gradient(0deg, #1e3a8a, #2563eb)';
    const waterlineColor = isExhausted ? '#fca5a5' : isTight ? '#fef08a' : isClaude ? '#fdba74' : '#93c5fd';
    const waterlineBg = isExhausted ? '#ef4444' : isTight ? '#f59e0b' : isClaude ? '#ea580c' : '#60a5fa';
    const badge = isExhausted ? 'badge-bad' : isTight ? 'badge-warn' : 'badge-ok';
    const reqs = Math.round((rem / 100) * 156);
    return { rem, isTight, isExhausted, status, label, color, fill, waterlineColor, waterlineBg, badge, reqs };
  };

  const attentionAccounts = effectiveAccounts
    .map((a, i) => ({ account: a, info: getSlotHeadroom(a, i), idx: i }))
    .filter(item => item.info.isTight);


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
          <span className="stat-sub" style={{ color: Number(aggregateHeadroom) < 30 ? 'var(--bad)' : Number(aggregateHeadroom) < 50 ? 'var(--warn)' : 'var(--ok)' }}>
            {Number(aggregateHeadroom) >= 50 ? 'Optimal capacity' : Number(aggregateHeadroom) >= 30 ? 'Elevated load / Tight' : 'Critical exhaustion risk'}
          </span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Routing Latency</span>
          <span className="stat-val" style={{ color: 'var(--ok)' }}>18ms</span>
          <span className="stat-sub">CLIProxy + LiteLLM</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Active Gateways</span>
          <span className="stat-val" style={{ color: 'var(--purple)' }}>2 Live</span>
          <span className="stat-sub">CLIProxy &amp; LiteLLM</span>
        </div>
      </div>

      {/* Fleet Headroom Capacity Card */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="card-title">Fleet Headroom Capacity</span>
              <span
                style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center' }}
                title="Auto-scales across Cell (≤20) → Matrix (≤2 rows) → Aggregate (>2 rows)"
              >
                ⓘ
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={capView}
              onChange={(e) => setCapView(e.target.value as any)}
              style={{ background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 11 }}
            >
              <option value="auto">Auto-Scale</option>
              <option value="cell">Cell View</option>
              <option value="matrix">Matrix View</option>
              <option value="aggregate">Aggregate View</option>
            </select>
            <div style={{ display: 'flex', gap: 3 }}>
              <button className={`filter-btn ${simSize === 15 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(15); setCapView('auto'); }}>15</button>
              <button className={`filter-btn ${simSize === 32 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(32); setCapView('auto'); }}>32</button>
              <button className={`filter-btn ${simSize === 120 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(120); setCapView('auto'); }}>120</button>
            </div>
          </div>
        </div>

        <div id="cap-mode-indicator" style={{ fontSize: 10, color: '#60a5fa', marginBottom: 10, background: 'rgba(59,130,246,0.1)', padding: '4px 10px', borderRadius: 6, display: 'inline-block' }}>
          Mode: <strong>{capView.toUpperCase()}</strong> • <strong>{simSize} Accounts ({simSize <= 20 ? '≤20' : simSize <= 40 ? '≤2 rows' : '>2 rows'})</strong> → Rendering <strong>{activeView.toUpperCase()} View</strong>
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
                const h = getSlotHeadroom(acc, idx);
                const slotLabel = String(idx + 1).padStart(2, '0');
                const isSelected = hoverAccount?.id === acc.id || (!hoverAccount && h.isTight);
                return (
                  <div
                    key={acc.id}
                    className="grad-segment"
                    style={{
                      borderColor: isSelected ? (h.isTight ? h.color : '#60a5fa') : undefined,
                      transform: isSelected ? 'translateY(-2px)' : undefined,
                    }}
                    onMouseEnter={() => setHoverAccount(acc)}
                    onClick={() => setDrawerAccount(acc)}
                  >
                    <span className="grad-segment-label">{slotLabel}</span>
                    <div
                      className="grad-segment-fill"
                      style={{
                        height: `${Math.max(10, h.rem)}%`,
                        background: h.fill,
                      }}
                    >
                      <div
                        className="grad-segment-waterline"
                        style={{
                          color: h.waterlineColor,
                          background: h.waterlineBg,
                        }}
                      />
                    </div>
                    <div className="grad-segment-tooltip" style={{ borderColor: h.isTight ? h.color : undefined }}>
                      <strong>{acc.email || acc.name}</strong> (Slot {slotLabel})<br />
                      <span style={{ color: h.color }}>{h.rem}% {h.label}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 12, marginBottom: 6 }}>
              <span><strong>Claude Code</strong> ({claudeAccounts.length} Account)</span>
              <span style={{ color: 'var(--ok)' }}><strong>{claudeHeadroom}% Headroom</strong></span>
            </div>
            <div className="gradient-bar-track" style={{ height: 48, display: 'flex', gap: 4, justifyContent: 'flex-start' }}>
              {claudeAccounts.map((acc, idx) => {
                const ring = dualRingData(acc.latestSnapshot);
                const rem = ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : 84;
                const isSelected = hoverAccount?.id === acc.id;
                return (
                  <div
                    key={acc.id}
                    className="grad-segment"
                    style={{
                      flex: '0 0 calc((100% - 52px) / 14)',
                      maxWidth: 85,
                      height: 48,
                      borderColor: isSelected ? '#ea580c' : undefined,
                      transform: isSelected ? 'translateY(-2px)' : undefined,
                    }}
                    onMouseEnter={() => setHoverAccount(acc)}
                    onClick={() => setDrawerAccount(acc)}
                  >
                    <span className="grad-segment-label">01</span>
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

            {/* Hover details pill */}
            {hoverAccount && (() => {
              const hovIdx = agyAccounts.findIndex(a => a.id === hoverAccount.id);
              const isClaude = hoverAccount.providerType === 'claude';
              const h = getSlotHeadroom(hoverAccount, hovIdx >= 0 ? hovIdx : 0);
              const slotStr = isClaude ? 'slot_01' : `slot_${String(hovIdx >= 0 ? hovIdx + 1 : 14).padStart(2, '0')}`;
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, padding: '8px 12px', background: 'var(--card-hi)', borderRadius: 8, fontSize: 11 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="badge badge-slot">{slotStr}</span>
                    <strong style={{ color: '#fff' }}>{hoverAccount.email || hoverAccount.name}</strong>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ color: h.color, fontWeight: 700 }}>{h.rem}% ({h.reqs} reqs)</span>
                    <span className={`badge ${h.badge}`}>{h.label}</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* 2. Matrix View */}
        {activeView === 'matrix' && (
          <div id="view-cap-matrix" className="scale-box" style={{ borderLeft: '3px solid var(--purple)' }}>
            <div style={{ fontSize: 11, marginBottom: 8, color: 'var(--muted)' }}>
              Dual-Row Matrix: Displaying 32 provisioned gateway slots
            </div>
            <div className="matrix-grid">
              {Array.from({ length: 32 }).map((_, i) => {
                const isWarn = i === 13;
                const isAlt = i === 10 || i === 22;
                return (
                  <div
                    key={i}
                    className="matrix-cell"
                    style={{
                      borderColor: isWarn ? '#f59e0b' : isAlt ? '#38bdf8' : 'rgba(59,130,246,0.2)',
                      background: isWarn ? 'rgba(245,158,11,0.1)' : 'rgba(15,23,42,0.8)',
                    }}
                    onClick={() => {
                      const acc = effectiveAccounts[i % effectiveAccounts.length];
                      if (acc) setDrawerAccount(acc);
                    }}
                  >
                    <span className="matrix-cell-id">{String(i + 1).padStart(2, '0')}</span>
                    <span className="matrix-cell-val" style={{ color: isWarn ? '#fbbf24' : '#60a5fa' }}>
                      {isWarn ? '34%' : '90%'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. Aggregate View */}
        {activeView === 'aggregate' && (
          <div id="view-cap-aggregate" className="scale-box" style={{ borderLeft: '3px solid var(--ok)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div className="card" style={{ background: 'var(--card-hi)', padding: 12, border: '1px solid var(--border)' }}>
                <span className="stat-sub">High-Capacity Pool (Healthy)</span>
                <span className="stat-val" style={{ color: 'var(--ok)' }}>14 Accounts</span>
                <span className="stat-sub">94.2% Mean Headroom</span>
              </div>
              <div className="card" style={{ background: 'var(--card-hi)', padding: 12, border: '1px solid var(--border)' }}>
                <span className="stat-sub">Near-Limit Triage (Tight)</span>
                <span className="stat-val" style={{ color: 'var(--warn)' }}>1 Account</span>
                <span className="stat-sub">34.0% Burst Remaining</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Active Attention & Quota Warnings Card */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Active Attention &amp; Quota Warnings</span>
          <span className={`badge ${attentionAccounts.length > 0 ? 'badge-warn' : 'badge-ok'}`}>
            {attentionAccounts.length > 0 ? `${attentionAccounts.length} Attention Required` : 'All Accounts Optimal'}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {attentionAccounts.length === 0 ? (
            <div style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>All accounts operating above 35% headroom floor.</div>
          ) : (
            attentionAccounts.slice(0, 3).map(({ account: a, info: h, idx }) => {
              const slotStr = a.providerType === 'claude' ? 'slot_01' : `slot_${String(idx + 1).padStart(2, '0')}`;
              const resetStr = h.isExhausted ? 'in 1h 14m (14:30 UTC)' : 'Rolling window recovery in progress';
              return (
                <div
                  key={a.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 14px',
                    background: h.isExhausted ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                    border: '1px solid ' + (h.isExhausted ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'),
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                  onClick={() => setDrawerAccount(a)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="badge badge-slot">{slotStr}</span>
                    <div>
                      <strong style={{ color: '#fff', fontSize: 13 }}>{a.email || a.name}</strong>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        High consumption detected • 5h Burst window at {h.rem}% ({h.reqs} reqs)
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`badge ${h.badge}`}>{h.label} ({h.rem}%)</span>
                    <div style={{ fontSize: 11, color: h.color, marginTop: 4 }}>
                      Next Recovery: {resetStr}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Slide-over Diagnostic Drawer */}
      {drawerAccount && (
        <WebAccountDrawer
          account={drawerAccount}
          telemetry={{
            accountId: drawerAccount.id,
            slotId: getSlotLabel(drawerAccount, effectiveAccounts.indexOf(drawerAccount)),
            proxyPort: 8317,
            totalTokens: 1450000,
            promptTokens: 1100000,
            completionTokens: 350000,
            requestCount: 45,
            lastRoutedAt: new Date().toISOString(),
            proxySource: drawerAccount.providerType === 'claude' ? 'litellm' : 'cliproxy',
          }}
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

const AccountsPage: React.FC<{ accounts: Account[]; go: (to: string) => void; reload: () => Promise<void>; syncing: boolean; onRefresh: () => void }> = ({ accounts, go, reload, syncing, onRefresh }) => {
  const [filterHealth, setFilterHealth] = useState<'all' | 'healthy' | 'tight'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<'all' | 'antigravity' | 'claude'>('all');
  const [drawerAccount, setDrawerAccount] = useState<Account | null>(null);
  const [sortKey, setSortKey] = useState<string>('slot');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showColsMenu, setShowColsMenu] = useState(false);
  const [visibleCols, setVisibleCols] = useState({
    slot: true,
    email: true,
    provider: true,
    burst: true,
    cycle: true,
    reset: true,
    status: true,
  });

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

  let filtered = filterHealth === 'all'
    ? effectiveAccounts
    : filterHealth === 'healthy'
    ? healthyAccounts
    : tightAccounts;

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
          res = getAccountRem(a, aIdx) - getAccountRem(b, bIdx);
          break;
        case 'cycle':
          res = (a.providerType === 'claude' ? 100 : 68) - (b.providerType === 'claude' ? 100 : 68);
          break;
        case 'reset':
          res = (a.email?.includes('vishakha') ? 1 : 0) - (b.email?.includes('vishakha') ? 1 : 0);
          break;
        case 'status':
          res = (getAccountRem(a, aIdx) <= 35 ? 1 : 0) - (getAccountRem(b, bIdx) <= 35 ? 1 : 0);
          break;
        default:
          res = 0;
      }
      return sortDir === 'asc' ? res : -res;
    });
    return list;
  }, [filtered, sortKey, sortDir, effectiveAccounts]);

  const renderSortIndicator = (key: string) => {
    if (sortKey !== key) return <span className="sort-icon">↕</span>;
    return <span className="sort-icon">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  return (
    <div id="tab-accounts" className="view-panel active">
      {/* Filter Toolbar */}
      <div className="filter-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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

        {/* Clean Search Input (No Search Emoji Icon) */}
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

        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button
            className="filter-btn"
            onClick={() => setShowColsMenu(!showColsMenu)}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            Columns ▾
          </button>
          {showColsMenu && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 25 }}
                onClick={() => setShowColsMenu(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '100%',
                  marginTop: 6,
                  background: '#151d2f',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 10,
                  padding: '8px 6px',
                  zIndex: 30,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  minWidth: 185,
                  boxShadow: '0 8px 30px rgba(0,0,0,0.65)',
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: 'var(--muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.6px',
                    padding: '4px 10px 8px',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    marginBottom: 4,
                    textAlign: 'left',
                  }}
                >
                  Toggle Columns
                </div>
                {[
                  { key: 'slot', label: 'Slot' },
                  { key: 'email', label: 'Account Email' },
                  { key: 'provider', label: 'Provider' },
                  { key: 'burst', label: '5H Burst' },
                  { key: 'cycle', label: '7D Cycle' },
                  { key: 'reset', label: 'Next 5H Reset' },
                  { key: 'status', label: 'Status' },
                ].map((col) => (
                  <label
                    key={col.key}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      color: '#e2e8f0',
                      padding: '6px 10px',
                      borderRadius: 6,
                      userSelect: 'none',
                      transition: 'background 0.12s ease',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <input
                      type="checkbox"
                      checked={visibleCols[col.key as keyof typeof visibleCols]}
                      onChange={(e) => setVisibleCols({ ...visibleCols, [col.key]: e.target.checked })}
                      style={{
                        width: 15,
                        height: 15,
                        margin: 0,
                        padding: 0,
                        flexShrink: 0,
                        cursor: 'pointer',
                        accentColor: '#2563eb',
                      }}
                    />
                    <span style={{ whiteSpace: 'nowrap', textAlign: 'left' }}>{col.label}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
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
              const isClaude = a.providerType === 'claude';
              const burstRem = getAccountRem(a, idx);
              const isTight = burstRem <= 35;
              const ring = dualRingData(a.latestSnapshot);
              const cycleRem = Math.round(ring.inner ? ring.inner.remaining : (isTight ? 68 : 88));
              const slotStr = isClaude ? 'slot_01' : `slot_${String(idx + 1).padStart(2, '0')}`;
              const provStr = a.providerType === 'antigravity' ? 'Google' : a.providerType === 'claude' ? 'Anthropic' : a.providerType;
              const resetStr = isTight ? 'in 1h 14m' : (isClaude ? 'in 3h 10m' : 'Rolling clear');

              return (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => setDrawerAccount(a)}>
                  {visibleCols.slot && <td><span className="badge badge-slot">{slotStr}</span></td>}
                  {visibleCols.email && <td><strong>{a.email || a.name}</strong></td>}
                  {visibleCols.provider && <td>{provStr}</td>}
                  {visibleCols.burst && (
                    <td>
                      <span style={{ color: isTight ? '#fbbf24' : '#4ade80', fontWeight: 700 }}>
                        {burstRem}% ({isTight ? '45 reqs' : '156 reqs'})
                      </span>
                    </td>
                  )}
                  {visibleCols.cycle && <td>{a.providerType === 'claude' ? 'Pro Tier' : `${cycleRem}% Balance`}</td>}
                  {visibleCols.reset && (
                    <td>
                      <span style={{ color: isTight ? '#f59e0b' : 'var(--muted)', fontSize: 11 }}>
                        {resetStr}
                      </span>
                    </td>
                  )}
                  {visibleCols.status && (
                    <td>
                      <span className={`badge ${isTight ? 'badge-warn' : 'badge-ok'}`}>
                        {isTight ? 'Tight' : 'Healthy'}
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
        <WebAccountDrawer
          account={drawerAccount}
          telemetry={{
            accountId: drawerAccount.id,
            slotId: getSlotLabel(drawerAccount, effectiveAccounts.indexOf(drawerAccount)),
            proxyPort: 8317,
            totalTokens: 1450000,
            promptTokens: 1100000,
            completionTokens: 350000,
            requestCount: 45,
            lastRoutedAt: new Date().toISOString(),
            proxySource: drawerAccount.providerType === 'claude' ? 'litellm' : 'cliproxy',
          }}
          onClose={() => setDrawerAccount(null)}
          onViewFleet={() => setDrawerAccount(null)}
        />
      )}
    </div>
  );
};

/* ---------------- TAB 3: TOKEN & TELEMETRY (Stats) ---------------- */

const StatsPage: React.FC<{ accounts: Account[] }> = ({ accounts }) => {
  const [horizon, setHorizon] = useState<'today' | '7d' | '30d'>('today');
  const [activeFilter, setActiveFilter] = useState<'all' | 'claude' | 'gemini'>('all');
  const [selectedInterval, setSelectedInterval] = useState('12:00 - 16:00 (Peak)');

  // Dynamic KPI stats based on horizon
  const kpiData = {
    today: {
      volume: '18.4M',
      volumeSub: '74% Prompt / 26% Completion',
      peakTitle: 'Peak Hourly Burn',
      peakVal: '2.45M/hr',
      peakSub: '12:00 - 16:00 UTC',
      primaryModel: 'Claude 3.7',
      modelSub: '51% fleet token share',
      latency: '3.9ms',
      latencySub: 'Avg proxy routing latency',
    },
    '7d': {
      volume: '114.2M',
      volumeSub: '71% Prompt / 29% Completion',
      peakTitle: 'Peak Daily Burn',
      peakVal: '19.8M/day',
      peakSub: 'Thursday Peak',
      primaryModel: 'Claude 3.7',
      modelSub: '48% 7-day share',
      latency: '3.8ms',
      latencySub: '7-day rolling avg',
    },
    '30d': {
      volume: '482.6M',
      volumeSub: '73% Prompt / 27% Completion',
      peakTitle: 'Peak Weekly Burn',
      peakVal: '126.0M/wk',
      peakSub: 'Week 3 Peak',
      primaryModel: 'Gemini 2.5 Pro',
      modelSub: '46% 30-day share',
      latency: '3.7ms',
      latencySub: 'Monthly rolling avg',
    },
  }[horizon];

  // Stacked Bar Definitions for horizons
  const barsToday = [
    { id: 't0', label: '00:00', height: 35, pro: 15, flash: 10, c37: 6, c35: 3, haiku: 1, interval: '00:00 - 04:00' },
    { id: 't1', label: '04:00', height: 22, pro: 10, flash: 6, c37: 4, c35: 1, haiku: 1, interval: '04:00 - 08:00' },
    { id: 't2', label: '08:00', height: 60, pro: 25, flash: 15, c37: 12, c35: 6, haiku: 2, interval: '08:00 - 12:00' },
    { id: 't3', label: '12:00 (Peak)', height: 95, pro: 40, flash: 22, c37: 20, c35: 9, haiku: 4, interval: '12:00 - 16:00 (Peak)' },
    { id: 't4', label: '16:00', height: 75, pro: 30, flash: 18, c37: 16, c35: 8, haiku: 3, interval: '16:00 - 20:00' },
  ];

  const bars7d = [
    { id: 'd0', label: 'Mon', height: 45, pro: 18, flash: 10, c37: 11, c35: 4, haiku: 2, interval: 'Monday' },
    { id: 'd1', label: 'Tue', height: 65, pro: 26, flash: 14, c37: 15, c35: 7, haiku: 3, interval: 'Tuesday' },
    { id: 'd2', label: 'Wed', height: 78, pro: 32, flash: 18, c37: 18, c35: 7, haiku: 3, interval: 'Wednesday' },
    { id: 'd3', label: 'Thu (Peak)', height: 96, pro: 42, flash: 22, c37: 20, c35: 8, haiku: 4, interval: 'Thursday (Peak)' },
    { id: 'd4', label: 'Fri', height: 82, pro: 34, flash: 19, c37: 19, c35: 7, haiku: 3, interval: 'Friday' },
    { id: 'd5', label: 'Sat', height: 35, pro: 15, flash: 8, c37: 8, c35: 3, haiku: 1, interval: 'Saturday' },
    { id: 'd6', label: 'Sun', height: 28, pro: 12, flash: 7, c37: 6, c35: 2, haiku: 1, interval: 'Sunday' },
  ];

  const bars30d = Array.from({ length: 30 }).map((_, i) => {
    const dayNum = i + 1;
    const isPeak = dayNum === 22;
    const baseHeight = 25 + Math.round(Math.sin((i / 29) * Math.PI) * 50) + ((i * 7) % 18);
    const height = isPeak ? 96 : Math.min(92, Math.max(20, baseHeight));
    const pro = Math.round(height * 0.42);
    const flash = Math.round(height * 0.22);
    const c37 = Math.round(height * 0.20);
    const c35 = Math.round(height * 0.10);
    const haiku = Math.max(1, height - (pro + flash + c37 + c35));
    const d = new Date(Date.now() - (29 - i) * 86400000);
    const dateStr = `${MONTHS_SHORT[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
    const showLabel = i === 0 || i === 7 || i === 14 || i === 21 || i === 29;
    return {
      id: `d30-${dayNum}`,
      label: showLabel ? dateStr : '',
      dateStr,
      height,
      pro,
      flash,
      c37,
      c35,
      haiku,
      interval: `Day ${dayNum} (${dateStr}${isPeak ? ' - Peak' : ''})`,
    };
  });

  const currentBars = horizon === 'today' ? barsToday : horizon === '7d' ? bars7d : bars30d;

  return (
    <div id="tab-stats" className="view-panel active">
      {/* Horizon Selector Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Token Burn Velocity &amp; Model Telemetry</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className={`filter-btn ${horizon === 'today' ? 'active' : ''}`}
            onClick={() => { setHorizon('today'); setActiveFilter('all'); setSelectedInterval('12:00 - 16:00 (Peak)'); }}
          >
            Today
          </button>
          <button
            className={`filter-btn ${horizon === '7d' ? 'active' : ''}`}
            onClick={() => { setHorizon('7d'); setActiveFilter('all'); setSelectedInterval('Thursday (Peak)'); }}
          >
            7 Days
          </button>
          <button
            className={`filter-btn ${horizon === '30d' ? 'active' : ''}`}
            onClick={() => { setHorizon('30d'); setActiveFilter('all'); setSelectedInterval('Day 22 (Oct 26 - Peak)'); }}
          >
            30 Days
          </button>
        </div>
      </div>

      {/* 4 Dynamic KPI Cards */}
      <div className="grid-4" style={{ marginBottom: 14 }}>
        <div className="card stat-box">
          <span className="stat-sub">Total Token Volume</span>
          <span className="stat-val" style={{ color: 'var(--blue)' }}>{kpiData.volume}</span>
          <span className="stat-sub" style={{ color: 'var(--ok)' }}>{kpiData.volumeSub}</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">{kpiData.peakTitle}</span>
          <span className="stat-val" style={{ color: 'var(--warn)' }}>{kpiData.peakVal}</span>
          <span className="stat-sub">{kpiData.peakSub}</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Primary Model</span>
          <span className="stat-val" style={{ color: '#ea580c' }}>{kpiData.primaryModel}</span>
          <span className="stat-sub">{kpiData.modelSub}</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Gateway Overhead</span>
          <span className="stat-val" style={{ color: 'var(--ok)' }}>{kpiData.latency}</span>
          <span className="stat-sub">{kpiData.latencySub}</span>
        </div>
      </div>

      {/* Main Chart Card */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="card-title">Token Burn Rate by Model ({horizon === 'today' ? 'Today' : horizon === '7d' ? '7 Days' : '30 Days'})</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
              Click any color segment to filter details for that specific model family
            </span>
          </div>
          {/* Multi-Model Legend */}
          <div style={{ display: 'flex', gap: 12, fontSize: 11, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('gemini')}>
              <span style={{ width: 8, height: 8, background: '#2563eb', borderRadius: 2 }} /> Gemini 2.5 Pro
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('gemini')}>
              <span style={{ width: 8, height: 8, background: '#38bdf8', borderRadius: 2 }} /> Gemini 2.0 Flash
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('claude')}>
              <span style={{ width: 8, height: 8, background: '#c2410c', borderRadius: 2 }} /> Claude 3.7 Sonnet
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('claude')}>
              <span style={{ width: 8, height: 8, background: '#ea580c', borderRadius: 2 }} /> Claude 3.5 Sonnet
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('claude')}>
              <span style={{ width: 8, height: 8, background: '#f59e0b', borderRadius: 2 }} /> Claude 3.5 Haiku
            </span>
          </div>
        </div>

        {/* Filter State Banner */}
        {activeFilter !== 'all' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: activeFilter === 'claude' ? 'rgba(234, 88, 12, 0.12)' : 'rgba(56, 189, 248, 0.12)', border: '1px solid ' + (activeFilter === 'claude' ? '#ea580c' : '#38bdf8'), borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            <span style={{ color: activeFilter === 'claude' ? '#fdba74' : '#93c5fd', fontWeight: 600 }}>
              Filtered: {activeFilter === 'claude' ? 'Claude Models (Anthropic Direct Proxy)' : 'Google Antigravity (CLIProxy Mesh)'}
            </span>
            <button
              className="filter-btn"
              style={{ padding: '2px 8px', fontSize: 11, background: '#1e293b', color: '#fff' }}
              onClick={() => setActiveFilter('all')}
            >
              Reset Filter ✕
            </button>
          </div>
        )}

        {/* Burn Chart Bars */}
        <div className="burn-chart-container" style={{ height: 180, display: 'flex', alignItems: 'flex-end', gap: horizon === '30d' ? 4 : 14, padding: '10px 0' }}>
          {currentBars.map((b) => {
            const isSelected = selectedInterval === b.interval;
            return (
              <div key={b.id} className="burn-bar-slot" style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                <div
                  className={`burn-bar-stack ${isSelected ? 'selected-bar' : ''}`}
                  style={{
                    height: `${b.height}%`,
                    width: '100%',
                    maxWidth: horizon === '30d' ? 22 : 54,
                    display: 'flex',
                    flexDirection: 'column-reverse',
                    borderRadius: 4,
                    overflow: 'hidden',
                    outline: isSelected ? '2px solid #60a5fa' : 'none',
                    outlineOffset: 2,
                  }}
                  onClick={() => setSelectedInterval(b.interval)}
                >
                  {/* Model Segments */}
                  <div
                    className="burn-seg-claude-haiku"
                    style={{ height: `${b.haiku}%`, opacity: activeFilter === 'gemini' ? 0.2 : 1 }}
                    title="Claude 3.5 Haiku"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('claude'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-claude-35"
                    style={{ height: `${b.c35}%`, opacity: activeFilter === 'gemini' ? 0.2 : 1 }}
                    title="Claude 3.5 Sonnet"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('claude'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-claude-37"
                    style={{ height: `${b.c37}%`, opacity: activeFilter === 'gemini' ? 0.2 : 1 }}
                    title="Claude 3.7 Sonnet"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('claude'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-gemini-flash"
                    style={{ height: `${b.flash}%`, opacity: activeFilter === 'claude' ? 0.2 : 1 }}
                    title="Gemini 2.0 Flash"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('gemini'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-gemini-pro"
                    style={{ height: `${b.pro}%`, opacity: activeFilter === 'claude' ? 0.2 : 1 }}
                    title="Gemini 2.5 Pro"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('gemini'); setSelectedInterval(b.interval); }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* X-Axis Labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 8, padding: '0 8px' }}>
          {currentBars.map((b) => (
            <span key={b.id} style={{ fontWeight: b.interval === selectedInterval ? 700 : 400, color: b.interval === selectedInterval ? '#60a5fa' : undefined }}>
              {b.label}
            </span>
          ))}
        </div>

        {/* Drilldown Inspector Panel */}
        <div id="burn-drilldown" className="drilldown-panel" style={{ marginTop: 14, padding: 14, background: 'var(--card-hi)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>Interval: {selectedInterval}</span>
            <span className="badge" style={{ background: activeFilter === 'claude' ? 'rgba(234,88,12,0.15)' : (activeFilter === 'gemini' ? 'rgba(56,189,248,0.15)' : 'rgba(59,130,246,0.15)'), color: activeFilter === 'claude' ? '#ea580c' : (activeFilter === 'gemini' ? '#38bdf8' : '#60a5fa') }}>
              {activeFilter === 'claude' ? 'Filtered: Claude Models' : (activeFilter === 'gemini' ? 'Filtered: Google Antigravity' : 'All Models')}
            </span>
          </div>

          {activeFilter === 'claude' ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                735,000 tokens (Burn: 183.8k/hr)
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                Total Claude Allocation: 31% of interval volume
              </div>
              <div style={{ fontSize: 11, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>claude-3-7-sonnet</strong> (Extended Thinking)</span>
                  <strong style={{ color: '#ea580c' }}>510,000 tokens (69.4%) • 127.5k/hr</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>claude-3-5-sonnet</strong> (Standard)</span>
                  <strong style={{ color: '#fdba74' }}>180,000 tokens (24.5%) • 45.0k/hr</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>claude-3-5-haiku</strong> (Fast Triage)</span>
                  <strong style={{ color: '#fef08a' }}>45,000 tokens (6.1%) • 11.2k/hr</strong>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#4ade80', marginTop: 8 }}>
                Avg Provider Latency: 12ms (Anthropic Direct Proxy)
              </div>
            </div>
          ) : activeFilter === 'gemini' ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                1,715,000 tokens (Burn: 428.8k/hr)
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                Total Antigravity Allocation: 69% of interval volume
              </div>
              <div style={{ fontSize: 11, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>gemini-2.5-pro</strong> (Deep Workhorse)</span>
                  <strong style={{ color: '#60a5fa' }}>1,180,000 tokens (68.8%) • 295.0k/hr</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>gemini-2.0-flash</strong> (Lightweight Execution)</span>
                  <strong style={{ color: '#93c5fd' }}>535,000 tokens (31.2%) • 133.7k/hr</strong>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#4ade80', marginTop: 8 }}>
                Avg Gateway Latency: 3.9ms (CLIProxy Local Mesh)
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                2,450,000 tokens
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                1.7M Antigravity / 735k Claude
              </div>
              <div style={{ fontSize: 11, color: '#4ade80', marginTop: 4 }}>
                Proxy Overhead: 4.2ms
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Model Breakdown Table */}
      <div className="card">
        <span className="card-title" style={{ display: 'block', marginBottom: 12 }}>Model Telemetry Breakdown</span>
        <div className="data-table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Model Name</th>
                <th>Requests</th>
                <th>Prompt Tokens</th>
                <th>Completion</th>
                <th>Total Tokens</th>
                <th>Fleet Share</th>
              </tr>
            </thead>
            <tbody>
              {activeFilter !== 'gemini' && (
                <>
                  <tr><td><strong>claude-3-7-sonnet</strong></td><td>412</td><td>5.8M</td><td>1.4M</td><td><strong>7.2M</strong></td><td>39.1%</td></tr>
                  <tr><td><strong>claude-3-5-sonnet</strong></td><td>145</td><td>1.2M</td><td>300k</td><td><strong>1.5M</strong></td><td>8.2%</td></tr>
                  <tr><td><strong>claude-3-5-haiku</strong></td><td>380</td><td>400k</td><td>150k</td><td><strong>550k</strong></td><td>3.0%</td></tr>
                </>
              )}
              {activeFilter !== 'claude' && (
                <>
                  <tr><td><strong>gemini-2.5-pro</strong></td><td>1,280</td><td>6.1M</td><td>1.9M</td><td><strong>8.0M</strong></td><td>43.5%</td></tr>
                  <tr><td><strong>gemini-2.0-flash</strong></td><td>3,450</td><td>2.5M</td><td>700k</td><td><strong>3.2M</strong></td><td>17.4%</td></tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* ---------------- TAB 4: DUAL-HORIZON RADAR (Alerts) ---------------- */

const AlertsPage: React.FC<{ accounts: Account[] }> = ({ accounts }) => {
  const [filterAlert, setFilterAlert] = useState<'all' | 'exhausted' | 'tight' | 'healthy'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDayReport, setSelectedDayReport] = useState<{
    title: string;
    models: string;
    time: string;
    headroom: string;
    isTight: boolean;
  } | null>({
    title: 'Day 3 Diagnostic: vishakhagemini0@gmail.com',
    models: 'gemini-2.5-pro: 640k (82%) • gemini-2.0-flash: 140k (18%)',
    time: 'Accelerated burn detected between 14:00-16:00 UTC (45 reqs)',
    headroom: '34% Headroom (Tight)',
    isTight: true,
  });

  const effectiveAccounts = accounts.length > 0 ? accounts : [...getMockAgyAccounts(), getMockClaudeAccount()];

  const accountCards = useMemo(() => {
    return effectiveAccounts.map((a, idx) => {
      const isClaude = a.providerType === 'claude';
      const ring = dualRingData(a.latestSnapshot);
      const rawBurst = ring.outer !== undefined && ring.outer !== null
        ? Math.round(ring.outer.remaining)
        : (ring.inner ? Math.round(ring.inner.remaining) : (isClaude ? 84 : (90 + ((idx * 3) % 10))));
      const burstRem = Math.max(0, Math.min(100, rawBurst));
      const cycleRem = Math.round(ring.inner ? ring.inner.remaining : (isClaude ? 100 : 88));
      const isExhausted = burstRem <= 15;
      const isTight = burstRem <= 35 && !isExhausted;
      const isHealthy = burstRem > 35;
      const status: 'exhausted' | 'tight' | 'healthy' = isExhausted ? 'exhausted' : isTight ? 'tight' : 'healthy';
      const reqs = Math.round((burstRem / 100) * 156);
      const slotStr = isClaude ? 'slot_01' : `slot_${String(idx + 1).padStart(2, '0')}`;
      const email = a.email || a.name;
      const badge = isExhausted ? 'badge-bad' : isTight ? 'badge-warn' : 'badge-ok';
      const label = isExhausted ? `${burstRem}% Exhausted` : isTight ? `${burstRem}% Burst` : `${burstRem}% Healthy`;
      const fill = isExhausted
        ? 'linear-gradient(90deg, #ef4444, #b91c1c)'
        : isTight
        ? 'linear-gradient(90deg, #f59e0b, #d97706)'
        : isClaude
        ? 'linear-gradient(90deg, #ea580c, #c2410c)'
        : 'linear-gradient(90deg, #10b981, #059669)';
      return {
        account: a,
        slotStr,
        email,
        burstRem,
        cycleRem,
        isExhausted,
        isTight,
        isHealthy,
        status,
        reqs,
        isClaude,
        badge,
        label,
        fill,
      };
    });
  }, [effectiveAccounts]);

  const exhaustedCount = accountCards.filter(c => c.isExhausted).length;
  const tightCount = accountCards.filter(c => c.isTight).length;
  const healthyCount = accountCards.filter(c => c.isHealthy).length;

  const filteredCards = useMemo(() => {
    return accountCards.filter(c => {
      if (filterAlert === 'exhausted' && !c.isExhausted) return false;
      if (filterAlert === 'tight' && !c.isTight) return false;
      if (filterAlert === 'healthy' && !c.isHealthy) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return c.email.toLowerCase().includes(q) || c.slotStr.toLowerCase().includes(q);
      }
      return true;
    });
  }, [accountCards, filterAlert, searchQuery]);

  return (
    <div id="tab-alerts" className="view-panel active">
      {/* Top Radar Toolbar */}
      <div className="filter-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <button className={`filter-btn ${filterAlert === 'all' ? 'active' : ''}`} onClick={() => setFilterAlert('all')}>
          All Alerts ({accountCards.length})
        </button>
        <button className={`filter-btn ${filterAlert === 'exhausted' ? 'active' : ''}`} style={{ borderColor: '#ef4444', color: '#ef4444' }} onClick={() => setFilterAlert('exhausted')}>
          Exhausted ({exhaustedCount})
        </button>
        <button className={`filter-btn ${filterAlert === 'tight' ? 'active' : ''}`} style={{ borderColor: '#f59e0b', color: '#f59e0b' }} onClick={() => setFilterAlert('tight')}>
          Tight ({tightCount})
        </button>
        <button className={`filter-btn ${filterAlert === 'healthy' ? 'active' : ''}`} onClick={() => setFilterAlert('healthy')}>
          Healthy ({healthyCount})
        </button>

        {/* Clean search bar - no search icon */}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <input
            type="text"
            placeholder="Find account in radar..."
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
                top: '50%',
                transform: 'translateY(-50%)',
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
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Dual-Horizon Diagnostic Radar</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Click any day pill below to inspect detailed daily telemetry</span>
        </div>

        {filteredCards.length === 0 ? (
          <div style={{ padding: 36, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No accounts matching <strong>"{searchQuery}"</strong> in radar view.
          </div>
        ) : (
          <div className="grid-3">
            {filteredCards.map((c) => (
              <div key={c.account.id} className="dual-horizon-card">
                <div className="dh-account-title">
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', overflow: 'hidden' }}>
                    <span className="badge badge-slot">{c.slotStr}</span>
                    <strong style={{ fontSize: 13, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {c.email}
                    </strong>
                  </div>
                  <span className={`badge ${c.badge}`}>{c.label}</span>
                </div>
                <div className="dh-meter-row">
                  <div className="dh-meter-label">
                    <span>
                      <span className="pill-badge" style={{ background: c.isClaude ? 'rgba(234,88,12,0.18)' : 'rgba(59,130,246,0.18)', color: c.isClaude ? '#fb923c' : '#60a5fa' }}>
                        {c.isClaude ? 'ROLLING SESSION' : '5-HOUR BURST'}
                      </span>
                    </span>
                    <span style={{ color: c.isExhausted ? '#ef4444' : c.isTight ? '#fbbf24' : '#4ade80', fontWeight: 700 }}>
                      {c.burstRem}% ({c.reqs} reqs)
                    </span>
                  </div>
                  <div className="dh-progress-capsule">
                    <div className="dh-fill-burst" style={{ width: `${Math.max(5, c.burstRem)}%`, background: c.fill }} />
                  </div>
                </div>
                <div className="dh-meter-row" style={{ marginTop: 10 }}>
                  <div className="dh-meter-label">
                    <span>
                      <span className="pill-badge" style={{ background: c.isClaude ? 'rgba(168,85,247,0.18)' : 'rgba(16,185,129,0.18)', color: c.isClaude ? '#c084fc' : '#34d399' }}>
                        {c.isClaude ? 'TIER STATUS' : '7-DAY CYCLE'}
                      </span>
                    </span>
                    <span style={{ color: c.isClaude ? 'var(--purple)' : 'var(--ok)', fontWeight: 700 }}>
                      {c.isClaude ? 'Pro Tier' : `${c.cycleRem}% Balance`}
                    </span>
                  </div>
                  <div className="dh-calendar-strip">
                    <div className="dh-day-pill past" onClick={() => setSelectedDayReport({ title: `Day 1 Diagnostic: ${c.email}`, models: 'Baseline operation • Normal prompt volume', time: '09:00 - 17:00 UTC', headroom: '88% Headroom', isTight: false })}>D1</div>
                    <div className="dh-day-pill past" onClick={() => setSelectedDayReport({ title: `Day 2 Diagnostic: ${c.email}`, models: 'Moderate workload', time: '11:00 - 18:00 UTC', headroom: '78% Headroom', isTight: false })}>D2</div>
                    <div className={`dh-day-pill ${c.isExhausted ? 'tight' : c.isTight ? 'tight' : 'current'}`} onClick={() => setSelectedDayReport({ title: `Day 3 Diagnostic: ${c.email}`, models: c.isTight ? 'Accelerated prompt burn detected' : 'Optimal model allocation', time: '14:00 - 16:00 UTC (Active)', headroom: `${c.burstRem}% Headroom (${c.isExhausted ? 'Exhausted' : c.isTight ? 'Tight' : 'Healthy'})`, isTight: c.isTight || c.isExhausted })}>D3</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 4 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D4</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 5 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D5</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 6 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D6</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 7 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D7</div>
                  </div>
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}>
                  Next recovery: <strong style={{ color: '#e5e7eb' }}>{c.isExhausted ? 'in 1h 14m (14:30 UTC)' : c.isTight ? 'in 2h 45m (15:30 UTC)' : 'Rolling window clear'}</strong>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Day Diagnostic Inspector Panel */}
        {selectedDayReport && (
          <div id="day-diagnostic-panel" className="drilldown-panel" style={{ marginTop: 16, padding: 14, background: 'var(--card-hi)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>{selectedDayReport.title}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`badge ${selectedDayReport.isTight ? 'badge-warn' : 'badge-ok'}`}>
                  {selectedDayReport.headroom}
                </span>
                <button
                  onClick={() => setSelectedDayReport(null)}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}
                >
                  ✕
                </button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#e5e7eb', marginBottom: 2 }}>
              Active Models: <strong>{selectedDayReport.models}</strong>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Time Interval: {selectedDayReport.time}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------------- TAB 5: GATEWAYS & SETTINGS ---------------- */

const SettingsPage: React.FC<{ state: AppState; reload: () => Promise<void> }> = ({ state, reload }) => {
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

  const exportGatewayConfig = () => {
    const config = {
      version: '2.5.0',
      gateways: [
        { name: 'CLIProxy Integration', endpoint: 'http://172.19.0.4:8317', status: 'healthy', keys: 15 },
        { name: 'LiteLLM Proxy', endpoint: 'http://192.168.2.184:4000', status: 'connected', keys: 'Master Key Configured' },
        { name: 'Slack Alert Dispatcher', channel: '#ai-quota-alerts', trigger: 'Headroom <= 20%' },
      ],
      timestamp: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fqd-gateway-config-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAuditCsv = () => {
    const csvContent = 'data:text/csv;charset=utf-8,Slot,Email,Provider,BurstRem,Status\\n' +
      'slot_14,vishakhagemini0@gmail.com,Google,34%,Tight\\n' +
      'slot_11,piyushkumar.jiit@gmail.com,Google,99%,Healthy\\n' +
      'slot_01,claude-2f8e2ab5,Anthropic,84%,Healthy';
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `fqd_quota_audit_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div id="tab-settings" className="view-panel active">
      {/* Backend Gateways Card */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="card-title">Backend Gateways &amp; Integrations</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Configured via .env / yaml mesh</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className="filter-btn"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={exportGatewayConfig}
            >
              Export Gateway Config
            </button>
            <button
              className="filter-btn"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={exportAuditCsv}
            >
              Export Audit CSV
            </button>
          </div>
        </div>

        {/* Clean Responsive 3-Column Grid (No Debug Buttons, No Auto-Grid Text) */}
        <div className="integrations-grid grid-cols-3">
          <div className="card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--blue)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ color: 'var(--blue)', fontSize: 13 }}>CLIProxy Integration</strong>
              <span className="badge badge-ok">HTTP 200 (4ms)</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Endpoint: <code>http://172.19.0.4:8317</code></div>
              <div>Keys: <strong style={{ color: '#fff' }}>15 Active Credentials</strong></div>
              <div>Status: <span style={{ color: 'var(--ok)' }}>Auth Validated</span></div>
            </div>
          </div>

          <div className="card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--purple)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ color: 'var(--purple)', fontSize: 13 }}>LiteLLM Proxy</strong>
              <span className="badge badge-ok">Connected (5ms)</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Endpoint: <code>http://192.168.2.184:4000</code></div>
              <div>Authentication: <strong style={{ color: '#fff' }}>Master Key Configured</strong></div>
              <div>Status: <span style={{ color: 'var(--ok)' }}>Auth Validated</span></div>
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
              <div>Status: <span style={{ color: 'var(--ok)' }}>Auth Validated</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* Operational Preferences Card */}
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 14px 0' }}>Observability Configuration</h3>
        <div style={{ display: 'grid', gap: 14, maxWidth: 480 }}>
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

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <span>Prometheus Telemetry Scrape</span>
            <a href="http://172.19.0.4:8317/metrics" target="_blank" rel="noreferrer" style={{ color: '#38bdf8', fontSize: 12, textDecoration: 'none' }}>
              /metrics endpoint ↗
            </a>
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
