import React from 'react';
import type { Account } from '../../api';
import { go, setParams, type Route } from '../../route';
import { quotaWindows, ACCOUNT_STATUS_LABEL, type AccountStatus } from '../common/cpaUiUtils';
import {
  Badge,
  BucketBar,
  ContextBar,
  Dot,
  Meter,
  bindingOf,
  familyOf,
  levelsOf,
  providerColor,
  providerName,
  reasonOf,
  slotOf,
  statusOf,
  untilText,
  type PanelData,
} from '../common/bits';

type StatusFilter = 'all' | 'attention' | AccountStatus;
const STATUS_ORDER: Record<AccountStatus, number> = { exhausted: 0, tight: 1, cooldown: 2, healthy: 3 };
const SORT_LABEL: Record<string, string> = {
  name: 'account',
  provider: 'provider',
  fiveHour: '5-hour headroom',
  weekly: 'weekly headroom',
  reset: 'next reset',
  status: 'status',
};

/** Every per-account view in one place: one filtered list, as a table or as cards. */
export const AccountsPage: React.FC<{ data: PanelData; route: Route; openAccount: (id: string) => void }> = ({ data, route, openAccount }) => {
  const p = route.params;
  const st = (p.get('status') || 'all') as StatusFilter;
  const prov = p.get('provider') || '';
  const search = p.get('q') || '';
  const sort = p.get('sort') || 'slot';
  const dir = p.get('dir') || 'asc';
  const view = p.get('view') || 'table';
  const highlight = p.get('highlight');

  const status = (a: Account) => statusOf(data, a);
  const matchStatus = (a: Account, f: StatusFilter) =>
    f === 'all' || (f === 'attention' ? status(a) === 'exhausted' || status(a) === 'tight' : status(a) === f);
  const counts = (f: StatusFilter) => data.accounts.filter((a) => matchStatus(a, f)).length;

  const key = (a: Account): string | number => {
    const w = quotaWindows(a);
    switch (sort) {
      case 'name': return a.name.toLowerCase();
      case 'provider': return familyOf(a);
      case 'fiveHour': return w.fiveHour?.remaining ?? 101;
      case 'weekly': return w.weekly?.remaining ?? 101;
      case 'reset': return bindingOf(a)?.resetsAt ? new Date(bindingOf(a)!.resetsAt!).getTime() : Infinity;
      case 'status': return STATUS_ORDER[status(a)];
      default: return data.accounts.indexOf(a);
    }
  };
  const list = data.accounts
    .filter((a) => matchStatus(a, st))
    .filter((a) => !prov || familyOf(a) === prov)
    .filter((a) => !search || `${a.name} ${a.email ?? ''} ${slotOf(data, a)}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const r = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) - (y as number);
      return dir === 'asc' ? r : -r;
    });

  const chips: Array<[string, string]> = [];
  if (st !== 'all') chips.push(['status', st === 'attention' ? 'Needs attention' : ACCOUNT_STATUS_LABEL[st]]);
  if (prov) chips.push(['provider', prov]);
  if (search) chips.push(['q', `"${search}"`]);
  if (sort !== 'slot') chips.push(['sort', `Sorted by ${SORT_LABEL[sort] ?? sort} (${dir === 'asc' ? 'lowest first' : 'highest first'})`]);

  const families = [...new Set(data.accounts.map(familyOf))].sort();
  const statusButton = (f: StatusFilter, label: string) => (
    <button key={f} className={st === f ? 'on' : ''} onClick={() => setParams({ status: f === 'all' ? null : f })}>
      {label}<span className="n">{counts(f)}</span>
    </button>
  );
  const th = (k: string, label: string) => (
    <th
      className={`sortable ${sort === k ? 'sorted' : ''}`}
      aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => setParams({ sort: k, dir: sort === k && dir === 'asc' ? 'desc' : 'asc' })}
    >
      {label}
    </th>
  );

  return (
    <>
      <ContextBar from={p.get('from')} chips={chips} clearKeys={['status', 'provider', 'q', 'sort', 'dir']} />
      <div className="toolbar">
        <div className="seg-group" role="group" aria-label="Status">
          {statusButton('all', 'All')}
          {statusButton('attention', 'Needs attention')}
          {statusButton('healthy', 'Healthy')}
          {statusButton('tight', 'Tight')}
          {statusButton('exhausted', 'Exhausted')}
          {statusButton('cooldown', 'Cooldown')}
        </div>
        <select className="sel" aria-label="Provider" value={prov} onChange={(e) => setParams({ provider: e.target.value || null })}>
          <option value="">All providers</option>
          {families.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <input
          className="search"
          placeholder="Search account or slot"
          aria-label="Search accounts"
          value={search}
          onChange={(e) => setParams({ q: e.target.value || null })}
        />
        <span className="spacer" />
        <div className="seg-group" role="group" aria-label="Layout">
          <button className={view === 'table' ? 'on' : ''} onClick={() => setParams({ view: null })}>Table</button>
          <button className={view === 'cards' ? 'on' : ''} onClick={() => setParams({ view: 'cards' })}>Cards</button>
        </div>
        <button className="btn primary" onClick={() => go('add')}>Add account</button>
      </div>

      {view === 'cards' ? (
        list.length ? (
          <div className="cards">
            {list.map((a) => (
              <button key={a.id} className="card acard drill" onClick={() => openAccount(a.id)}>
                <div className="acard-head" style={{ width: '100%' }}>
                  <div>
                    <strong>{a.name}</strong>
                    <div className="muted small"><Dot color={providerColor(a.providerType)} /> {providerName(a.providerType)} · slot {slotOf(data, a)}</div>
                  </div>
                  <Badge status={status(a)} />
                </div>
                <div style={{ width: '100%' }}>
                  {(a.latestSnapshot?.buckets ?? []).map((b) => <BucketBar key={b.id} bucket={b} levels={levelsOf(data, a)} />)}
                  {!(a.latestSnapshot?.buckets ?? []).length && <span className="muted small">No quota reported yet.</span>}
                </div>
                <div className="muted small">{reasonOf(data, a)}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="card empty">No accounts match these filters.</div>
        )
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {th('slot', 'Slot')}
                {th('name', 'Account')}
                {th('provider', 'Provider')}
                {th('fiveHour', '5-hour')}
                {th('weekly', 'Weekly')}
                {th('reset', 'Next reset')}
                {th('status', 'Status')}
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const w = quotaWindows(a);
                const b = bindingOf(a);
                return (
                  <tr key={a.id} className={`clickable ${highlight === a.id ? 'hl' : ''}`} tabIndex={0} onClick={() => openAccount(a.id)} onKeyDown={(e) => (e.key === 'Enter' ? openAccount(a.id) : undefined)}>
                    <td className="muted small">#{slotOf(data, a)}</td>
                    <td>
                      <div className="acct-cell">
                        <strong>{a.name}</strong>
                        {a.email && a.email !== a.name && <small>{a.email}</small>}
                      </div>
                    </td>
                    <td><Dot color={providerColor(a.providerType)} /> {providerName(a.providerType)}</td>
                    <td><Meter value={w.fiveHour?.remaining} levels={levelsOf(data, a)} /></td>
                    <td><Meter value={w.weekly?.remaining} levels={levelsOf(data, a)} /></td>
                    <td className="muted small">{b?.resetsAt ? `${b.label} in ${untilText(b.resetsAt)}` : '-'}</td>
                    <td><Badge status={status(a)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length === 0 && <div className="empty">{data.accounts.length ? 'No accounts match these filters.' : 'No accounts yet. Connect CLIProxy in the server settings or add an account.'}</div>}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Showing {list.length} of {data.accounts.length} accounts · click any account for its quota windows, traffic and actions.
      </p>
    </>
  );
};
