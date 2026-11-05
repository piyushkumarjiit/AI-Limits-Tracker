import React from 'react';
import type { Account } from '../../api';
import type { WatermarkFleetOverview } from '../../../../server/src/cpaWatermarkTypes';
import { dualRingData } from '../../../../src/services/capacity';
import { accountStatus, ACCOUNT_STATUS_BADGE, ACCOUNT_STATUS_LABEL } from '../common/cpaUiUtils';
import { formatResetCountdown } from '../../../../src/utils/formatters';
import './ActiveAttention.css';

export interface ActiveAttentionProps {
  accounts: Account[];
  overview?: WatermarkFleetOverview | null;
  onSelectAccount: (a: Account) => void;
}

export const ActiveAttention: React.FC<ActiveAttentionProps> = ({
  accounts,
  overview,
  onSelectAccount,
}) => {
  // Same four states as the Accounts page: everything that is not Healthy needs a look.
  const attentionAccounts = accounts
    .map((a, idx) => ({
      account: a,
      idx,
      status: accountStatus(a, overview?.accounts.find((v) => v.accountId === a.id) || null),
    }))
    .filter(({ status }) => status !== 'healthy');

  return (
    <div className="card fqd-active-attention" style={{ marginBottom: 14 }}>
      <div className="card-header">
        <span className="card-title">Active Attention &amp; Quota Warnings</span>
        <span className={`badge ${attentionAccounts.length > 0 ? 'badge-warn' : 'badge-ok'}`}>
          {attentionAccounts.length > 0 ? `${attentionAccounts.length} Attention Required` : 'All Accounts Optimal'}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {attentionAccounts.length === 0 ? (
          <div style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>All accounts are above the 35% headroom floor.</div>
        ) : (
          attentionAccounts.slice(0, 3).map(({ account: a, idx, status }) => {
            const slotStr = `slot_${String(idx + 1).padStart(2, '0')}`;
            const binding = dualRingData(a.latestSnapshot).binding;
            const resetStr = formatResetCountdown(binding?.bucket.resetsAt);
            const rem = binding ? Math.max(0, Math.round(binding.remaining)) : null;
            const severe = status === 'exhausted';
            const color = severe ? '#f87171' : status === 'tight' ? '#fbbf24' : '#93c5fd';
            return (
              <div
                key={a.id}
                className={`fqd-active-attention__item fqd-active-attention__item--${status}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '12px 14px',
                  background: severe ? 'rgba(239,68,68,0.08)' : status === 'tight' ? 'rgba(245,158,11,0.08)' : 'rgba(96,165,250,0.08)',
                  border: '1px solid ' + (severe ? 'rgba(239,68,68,0.3)' : status === 'tight' ? 'rgba(245,158,11,0.3)' : 'rgba(96,165,250,0.3)'),
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
                onClick={() => onSelectAccount(a)}
              >
                <div className="fqd-active-attention__left" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="badge badge-slot">{slotStr}</span>
                  <div>
                    <strong className="fqd-active-attention__title" style={{ color: '#fff', fontSize: 13 }}>{a.email || a.name}</strong>
                    <div className="fqd-active-attention__sub" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {binding ? `${binding.bucket.label}: ${rem}% remaining` : 'No quota data'}
                    </div>
                  </div>
                </div>
                <div className="fqd-active-attention__right" style={{ textAlign: 'right' }}>
                  <span className={`badge ${ACCOUNT_STATUS_BADGE[status]}`}>{ACCOUNT_STATUS_LABEL[status]}</span>
                  <div className="fqd-active-attention__recovery" style={{ fontSize: 11, color, marginTop: 4 }}>
                    Resets {resetStr}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
