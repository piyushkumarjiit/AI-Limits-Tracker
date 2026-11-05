import React from 'react';
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
}

/**
 * Routing warning for accounts that are exhausted or rate-limited but still carry
 * routing weight; holds are applied from the account drawer. Fleet-level notices
 * from the watermark service are listed separately as they name no single account.
 */
export const CpaDangerAlert: React.FC<CpaDangerAlertProps> = ({ overview, accounts = [] }) => {
  const violations = detectInvariantViolations(overview, accounts);
  const fleetNotices = overview?.activeDangerAlerts ?? [];
  if (violations.length === 0 && fleetNotices.length === 0) return null;

  const names = [...new Set(violations.map((v) => v.accountName))].join(', ');
  return (
    <>
      {violations.length > 0 && (
        <div className="cpa-danger-alert" role="alert">
          Routing warning: {violations.length === 1 ? '1 account is' : `${violations.length} accounts are`} exhausted or
          rate-limited but still receiving traffic ({names}). Open the account to apply a hold.
        </div>
      )}
      {fleetNotices.length > 0 && (
        <div className="cpa-fleet-notice" role="status">
          Fleet: {fleetNotices.join(' · ')}
        </div>
      )}
    </>
  );
};
