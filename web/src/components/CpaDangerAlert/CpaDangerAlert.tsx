import React, { useState } from 'react';
import type { WatermarkFleetOverview } from '../../../../server/src/cpaWatermarkTypes';
import type { Account } from '../../api';
import {
  detectInvariantViolations,
  type InvariantViolation,
} from '../common/cpaUiUtils';
import './CpaDangerAlert.css';

export { detectInvariantViolations, type InvariantViolation };

export interface CpaDangerAlertProps {
  overview: WatermarkFleetOverview | null;
  accounts?: Account[];
  onEnforceAirgap: (accountId: string, reason?: string) => Promise<void> | void;
}

export const CpaDangerAlert: React.FC<CpaDangerAlertProps> = ({
  overview,
  accounts = [],
  onEnforceAirgap,
}) => {
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const violations = detectInvariantViolations(overview, accounts);

  if (violations.length === 0) return null;

  const handleAirgap = async (v: InvariantViolation) => {
    if (!v.accountId) return;
    setBusyMap((prev) => ({ ...prev, [v.accountId]: true }));
    try {
      await onEnforceAirgap(v.accountId, `Operator Enforced Airgap: ${v.type} invariant violation`);
    } finally {
      setBusyMap((prev) => ({ ...prev, [v.accountId]: false }));
    }
  };

  return (
    <div className="cpa-danger-alert" role="alert" aria-live="assertive">
      <div className="cpa-danger-alert__header">
        <span className="cpa-danger-alert__badge">
          🚨 DANGER
        </span>
        <span className="cpa-danger-alert__title">
          Invariant Violation Detected ({violations.length} {violations.length === 1 ? 'breach' : 'breaches'})
        </span>
      </div>

      <div className="cpa-danger-alert__items">
        {violations.map((v) => (
          <div key={v.id} className="cpa-danger-alert__item">
            <div className="cpa-danger-alert__item-info">
              <div className="cpa-danger-alert__item-account">
                <span>⚠️ {v.accountName}</span>
                <span style={{ fontSize: 11, opacity: 0.8, textTransform: 'uppercase' }}>
                  [{v.provider}]
                </span>
                <span style={{ fontSize: 10, background: 'rgba(239,68,68,0.3)', padding: '1px 5px', borderRadius: 4 }}>
                  {v.type === 'leaked_weight' ? 'ROUTING WEIGHT LEAK' : 'UNAIRGAPPED 429'}
                </span>
              </div>
              <div className="cpa-danger-alert__item-msg">
                {v.message}
              </div>
            </div>

            {v.accountId && (
              <div className="cpa-danger-alert__item-action">
                <button
                  type="button"
                  className="cpa-danger-alert__airgap-btn"
                  onClick={() => handleAirgap(v)}
                  disabled={busyMap[v.accountId]}
                  title="Immediately cut all routing traffic and apply airgap hold to this credential"
                >
                  <span>🛡️</span>
                  <span>{busyMap[v.accountId] ? 'Airgapping…' : 'Enforce Airgap Now'}</span>
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
