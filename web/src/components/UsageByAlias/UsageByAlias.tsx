import React, { useEffect, useState } from 'react';
import { api, type Account } from '../../api';
import type { UsageReport } from '../../../../src/services/liteLlmUsage';
import './UsageByAlias.css';

export const USAGE_RANGE_LABEL: Record<number, string> = { 1: 'Today', 7: '7 days', 30: '30 days' };

/** LiteLLM usage for a range; null while loading or when the request fails. */
export function useUsage(days: number): UsageReport | null {
  const [report, setReport] = useState<UsageReport | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.usage(days).then((r) => live && setReport(r)).catch(() => live && setReport(null));
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [days]);
  return report;
}

export const fmtCount = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString();
export const fmtSpend = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const RangePicker: React.FC<{ days: number; onChange: (d: number) => void }> = ({ days, onChange }) => (
  <div className="usage-range" role="group" aria-label="Usage range">
    {[1, 7, 30].map((d) => (
      <button key={d} type="button" className={d === days ? 'active' : ''} aria-pressed={d === days} onClick={() => onChange(d)}>
        {USAGE_RANGE_LABEL[d]}
      </button>
    ))}
  </div>
);

/** Usage by LiteLLM alias, expandable to the models behind it and the accounts that served them. */
export const UsageByAlias: React.FC<{ accounts: Account[] }> = ({ accounts }) => {
  const [days, setDays] = useState(7);
  const report = useUsage(days);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const labelOf = (id: string | null, email: string) => {
    const acc = id ? accounts.find((a) => a.id === id) : undefined;
    return acc ? acc.name || acc.email || email : email;
  };

  return (
    <div className="view-panel active usage-page">
      <div className="usage-head">
        <div>
          <h2 className="usage-title">Usage by alias</h2>
          <p className="usage-sub">What each LiteLLM alias costs, which models answer it, and which accounts serve them.</p>
        </div>
        <RangePicker days={days} onChange={setDays} />
      </div>

      {report && !report.connected && (
        <div className="card usage-note">{report.notes[0] ?? 'LiteLLM is not connected.'}</div>
      )}

      {report?.connected && (
        <>
          <div className="grid-4">
            <div className="card stat-box">
              <span className="stat-sub">Requests</span>
              <span className="stat-val">{report.totals.requests.toLocaleString()}</span>
              <span className="stat-sub">{report.totals.successful.toLocaleString()} succeeded</span>
            </div>
            <div className="card stat-box">
              <span className="stat-sub">Spend</span>
              <span className="stat-val">{fmtSpend(report.totals.spend)}</span>
              <span className="stat-sub">{fmtCount(report.totals.tokens)} tokens</span>
            </div>
            <div className="card stat-box">
              <span className="stat-sub">Failed calls</span>
              <span className="stat-val" style={{ color: report.totals.failed ? 'var(--warn)' : 'var(--ok)' }}>
                {report.totals.failed.toLocaleString()}
              </span>
              <span className="stat-sub">
                {report.totals.requests ? `${((report.totals.failed / report.totals.requests) * 100).toFixed(1)}% of requests` : '-'}
              </span>
            </div>
            <div className="card stat-box">
              <span className="stat-sub">Aliases in use</span>
              <span className="stat-val">{report.aliases.length}</span>
              <span className="stat-sub">{report.families.map((f) => f.family).join(' · ') || '-'}</span>
            </div>
          </div>

          <div className="usage-legend">
            <span className="ux-chip ux-chip-alias">alias</span>→<span className="ux-chip ux-chip-model">model</span>→<span className="ux-chip ux-chip-account">account</span>
            <span>Alias, cost and failures come from LiteLLM; accounts come from CLIProxy (last 24 hours), joined on the model.</span>
          </div>

          <div className="card usage-table">
            <div className="usage-row usage-row--head">
              <span>Alias</span>
              <span>Requests</span>
              <span>Failed</span>
              <span>Tokens</span>
              <span>Spend</span>
            </div>
            {report.aliases.map((a) => {
              const isOpen = !!open[a.alias];
              return (
                <div key={a.alias} className="usage-alias">
                  <button
                    type="button"
                    className="usage-row"
                   
                    aria-expanded={isOpen}
                    onClick={() => setOpen((o) => ({ ...o, [a.alias]: !o[a.alias] }))}
                  >
                    <span className="usage-alias-name">
                      <span className="usage-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      <code>{a.alias}</code>
                      <span className="usage-family">{a.family}</span>
                    </span>
                    <span>{a.requests.toLocaleString()}</span>
                    <span style={{ color: a.failed ? 'var(--warn)' : undefined }}>{a.failed.toLocaleString()}</span>
                    <span>{fmtCount(a.tokens)}</span>
                    <strong>{fmtSpend(a.spend)}</strong>
                  </button>
                  {isOpen && (
                    <div className="usage-detail">
                      {a.models.length === 0 && (
                        <div className="usage-model">This alias is no longer in LiteLLM's model list, so its models are unknown.</div>
                      )}
                      {a.models.map((m) => {
                        const total = m.accounts.reduce((n, x) => n + x.requests, 0);
                        return (
                          <div key={m.model} className="usage-model">
                            <div className="usage-model-head">
                              <span className="ux-chip ux-chip-model">{m.model}</span>
                              <span className="usage-family">{m.accounts.length ? 'served by accounts via CLIProxy' : 'no CLIProxy account traffic in the last 24 hours'}</span>
                            </div>
                            {m.accounts.map((ac) => {
                              const share = total ? Math.round((ac.requests / total) * 100) : 0;
                              return (
                                <div key={ac.email} className="usage-acct">
                                  <span className="ux-chip ux-chip-account" title={ac.email}>{labelOf(ac.accountId, ac.email)}</span>
                                  <div className="usage-bar"><div style={{ width: `${share}%` }} /></div>
                                  <span>{ac.requests.toLocaleString()} req · {share}%</span>
                                </div>
                              );
                            })}
                            {m.sharedWith.length > 0 && m.accounts.length > 0 && (
                              <div className="usage-shared">
                                Also used by {m.sharedWith.join(', ')}: account shares are combined across these aliases.
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {report.aliases.length === 0 && <div className="usage-model">No LiteLLM requests in this range.</div>}
          </div>
          {report.notes.map((n) => (
            <p key={n} className="usage-sub">{n}</p>
          ))}
        </>
      )}
      {!report && <div className="card usage-note">Loading usage…</div>}
    </div>
  );
};
