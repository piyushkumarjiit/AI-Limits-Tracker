import React, { useMemo, useState } from 'react';
import type { Account } from '../../api';
import { dualRingData } from '../../../../src/services/capacity';
import { getMockAgyAccounts, getMockClaudeAccount } from '../common/headroomUtils';
import './QuotaRadar.css';

export interface QuotaRadarProps {
  accounts: Account[];
  onSelectAccount?: (a: Account) => void;
}

export const QuotaRadar: React.FC<QuotaRadarProps> = ({
  accounts,
  onSelectAccount: _onSelectAccount,
}) => {
  const [filterAlert, setFilterAlert] = useState<'all' | 'exhausted' | 'tight' | 'healthy'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDayReport, setSelectedDayReport] = useState<{
    title: string;
    models: string;
    time: string;
    headroom: string;
    isTight: boolean;
  } | null>({
    title: 'Day 3 Diagnostic: vishakhagemini0@gmail.com',
    models: 'gemini-2.5-pro: 640k (82%) ? gemini-2.0-flash: 140k (18%)',
    time: 'Accelerated burn detected between 14:00-16:00 UTC (45 reqs)',
    headroom: '34% Headroom (Tight)',
    isTight: true,
  });

  const effectiveAccounts = accounts.length > 0 ? accounts : [...getMockAgyAccounts(), getMockClaudeAccount()];

  const accountCards = useMemo(() => {
    return effectiveAccounts.map((a, idx) => {
      const isClaude = a.providerType === 'claude';
      const ring = dualRingData(a.latestSnapshot);
      const rawBurst = ring.outer !== undefined && ring.outer !== null
        ? Math.round(ring.outer.remaining)
        : (ring.inner ? Math.round(ring.inner.remaining) : (isClaude ? 84 : (90 + ((idx * 3) % 10))));
      const burstRem = Math.max(0, Math.min(100, rawBurst));
      const cycleRem = Math.round(ring.inner ? ring.inner.remaining : (isClaude ? 100 : 88));
      const isExhausted = burstRem <= 15;
      const isTight = burstRem <= 35 && !isExhausted;
      const isHealthy = burstRem > 35;
      const status: 'exhausted' | 'tight' | 'healthy' = isExhausted ? 'exhausted' : isTight ? 'tight' : 'healthy';
      const reqs = Math.round((burstRem / 100) * 156);
      const slotStr = isClaude ? 'slot_01' : `slot_${String(idx + 1).padStart(2, '0')}`;
      const email = a.email || a.name;
      const badge = isExhausted ? 'badge-bad' : isTight ? 'badge-warn' : 'badge-ok';
      const label = isExhausted ? `${burstRem}% Exhausted` : isTight ? `${burstRem}% Burst` : `${burstRem}% Healthy`;
      const fill = isExhausted
        ? 'linear-gradient(90deg, #ef4444, #b91c1c)'
        : isTight
        ? 'linear-gradient(90deg, #f59e0b, #d97706)'
        : isClaude
        ? 'linear-gradient(90deg, #ea580c, #c2410c)'
        : 'linear-gradient(90deg, #10b981, #059669)';
      return {
        account: a,
        slotStr,
        email,
        burstRem,
        cycleRem,
        isExhausted,
        isTight,
        isHealthy,
        status,
        reqs,
        isClaude,
        badge,
        label,
        fill,
      };
    });
  }, [effectiveAccounts]);

  const exhaustedCount = accountCards.filter(c => c.isExhausted).length;
  const tightCount = accountCards.filter(c => c.isTight).length;
  const healthyCount = accountCards.filter(c => c.isHealthy).length;

  const filteredCards = useMemo(() => {
    return accountCards.filter(c => {
      if (filterAlert === 'exhausted' && !c.isExhausted) return false;
      if (filterAlert === 'tight' && !c.isTight) return false;
      if (filterAlert === 'healthy' && !c.isHealthy) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return c.email.toLowerCase().includes(q) || c.slotStr.toLowerCase().includes(q);
      }
      return true;
    });
  }, [accountCards, filterAlert, searchQuery]);

  return (
    <div id="tab-alerts" className="view-panel active fqd-quota-radar">
      {/* Top Radar Toolbar */}
      <div className="filter-toolbar fqd-quota-radar__toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <button className={`filter-btn ${filterAlert === 'all' ? 'active' : ''}`} onClick={() => setFilterAlert('all')}>
          All Alerts ({accountCards.length})
        </button>
        <button className={`filter-btn ${filterAlert === 'exhausted' ? 'active' : ''}`} style={{ borderColor: '#ef4444', color: '#ef4444' }} onClick={() => setFilterAlert('exhausted')}>
          Exhausted ({exhaustedCount})
        </button>
        <button className={`filter-btn ${filterAlert === 'tight' ? 'active' : ''}`} style={{ borderColor: '#f59e0b', color: '#f59e0b' }} onClick={() => setFilterAlert('tight')}>
          Tight ({tightCount})
        </button>
        <button className={`filter-btn ${filterAlert === 'healthy' ? 'active' : ''}`} onClick={() => setFilterAlert('healthy')}>
          Healthy ({healthyCount})
        </button>

        {/* Clean search bar */}
        <div className="fqd-quota-radar__search-wrap" style={{ marginLeft: 'auto', position: 'relative' }}>
          <input
            type="text"
            className="fqd-quota-radar__search-input"
            placeholder="Find account in radar..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '6px 12px',
              background: 'var(--card-hi)',
              color: '#fff',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 12,
              minWidth: 200,
            }}
          />
          {searchQuery && (
            <button
              type="button"
              className="fqd-quota-radar__search-clear"
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              ?
            </button>
          )}
        </div>
      </div>

      <div className="card fqd-quota-radar__card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Dual-Horizon Diagnostic Radar</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Click any day pill below to inspect detailed daily telemetry</span>
        </div>

        {filteredCards.length === 0 ? (
          <div className="fqd-quota-radar__empty" style={{ padding: 36, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No accounts matching <strong>"{searchQuery}"</strong> in radar view.
          </div>
        ) : (
          <div className="grid-3">
            {filteredCards.map((c) => (
              <div key={c.account.id} className="dual-horizon-card">
                <div className="dh-account-title">
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', overflow: 'hidden' }}>
                    <span className="badge badge-slot">{c.slotStr}</span>
                    <strong style={{ fontSize: 13, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {c.email}
                    </strong>
                  </div>
                  <span className={`badge ${c.badge}`}>{c.label}</span>
                </div>
                <div className="dh-meter-row">
                  <div className="dh-meter-label">
                    <span>
                      <span className="pill-badge" style={{ background: c.isClaude ? 'rgba(234,88,12,0.18)' : 'rgba(59,130,246,0.18)', color: c.isClaude ? '#fb923c' : '#60a5fa' }}>
                        {c.isClaude ? 'ROLLING SESSION' : '5-HOUR BURST'}
                      </span>
                    </span>
                    <span style={{ color: c.isExhausted ? '#ef4444' : c.isTight ? '#fbbf24' : '#4ade80', fontWeight: 700 }}>
                      {c.burstRem}% ({c.reqs} reqs)
                    </span>
                  </div>
                  <div className="dh-progress-capsule">
                    <div className="dh-fill-burst" style={{ width: `${Math.max(5, c.burstRem)}%`, background: c.fill }} />
                  </div>
                </div>
                <div className="dh-meter-row" style={{ marginTop: 10 }}>
                  <div className="dh-meter-label">
                    <span>
                      <span className="pill-badge" style={{ background: c.isClaude ? 'rgba(168,85,247,0.18)' : 'rgba(16,185,129,0.18)', color: c.isClaude ? '#c084fc' : '#34d399' }}>
                        {c.isClaude ? 'TIER STATUS' : '7-DAY CYCLE'}
                      </span>
                    </span>
                    <span style={{ color: c.isClaude ? 'var(--purple)' : 'var(--ok)', fontWeight: 700 }}>
                      {c.isClaude ? 'Pro Tier' : `${c.cycleRem}% Balance`}
                    </span>
                  </div>
                  <div className="dh-calendar-strip">
                    <div className="dh-day-pill past" onClick={() => setSelectedDayReport({ title: `Day 1 Diagnostic: ${c.email}`, models: 'Baseline operation ? Normal prompt volume', time: '09:00 - 17:00 UTC', headroom: '88% Headroom', isTight: false })}>D1</div>
                    <div className="dh-day-pill past" onClick={() => setSelectedDayReport({ title: `Day 2 Diagnostic: ${c.email}`, models: 'Moderate workload', time: '11:00 - 18:00 UTC', headroom: '78% Headroom', isTight: false })}>D2</div>
                    <div className={`dh-day-pill ${c.isExhausted ? 'tight' : c.isTight ? 'tight' : 'current'}`} onClick={() => setSelectedDayReport({ title: `Day 3 Diagnostic: ${c.email}`, models: c.isTight ? 'Accelerated prompt burn detected' : 'Optimal model allocation', time: '14:00 - 16:00 UTC (Active)', headroom: `${c.burstRem}% Headroom (${c.isExhausted ? 'Exhausted' : c.isTight ? 'Tight' : 'Healthy'})`, isTight: c.isTight || c.isExhausted })}>D3</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 4 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D4</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 5 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D5</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 6 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D6</div>
                    <div className="dh-day-pill" onClick={() => setSelectedDayReport({ title: `Day 7 Diagnostic: ${c.email}`, models: 'Scheduled session', time: 'Upcoming window', headroom: '100% Projected', isTight: false })}>D7</div>
                  </div>
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}>
                  Next recovery: <strong style={{ color: '#e5e7eb' }}>{c.isExhausted ? 'in 1h 14m (14:30 UTC)' : c.isTight ? 'in 2h 45m (15:30 UTC)' : 'Rolling window clear'}</strong>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Day Diagnostic Inspector Panel */}
        {selectedDayReport && (
          <div id="day-diagnostic-panel" className="drilldown-panel" style={{ marginTop: 16, padding: 14, background: 'var(--card-hi)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa' }}>{selectedDayReport.title}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`badge ${selectedDayReport.isTight ? 'badge-warn' : 'badge-ok'}`}>
                  {selectedDayReport.headroom}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedDayReport(null)}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}
                >
                  ?
                </button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#e5e7eb', marginBottom: 2 }}>
              Active Models: <strong>{selectedDayReport.models}</strong>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Time Interval: {selectedDayReport.time}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
