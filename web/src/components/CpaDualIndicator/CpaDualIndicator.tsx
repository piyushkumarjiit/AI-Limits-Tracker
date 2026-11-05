import React from 'react';
import type { WatermarkAccountView } from '../../../../server/src/cpaWatermarkTypes';
import type { Account } from '../../api';
import {
  deriveUpstreamQuota,
  deriveRoutingEnforcement,
} from '../common/cpaUiUtils';
import './CpaDualIndicator.css';

export { deriveUpstreamQuota, deriveRoutingEnforcement };

export interface CpaDualIndicatorProps {
  account: Account;
  accountView?: WatermarkAccountView | null;
  onOpenEmergency?: () => void;
  compact?: boolean;
}

export const CpaDualIndicator: React.FC<CpaDualIndicatorProps> = ({
  account,
  accountView,
  onOpenEmergency,
  compact = false,
}) => {
  const quota = deriveUpstreamQuota(account, accountView);
  const routing = deriveRoutingEnforcement(account, accountView);

  const quotaPillClass = quota.severity === 'exhausted'
    ? 'cpa-indicator-pill--quota-exhausted'
    : quota.severity === 'warning'
    ? 'cpa-indicator-pill--quota-warning'
    : 'cpa-indicator-pill--quota-healthy';

  return (
    <div className={`cpa-dual-indicator ${compact ? 'cpa-dual-indicator--compact' : ''}`}>
      {/* 1. Upstream Quota Status Indicator */}
      <div className="cpa-dual-indicator__col">
        <span className={`cpa-indicator-pill ${quotaPillClass}`} title={`Upstream Quota: ${quota.headroomPct}% Headroom`}>
          <span>📊</span>
          <span>{quota.headroomPct}% Headroom</span>
        </span>
        <div className="cpa-dual-indicator__sub">
          <span className="cpa-dual-indicator__binding-tag">{quota.bindingWindow.toUpperCase()} BINDING</span>
          <span>•</span>
          <span>{quota.burnRateDisplay}</span>
        </div>
      </div>

      {/* 2. Routing Enforcement Status Indicator */}
      <div className="cpa-dual-indicator__col">
        <span className={`cpa-indicator-pill ${routing.badgeClass}`} title={`Routing Enforcement: ${routing.effectiveState} (Weight: ${routing.weight})`}>
          <span>{routing.effectiveState === 'Airgapped' ? '🛑' : routing.effectiveState === 'Quarantined' ? '🔒' : routing.effectiveState === 'Tight' ? '⚠️' : '⚡'}</span>
          <span>{routing.effectiveState}</span>
          <span style={{ fontSize: 10, opacity: 0.85 }}>({routing.weight}W)</span>
        </span>
        <div className="cpa-dual-indicator__sub">
          <span className={`cpa-origin-tag ${routing.origin === 'manual' ? 'cpa-origin-tag--manual' : 'cpa-origin-tag--auto'}`}>
            {routing.originLabel}
          </span>
        </div>
      </div>

      {/* Emergency Control Trigger Button */}
      {onOpenEmergency && (
        <button
          type="button"
          className="cpa-dual-indicator__action-btn"
          onClick={onOpenEmergency}
          title="Open Operator Emergency Action Controls"
        >
          <span>🛡️</span>
          <span>Hold / Airgap</span>
        </button>
      )}
    </div>
  );
};
