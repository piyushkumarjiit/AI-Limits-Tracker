import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlertLogEntry, ProviderType, QuotaBucket } from '../../src/models/types';
import type { Forecast, StatPoint, UsageStats } from '../../src/services/stats';
import { bindingBucket, headlineBucket } from '../../src/services/providers/common';
import { accountChartColor, Colors, PROVIDER_COMPANY, PROVIDER_NAMES } from '../../src/constants/theme';
import { formatTimeRemaining, greeting, MONTHS_SHORT } from '../../src/utils/formatters';
import { Account, api, ApiError } from './api';
import { BarChart, Donut, Icon, LineChart, Logo, MiniBars, Ring, Segmented, StatusDot } from './ui';

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
        <div className="brand">
          <span className="brand-mark">◔</span> AI Limits
        </div>
        <NavItem icon="home" label="Home" active={tab === 'home'} onClick={() => go('/')} />
        <NavItem icon="chart" label="Stats" active={tab === 'stats'} onClick={() => go('/stats')} />
        <NavItem icon="users" label="Accounts" active={tab === 'accounts'} onClick={() => go('/accounts')} />
        <NavItem icon="bell" label="Alerts" active={tab === 'alerts'} onClick={() => go('/alerts')} />
        <NavItem icon="settings" label="Settings" active={tab === 'settings'} onClick={() => go('/settings')} />
        <button className="btn dark wide" onClick={() => go('/add')}>
          <Icon name="plus" size={18} /> Add account
        </button>
      </nav>
      <main className="main">{page}</main>
      <nav className="tabbar">
        <NavItem icon="home" label="Home" active={tab === 'home'} onClick={() => go('/')} />
        <NavItem icon="chart" label="Stats" active={tab === 'stats'} onClick={() => go('/stats')} />
        <div className="fab-slot">
          <button className="fab" aria-label="Add account" onClick={() => go('/add')}>
            <Icon name="plus" size={26} stroke={2.4} />
          </button>
        </div>
        <NavItem icon="users" label="Accounts" active={tab === 'accounts'} onClick={() => go('/accounts')} />
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

  useEffect(() => {
    api.history(2).then(({ points }) => {
      const by: Record<string, Array<number | null>> = {};
      for (const p of points) (by[p.accountId] = by[p.accountId] || []).push(p.session);
      for (const k of Object.keys(by)) by[k] = by[k].slice(-10);
      setBars(by);
    }).catch(() => {});
    api.stats(60).then(({ stats }) => setStreak(stats.currentStreak)).catch(() => {});
  }, [state.lastSyncAllAt, accounts.length]);

  let sum = 0, n = 0, low = 0, healthy = 0;
  let nearest: string | null = null;
  for (const a of accounts) {
    if (a.latestSnapshot?.status === 'ok') healthy++;
    const b = headlineBucket(a.latestSnapshot);
    if (b?.utilizationPercent != null) {
      sum += b.utilizationPercent;
      n++;
      if ((b.remainingPercent ?? 100) <= 20) low++;
      if (b.resetsAt && new Date(b.resetsAt).getTime() > Date.now() && (!nearest || b.resetsAt < nearest)) nearest = b.resetsAt;
    }
  }
  const avg = n ? Math.round(sum / n) : null;
  const counts: Record<string, number> = {};
  accounts.forEach((a) => (counts[a.providerType] = (counts[a.providerType] || 0) + 1));
  const filters = ['all', ...(['claude', 'chatgpt', 'gemini'] as ProviderType[]).filter((p) => counts[p])] as Array<'all' | ProviderType>;
  const visible = accounts.filter((a) => filter === 'all' || a.providerType === filter);
  const attention = accounts.some((a) => ['reauth_required', 'error'].includes(a.latestSnapshot?.status || a.lastStatus));

  return (
    <>
      <header className="home-head">
        <div>
          <p className="hello">{greeting()}</p>
          <h1 className="hero-name">Your limits 👋</h1>
          <p className="muted">All your AI accounts in one place, under control</p>
        </div>
        <div className="home-actions">
          <button className={`icon-btn ${syncing ? 'spin' : ''}`} onClick={onRefresh} aria-label="Refresh">
            <Icon name="refresh" />
          </button>
          <button className="icon-btn only-mobile" onClick={() => go('/stats')} aria-label="Stats">
            <Icon name="chart" />
          </button>
          <button className="icon-btn bell" onClick={() => go('/alerts')} aria-label="Alerts">
            <Icon name="bell" />
            {attention && <i className="dot" />}
          </button>
        </div>
      </header>

      <section className="card summary">
        <div className="summary-top">
          <div>
            <p className="label">Overall usage</p>
            <p className="big">{avg === null ? '—' : `${avg}%`}</p>
          </div>
          {streak !== null && streak > 0 && (
            <div className="streak-pill" title="Days in a row with activity">
              <Icon name="flame" size={16} /> {streak} {streak === 1 ? 'day' : 'days'} in a row
            </div>
          )}
        </div>
        <div className="track"><i style={{ width: `${Math.min(100, avg ?? 0)}%` }} /></div>
        <div className="stats4">
          <Stat v={String(accounts.length)} l={accounts.length === 1 ? 'account' : 'accounts'} />
          <Stat v={String(healthy)} l="active" />
          <Stat v={String(low)} l="running low" />
          <Stat v={nearest ? formatTimeRemaining(nearest) : '—'} l="until reset" />
        </div>
      </section>


      {accounts.length > 0 && (
        <div className="chips">
          {filters.map((f) => (
            <button key={f} className={`chip ${f === filter ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : PROVIDER_NAMES[f]} <i>{f === 'all' ? accounts.length : counts[f]}</i>
            </button>
          ))}
        </div>
      )}

      <div className="cards-grid">
        {visible.map((a) => {
          const b = headlineBucket(a.latestSnapshot);
          return (
            <button key={a.id} className="card account-card" onClick={() => go(`/account/${a.id}`)}>
              <div className="ac-left">
                <Logo type={a.providerType} size={44} />
                <div className="ac-meta">
                  <b>{a.name}</b>
                  <span className="muted small ellipsis">{[a.latestSnapshot?.planName || a.plan, a.email].filter(Boolean).join(' · ') || '—'}</span>
                  <StatusDot account={a} />
                </div>
              </div>
              <Ring remaining={b?.remainingPercent ?? null} provider={a.providerType} dim={a.latestSnapshot?.isStale} />
              <div className="ac-right">
                {b && b.remainingPercent != null && b.remainingPercent < 100 && b.resetsAt && (
                  <>
                    <span className="muted small">Resets in</span>
                    <b className="reset"><Icon name="clock" size={13} stroke={2.4} /> {formatTimeRemaining(b.resetsAt)}</b>
                  </>
                )}
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
  const [range, setRange] = useState('30');
  const [data, setData] = useState<{ stats: UsageStats; forecasts: Record<string, Forecast> } | null>(null);
  const colors = useColors(accounts);

  useEffect(() => {
    setData(null);
    api.stats(Number(range)).then(setData).catch(() => {});
  }, [range]);

  const dist = useMemo(() => {
    const items = accounts
      .map((a) => ({ a, used: bindingBucket(a.latestSnapshot)?.utilizationPercent ?? null }))
      .filter((x): x is { a: Account; used: number } => x.used !== null);
    const total = items.reduce((s, x) => s + x.used, 0);
    return { avg: items.length ? Math.round(total / items.length) : 0, items: items.map((x) => ({ ...x, share: total ? Math.round((x.used / total) * 100) : 0 })) };
  }, [accounts]);

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

          <div className="two-col">
            <div className="card">
              <h2>Load distribution</h2>
              <div className="dist">
                <Donut segments={dist.items.map((x) => ({ value: x.used, color: colors[x.a.id] }))} value={`${dist.avg}%`} label="on average" />
                <div className="legend">
                  {dist.items.map((x) => (
                    <div key={x.a.id}><i style={{ background: colors[x.a.id] }} /><span className="ellipsis">{x.a.name}</span><b>{x.share}%</b></div>
                  ))}
                  {!dist.items.length && <p className="muted small">No current data</p>}
                </div>
              </div>
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
  const move = async (i: number, dir: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.reorder(ids);
    await reload();
  };
  return (
    <>
      <Header
        title="Accounts"
        sub="Manage all AI accounts"
        right={<button className={`icon-btn ${syncing ? 'spin' : ''}`} onClick={onRefresh} aria-label="Refresh all"><Icon name="refresh" /></button>}
      />
      <button className="btn dark wide mb" onClick={() => go('/add')}><Icon name="plus" size={18} /> Add account</button>
      <div className="stack">
        {accounts.map((a, i) => (
          <div key={a.id} className="card list-row">
            <button className="row-main" onClick={() => go(`/account/${a.id}`)}>
              <Logo type={a.providerType} size={46} />
              <div className="grow">
                <b className="ellipsis">{a.name}</b>
                <span className="muted small ellipsis">{a.email || `updated ${relative(a.lastSyncAt)}`}</span>
              </div>
              <StatusDot account={a} />
            </button>
            <div className="order">
              <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
              <button disabled={i === accounts.length - 1} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
            </div>
          </div>
        ))}
        {!accounts.length && <Empty title="No accounts" text='Tap "Add account".' />}
      </div>
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
  { title: 'Coding', items: ['cursor', 'copilot'] },
  { title: 'Chat assistants', items: ['perplexity', 'grok', 'mistral', 'deepseek', 'poe'] },
  { title: 'Any other service', items: ['custom'] },
];

const supportsOAuth = (p: ProviderType) => p === 'claude' || p === 'chatgpt';

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
  const codePlaceholder = provider === 'claude' ? 'code#state' : 'http://localhost:1455/auth/callback?code=…';
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
              <p className="small muted">{provider === 'claude' ? 'Claude will show a code like xxxx#yyyy.' : 'The browser will open localhost:1455/auth/callback?code=… and show an error — that is normal; copy the whole address from the address bar.'}</p>
            </div></div>
            <div className="step"><i>3</i><div className="grow">
              <b>Paste it here</b>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={codePlaceholder} disabled={!oauth} style={{ marginTop: 6 }} />
            </div></div>
          </div>
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
          {supportsOAuth(provider) && <p className="muted tiny">⚠ cURL/sessionKey sign-in doesn't last long (about 30 min for Claude). For long-term use, choose "Sign in to account".</p>}
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
  useEffect(() => {
    api.alerts().then((r) => setItems(r.alerts)).catch(() => setItems([]));
  }, []);
  const icon: Record<string, string> = { low20: '🔔', low10: '⚠️', exhausted: '⛔', restored: '✅', reauth: 'ℹ️' };
  return (
    <>
      <Header
        title="Alerts"
        back
        right={items?.length ? <button className="link-btn" onClick={async () => { await api.clearAlerts(); setItems([]); }}>Clear</button> : null}
      />
      <div className="card list">
        {(items || []).map((n) => (
          <div key={n.id} className="alert-row">
            <span className="alert-icon">{icon[n.kind] || '🔔'}</span>
            <div className="grow">
              <b>{n.title}</b>
              <p className="muted small">{n.body}</p>
              {!n.title.includes(accounts.find((a) => a.id === n.accountId)?.name || '\u0000') && (
                <p className="muted tiny">{accounts.find((a) => a.id === n.accountId)?.name}</p>
              )}
            </div>
            <span className="muted tiny">{clock(n.createdAt)}</span>
          </div>
        ))}
        {items && !items.length && <Empty title="No alerts" text="Warnings about low limits, exhaustion, recovery and re-login requirements will appear here." />}
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
        AI Limits Tracker · open source · <a href="https://github.com/Rauan228/AI-Limits-Tracker" target="_blank" rel="noopener">GitHub</a>
      </p>
    </>
  );
};
