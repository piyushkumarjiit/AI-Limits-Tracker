import React, { useMemo, useState } from 'react';
import type { WatermarkFleetOverview, WatermarkHistoryEntry } from '../../../../server/src/cpaWatermarkTypes';
import {
  parseAuditItems,
  formatTime,
  type AuditItem,
} from '../common/cpaUiUtils';
import './CpaAuditFeed.css';

export { parseAuditItems, formatTime, type AuditItem };

export interface CpaAuditFeedProps {
  overview: WatermarkFleetOverview | null;
  historyEntries?: WatermarkHistoryEntry[];
  isOpen: boolean;
  onClose: () => void;
}

export const CpaAuditFeed: React.FC<CpaAuditFeedProps> = ({
  overview,
  historyEntries = [],
  isOpen,
  onClose,
}) => {
  const [filter, setFilter] = useState<'all' | 'tripwire' | 'leadtime' | '429' | 'hold'>('all');

  const allItems = useMemo(
    () => parseAuditItems(overview, historyEntries),
    [overview, historyEntries]
  );

  const filteredItems = useMemo(() => {
    if (filter === 'all') return allItems;
    return allItems.filter((item) => item.type === filter);
  }, [allItems, filter]);

  if (!isOpen) return null;

  return (
    <div className="cpa-audit-feed" role="region" aria-label="Shadow Telemetry and Audit Feed">
      <div className="cpa-audit-feed__header">
        <div className="cpa-audit-feed__title">
          <span>📡</span>
          <span>Shadow-Mode Telemetry &amp; Watermark Audit Feed</span>
          <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>
            ({filteredItems.length} {filteredItems.length === 1 ? 'event' : 'events'})
          </span>
        </div>

        <div className="cpa-audit-feed__filters">
          <button
            type="button"
            className={`cpa-audit-filter-btn ${filter === 'all' ? 'cpa-audit-filter-btn--active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`cpa-audit-filter-btn ${filter === 'tripwire' ? 'cpa-audit-filter-btn--active' : ''}`}
            onClick={() => setFilter('tripwire')}
          >
            Tripwires
          </button>
          <button
            type="button"
            className={`cpa-audit-filter-btn ${filter === 'leadtime' ? 'cpa-audit-filter-btn--active' : ''}`}
            onClick={() => setFilter('leadtime')}
          >
            Lead-Time Projections
          </button>
          <button
            type="button"
            className={`cpa-audit-filter-btn ${filter === '429' ? 'cpa-audit-filter-btn--active' : ''}`}
            onClick={() => setFilter('429')}
          >
            429 Prevention
          </button>
          <button
            type="button"
            className={`cpa-audit-filter-btn ${filter === 'hold' ? 'cpa-audit-filter-btn--active' : ''}`}
            onClick={() => setFilter('hold')}
          >
            Manual Holds
          </button>
          <button
            type="button"
            className="cpa-audit-filter-btn"
            style={{ marginLeft: 6, color: '#f87171' }}
            onClick={onClose}
            aria-label="Close feed"
          >
            ✕ Close
          </button>
        </div>
      </div>

      <div className="cpa-audit-feed__list">
        {filteredItems.length === 0 ? (
          <div className="cpa-audit-feed__empty">
            No audit events found for selected filter. Watermark tripwires and shadow telemetry log in real time.
          </div>
        ) : (
          filteredItems.map((item) => (
            <div key={item.id} className="cpa-audit-card">
              <div className="cpa-audit-card__top">
                <span className={`cpa-audit-type-badge cpa-audit-type-badge--${item.type}`}>
                  {item.typeLabel}
                </span>
                <span className="cpa-audit-time">{item.timeFormatted}</span>
              </div>

              <div className="cpa-audit-card__main">
                <div className="cpa-audit-account">
                  <span>Credential: {item.accountId}</span>
                  {item.details && (
                    <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 8 }}>
                      ({item.details})
                    </span>
                  )}
                </div>

                {item.oldWeight !== undefined && item.newWeight !== undefined && (
                  <div className="cpa-audit-weight-transition">
                    <span>{item.oldWeight}W</span>
                    <span style={{ color: '#60a5fa' }}> ➔ </span>
                    <span style={{ color: item.newWeight === 0 ? '#ef4444' : '#10b981' }}>{item.newWeight}W</span>
                  </div>
                )}
              </div>

              <div className="cpa-audit-reason">
                {item.reason}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
