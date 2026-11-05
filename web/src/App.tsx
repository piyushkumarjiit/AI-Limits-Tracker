import React, { useCallback, useEffect, useState } from 'react';
import type { WatermarkFleetOverview } from '../../server/src/cpaWatermarkTypes';
import type { TelemetryResponse } from '../../src/services/telemetryService';
import { DEFAULT_STATUS_LEVELS } from '../../src/constants/statusLevels';
import { api, ApiError, type Account } from './api';
import { href, go, useRoute } from './route';
import { isInsecurePage } from './session';
import { CloseIcon, NavIcon, statusOf, type PanelData } from './components/common/bits';
import { Overview } from './components/Overview/Overview';
import { AccountsPage } from './components/Accounts/AccountsPage';
import { UsagePage } from './components/Usage/UsagePage';
import { SettingsPage } from './components/Settings/SettingsPage';
import { AccountPanel } from './components/AccountPanel/AccountPanel';
import { AddAccount } from './components/Add/AddAccount';

const TABS: Array<[string, string]> = [
  ['overview', 'Overview'],
  ['accounts', 'Accounts'],
  ['usage', 'Usage'],
  ['settings', 'Settings'],
];

interface StateResponse {
  accounts: Account[];
  intervalMin: number;
  telegram: boolean;
  gateways?: { cliproxyUrl: string | null; litellmUrl: string | null };
}

export function App() {
  const route = useRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [overview, setOverview] = useState<WatermarkFleetOverview | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.state();
      setState(res);
      setAuthed(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
      else console.error(e);
      return;
    }
    const [ov, tel] = await Promise.allSettled([api.cpaOverview(), api.telemetry()]);
    if (ov.status === 'fulfilled') setOverview(ov.value);
    if (tel.status === 'fulfilled') setTelemetry(tel.value);
  }, []);

  useEffect(() => {
    load();
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener('alt:unauthorized', onUnauthorized);
    return () => window.removeEventListener('alt:unauthorized', onUnauthorized);
  }, [load]);

  // The panel only reloads when asked; the server keeps polling providers on its own interval.
  const refresh = async () => {
    setSyncing(true);
    try {
      await api.refreshAll();
      await load();
      setRefreshKey((k) => k + 1);
      notify('Refreshed');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setSyncing(false);
    }
  };

  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      setAuthed(false);
      setState(null);
    }
  };

  // Close the account panel whenever the page changes.
  useEffect(() => setOpenId(null), [route.path]);

  if (authed === null) return <div className="splash"><div className="spinner" /></div>;
  if (!authed) return <Login onDone={load} />;
  if (!state) return null;

  const data: PanelData = {
    accounts: state.accounts,
    overview,
    telemetry,
    levels: overview?.statusLevels ?? DEFAULT_STATUS_LEVELS,
    gateways: state.gateways ?? { cliproxyUrl: null, litellmUrl: null },
    intervalMin: state.intervalMin,
    telegram: state.telegram,
  };
  const exhausted = data.accounts.filter((a) => statusOf(data, a) === 'exhausted').length;
  const openAccount = (id: string) => setOpenId(id);
  const opened = openId ? data.accounts.find((a) => a.id === openId) : undefined;
  const tab = TABS.some(([k]) => k === route.path) ? route.path : route.path === 'add' ? 'accounts' : 'overview';
  const count = (k: string) => (k === 'accounts' && exhausted > 0 ? <span className="count" title={`${exhausted} exhausted`}>{exhausted}</span> : null);

  const cliproxyOk = Boolean(telemetry?.global.providers.cliproxy);
  const litellmOk = Boolean(telemetry?.global.providers.litellm);
  const gatewayPill = (key: string, label: string, ok: boolean) => (
    <a className="pill" href={href('settings', { focus: key })} title={`${label}: ${ok ? 'connected' : 'not connected'}`} aria-label={`${label} ${ok ? 'connected' : 'not connected'}`}>
      <span className="dot" style={{ background: ok ? 'var(--ok)' : 'var(--bad)' }} />
      {label}
    </a>
  );

  let page: React.ReactNode;
  switch (route.path) {
    case 'accounts':
      page = <AccountsPage data={data} route={route} openAccount={openAccount} />;
      break;
    case 'usage':
      page = <UsagePage data={data} route={route} openAccount={openAccount} refreshKey={refreshKey} />;
      break;
    case 'settings':
      page = <SettingsPage data={data} route={route} reload={load} refresh={refresh} syncing={syncing} notify={notify} />;
      break;
    case 'add':
      page = <AddAccount accounts={data.accounts} reload={load} reconnectId={route.param} />;
      break;
    default:
      page = <Overview data={data} openAccount={openAccount} refreshKey={refreshKey} />;
  }

  return (
    <>
      <div className="wrap">
        <InsecureBanner />
        <header className="top">
          <a className="brand" href={href('overview')}>
            <b>FQD</b>
            <span>Fleet Quota Display</span>
          </a>
        </header>
        <nav className="tabs" aria-label="Main">
          {TABS.map(([k, label]) => (
            <button key={k} className={`tab ${tab === k ? 'active' : ''}`} aria-current={tab === k ? 'page' : undefined} onClick={() => go(k)}>
              {label}
              {count(k)}
            </button>
          ))}
          <div className="nav-right">
            {gatewayPill('cliproxy', 'CLIProxy', cliproxyOk)}
            {gatewayPill('litellm', 'LiteLLM', litellmOk)}
            <button className="btn danger" onClick={signOut}>Sign out</button>
          </div>
        </nav>

        <main>{page}</main>

        <footer className="app-footer">
          <span>FQD · Fleet Quota Display</span>
          <a href="https://github.com/piyushkumarjiit/FQD" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://github.com/piyushkumarjiit/FQD#readme" target="_blank" rel="noreferrer">Documentation</a>
          <span>MIT License</span>
        </footer>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => go(k)}>
            <NavIcon name={k} />
            {label}
            {count(k)}
          </button>
        ))}
      </nav>

      {opened && <AccountPanel data={data} account={opened} onClose={() => setOpenId(null)} reload={load} notify={notify} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

const InsecureBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !isInsecurePage()) return null;
  return (
    <div className="banner warn" style={{ marginTop: 12 }}>
      <span>FQD session cookies require HTTPS. Over plain HTTP, sign-in persists until the tab closes.</span>
      <button className="icon-btn" type="button" onClick={() => setDismissed(true)} aria-label="Dismiss">
        <CloseIcon />
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
        <p className="muted small" style={{ margin: 0 }}>Enter master key or master password</p>
        <form onSubmit={submit}>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Master password" aria-label="Master password" autoFocus />
          {err && <div className="banner danger" style={{ margin: 0 }}>{err}</div>}
          <button type="submit" className="btn primary" disabled={busy || !pass}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default App;
