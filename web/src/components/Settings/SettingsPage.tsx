import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { href, type Route } from '../../route';
import { Badge, type PanelData } from '../common/bits';

type CpaStatus = Awaited<ReturnType<typeof api.cpaStatus>>;

const ROUTING_MODE_TIP =
  'Set with CPA_ROUTING_MODE. Use enforce if you want FQD to cool down (drain and disable) accounts automatically. shadow (the default) only logs what FQD would change; off leaves routing alone.';

/** Integrations and preferences. Connections are configured through server environment variables. */
export const SettingsPage: React.FC<{
  data: PanelData;
  route: Route;
  reload: () => Promise<void>;
  refresh: () => void;
  syncing: boolean;
  notify: (msg: string) => void;
}> = ({ data, route, reload, refresh, syncing, notify }) => {
  const focus = route.params.get('focus');
  const [cpa, setCpa] = useState<CpaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.cpaStatus().then(setCpa).catch(() => setCpa(null));
  }, []);

  const ring = (k: string): React.CSSProperties => (focus === k ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-soft)' } : {});
  const litellm = data.telemetry ? data.telemetry.global.providers.litellm : null;
  const cpaBadge = !cpa ? ['b-tight', 'Unknown'] : !cpa.enabled ? ['b-cooldown', 'Not configured'] : cpa.lastDiscoveryOk ? ['b-healthy', 'Connected'] : ['b-exhausted', 'Unreachable'];
  const liteBadge = litellm === null ? ['b-tight', 'Unknown'] : litellm ? ['b-healthy', 'Connected'] : ['b-cooldown', 'Not connected'];
  const plainBadge = (cls: string, text: string) => <span className={`badge ${cls}`}>{text}</span>;

  const changeInterval = async (min: number) => {
    setBusy(true);
    try {
      await api.setInterval(min);
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const sendTest = async () => {
    try {
      await api.telegramTest();
      notify('Test message sent.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Test message failed.');
    }
  };

  const lv = data.levels;
  // Enforce needs CLIProxy's weighted-round-robin strategy; otherwise the engine only logs decisions.
  const enforcePaused = data.overview?.mode === 'enforce' && data.overview?.writesBlockedReason === 'strategy';
  return (
    <>
      {focus && (
        <div className="context">
          <a className="link" href={href('overview')}>Back to Overview</a>
        </div>
      )}
      <div className="section-head">
        <h2>Integrations</h2>
        <span className="muted small">Configured through server environment variables</span>
      </div>
      <div className="grid-auto n3">
        <div className="card" style={ring('cliproxy')}>
          <div className="section-head"><h2>CLIProxy</h2>{plainBadge(cpaBadge[0], cpaBadge[1])}</div>
          {cpa?.enabled ? (
            <>
              <div className="kv"><span className="muted">URL</span><span>{data.gateways.cliproxyUrl ?? '-'}</span></div>
              <div className="kv"><span className="muted has-tip" title={ROUTING_MODE_TIP}>FQD routing mode</span><span>{cpa.routingMode ?? '-'}{enforcePaused ? ' (paused)' : ''}</span></div>
              <div className="kv"><span className="muted has-tip" title="The routing strategy configured in CLIProxy, read from its management API.">CLIProxy strategy</span><span>{data.overview?.routingStrategy ?? '-'}</span></div>
              {enforcePaused && (
                <div className="banner warn" style={{ margin: '8px 0', display: 'block' }}>
                  Enforce is paused: CLIProxy's routing strategy is <code>{data.overview?.routingStrategy}</code>. Set <code>routing.strategy: weighted-round-robin</code> in CLIProxy's <code>config.yaml</code> so FQD can drain and disable accounts. Until then FQD only logs what it would do.
                </div>
              )}
              <div className="kv"><span className="muted">Last sync</span><span>{cpa.lastDiscoveryAt ? new Date(cpa.lastDiscoveryAt).toLocaleString() : 'never'}</span></div>
            </>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>Set <code>CPA_BASE_URL</code> and <code>CPA_MANAGEMENT_KEY</code> in the server environment.</p>
          )}
        </div>
        <div className="card" style={ring('litellm')}>
          <div className="section-head"><h2>LiteLLM</h2>{plainBadge(liteBadge[0], liteBadge[1])}</div>
          {data.gateways.litellmUrl && <div className="kv"><span className="muted">URL</span><span>{data.gateways.litellmUrl}</span></div>}
          <div className="kv"><span className="muted">Provides</span><span>Requests, spend and failures by alias</span></div>
          {!data.gateways.litellmUrl && (
            <p className="muted small" style={{ margin: '6px 0 0' }}>Set <code>LITELLM_URL</code> and <code>LITELLM_KEY</code> in the server environment.</p>
          )}
        </div>
        <div className="card">
          <div className="section-head"><h2>Telegram alerts</h2>{plainBadge(data.telegram ? 'b-healthy' : 'b-cooldown', data.telegram ? 'Configured' : 'Not configured')}</div>
          <p className="muted small" style={{ margin: '0 0 10px' }}>
            Low-quota, reset and re-login alerts.
            {!data.telegram && <> Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in the server environment.</>}
          </p>
          {data.telegram && <button className="btn" onClick={sendTest}>Send test message</button>}
        </div>
      </div>

      <div className="grid-auto n1">
        <div className="card">
          <div className="section-head"><h2>Preferences</h2></div>
          <div className="pref" style={{ paddingTop: 0 }}>
            <strong style={{ flex: 1 }}>Auto-refresh interval</strong>
            <select className="sel" aria-label="Auto-refresh interval" value={data.intervalMin || 15} disabled={busy} onChange={(e) => changeInterval(Number(e.target.value))}>
              <option value={5}>Every 5 minutes</option>
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every hour</option>
            </select>
            <button className="btn" onClick={refresh} disabled={syncing}>{syncing ? 'Refreshing…' : 'Refresh now'}</button>
          </div>
          <div style={{ paddingTop: 12 }}>
            <div style={{ marginBottom: 4 }}>
              <strong>Status levels</strong> <span className="muted small">(from policy.yaml, read-only)</span>
            </div>
            <div className="lvl head"><span /><span>Pro tier</span><span>Non-Pro tier</span></div>
            <div className="lvl"><span><Badge status="healthy" /></span><span>above {lv.pro.tightPct}%</span><span>above {lv.nonPro.tightPct}%</span></div>
            <div className="lvl"><span><Badge status="tight" /></span><span>{lv.pro.tightPct}% or less (drain)</span><span>{lv.nonPro.tightPct}% or less (drain)</span></div>
            <div className="lvl"><span><Badge status="exhausted" /></span><span>{lv.pro.exhaustedPct}% or less (hard stop)</span><span>{lv.nonPro.exhaustedPct}% or less (hard stop)</span></div>
            <p className="muted small" style={{ margin: '8px 0 0' }}>
              Tiers come from the policy's classification rules. Change these in the file set by <code>CPA_WATERMARK_POLICY_FILE</code>.
            </p>
          </div>
        </div>
      </div>
    </>
  );
};
