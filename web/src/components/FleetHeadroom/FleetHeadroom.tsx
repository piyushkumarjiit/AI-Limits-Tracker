import React, { useState } from 'react';
import type { Account } from '../../api';
import { dualRingData } from '../../../../src/services/capacity';
import { getSlotHeadroom } from '../common/headroomUtils';
import './FleetHeadroom.css';

export interface FleetHeadroomProps {
  agyAccounts: Account[];
  claudeAccounts: Account[];
  effectiveAccounts: Account[];
  hoverAccount: Account | null;
  setHoverAccount: (a: Account | null) => void;
  onSelectAccount: (a: Account) => void;
  agyHeadroom: string;
  claudeHeadroom: string;
}

export const FleetHeadroom: React.FC<FleetHeadroomProps> = ({
  agyAccounts,
  claudeAccounts,
  effectiveAccounts,
  hoverAccount,
  setHoverAccount,
  onSelectAccount,
  agyHeadroom,
  claudeHeadroom,
}) => {
  const [capView, setCapView] = useState<'auto' | 'cell' | 'matrix' | 'aggregate'>('auto');
  const [simSize, setSimSize] = useState<number>(15);

  const activeView = capView === 'auto'
    ? (simSize <= 20 ? 'cell' : simSize <= 40 ? 'matrix' : 'aggregate')
    : capView;

  return (
    <div className="card fqd-fleet-headroom" style={{ marginBottom: 14 }}>
      <div className="card-header fqd-fleet-headroom__header" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div>
          <div className="fqd-fleet-headroom__title-wrap" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="card-title">Fleet Headroom Capacity</span>
            <span
              className="fqd-fleet-headroom__info-icon"
              style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center' }}
              title="Auto-scales across Cell (?20) ? Matrix (?2 rows) ? Aggregate (>2 rows)"
            >
              ?
            </span>
          </div>
        </div>
        <div className="fqd-fleet-headroom__controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="fqd-fleet-headroom__select"
            value={capView}
            onChange={(e) => setCapView(e.target.value as any)}
            style={{ background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 11 }}
          >
            <option value="auto">Auto-Scale</option>
            <option value="cell">Cell View</option>
            <option value="matrix">Matrix View</option>
            <option value="aggregate">Aggregate View</option>
          </select>
          <div style={{ display: 'flex', gap: 3 }}>
            <button className={`filter-btn ${simSize === 15 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(15); setCapView('auto'); }}>15</button>
            <button className={`filter-btn ${simSize === 32 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(32); setCapView('auto'); }}>32</button>
            <button className={`filter-btn ${simSize === 120 ? 'active' : ''}`} style={{ padding: '2px 6px', fontSize: 10 }} onClick={() => { setSimSize(120); setCapView('auto'); }}>120</button>
          </div>
        </div>
      </div>

      <div id="cap-mode-indicator" className="fqd-fleet-headroom__indicator" style={{ fontSize: 10, color: '#60a5fa', marginBottom: 10, background: 'rgba(59,130,246,0.1)', padding: '4px 10px', borderRadius: 6, display: 'inline-block' }}>
        Mode: <strong>{capView.toUpperCase()}</strong> ? <strong>{simSize} Accounts ({simSize <= 20 ? '?20' : simSize <= 40 ? '?2 rows' : '>2 rows'})</strong> ? Rendering <strong>{activeView.toUpperCase()} View</strong>
      </div>

      {/* 1. Cell View */}
      {activeView === 'cell' && (
        <div id="view-cap-cell" className="scale-box" style={{ borderLeft: '3px solid var(--blue)' }}>
          <div className="fqd-fleet-headroom__row-header" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
            <span><strong>Google Antigravity</strong> ({agyAccounts.length} Accounts)</span>
            <span style={{ color: 'var(--ok)' }}><strong>{agyHeadroom}% Headroom</strong></span>
          </div>
          <div className="gradient-bar-track">
            {agyAccounts.map((acc, idx) => {
              const h = getSlotHeadroom(acc, idx);
              const slotLabel = String(idx + 1).padStart(2, '0');
              const isSelected = hoverAccount?.id === acc.id || (!hoverAccount && h.isTight);
              return (
                <div
                  key={acc.id}
                  className="grad-segment"
                  style={{
                    borderColor: isSelected ? (h.isTight ? h.color : '#60a5fa') : undefined,
                    transform: isSelected ? 'translateY(-2px)' : undefined,
                  }}
                  onMouseEnter={() => setHoverAccount(acc)}
                  onClick={() => onSelectAccount(acc)}
                >
                  <span className="grad-segment-label">{slotLabel}</span>
                  <div
                    className="grad-segment-fill"
                    style={{
                      height: `${Math.max(10, h.rem)}%`,
                      background: h.fill,
                    }}
                  >
                    <div
                      className="grad-segment-waterline"
                      style={{
                        color: h.waterlineColor,
                        background: h.waterlineBg,
                      }}
                    />
                  </div>
                  <div className="grad-segment-tooltip" style={{ borderColor: h.isTight ? h.color : undefined }}>
                    <strong>{acc.email || acc.name}</strong> (Slot {slotLabel})<br />
                    <span style={{ color: h.color }}>{h.rem}% {h.label}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="fqd-fleet-headroom__row-header" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 12, marginBottom: 6 }}>
            <span><strong>Claude Code</strong> ({claudeAccounts.length} Account)</span>
            <span style={{ color: 'var(--ok)' }}><strong>{claudeHeadroom}% Headroom</strong></span>
          </div>
          <div className="gradient-bar-track fqd-fleet-headroom__claude-track" style={{ height: 48, display: 'flex', gap: 4, justifyContent: 'flex-start' }}>
            {claudeAccounts.map((acc) => {
              const ring = dualRingData(acc.latestSnapshot);
              const rem = ring.outer ? ring.outer.remaining : ring.inner ? ring.inner.remaining : 84;
              const isSelected = hoverAccount?.id === acc.id;
              return (
                <div
                  key={acc.id}
                  className="grad-segment fqd-fleet-headroom__claude-segment"
                  style={{
                    flex: '0 0 calc((100% - 52px) / 14)',
                    maxWidth: 85,
                    height: 48,
                    borderColor: isSelected ? '#ea580c' : undefined,
                    transform: isSelected ? 'translateY(-2px)' : undefined,
                  }}
                  onMouseEnter={() => setHoverAccount(acc)}
                  onClick={() => onSelectAccount(acc)}
                >
                  <span className="grad-segment-label">01</span>
                  <div
                    className="grad-segment-fill"
                    style={{
                      height: `${Math.max(10, rem)}%`,
                      background: 'linear-gradient(0deg, #7c2d12, #ea580c)',
                    }}
                  >
                    <div className="grad-segment-waterline" style={{ color: '#fdba74', background: '#ffedd5' }} />
                  </div>
                  <div className="grad-segment-tooltip" style={{ borderColor: '#ea580c' }}>
                    <strong>{acc.email || acc.name}</strong><br />
                    {Math.round(rem)}% Available ? Anthropic Rolling
                  </div>
                </div>
              );
            })}
          </div>

          {/* Hover details pill */}
          {hoverAccount && (() => {
            const hovIdx = agyAccounts.findIndex(a => a.id === hoverAccount.id);
            const isClaude = hoverAccount.providerType === 'claude';
            const h = getSlotHeadroom(hoverAccount, hovIdx >= 0 ? hovIdx : 0);
            const slotStr = isClaude ? 'slot_01' : `slot_${String(hovIdx >= 0 ? hovIdx + 1 : 14).padStart(2, '0')}`;
            return (
              <div className="fqd-fleet-headroom__hover-pill" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, padding: '8px 12px', background: 'var(--card-hi)', borderRadius: 8, fontSize: 11 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="badge badge-slot">{slotStr}</span>
                  <strong style={{ color: '#fff' }}>{hoverAccount.email || hoverAccount.name}</strong>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ color: h.color, fontWeight: 700 }}>{h.rem}% ({h.reqs} reqs)</span>
                  <span className={`badge ${h.badge}`}>{h.label}</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 2. Matrix View */}
      {activeView === 'matrix' && (
        <div id="view-cap-matrix" className="scale-box" style={{ borderLeft: '3px solid var(--purple)' }}>
          <div style={{ fontSize: 11, marginBottom: 8, color: 'var(--muted)' }}>
            Dual-Row Matrix: Displaying 32 provisioned gateway slots
          </div>
          <div className="matrix-grid">
            {Array.from({ length: 32 }).map((_, i) => {
              const isWarn = i === 13;
              const isAlt = i === 10 || i === 22;
              return (
                <div
                  key={i}
                  className="matrix-cell"
                  style={{
                    borderColor: isWarn ? '#f59e0b' : isAlt ? '#38bdf8' : 'rgba(59,130,246,0.2)',
                    background: isWarn ? 'rgba(245,158,11,0.1)' : 'rgba(15,23,42,0.8)',
                  }}
                  onClick={() => {
                    const acc = effectiveAccounts[i % effectiveAccounts.length];
                    if (acc) onSelectAccount(acc);
                  }}
                >
                  <span className="matrix-cell-id">{String(i + 1).padStart(2, '0')}</span>
                  <span className="matrix-cell-val" style={{ color: isWarn ? '#fbbf24' : '#60a5fa' }}>
                    {isWarn ? '34%' : '90%'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Aggregate View */}
      {activeView === 'aggregate' && (
        <div id="view-cap-aggregate" className="scale-box" style={{ borderLeft: '3px solid var(--ok)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <div className="card" style={{ background: 'var(--card-hi)', padding: 12, border: '1px solid var(--border)' }}>
              <span className="stat-sub">High-Capacity Pool (Healthy)</span>
              <span className="stat-val" style={{ color: 'var(--ok)' }}>14 Accounts</span>
              <span className="stat-sub">94.2% Mean Headroom</span>
            </div>
            <div className="card" style={{ background: 'var(--card-hi)', padding: 12, border: '1px solid var(--border)' }}>
              <span className="stat-sub">Near-Limit Triage (Tight)</span>
              <span className="stat-val" style={{ color: 'var(--warn)' }}>1 Account</span>
              <span className="stat-sub">34.0% Burst Remaining</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
