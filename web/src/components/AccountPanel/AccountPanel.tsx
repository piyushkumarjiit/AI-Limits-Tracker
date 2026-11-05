import React, { useEffect, useRef, useState } from 'react';
import { api, type Account } from '../../api';
import { go, href } from '../../route';
import {
  Badge,
  BucketBar,
  Dot,
  PencilIcon,
  STATUS_COLOR,
  familyOf,
  fmtCompact,
  fmtNum,
  levelsOf,
  providerColor,
  providerName,
  reasonOf,
  slotOf,
  statusOf,
  viewOf,
  type PanelData,
} from '../common/bits';

/** Quick look at one account, opened in place from any page. */
export const AccountPanel: React.FC<{
  data: PanelData;
  account: Account;
  onClose: () => void;
  reload: () => Promise<void>;
  notify: (msg: string) => void;
}> = ({ data, account: a, onClose, reload, notify }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const st = statusOf(data, a);
  const view = viewOf(data, a.id);
  const tele = data.telemetry?.accounts[a.id] ?? null;
  const fromCliproxy = Boolean(a.cpaLinked);
  const onHold = Boolean(view && view.manualHold !== 'none');

  useEffect(() => {
    setName(a.name);
    setEditing(false);
  }, [a.id, a.name]);
  useEffect(() => {
    if (editing) nameRef.current?.select();
  }, [editing]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      notify(done);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  const saveName = async () => {
    const next = name.trim();
    if (!next || next === a.name) return setEditing(false);
    await run(() => api.rename(a.id, next), 'Name saved');
    setEditing(false);
  };
  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(a.email ?? '');
      notify('Email copied');
    } catch {
      notify('Could not copy the email');
    }
  };
  const remove = async () => {
    if (!confirm(`Delete "${a.name}" and remove its stored credentials from FQD?`)) return;
    await run(() => api.remove(a.id), 'Account deleted');
    onClose();
  };

  const buckets = a.latestSnapshot?.buckets ?? [];
  const family = familyOf(a);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Details for ${a.name}`}>
        <div className="d-head">
          <div style={{ minWidth: 0 }}>
            {editing ? (
              <div className="name-edit">
                <input
                  ref={nameRef}
                  value={name}
                  aria-label="Display name"
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') {
                      setName(a.name);
                      setEditing(false);
                    }
                  }}
                />
                <button className="btn" disabled={busy} onClick={saveName}>Save</button>
                <button className="btn" onClick={() => { setName(a.name); setEditing(false); }}>Cancel</button>
              </div>
            ) : (
              <div className="name-row">
                <h3>{a.name}</h3>
                <button className="icon-btn" title="Edit display name" aria-label="Edit display name" onClick={() => setEditing(true)}>
                  <PencilIcon />
                </button>
              </div>
            )}
            {a.email && (
              <div className="muted small" style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {a.email !== a.name && a.email}
                <button className="link" onClick={copyEmail}>Copy email</button>
              </div>
            )}
            <div className="muted small">
              <Dot color={providerColor(a.providerType)} /> {providerName(a.providerType)} · slot {slotOf(data, a)} · {fromCliproxy ? 'from CLIProxy' : 'added directly'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!editing && <Badge status={st} />}
            <button className="btn" aria-label="Close panel" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="why" style={{ borderLeft: `3px solid ${STATUS_COLOR[st]}` }}>{reasonOf(data, a)}</div>

        <div className="d-sec" style={{ marginTop: 14 }}>
          <h4>Quota</h4>
          {buckets.length ? (
            buckets.map((b) => <BucketBar key={b.id} bucket={b} levels={levelsOf(data, a)} />)
          ) : (
            <span className="muted small">{a.lastError || 'The provider has not reported any quota yet.'}</span>
          )}
        </div>

        <div className="d-sec">
          <h4>Proxy traffic</h4>
          {fromCliproxy && tele ? (
            <>
              <div className="kv"><span className="muted">CLIProxy status</span><b>{tele.disabled ? 'Disabled' : tele.proxyStatus ? tele.proxyStatus[0].toUpperCase() + tele.proxyStatus.slice(1) : 'Active'}</b></div>
              <div className="kv"><span className="muted">Requests (last hour)</span><b>{fmtNum(tele.requestsLastHour ?? 0)} ({fmtNum(tele.failedLastHour ?? 0)} failed)</b></div>
              <div className="kv"><span className="muted">Requests (since proxy start)</span><b>{fmtNum(tele.successCount ?? 0)} ok / {fmtNum(tele.failedCount ?? 0)} failed</b></div>
              {tele.totalTokens > 0 && <div className="kv"><span className="muted">Tokens (last 24 h)</span><b>{fmtCompact(tele.totalTokens)}</b></div>}
              {tele.models?.map((m) => (
                <div className="kv" key={m.model} style={{ paddingLeft: 10 }}>
                  <span className="muted">{m.model}</span>
                  <span>{fmtNum(m.requests)} req · {fmtCompact(m.totalTokens)} tokens</span>
                </div>
              ))}
            </>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              {fromCliproxy
                ? data.telemetry?.global.notes?.[0] ?? 'No proxy telemetry for this account yet.'
                : 'No proxy telemetry for this account. It was added directly in FQD and is not routed through CLIProxy.'}
            </p>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <a className="link" href={href('accounts', { provider: family, highlight: a.id })} onClick={onClose}>Compare with other {family} accounts</a>
            <a className="link" href={href('usage', { family })} onClick={onClose}>{family} usage by alias</a>
          </div>
        </div>

        <div className="d-sec">
          <div className="d-actions">
            {fromCliproxy ? (
              onHold ? (
                <button
                  className="btn"
                  disabled={busy}
                  title="Clear the manual hold and return this account to automatic routing."
                  onClick={() => run(() => api.cpaHold({ accountId: a.id, hold: 'none' }), 'Back in rotation')}
                >
                  Return to rotation
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busy}
                  title="Take this account out of the CLIProxy pool now (weight 0, disabled). The hold ends automatically after 24 hours."
                  onClick={() => run(() => api.cpaHold({ accountId: a.id, hold: 'airgap' }), 'Taken out of rotation for 24 hours')}
                >
                  Cooldown
                </button>
              )
            ) : (
              <>
                <button
                  className="btn"
                  disabled={busy}
                  title="Sign in again for this account when its credentials have expired or been revoked."
                  onClick={() => {
                    onClose();
                    go(`add/${a.id}`);
                  }}
                >
                  Reconnect
                </button>
                <button className="btn danger" disabled={busy} title="Stop monitoring this account and remove its stored credentials from FQD." onClick={remove}>
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
