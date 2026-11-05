import React, { useState } from 'react';
import type { Account } from '../../api';
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

const AGGREGATE_BANDS = [
  { status: 'healthy', title: 'Healthy (above 35%)', color: 'var(--ok)' },
  { status: 'tight', title: 'Tight (35% or less)', color: 'var(--warn)' },
  { status: 'exhausted', title: 'Exhausted (0%)', color: 'var(--bad)' },
  { status: 'nodata', title: 'No data', color: 'var(--muted)' },
] as const;

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
  const slotOf = (acc: Account) => String(effectiveAccounts.findIndex((a) => a.id === acc.id) + 1).padStart(2, '0');
  const plural = (n: number) => `${n} ${n === 1 ? 'Account' : 'Accounts'}`;
  const headroomStyle = (v: string) => ({
    color: v === '-' ? 'var(--muted)' : Number(v) <= 0 ? 'var(--bad)' : Number(v) <= 35 ? 'var(--warn)' : 'var(--ok)',
  });
  const [capView, setCapView] = useState<'auto' | 'cell' | 'matrix' | 'aggregate'>('auto');

  const activeView = capView === 'auto'
    ? (effectiveAccounts.length <= 20 ? 'cell' : effectiveAccounts.length <= 40 ? 'matrix' : 'aggregate')
    : capView;

  return (
    <div className="card fqd-fleet-headroom" style={{ marginBottom: 14 }}>
      <div className="card-header fqd-fleet-headroom__header" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div>
          <div className="fqd-fleet-headroom__title-wrap" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="card-title">Fleet Headroom Capacity</span>
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
        </div>
      </div>

      {/* 1. Cell View */}
      {activeView === 'cell' && (
        <div id="view-cap-cell" className="scale-box" style={{ borderLeft: '3px solid var(--blue)' }}>
          <div className="fqd-fleet-headroom__row-header" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
            <span><strong>Google Antigravity</strong> ({plural(agyAccounts.length)})</span>
            <span style={headroomStyle(agyHeadroom)}><strong>{agyHeadroom === '-' ? 'No data' : `${agyHeadroom}% Headroom`}</strong></span>
          </div>
          <div className="gradient-bar-track">
            {agyAccounts.map((acc, idx) => {
              const h = getSlotHeadroom(acc, idx);
              const slotLabel = slotOf(acc);
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
            <span><strong>Claude Code</strong> ({plural(claudeAccounts.length)})</span>
            <span style={headroomStyle(claudeHeadroom)}><strong>{claudeHeadroom === '-' ? 'No data' : `${claudeHeadroom}% Headroom`}</strong></span>
          </div>
          <div className="gradient-bar-track fqd-fleet-headroom__claude-track" style={{ height: 48, display: 'flex', gap: 4, justifyContent: 'flex-start' }}>
            {claudeAccounts.map((acc, idx) => {
              const h = getSlotHeadroom(acc, idx);
              const slotLabel = slotOf(acc);
              const isSelected = hoverAccount?.id === acc.id;
              return (
                <div
                  key={acc.id}
                  className="grad-segment fqd-fleet-headroom__claude-segment"
                  style={{
                    flex: '0 0 calc((100% - 52px) / 14)',
                    maxWidth: 85,
                    height: 48,
                    borderColor: isSelected ? (h.isTight ? h.color : '#ea580c') : undefined,
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
                    <div className="grad-segment-waterline" style={{ color: h.waterlineColor, background: h.waterlineBg }} />
                  </div>
                  <div className="grad-segment-tooltip" style={{ borderColor: h.isTight ? h.color : '#ea580c' }}>
                    <strong>{acc.email || acc.name}</strong> (Slot {slotLabel})<br />
                    <span style={{ color: h.color }}>{h.rem}% {h.label}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Hover details pill */}
          {hoverAccount && (() => {
            const h = getSlotHeadroom(hoverAccount, 0);
            return (
              <div className="fqd-fleet-headroom__hover-pill" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, padding: '8px 12px', background: 'var(--card-hi)', borderRadius: 8, fontSize: 11 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="badge badge-slot">slot_{slotOf(hoverAccount)}</span>
                  <strong style={{ color: '#fff' }}>{hoverAccount.email || hoverAccount.name}</strong>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ color: h.color, fontWeight: 700 }}>{h.rem}%</span>
                  <span className={`badge ${h.badge}`}>{h.label}</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 2. Matrix View: one compact cell per account, every provider */}
      {activeView === 'matrix' && (
        <div id="view-cap-matrix" className="scale-box" style={{ borderLeft: '3px solid var(--purple)' }}>
          <div style={{ fontSize: 11, marginBottom: 8, color: 'var(--muted)' }}>
            {plural(effectiveAccounts.length)} · tightest window per account
          </div>
          <div className="matrix-grid">
            {effectiveAccounts.map((acc, i) => {
              const h = getSlotHeadroom(acc, i);
              const hasData = h.label !== 'No data';
              return (
                <div
                  key={acc.id}
                  className="matrix-cell"
                  title={`${acc.email || acc.name}: ${hasData ? `${h.rem}% ${h.label}` : 'No data'}`}
                  style={{
                    borderColor: h.isTight ? h.color : 'rgba(59,130,246,0.2)',
                    background: h.isTight ? 'rgba(245,158,11,0.1)' : 'rgba(15,23,42,0.8)',
                  }}
                  onClick={() => onSelectAccount(acc)}
                >
                  <span className="matrix-cell-id">{slotOf(acc)}</span>
                  <span className="matrix-cell-val" style={{ color: hasData ? h.color : 'var(--muted)' }}>
                    {hasData ? `${h.rem}%` : '-'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Aggregate View: accounts grouped by headroom band */}
      {activeView === 'aggregate' && (
        <div id="view-cap-aggregate" className="scale-box" style={{ borderLeft: '3px solid var(--ok)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {AGGREGATE_BANDS.map((band) => {
              const members = effectiveAccounts
                .map((acc, i) => getSlotHeadroom(acc, i))
                .filter((h) => (h.label === 'No data' ? band.status === 'nodata' : h.status === band.status));
              const mean = members.length && band.status !== 'nodata'
                ? `${Math.round(members.reduce((sum, h) => sum + h.rem, 0) / members.length)}% mean headroom`
                : band.status === 'nodata' ? 'Provider has not reported quota' : 'None';
              return (
                <div key={band.status} className="card" style={{ background: 'var(--card-hi)', padding: 12, border: '1px solid var(--border)' }}>
                  <span className="stat-sub">{band.title}</span>
                  <span className="stat-val" style={{ color: band.color }}>{plural(members.length)}</span>
                  <span className="stat-sub">{members.length ? mean : 'None'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
