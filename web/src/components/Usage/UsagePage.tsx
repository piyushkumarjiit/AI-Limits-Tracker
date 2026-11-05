import React, { useState } from 'react';
import { href, setParams, type Route } from '../../route';
import { useUsage, USAGE_RANGE_LABEL } from './useUsage';
import { ContextBar, Dot, familyOf, fmtCompact, fmtNum, fmtSpend, providerColor, providerName, type PanelData } from '../common/bits';

/** All traffic in one place: LiteLLM usage by alias, and CLIProxy traffic per account. */
export const UsagePage: React.FC<{ data: PanelData; route: Route; openAccount: (id: string) => void; refreshKey: number }> = ({
  data,
  route,
  openAccount,
  refreshKey,
}) => {
  const p = route.params;
  const range = [1, 7, 30].includes(Number(p.get('range'))) ? Number(p.get('range')) : 7;
  const fam = p.get('family') || '';
  const report = useUsage(range, refreshKey);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const accountName = (id: string | null, email: string) => data.accounts.find((a) => a.id === id)?.name ?? email;
  const familyColor = (f: string) => {
    const a = data.accounts.find((x) => familyOf(x) === f);
    return a ? providerColor(a.providerType) : 'var(--muted)';
  };

  const aliases = (report?.aliases ?? []).filter((a) => !fam || a.family === fam);
  const tot = aliases.reduce(
    (t, a) => ({ requests: t.requests + a.requests, failed: t.failed + a.failed, spend: t.spend + a.spend, tokens: t.tokens + a.tokens }),
    { requests: 0, failed: 0, spend: 0, tokens: 0 }
  );
  const families = [...new Set([...(report?.families ?? []).map((f) => f.family), ...data.accounts.map(familyOf)])].sort();
  const traffic = data.accounts.filter((a) => a.cpaLinked !== false && (!fam || familyOf(a) === fam) && data.telemetry?.accounts[a.id]);

  const tile = (lbl: string, val: React.ReactNode, sub: string, color?: string) => (
    <div className="card tile">
      <span className="lbl">{lbl}</span>
      <span className="val" style={{ color: color ?? 'var(--text)' }}>{val}</span>
      <span className="sub">{sub}</span>
    </div>
  );

  return (
    <>
      <ContextBar from={p.get('from')} chips={fam ? [['family', fam]] : []} clearKeys={['family']} />
      <div className="toolbar">
        <div className="seg-group" role="group" aria-label="Range">
          {[1, 7, 30].map((d) => (
            <button key={d} className={range === d ? 'on' : ''} aria-pressed={range === d} onClick={() => setParams({ range: d === 7 ? null : d })}>
              {USAGE_RANGE_LABEL[d]}
            </button>
          ))}
        </div>
        <select className="sel" aria-label="Provider" value={fam} onChange={(e) => setParams({ family: e.target.value || null })}>
          <option value="">All providers</option>
          {families.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      {!report && <div className="card muted small">Loading usage…</div>}
      {report && !report.connected && (
        <div className="card empty">
          <p style={{ margin: '0 0 10px' }}>LiteLLM is not connected, so there is no usage by alias.</p>
          <a className="btn" href={href('settings', { focus: 'litellm' })}>See LiteLLM settings</a>
        </div>
      )}

      {report?.connected && (
        <>
          <div className="tiles">
            {tile('Requests', fmtNum(tot.requests), `${fmtNum(tot.requests - tot.failed)} succeeded`)}
            {tile('Spend', fmtSpend(tot.spend), `${fmtCompact(tot.tokens)} tokens`)}
            {tile('Failed calls', fmtNum(tot.failed), tot.requests ? `${((tot.failed / tot.requests) * 100).toFixed(1)}% of requests` : '-', tot.failed ? 'var(--warn)' : 'var(--ok)')}
            {tile('Aliases in use', aliases.length, [...new Set(aliases.map((a) => a.family))].join(' · ') || '-')}
          </div>

          <section className="section">
            <div className="section-head">
              <h2>Usage by alias</h2>
              <span className="muted small">Alias, cost and failures from LiteLLM. Accounts from CLIProxy (last 24 hours), joined on the model.</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Provider</th>
                    <th className="num">Requests</th>
                    <th className="num">Failed</th>
                    <th className="num">Tokens</th>
                    <th className="num">Spend</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {aliases.map((a) => {
                    const isOpen = Boolean(open[a.alias]);
                    const toggle = () => setOpen((o) => ({ ...o, [a.alias]: !o[a.alias] }));
                    return (
                      <React.Fragment key={a.alias}>
                        <tr className="clickable" tabIndex={0} aria-expanded={isOpen} onClick={toggle} onKeyDown={(e) => (e.key === 'Enter' ? toggle() : undefined)}>
                          <td><strong>{a.alias}</strong></td>
                          <td><Dot color={familyColor(a.family)} /> {a.family}</td>
                          <td className="num">{fmtNum(a.requests)}</td>
                          <td className="num" style={{ color: a.failed ? 'var(--warn)' : undefined }}>{fmtNum(a.failed)}</td>
                          <td className="num">{fmtCompact(a.tokens)}</td>
                          <td className="num"><strong>{fmtSpend(a.spend)}</strong></td>
                          <td className="toggle-txt">{isOpen ? 'Hide accounts' : 'Show accounts'}</td>
                        </tr>
                        {isOpen && (
                          <tr className="alias-split">
                            <td colSpan={7}>
                              {a.models.length === 0 && <div className="muted small">This alias is no longer in LiteLLM's model list, so its models are unknown.</div>}
                              {a.models.map((m) => {
                                const total = m.accounts.reduce((n, x) => n + x.requests, 0);
                                return (
                                  <div key={m.model} style={{ margin: '4px 0 8px' }}>
                                    <div className="small" style={{ marginBottom: 4 }}>
                                      <code>{m.model}</code>{' '}
                                      <span className="muted">{m.accounts.length ? 'served by accounts via CLIProxy' : 'no CLIProxy account traffic in the last 24 hours'}</span>
                                    </div>
                                    {m.accounts.map((ac) => {
                                      const share = total ? Math.round((ac.requests / total) * 100) : 0;
                                      return (
                                        <div className="split-row" key={ac.email}>
                                          {ac.accountId ? (
                                            <button className="link" style={{ textAlign: 'left' }} onClick={() => openAccount(ac.accountId!)}>
                                              {accountName(ac.accountId, ac.email)}
                                            </button>
                                          ) : (
                                            <span>{ac.email}</span>
                                          )}
                                          <div className="split-bar"><i style={{ width: `${share}%` }} /></div>
                                          <span className="num">{fmtNum(ac.requests)} req · {share}%</span>
                                        </div>
                                      );
                                    })}
                                    {m.sharedWith.length > 0 && m.accounts.length > 0 && (
                                      <div className="muted small">Also used by {m.sharedWith.join(', ')}: account shares are combined across these aliases.</div>
                                    )}
                                  </div>
                                );
                              })}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
              {aliases.length === 0 && <div className="empty">No LiteLLM requests {fam ? `for ${fam} ` : ''}in this range.</div>}
            </div>
            {report.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
          </section>
        </>
      )}

      <section className="section" style={{ marginTop: 18 }}>
        <div className="section-head">
          <h2>Account traffic</h2>
          <span className="muted small">From CLIProxy</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Provider</th>
                <th className="num">Last hour</th>
                <th className="num">Failed (last hour)</th>
                <th className="num">Since proxy start</th>
                <th className="num">Tokens (24 h)</th>
              </tr>
            </thead>
            <tbody>
              {traffic.map((a) => {
                const t = data.telemetry!.accounts[a.id];
                return (
                  <tr key={a.id} className="clickable" tabIndex={0} onClick={() => openAccount(a.id)} onKeyDown={(e) => (e.key === 'Enter' ? openAccount(a.id) : undefined)}>
                    <td>{a.name}</td>
                    <td><Dot color={providerColor(a.providerType)} /> {providerName(a.providerType)}</td>
                    <td className="num">{fmtNum(t.requestsLastHour ?? 0)}</td>
                    <td className="num" style={{ color: t.failedLastHour ? 'var(--warn)' : undefined }}>{fmtNum(t.failedLastHour ?? 0)}</td>
                    <td className="num">{fmtNum(t.successCount ?? 0)} ok / {fmtNum(t.failedCount ?? 0)} failed</td>
                    <td className="num">{fmtCompact(t.totalTokens ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {traffic.length === 0 && (
            <div className="empty">
              {fam && !data.accounts.some((a) => familyOf(a) === fam)
                ? `No CLIProxy accounts for ${fam}. It is routed directly by LiteLLM.`
                : (data.telemetry?.global.notes?.[0] ?? 'No proxy traffic reported yet.')}
            </div>
          )}
        </div>
      </section>
    </>
  );
};
