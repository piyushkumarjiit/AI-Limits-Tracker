import React, { useMemo, useState } from 'react';
import type { Account } from '../../api';
import type { WatermarkFleetOverview } from '../../../../server/src/cpaWatermarkTypes';
import { formatResetCountdown } from '../../../../src/utils/formatters';
import { accountStatus, quotaWindows, ACCOUNT_STATUS_LABEL, ACCOUNT_STATUS_BADGE, TIGHT_THRESHOLD, type AccountStatus } from '../common/cpaUiUtils';
import './QuotaRadar.css';

export interface QuotaRadarProps {
  accounts: Account[];
  overview?: WatermarkFleetOverview | null;
  onSelectAccount?: (a: Account) => void;
}

const STATUS_BADGE = ACCOUNT_STATUS_BADGE;

const STATUS_ORDER: AccountStatus[] = ['cooldown', 'exhausted', 'healthy', 'tight'];

function meterColor(remaining: number): string {
  if (remaining <= 0) return 'linear-gradient(90deg, #ef4444, #b91c1c)';
  if (remaining <= TIGHT_THRESHOLD) return 'linear-gradient(90deg, #f59e0b, #d97706)';
  return 'linear-gradient(90deg, #10b981, #059669)';
}

export const QuotaRadar: React.FC<QuotaRadarProps> = ({ accounts, overview, onSelectAccount }) => {
  const [filterAlert, setFilterAlert] = useState<'all' | AccountStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const accountCards = useMemo(
    () =>
      accounts.map((a, idx) => {
        const view = overview?.accounts.find((av) => av.accountId === a.id) || null;
        return {
          account: a,
          slotStr: `slot_${String(idx + 1).padStart(2, '0')}`,
          email: a.email || a.name,
          status: accountStatus(a, view),
          ...quotaWindows(a),
        };
      }),
    [accounts, overview]
  );

  const countOf = (st: AccountStatus) => accountCards.filter((c) => c.status === st).length;

  const filteredCards = accountCards.filter((c) => {
    if (filterAlert !== 'all' && c.status !== filterAlert) return false;
    const q = searchQuery.trim().toLowerCase();
    return !q || c.email.toLowerCase().includes(q) || c.slotStr.includes(q);
  });

  const meter = (title: string, w: typeof accountCards[number]['fiveHour']) => (
    <div className="dh-meter-row" style={{ marginTop: 10 }}>
      <div className="dh-meter-label">
        <span>{title}</span>
        <span style={{ fontWeight: 700 }}>{w ? `${Math.round(w.remaining)}%` : 'Not reported'}</span>
      </div>
      {w && (
        <>
          <div className="dh-progress-capsule">
            <div className="dh-fill-burst" style={{ width: `${Math.max(2, w.remaining)}%`, background: meterColor(w.remaining) }} />
          </div>
          {w.bucket.resetsAt && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Resets {formatResetCountdown(w.bucket.resetsAt)}</div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div id="tab-alerts" className="view-panel active fqd-quota-radar">
      <div className="filter-toolbar fqd-quota-radar__toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <button className={`filter-btn ${filterAlert === 'all' ? 'active' : ''}`} onClick={() => setFilterAlert('all')}>
          All Alerts ({accountCards.length})
        </button>
        {STATUS_ORDER.map((st) => (
          <button key={st} className={`filter-btn ${filterAlert === st ? 'active' : ''}`} onClick={() => setFilterAlert(st)}>
            {ACCOUNT_STATUS_LABEL[st]} ({countOf(st)})
          </button>
        ))}

        <div className="fqd-quota-radar__search-wrap" style={{ marginLeft: 'auto', position: 'relative' }}>
          <input
            type="text"
            className="fqd-quota-radar__search-input"
            placeholder="Find account..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ padding: '6px 12px', background: 'var(--card-hi)', color: '#fff', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, minWidth: 200 }}
          />
          {searchQuery && (
            <button
              type="button"
              className="fqd-quota-radar__search-clear"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11 }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="card fqd-quota-radar__card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Quota Radar</span>
        </div>

        {filteredCards.length === 0 ? (
          <div className="fqd-quota-radar__empty" style={{ padding: 36, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            {accounts.length === 0 ? 'No accounts connected yet.' : 'No accounts match the current filter.'}
          </div>
        ) : (
          <div className="grid-3">
            {filteredCards.map((c) => (
              <div
                key={c.account.id}
                className="dual-horizon-card"
                style={{ cursor: onSelectAccount ? 'pointer' : undefined }}
                onClick={() => onSelectAccount?.(c.account)}
              >
                <div className="dh-account-title">
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', overflow: 'hidden' }}>
                    <span className="badge badge-slot">{c.slotStr}</span>
                    <strong style={{ fontSize: 13, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{c.email}</strong>
                  </div>
                  <span className={`badge ${STATUS_BADGE[c.status]}`}>{ACCOUNT_STATUS_LABEL[c.status]}</span>
                </div>
                {meter('5-hour', c.fiveHour)}
                {meter('Weekly', c.weekly)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
