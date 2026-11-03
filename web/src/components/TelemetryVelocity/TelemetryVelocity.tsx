import React, { useState } from 'react';
import type { Account } from '../../api';
import { MONTHS_SHORT } from '../../../../src/utils/formatters';
import type { TelemetryResponse } from '../../../../src/services/telemetryService';
import './TelemetryVelocity.css';

export interface TelemetryVelocityProps {
  accounts: Account[];
  telemetry?: TelemetryResponse | null;
}

export const TelemetryVelocity: React.FC<TelemetryVelocityProps> = ({
  accounts: _accounts,
  telemetry: _telemetry,
}) => {
  const [horizon, setHorizon] = useState<'today' | '7d' | '30d'>('today');
  const [activeFilter, setActiveFilter] = useState<'all' | 'claude' | 'gemini'>('all');
  const [selectedInterval, setSelectedInterval] = useState('12:00 - 16:00 (Peak)');

  // Dynamic KPI stats based on horizon
  const kpiData = {
    today: {
      volume: '18.4M',
      volumeSub: '74% Prompt / 26% Completion',
      peakTitle: 'Peak Hourly Burn',
      peakVal: '2.45M/hr',
      peakSub: '12:00 - 16:00 UTC',
      primaryModel: 'Claude 3.7',
      modelSub: '51% fleet token share',
      latency: '3.9ms',
      latencySub: 'Avg proxy routing latency',
    },
    '7d': {
      volume: '114.2M',
      volumeSub: '71% Prompt / 29% Completion',
      peakTitle: 'Peak Daily Burn',
      peakVal: '19.8M/day',
      peakSub: 'Thursday Peak',
      primaryModel: 'Claude 3.7',
      modelSub: '48% 7-day share',
      latency: '3.8ms',
      latencySub: '7-day rolling avg',
    },
    '30d': {
      volume: '482.6M',
      volumeSub: '73% Prompt / 27% Completion',
      peakTitle: 'Peak Weekly Burn',
      peakVal: '126.0M/wk',
      peakSub: 'Week 3 Peak',
      primaryModel: 'Gemini 2.5 Pro',
      modelSub: '46% 30-day share',
      latency: '3.7ms',
      latencySub: 'Monthly rolling avg',
    },
  }[horizon];

  // Stacked Bar Definitions for horizons
  const barsToday = [
    { id: 't0', label: '00:00', height: 35, pro: 15, flash: 10, c37: 6, c35: 3, haiku: 1, interval: '00:00 - 04:00' },
    { id: 't1', label: '04:00', height: 22, pro: 10, flash: 6, c37: 4, c35: 1, haiku: 1, interval: '04:00 - 08:00' },
    { id: 't2', label: '08:00', height: 60, pro: 25, flash: 15, c37: 12, c35: 6, haiku: 2, interval: '08:00 - 12:00' },
    { id: 't3', label: '12:00 (Peak)', height: 95, pro: 40, flash: 22, c37: 20, c35: 9, haiku: 4, interval: '12:00 - 16:00 (Peak)' },
    { id: 't4', label: '16:00', height: 75, pro: 30, flash: 18, c37: 16, c35: 8, haiku: 3, interval: '16:00 - 20:00' },
  ];

  const bars7d = [
    { id: 'd0', label: 'Mon', height: 45, pro: 18, flash: 10, c37: 11, c35: 4, haiku: 2, interval: 'Monday' },
    { id: 'd1', label: 'Tue', height: 65, pro: 26, flash: 14, c37: 15, c35: 7, haiku: 3, interval: 'Tuesday' },
    { id: 'd2', label: 'Wed', height: 78, pro: 32, flash: 18, c37: 18, c35: 7, haiku: 3, interval: 'Wednesday' },
    { id: 'd3', label: 'Thu (Peak)', height: 96, pro: 42, flash: 22, c37: 20, c35: 8, haiku: 4, interval: 'Thursday (Peak)' },
    { id: 'd4', label: 'Fri', height: 82, pro: 34, flash: 19, c37: 19, c35: 7, haiku: 3, interval: 'Friday' },
    { id: 'd5', label: 'Sat', height: 35, pro: 15, flash: 8, c37: 8, c35: 3, haiku: 1, interval: 'Saturday' },
    { id: 'd6', label: 'Sun', height: 28, pro: 12, flash: 7, c37: 6, c35: 2, haiku: 1, interval: 'Sunday' },
  ];

  const bars30d = Array.from({ length: 30 }).map((_, i) => {
    const dayNum = i + 1;
    const isPeak = dayNum === 22;
    const baseHeight = 25 + Math.round(Math.sin((i / 29) * Math.PI) * 50) + ((i * 7) % 18);
    const height = isPeak ? 96 : Math.min(92, Math.max(20, baseHeight));
    const pro = Math.round(height * 0.42);
    const flash = Math.round(height * 0.22);
    const c37 = Math.round(height * 0.20);
    const c35 = Math.round(height * 0.10);
    const haiku = Math.max(1, height - (pro + flash + c37 + c35));
    const d = new Date(Date.now() - (29 - i) * 86400000);
    const dateStr = `${MONTHS_SHORT[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
    const showLabel = i === 0 || i === 7 || i === 14 || i === 21 || i === 29;
    return {
      id: `d30-${dayNum}`,
      label: showLabel ? dateStr : '',
      dateStr,
      height,
      pro,
      flash,
      c37,
      c35,
      haiku,
      interval: `Day ${dayNum} (${dateStr}${isPeak ? ' - Peak' : ''})`,
    };
  });

  const currentBars = horizon === 'today' ? barsToday : horizon === '7d' ? bars7d : bars30d;

  return (
    <div id="tab-stats" className="view-panel active fqd-telemetry-velocity">
      {/* Horizon Selector Header */}
      <div className="fqd-telemetry-velocity__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <h2 className="fqd-telemetry-velocity__title" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Token Burn Velocity &amp; Model Telemetry</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className={`filter-btn ${horizon === 'today' ? 'active' : ''}`}
            onClick={() => { setHorizon('today'); setActiveFilter('all'); setSelectedInterval('12:00 - 16:00 (Peak)'); }}
          >
            Today
          </button>
          <button
            className={`filter-btn ${horizon === '7d' ? 'active' : ''}`}
            onClick={() => { setHorizon('7d'); setActiveFilter('all'); setSelectedInterval('Thursday (Peak)'); }}
          >
            7 Days
          </button>
          <button
            className={`filter-btn ${horizon === '30d' ? 'active' : ''}`}
            onClick={() => { setHorizon('30d'); setActiveFilter('all'); setSelectedInterval('Day 22 (Oct 26 - Peak)'); }}
          >
            30 Days
          </button>
        </div>
      </div>

      {/* 4 Dynamic KPI Cards */}
      <div className="grid-4" style={{ marginBottom: 14 }}>
        <div className="card stat-box">
          <span className="stat-sub">Total Token Volume</span>
          <span className="stat-val" style={{ color: 'var(--blue)' }}>{kpiData.volume}</span>
          <span className="stat-sub" style={{ color: 'var(--ok)' }}>{kpiData.volumeSub}</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">{kpiData.peakTitle}</span>
          <span className="stat-val" style={{ color: 'var(--warn)' }}>{kpiData.peakVal}</span>
          <span className="stat-sub">{kpiData.peakSub}</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Primary Model</span>
          <span className="stat-val" style={{ color: '#ea580c' }}>{kpiData.primaryModel}</span>
          <span className="stat-sub">{kpiData.modelSub}</span>
        </div>
        <div className="card stat-box">
          <span className="stat-sub">Gateway Overhead</span>
          <span className="stat-val" style={{ color: 'var(--ok)' }}>{kpiData.latency}</span>
          <span className="stat-sub">{kpiData.latencySub}</span>
        </div>
      </div>

      {/* Main Chart Card */}
      <div className="card fqd-telemetry-velocity__chart-card" style={{ marginBottom: 14 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span className="card-title">Token Burn Rate by Model ({horizon === 'today' ? 'Today' : horizon === '7d' ? '7 Days' : '30 Days'})</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>
              Click any color segment to filter details for that specific model family
            </span>
          </div>
          {/* Multi-Model Legend */}
          <div className="fqd-telemetry-velocity__legend" style={{ display: 'flex', gap: 12, fontSize: 11, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="fqd-telemetry-velocity__legend-item" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('gemini')}>
              <span className="fqd-telemetry-velocity__legend-dot" style={{ width: 8, height: 8, background: '#2563eb', borderRadius: 2 }} /> Gemini 2.5 Pro
            </span>
            <span className="fqd-telemetry-velocity__legend-item" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('gemini')}>
              <span className="fqd-telemetry-velocity__legend-dot" style={{ width: 8, height: 8, background: '#38bdf8', borderRadius: 2 }} /> Gemini 2.0 Flash
            </span>
            <span className="fqd-telemetry-velocity__legend-item" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('claude')}>
              <span className="fqd-telemetry-velocity__legend-dot" style={{ width: 8, height: 8, background: '#c2410c', borderRadius: 2 }} /> Claude 3.7 Sonnet
            </span>
            <span className="fqd-telemetry-velocity__legend-item" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('claude')}>
              <span className="fqd-telemetry-velocity__legend-dot" style={{ width: 8, height: 8, background: '#ea580c', borderRadius: 2 }} /> Claude 3.5 Sonnet
            </span>
            <span className="fqd-telemetry-velocity__legend-item" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={() => setActiveFilter('claude')}>
              <span className="fqd-telemetry-velocity__legend-dot" style={{ width: 8, height: 8, background: '#f59e0b', borderRadius: 2 }} /> Claude 3.5 Haiku
            </span>
          </div>
        </div>

        {/* Filter State Banner */}
        {activeFilter !== 'all' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: activeFilter === 'claude' ? 'rgba(234, 88, 12, 0.12)' : 'rgba(56, 189, 248, 0.12)', border: '1px solid ' + (activeFilter === 'claude' ? '#ea580c' : '#38bdf8'), borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            <span style={{ color: activeFilter === 'claude' ? '#fdba74' : '#93c5fd', fontWeight: 600 }}>
              Filtered: {activeFilter === 'claude' ? 'Claude Models (Anthropic Direct Proxy)' : 'Google Antigravity (CLIProxy Mesh)'}
            </span>
            <button
              className="filter-btn"
              style={{ padding: '2px 8px', fontSize: 11, background: '#1e293b', color: '#fff' }}
              onClick={() => setActiveFilter('all')}
            >
              Reset Filter ?
            </button>
          </div>
        )}

        {/* Burn Chart Bars */}
        <div className="burn-chart-container fqd-telemetry-velocity__bars" style={{ height: 180, display: 'flex', alignItems: 'flex-end', gap: horizon === '30d' ? 4 : 14, padding: '10px 0' }}>
          {currentBars.map((b) => {
            const isSelected = selectedInterval === b.interval;
            return (
              <div key={b.id} className="burn-bar-slot fqd-telemetry-velocity__bar-slot" style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                <div
                  className={`burn-bar-stack ${isSelected ? 'selected-bar' : ''}`}
                  style={{
                    height: `${b.height}%`,
                    width: '100%',
                    maxWidth: horizon === '30d' ? 22 : 54,
                    display: 'flex',
                    flexDirection: 'column-reverse',
                    borderRadius: 4,
                    overflow: 'hidden',
                    outline: isSelected ? '2px solid #60a5fa' : 'none',
                    outlineOffset: 2,
                  }}
                  onClick={() => setSelectedInterval(b.interval)}
                >
                  {/* Model Segments */}
                  <div
                    className="burn-seg-claude-haiku"
                    style={{ height: `${b.haiku}%`, opacity: activeFilter === 'gemini' ? 0.2 : 1 }}
                    title="Claude 3.5 Haiku"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('claude'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-claude-35"
                    style={{ height: `${b.c35}%`, opacity: activeFilter === 'gemini' ? 0.2 : 1 }}
                    title="Claude 3.5 Sonnet"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('claude'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-claude-37"
                    style={{ height: `${b.c37}%`, opacity: activeFilter === 'gemini' ? 0.2 : 1 }}
                    title="Claude 3.7 Sonnet"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('claude'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-gemini-flash"
                    style={{ height: `${b.flash}%`, opacity: activeFilter === 'claude' ? 0.2 : 1 }}
                    title="Gemini 2.0 Flash"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('gemini'); setSelectedInterval(b.interval); }}
                  />
                  <div
                    className="burn-seg-gemini-pro"
                    style={{ height: `${b.pro}%`, opacity: activeFilter === 'claude' ? 0.2 : 1 }}
                    title="Gemini 2.5 Pro"
                    onClick={(e) => { e.stopPropagation(); setActiveFilter('gemini'); setSelectedInterval(b.interval); }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* X-Axis Labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 8, padding: '0 8px' }}>
          {currentBars.map((b) => (
            <span key={b.id} style={{ fontWeight: b.interval === selectedInterval ? 700 : 400, color: b.interval === selectedInterval ? '#60a5fa' : undefined }}>
              {b.label}
            </span>
          ))}
        </div>

        {/* Drilldown Inspector Panel */}
        <div id="burn-drilldown" className="drilldown-panel" style={{ marginTop: 14, padding: 14, background: 'var(--card-hi)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>Interval: {selectedInterval}</span>
            <span className="badge" style={{ background: activeFilter === 'claude' ? 'rgba(234,88,12,0.15)' : (activeFilter === 'gemini' ? 'rgba(56,189,248,0.15)' : 'rgba(59,130,246,0.15)'), color: activeFilter === 'claude' ? '#ea580c' : (activeFilter === 'gemini' ? '#38bdf8' : '#60a5fa') }}>
              {activeFilter === 'claude' ? 'Filtered: Claude Models' : (activeFilter === 'gemini' ? 'Filtered: Google Antigravity' : 'All Models')}
            </span>
          </div>

          {activeFilter === 'claude' ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                735,000 tokens (Burn: 183.8k/hr)
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                Total Claude Allocation: 31% of interval volume
              </div>
              <div style={{ fontSize: 11, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>claude-3-7-sonnet</strong> (Extended Thinking)</span>
                  <strong style={{ color: '#ea580c' }}>510,000 tokens (69.4%) ? 127.5k/hr</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>claude-3-5-sonnet</strong> (Standard)</span>
                  <strong style={{ color: '#fdba74' }}>180,000 tokens (24.5%) ? 45.0k/hr</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>claude-3-5-haiku</strong> (Fast Triage)</span>
                  <strong style={{ color: '#fef08a' }}>45,000 tokens (6.1%) ? 11.2k/hr</strong>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#4ade80', marginTop: 8 }}>
                Avg Provider Latency: 12ms (Anthropic Direct Proxy)
              </div>
            </div>
          ) : activeFilter === 'gemini' ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                1,715,000 tokens (Burn: 428.8k/hr)
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                Total Antigravity Allocation: 69% of interval volume
              </div>
              <div style={{ fontSize: 11, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>gemini-2.5-pro</strong> (Deep Workhorse)</span>
                  <strong style={{ color: '#60a5fa' }}>1,180,000 tokens (68.8%) ? 295.0k/hr</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>gemini-2.0-flash</strong> (Lightweight Execution)</span>
                  <strong style={{ color: '#93c5fd' }}>535,000 tokens (31.2%) ? 133.7k/hr</strong>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#4ade80', marginTop: 8 }}>
                Avg Gateway Latency: 3.9ms (CLIProxy Local Mesh)
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                2,450,000 tokens
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                1.7M Antigravity / 735k Claude
              </div>
              <div style={{ fontSize: 11, color: '#4ade80', marginTop: 4 }}>
                Proxy Overhead: 4.2ms
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Model Breakdown Table */}
      <div className="card">
        <span className="card-title" style={{ display: 'block', marginBottom: 12 }}>Model Telemetry Breakdown</span>
        <div className="data-table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Model Name</th>
                <th>Requests</th>
                <th>Prompt Tokens</th>
                <th>Completion</th>
                <th>Total Tokens</th>
                <th>Fleet Share</th>
              </tr>
            </thead>
            <tbody>
              {activeFilter !== 'gemini' && (
                <>
                  <tr><td><strong>claude-3-7-sonnet</strong></td><td>412</td><td>5.8M</td><td>1.4M</td><td><strong>7.2M</strong></td><td>39.1%</td></tr>
                  <tr><td><strong>claude-3-5-sonnet</strong></td><td>145</td><td>1.2M</td><td>300k</td><td><strong>1.5M</strong></td><td>8.2%</td></tr>
                  <tr><td><strong>claude-3-5-haiku</strong></td><td>380</td><td>400k</td><td>150k</td><td><strong>550k</strong></td><td>3.0%</td></tr>
                </>
              )}
              {activeFilter !== 'claude' && (
                <>
                  <tr><td><strong>gemini-2.5-pro</strong></td><td>1,280</td><td>6.1M</td><td>1.9M</td><td><strong>8.0M</strong></td><td>43.5%</td></tr>
                  <tr><td><strong>gemini-2.0-flash</strong></td><td>3,450</td><td>2.5M</td><td>700k</td><td><strong>3.2M</strong></td><td>17.4%</td></tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
