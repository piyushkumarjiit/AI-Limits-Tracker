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

/** One-line routing warning; holds are applied from the account drawer. */
export const CpaDangerAlert: React.FC<CpaDangerAlertProps> = ({ overview, accounts = [] }) => {
  const violations = detectInvariantViolations(overview, accounts);
  if (violations.length === 0) return null;

  const names = violations.map((v) => v.accountName).join(', ');
  return (
    <div className="cpa-danger-alert" role="alert">
      Routing warning: {violations.length === 1 ? '1 account is' : `${violations.length} accounts are`} exhausted or
      rate-limited but still receiving traffic ({names}). Open the account to apply a hold.
    </div>
  );
};
