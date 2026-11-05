import React from 'react';
import type { Account } from '../../api';
import { formatTokenCount, type TelemetryResponse } from '../../../../src/services/telemetryService';
import './TelemetryVelocity.css';

export interface TelemetryVelocityProps {
  accounts: Account[];
  telemetry?: TelemetryResponse | null;
}

/** Request and model usage reported by CLIProxy and LiteLLM; shows nothing it cannot source. */
export const TelemetryVelocity: React.FC<TelemetryVelocityProps> = ({ accounts, telemetry }) => {
  const rows = accounts
    .map((a) => ({ account: a, t: telemetry?.accounts[a.id] }))
    .filter((r) => r.t)
    .sort((x, y) => (y.t!.requestsLastHour ?? 0) - (x.t!.requestsLastHour ?? 0));
  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const lastHour = sum((r) => r.t!.requestsLastHour ?? 0);
  const failedHour = sum((r) => r.t!.failedLastHour ?? 0);
  const total = sum((r) => r.t!.requestCount);
  const models = telemetry?.models ?? [];
  const notes = telemetry?.global.notes ?? [];

  return (
    <div id="tab-telemetry" className="view-panel active fqd-telemetry-velocity">
      <div className="grid-4" style={{ marginBottom: 14 }}>
        <div className="card stat-box">
          <span className="stat-sub">Requests (last hour)</span>
          <span className="stat-val">{telemetry ? lastHour : '-'}</span>
          <span className="stat-sub">{failedHour} failed</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Requests (since proxy start)</span>
          <span className="stat-val">{telemetry ? total : '-'}</span>
          <span className="stat-sub">{rows.length} accounts reporting</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">CLIProxy</span>
          <span className="stat-val">{telemetry?.global.providers.cliproxy ? 'Connected' : 'Not connected'}</span>
          <span className="stat-sub">Per-account requests</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">LiteLLM</span>
          <span className="stat-val">{telemetry?.global.providers.litellm ? 'Connected' : 'Not connected'}</span>
          <span className="stat-sub">Per-model usage (CLIProxy feed used when absent)</span>
        </div>
      </div>

      {notes.length > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: 12, fontSize: 12, color: 'var(--muted)' }}>
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Model Usage (last 24 hours)</span>
        </div>
        {models.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No model usage reported.</div>
        ) : (
          <div className="data-table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>MODEL</th>
                  <th>REQUESTS</th>
                  <th>PROMPT TOKENS</th>
                  <th>COMPLETION TOKENS</th>
                  <th>TOTAL TOKENS</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model}>
                    <td><strong>{m.model}</strong></td>
                    <td>{m.requests}</td>
                    <td>{formatTokenCount(m.promptTokens)}</td>
                    <td>{formatTokenCount(m.completionTokens)}</td>
                    <td>{formatTokenCount(m.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Account Traffic</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No account traffic reported.</div>
        ) : (
          <div className="data-table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ACCOUNT</th>
                  <th>CLIPROXY STATUS</th>
                  <th>LAST HOUR</th>
                  <th>FAILED (LAST HOUR)</th>
                  <th>SINCE PROXY START</th>
                  <th>TOKENS (24H)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ account, t }) => (
                  <tr key={account.id}>
                    <td><strong>{account.email || account.name}</strong></td>
                    <td>{t!.disabled ? 'Disabled' : t!.proxyStatus || 'Active'}</td>
                    <td>{t!.requestsLastHour ?? 0}</td>
                    <td>{t!.failedLastHour ?? 0}</td>
                    <td>{t!.successCount ?? 0} ok / {t!.failedCount ?? 0} failed</td>
                    <td>{t!.totalTokens > 0 ? formatTokenCount(t!.totalTokens) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
