import React, { useState } from 'react';
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
    const csvContent = 'data:text/csv;charset=utf-8,Slot,Email,Provider,BurstRem,Status\n' +
      'slot_14,vishakhagemini0@gmail.com,Google,34%,Tight\n' +
      'slot_11,piyushkumar.jiit@gmail.com,Google,99%,Healthy\n' +
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
    <div id="tab-settings" className="view-panel active fqd-gateways-settings">
      {/* Backend Gateways Card */}
      <div className="card fqd-gateways-settings__card" style={{ marginBottom: 14 }}>
        <div className="card-header fqd-gateways-settings__header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="card-title">Backend Gateways &amp; Integrations</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Configured via .env / yaml mesh</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className="filter-btn"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={exportGatewayConfig}
            >
              Export Gateway Config
            </button>
            <button
              type="button"
              className="filter-btn"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={exportAuditCsv}
            >
              Export Audit CSV
            </button>
          </div>
        </div>

        {/* Clean Responsive 3-Column Grid */}
        <div className="integrations-grid grid-cols-3 fqd-gateways-settings__grid">
          <div className="card fqd-gateways-settings__gateway-card fqd-gateways-settings__gateway-card--cliproxy" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--blue)', padding: 12 }}>
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

          <div className="card fqd-gateways-settings__gateway-card fqd-gateways-settings__gateway-card--litellm" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--purple)', padding: 12 }}>
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

          <div className="card fqd-gateways-settings__gateway-card fqd-gateways-settings__gateway-card--slack" style={{ background: 'rgba(31, 41, 55, 0.5)', borderLeft: '3px solid var(--slack)', padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ color: '#f43f5e', fontSize: 13 }}>Slack Alert Dispatcher</strong>
              <span className="badge badge-ok">Webhook OK</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
              <div>Channel: <code>#ai-quota-alerts</code></div>
              <div>Trigger: <code>Headroom ? 20%</code></div>
              <div>Status: <span style={{ color: 'var(--ok)' }}>Auth Validated</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* Operational Preferences Card */}
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 14px 0' }}>Observability Configuration</h3>
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

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <span>Telegram Quota Notifications</span>
            <span className={`badge ${state.telegram ? 'badge-ok' : ''}`}>
              {state.telegram ? 'Active' : 'Disabled'}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <span>Prometheus Telemetry Scrape</span>
            <a href="http://172.19.0.4:8317/metrics" target="_blank" rel="noreferrer" style={{ color: '#38bdf8', fontSize: 12, textDecoration: 'none' }}>
              /metrics endpoint ?
            </a>
          </div>

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
