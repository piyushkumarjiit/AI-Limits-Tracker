import React from 'react';
import type { Account } from '../../api';
import { getSlotHeadroom } from '../common/headroomUtils';
import { dualRingData } from '../../../../src/services/capacity';
import { formatResetCountdown } from '../../../../src/utils/formatters';
import './ActiveAttention.css';

export interface ActiveAttentionProps {
  accounts: Account[];
  onSelectAccount: (a: Account) => void;
}

export const ActiveAttention: React.FC<ActiveAttentionProps> = ({
  accounts,
  onSelectAccount,
}) => {
  const attentionAccounts = accounts
    .map((a, i) => ({ account: a, info: getSlotHeadroom(a, i), idx: i }))
    .filter(({ info }) => info.isTight);

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
          <div style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>All accounts operating above 35% headroom floor.</div>
        ) : (
          attentionAccounts.slice(0, 3).map(({ account: a, info: h, idx }) => {
            const slotStr = `slot_${String(idx + 1).padStart(2, '0')}`;
            const binding = dualRingData(a.latestSnapshot).binding;
            const resetStr = binding?.bucket.resetsAt ? formatResetCountdown(binding.bucket.resetsAt) : '-';
            return (
              <div
                key={a.id}
                className={`fqd-active-attention__item ${h.isExhausted ? 'fqd-active-attention__item--exhausted' : 'fqd-active-attention__item--tight'}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '12px 14px',
                  background: h.isExhausted ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                  border: '1px solid ' + (h.isExhausted ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'),
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
                      {binding ? `${binding.bucket.label}: ${h.rem}% remaining` : "No quota data"}
                    </div>
                  </div>
                </div>
                <div className="fqd-active-attention__right" style={{ textAlign: 'right' }}>
                  <span className={`badge ${h.badge}`}>{h.label} ({h.rem}%)</span>
                  <div className="fqd-active-attention__recovery" style={{ fontSize: 11, color: h.color, marginTop: 4 }}>
                    Next Recovery: {resetStr}
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
