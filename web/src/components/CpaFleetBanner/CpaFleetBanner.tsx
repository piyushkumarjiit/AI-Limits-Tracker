import React from 'react';
import type { WatermarkFleetOverview, WatermarkAccountView } from '../../../../server/src/cpaWatermarkTypes';
import type { Account } from '../../api';
import {
  formatRunway,
  calculatePoolSummary,
  type PoolSummary,
} from '../common/cpaUiUtils';
import './CpaFleetBanner.css';

export { formatRunway, calculatePoolSummary, type PoolSummary };

export interface CpaFleetBannerProps {
  overview: WatermarkFleetOverview | null;
  accounts: Account[];
  isAuditOpen: boolean;
  onToggleAudit: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export const CpaFleetBanner: React.FC<CpaFleetBannerProps> = ({
  overview,
  accounts,
  isAuditOpen,
  onToggleAudit,
  onRefresh,
  refreshing = false,
}) => {
  const accountViews = overview?.accounts || [];
  const agySummary = calculatePoolSummary('antigravity', accountViews, accounts);
  const claudeSummary = calculatePoolSummary('claude', accountViews, accounts);

  const mode = overview?.mode || 'shadow';
  const tierState = overview?.tierState || (agySummary.exhaustedCount > 0 || claudeSummary.exhaustedCount > 0 ? 'DEGRADED' : 'OPEN');

  const modeClass = mode === 'enforce'
    ? 'cpa-fleet-banner__badge--mode-enforce'
    : mode === 'shadow'
    ? 'cpa-fleet-banner__badge--mode-shadow'
    : 'cpa-fleet-banner__badge--mode-off';

  const tierClass = tierState === 'OPEN'
    ? 'cpa-fleet-banner__badge--tier-open'
    : tierState === 'DEGRADED'
    ? 'cpa-fleet-banner__badge--tier-degraded'
    : 'cpa-fleet-banner__badge--tier-closed';

  return (
    <div className="cpa-fleet-banner" role="region" aria-label="CPA Fleet Health Banner">
      <div className="cpa-fleet-banner__container">
        {/* Top bar: Mode, Tier State, Actions */}
        <div className="cpa-fleet-banner__top-bar">
          <div className="cpa-fleet-banner__brand-group">
            <span className="cpa-fleet-banner__title">
              <span style={{ color: '#3b82f6' }}>?</span> FQD Fleet Runway &amp; CPA Health
            </span>
            <div className="cpa-fleet-banner__meta-badges">
              <span className={`cpa-fleet-banner__badge ${modeClass}`} title="CPA Routing Enforcement Mode">
                MODE: {mode.toUpperCase()}
              </span>
              <span className={`cpa-fleet-banner__badge ${tierClass}`} title="Collective Watermark Tier State">
                TIER: {tierState}
              </span>
            </div>
          </div>

          <div className="cpa-fleet-banner__actions">
            <button
              type="button"
              className={`cpa-fleet-banner__btn ${isAuditOpen ? 'cpa-fleet-banner__btn--active' : ''}`}
              onClick={onToggleAudit}
              title="Toggle Shadow-Mode Telemetry & Audit Log"
            >
              <span>?</span>
              <span>{isAuditOpen ? 'Close Audit Feed' : 'Telemetry & Audit Feed'}</span>
            </button>
            {onRefresh && (
              <button
                type="button"
                className="cpa-fleet-banner__btn"
                onClick={onRefresh}
                disabled={refreshing}
                title="Refresh CPA Watermark Status"
              >
                <span>?</span>
                <span>{refreshing ? 'Syncing…' : 'Refresh'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Pools Grid: Google Antigravity & Anthropic Claude */}
        <div className="cpa-fleet-banner__pools-grid">
          {/* Antigravity Pool Card */}
          <PoolCard summary={agySummary} />

          {/* Claude Pool Card */}
          <PoolCard summary={claudeSummary} />
        </div>
      </div>
    </div>
  );
};

const PoolCard: React.FC<{ summary: PoolSummary }> = ({ summary }) => {
  const runwayInfo = formatRunway(summary.runwayMinutes);
  const runwayClass = runwayInfo.urgency === 'urgent'
    ? 'cpa-pool-card__runway-badge--urgent'
    : runwayInfo.urgency === 'warning'
    ? 'cpa-pool-card__runway-badge--warning'
    : runwayInfo.urgency === 'safe'
    ? 'cpa-pool-card__runway-badge--safe'
    : '';

  const fillColor = summary.headroomPct <= 10
    ? '#ef4444'
    : summary.headroomPct <= 35
    ? '#f59e0b'
    : summary.provider === 'antigravity'
    ? '#3b82f6'
    : '#8b5cf6';

  return (
    <div className={`cpa-pool-card ${summary.provider === 'antigravity' ? 'cpa-pool-card--agy' : 'cpa-pool-card--claude'}`}>
      <div className="cpa-pool-card__header">
        <div className="cpa-pool-card__title">
          <span>{summary.provider === 'antigravity' ? '⚡' : '🔮'}</span>
          <span>{summary.name}</span>
          <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>
            ({summary.totalCount} {summary.totalCount === 1 ? 'account' : 'accounts'})
          </span>
        </div>
        <div className={`cpa-pool-card__runway-badge ${runwayClass}`} title="Estimated pool exhaustion countdown at current burn velocity">
          <span>⏳</span>
          <span>{runwayInfo.text}</span>
        </div>
      </div>

      <div className="cpa-pool-card__metrics">
        <div className="cpa-pool-card__headroom-wrap">
          <span className="cpa-pool-card__headroom-val" style={{ color: fillColor }}>
            {summary.headroomPct}%
          </span>
          <span className="cpa-pool-card__headroom-sub">Aggregate Headroom</span>
        </div>

        <div className="cpa-pool-card__counts">
          <span className="cpa-count-pill cpa-count-pill--active" title="Active (operating within nominal limits)">
            ● {summary.activeCount} Active
          </span>
          {summary.tightCount > 0 && (
            <span className="cpa-count-pill cpa-count-pill--tight" title="Tight (<= 35% headroom)">
              ▲ {summary.tightCount} Tight
            </span>
          )}
          {summary.exhaustedCount > 0 && (
            <span className="cpa-count-pill cpa-count-pill--exhausted" title="Exhausted (hard floor breached or 429)">
              ✖ {summary.exhaustedCount} Exhausted
            </span>
          )}
          {summary.quarantinedCount > 0 && (
            <span className="cpa-count-pill cpa-count-pill--quarantined" title="Quarantined or Airgapped">
              🔒 {summary.quarantinedCount} Quarantined
            </span>
          )}
        </div>
      </div>

      <div className="cpa-pool-card__progress-bar">
        <div
          className="cpa-pool-card__progress-fill"
          style={{
            width: `${Math.max(0, Math.min(100, summary.headroomPct))}%`,
            background: fillColor,
          }}
        />
      </div>
    </div>
  );
};
