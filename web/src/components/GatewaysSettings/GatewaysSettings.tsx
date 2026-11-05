import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import './GatewaysSettings.css';

export interface GatewaysSettingsProps {
  state: {
    intervalMin?: number;
    telegram?: boolean;
    [key: string]: any;
  };
  reload: () => Promise<void>;
  onLogout?: () => void;
}

export const GatewaysSettings: React.FC<GatewaysSettingsProps> = ({
  state,
  reload,
  onLogout,
}) => {
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
    if (onLogout) {
      onLogout();
    } else {
      await api.logout();
      location.reload();
    }
  };

  const [cpa, setCpa] = useState<Awaited<ReturnType<typeof api.cpaStatus>> | null>(null);
  const [liteLlm, setLiteLlm] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  useEffect(() => {
    api.cpaStatus().then(setCpa).catch(() => setCpa(null));
    api.telemetry().then((t) => setLiteLlm(Boolean(t.global?.providers?.litellm))).catch(() => setLiteLlm(null));
  }, []);

  const sendTest = async () => {
    setTestMsg('Sending...');
    try {
      await api.telegramTest();
      setTestMsg('Test message sent.');
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : 'Test message failed.');
    }
  };

  const cpaBadge = !cpa ? ['badge-warn', 'Unknown'] : !cpa.enabled ? ['', 'Not configured'] : cpa.lastDiscoveryOk ? ['badge-ok', 'Connected'] : ['badge-bad', 'Unreachable'];
  const liteBadge = liteLlm === null ? ['badge-warn', 'Unknown'] : liteLlm ? ['badge-ok', 'Connected'] : ['', 'Not connected'];

  return (
    <div id="tab-settings" className="view-panel active fqd-gateways-settings">
      {/* Backend Gateways Card */}
      <div className="card fqd-gateways-settings__card" style={{ marginBottom: 14 }}>
        <div className="card-header fqd-gateways-settings__header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="card-title">Integrations</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Configured through server environment variables</span>
          </div>
        </div>

        <div className="integrations-grid grid-cols-3 fqd-gateways-settings__grid">
          <div className="card fqd-gateways-settings__gateway-card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--blue)', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>CLIProxy</strong>
              <span className={`badge ${cpaBadge[0]}`}>{cpaBadge[1]}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              {cpa?.enabled ? (
                <>
                  <div>Routing mode: <strong style={{ color: '#fff' }}>{cpa.routingMode || '-'}</strong></div>
                  <div>Last sync: {cpa.lastDiscoveryAt ? new Date(cpa.lastDiscoveryAt).toLocaleString() : 'never'}</div>
                </>
              ) : (
                <div>Set <code>CPA_BASE_URL</code> and <code>CPA_MANAGEMENT_KEY</code> in the server environment.</div>
              )}
            </div>
          </div>

          <div className="card fqd-gateways-settings__gateway-card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--purple)', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>LiteLLM</strong>
              <span className={`badge ${liteBadge[0]}`}>{liteBadge[1]}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Usage telemetry source. Set <code>LITELLM_URL</code> and <code>LITELLM_KEY</code> in the server environment.</div>
            </div>
          </div>

          <div className="card fqd-gateways-settings__gateway-card" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--ok)', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>Telegram Alerts</strong>
              <span className={`badge ${state.telegram ? 'badge-ok' : ''}`}>{state.telegram ? 'Configured' : 'Not configured'}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Low-quota, reset and re-login alerts. Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in the server environment.</div>
              {state.telegram && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button type="button" className="filter-btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={sendTest}>
                    Send test message
                  </button>
                  {testMsg && <span>{testMsg}</span>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Operational Preferences Card */}
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 14px 0' }}>Preferences</h3>
        <div style={{ display: 'grid', gap: 14, maxWidth: 480 }}>
          <label className="fqd-gateways-settings__pref-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
            <span>Auto-Refresh Interval</span>
            <select
              className="fqd-gateways-settings__select"
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

          <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
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
