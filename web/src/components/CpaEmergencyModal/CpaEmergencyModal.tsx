import React, { useEffect, useState } from 'react';
import type { ManualHoldType, WatermarkAccountState, WatermarkAccountView } from '../../../../server/src/cpaWatermarkTypes';
import { effectiveAccountState } from '../../../../server/src/cpaWatermarkTypes';
import type { Account } from '../../api';
import './CpaEmergencyModal.css';

export interface CpaEmergencyModalProps {
  account: Account | null;
  accountView?: WatermarkAccountView | null;
  isOpen: boolean;
  onClose: () => void;
  onApplyHold: (req: {
    accountId: string;
    hold: ManualHoldType;
    reason?: string;
    ttlSeconds?: number;
  }) => Promise<void>;
}

export const CpaEmergencyModal: React.FC<CpaEmergencyModalProps> = ({
  account,
  accountView,
  isOpen,
  onClose,
  onApplyHold,
}) => {
  const [selectedHold, setSelectedHold] = useState<ManualHoldType>('quarantine');
  const [reason, setReason] = useState<string>('');
  const [ttlHours, setTtlHours] = useState<number>(24);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Synchronize initial hold from accountView when opened
  useEffect(() => {
    if (accountView?.manualHold) {
      setSelectedHold(accountView.manualHold === 'none' ? 'quarantine' : accountView.manualHold);
    } else {
      setSelectedHold('quarantine');
    }
    setReason('');
    setTtlHours(24);
    setErrorMsg(null);
  }, [account, accountView, isOpen]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  if (!isOpen || !account) return null;

  // Determine auto-state
  let autoState: WatermarkAccountState = 'healthy';
  if (accountView) {
    autoState = accountView.state;
  } else {
    const buckets = account.latestSnapshot?.buckets || [];
    const lowest = buckets.length > 0
      ? Math.min(...buckets.map((b) => b.remainingPercent ?? 100))
      : 100;
    if (account.latestSnapshot?.status === 'rate_limited' || lowest <= 10) {
      autoState = 'exhausted';
    } else if (lowest <= 35) {
      autoState = 'tight';
    }
  }

  // Derive simulated effective state
  const simulatedEffectiveState = effectiveAccountState(selectedHold, autoState);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await onApplyHold({
        accountId: account.id,
        hold: selectedHold,
        reason: reason.trim() || undefined,
        ttlSeconds: selectedHold !== 'none' ? ttlHours * 3600 : undefined,
      });
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to apply hold');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="cpa-emergency-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="emergency-modal-title"
    >
      <div className="cpa-emergency-modal-content">
        <div className="cpa-emergency-modal-header">
          <div className="cpa-emergency-modal-title" id="emergency-modal-title">
            <span>🛡️</span>
            <span>Operator Emergency Hold Controls</span>
          </div>
          <button
            type="button"
            className="cpa-emergency-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="cpa-emergency-modal-body">
            {/* Account Info Pill */}
            <div className="cpa-account-pill-banner">
              <div>
                <div className="cpa-account-pill-banner__name">
                  {account.name} <span style={{ fontSize: 11, color: '#93c5fd' }}>[{account.providerType}]</span>
                </div>
                <div className="cpa-account-pill-banner__email">
                  {account.email || account.id}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>Current Auto-State</span>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', textTransform: 'capitalize' }}>
                  {autoState}
                </div>
              </div>
            </div>

            {/* Error Message if any */}
            {errorMsg && (
              <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', borderRadius: 6, padding: '8px 12px', color: '#fca5a5', fontSize: 12 }}>
                ⚠️ {errorMsg}
              </div>
            )}

            {/* Hold Options Selector */}
            <div className="cpa-form-group">
              <label className="cpa-form-label">Select Intervention Level:</label>
              <div className="cpa-hold-options-group">
                {/* Airgap Option */}
                <button
                  type="button"
                  className={`cpa-hold-option-btn ${selectedHold === 'airgap' ? 'cpa-hold-option-btn--active-airgap' : ''}`}
                  onClick={() => setSelectedHold('airgap')}
                >
                  <div className="cpa-hold-option-title" style={{ color: selectedHold === 'airgap' ? '#f87171' : '#fca5a5' }}>
                    <span>🛑 AIRGAP (Immediate Drop &amp; Hard Sever)</span>
                  </div>
                  <div className="cpa-hold-option-desc">
                    Immediately drops routing weight to 0, halts proxy dispatch, and marks credential airgapped to shield against upstream flagging/bans.
                  </div>
                </button>

                {/* Quarantine Option */}
                <button
                  type="button"
                  className={`cpa-hold-option-btn ${selectedHold === 'quarantine' ? 'cpa-hold-option-btn--active-quarantine' : ''}`}
                  onClick={() => setSelectedHold('quarantine')}
                >
                  <div className="cpa-hold-option-title" style={{ color: selectedHold === 'quarantine' ? '#c084fc' : '#d8b4fe' }}>
                    <span>🔒 QUARANTINE (Standby Cooldown)</span>
                  </div>
                  <div className="cpa-hold-option-desc">
                    Sets routing weight to 0 while keeping credential authenticated. Will hold until manual release or TTL expiry.
                  </div>
                </button>

                {/* Clear Hold Option */}
                <button
                  type="button"
                  className={`cpa-hold-option-btn ${selectedHold === 'none' ? 'cpa-hold-option-btn--active-none' : ''}`}
                  onClick={() => setSelectedHold('none')}
                >
                  <div className="cpa-hold-option-title" style={{ color: selectedHold === 'none' ? '#34d399' : '#a7f3d0' }}>
                    <span>✨ CLEAR HOLD (Resume Automated Watermarks)</span>
                  </div>
                  <div className="cpa-hold-option-desc">
                    Removes manual operator lock and returns account state to automated telemetry &amp; watermark tripwires.
                  </div>
                </button>
              </div>
            </div>

            {/* Effective State Visualization Box */}
            <div className="cpa-effective-state-box">
              <span className="cpa-effective-state-header">
                Interactive Precedence Preview
              </span>
              <div className="cpa-effective-state-calc">
                <span>Auto-State:</span>
                <span className="cpa-calc-chip cpa-calc-chip--auto">{autoState.toUpperCase()}</span>
                <span>+</span>
                <span>Manual Hold:</span>
                <span className="cpa-calc-chip cpa-calc-chip--hold">{selectedHold.toUpperCase()}</span>
                <span>➔</span>
                <span>Effective State:</span>
                <span className={`cpa-calc-chip ${simulatedEffectiveState === 'airgapped' || simulatedEffectiveState === 'quarantined' ? 'cpa-calc-chip--result-danger' : 'cpa-calc-chip--result'}`}>
                  {simulatedEffectiveState.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
                Formula: <code>EffectiveState = most_restrictive(ManualHold, AutoState)</code>
              </div>
            </div>

            {/* Reason input */}
            <div className="cpa-form-group">
              <label className="cpa-form-label" htmlFor="hold-reason-input">
                Operator Reason / Ticket Reference:
              </label>
              <input
                id="hold-reason-input"
                className="cpa-form-input"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g., Investigating upstream 429 spike or planned credential rotation"
              />
            </div>

            {/* TTL selection (only if hold !== 'none') */}
            {selectedHold !== 'none' && (
              <div className="cpa-form-group">
                <label className="cpa-form-label">
                  Hold Duration / TTL (Time To Live):
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    className="cpa-form-input"
                    type="number"
                    min="1"
                    max="720"
                    value={ttlHours}
                    onChange={(e) => setTtlHours(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    style={{ width: 100 }}
                  />
                  <span style={{ fontSize: 12, color: '#cbd5e1' }}>hours</span>
                </div>
                <div className="cpa-ttl-presets">
                  {[1, 6, 24, 72].map((hours) => (
                    <button
                      key={hours}
                      type="button"
                      className={`cpa-ttl-preset-btn ${ttlHours === hours ? 'cpa-ttl-preset-btn--active' : ''}`}
                      onClick={() => setTtlHours(hours)}
                    >
                      {hours}h {hours === 24 ? '(Default)' : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="cpa-emergency-modal-footer">
            <button
              type="button"
              className="cpa-btn-cancel"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`cpa-btn-submit ${selectedHold === 'airgap' ? 'cpa-btn-submit--airgap' : ''}`}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <span>Applying…</span>
              ) : selectedHold === 'airgap' ? (
                <span>🛡️ Enforce Airgap</span>
              ) : selectedHold === 'quarantine' ? (
                <span>🔒 Enforce Quarantine</span>
              ) : (
                <span>✨ Clear Hold</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
