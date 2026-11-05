import React, { useEffect, useRef, useState } from 'react';
import type { Account } from '../../api';
import type { ProviderType, QuotaBucket } from '../../../../src/models/types';
import type { ManualHoldType, WatermarkAccountView } from '../../../../server/src/cpaWatermarkTypes';
import { LAB_BRAND_PALETTES, PROVIDER_NAMES } from '../../../../src/constants/theme';
import { capitalize, formatTimeRemaining, formatResetCountdown } from '../../../../src/utils/formatters';
import { formatTokenCount, type AccountTelemetry } from '../../../../src/services/telemetryService';
import { accountStatus, deriveRoutingEnforcement, ACCOUNT_STATUS_LABEL } from '../common/cpaUiUtils';
import './AccountDrawer.css';

/** Real proxy telemetry for one account, or null when no source reports it. */
export type AccountDrawerTelemetry = AccountTelemetry | null;

export interface AccountDrawerProps {
  account: Account | null;
  telemetry?: AccountDrawerTelemetry;
  /** Why telemetry is missing, shown when there is no data for this account. */
  telemetryNotes?: string[];
  accountView?: WatermarkAccountView | null;
  onApplyHold?: (req: { accountId: string; hold: ManualHoldType; reason?: string }) => Promise<void>;
  onClose: () => void;
  onViewFleet?: () => void;
}

export const AccountDrawer: React.FC<AccountDrawerProps> = ({
  account,
  telemetry,
  telemetryNotes,
  accountView,
  onApplyHold,
  onClose,
  onViewFleet: _onViewFleet,
}) => {
  const [copied, setCopied] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (!account) return null;

  const prov = account.providerType as ProviderType;
  const brand = LAB_BRAND_PALETTES[prov] || { primary: '#8b5cf6' };
  const providerTitle = PROVIDER_NAMES[prov] || prov;
  const buckets = (account.latestSnapshot?.buckets || []) as QuotaBucket[];
  // Match windows by type only; positional fallbacks put 5-hour values under the weekly label.
  const rolling = buckets.find((b: QuotaBucket) => b.windowType === 'session_5h');
  const weekly = buckets.find((b: QuotaBucket) => b.windowType === 'weekly_7d') || buckets.find((b: QuotaBucket) => b.windowType !== 'session_5h');
  const routing = deriveRoutingEnforcement(account, accountView);

  const applyHold = async (hold: ManualHoldType) => {
    if (!onApplyHold) return;
    setHoldBusy(true);
    setHoldError(null);
    try {
      await onApplyHold({ accountId: account.id, hold, reason: holdReason.trim() || undefined });
      setHoldReason('');
    } catch (e) {
      setHoldError(e instanceof Error ? e.message : 'Hold request failed');
    } finally {
      setHoldBusy(false);
    }
  };

  const weeklyRem = Math.round(weekly?.remainingPercent ?? 100);
  const rollingRem = Math.round(rolling?.remainingPercent ?? 100);
  const status = accountStatus(account, accountView);
  const tone = {
    healthy: { fg: 'var(--ok)', bg: 'var(--ok-soft)' },
    tight: { fg: 'var(--warn)', bg: 'var(--warn-soft)' },
    exhausted: { fg: 'var(--bad)', bg: 'var(--bad-soft)' },
    cooldown: { fg: '#93c5fd', bg: 'rgba(96, 165, 250, 0.12)' },
  }[status];
  const nearestReset = weekly?.resetsAt || rolling?.resetsAt;

  const handleCopy = () => {
    if (account.email) {
      navigator.clipboard?.writeText(account.email).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };


  return (
    <div
      className="web-drawer-backdrop fqd-account-drawer-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={drawerRef}
        className="web-drawer-content fqd-account-drawer-content"
        style={{
          width: '100%',
          maxWidth: 440,
          height: '100%',
          background: 'var(--card)',
          borderLeft: '1px solid var(--border)',
          padding: 24,
          boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                background: brand.primary,
                color: '#fff',
                padding: '3px 8px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {providerTitle}
            </span>
            <b style={{ fontSize: 18 }}>{account.name}</b>
          </div>
          <button
            type="button"
            className="fqd-account-drawer-close-btn"
            onClick={onClose}
            style={{
              padding: '6px 10px',
              borderRadius: '50%',
              background: 'var(--card-hi)',
              fontSize: 16,
              fontWeight: 700,
              cursor: 'pointer',
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted small">{account.email || 'No email associated'}</span>
          {account.email && (
            <button
              type="button"
              onClick={handleCopy}
              style={{
                background: 'var(--card-hi)',
                padding: '4px 8px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                color: copied ? 'var(--ok)' : 'var(--muted)',
                cursor: 'pointer',
              }}
            >
              {copied ? 'Copied' : 'Copy email'}
            </button>
          )}
        </div>

        <div
          style={{
            padding: 12,
            borderRadius: 12,
            background: tone.bg,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: tone.fg,
                display: 'inline-block',
              }}
            />
            <b style={{ color: tone.fg, fontSize: 13 }}>
              {ACCOUNT_STATUS_LABEL[status]}
            </b>
          </div>
          {nearestReset && (
            <span className="small muted">
              {formatResetCountdown(nearestReset)}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Meter 1: Weekly */}
          {weekly && <div style={{ background: 'var(--card-hi)', padding: 12, borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Weekly Quota Cap</span>
              <b style={{ fontSize: 13 }}>{weeklyRem}% remaining</b>
            </div>
            <div style={{ height: 8, background: 'var(--track)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${weeklyRem}%`, background: brand.primary, borderRadius: 4 }} />
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              {weekly?.resetsAt ? `Resets ${formatTimeRemaining(weekly.resetsAt)}` : '7-day rolling window'}
            </div>
          </div>}

          {/* Meter 2: 5-Hour */}
          {rolling && <div style={{ background: 'var(--card-hi)', padding: 12, borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>5-Hour Rolling Limit</span>
              <b style={{ fontSize: 13 }}>{rollingRem}% remaining</b>
            </div>
            <div style={{ height: 8, background: 'var(--track)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${rollingRem}%`, background: brand.primary, borderRadius: 4 }} />
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              {rolling?.resetsAt ? `Next Window Recovery: ${formatResetCountdown(rolling.resetsAt)}` : 'Active session window'}
            </div>
          </div>}
        </div>

        {/* Every quota window the provider reports (e.g. Gemini, Claude/GPT) */}
        {buckets.length > 2 && (
          <div style={{ background: 'var(--card-hi)', padding: 12, borderRadius: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Quota by Model</div>
            {buckets.map((b) => (
              <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                <span>{b.label}</span>
                <span>
                  <b>{b.remainingPercent === null ? '-' : `${Math.round(b.remainingPercent)}%`}</b>
                  {b.resetsAt && <span style={{ color: 'var(--muted)' }}> · resets {formatResetCountdown(b.resetsAt)}</span>}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Routing: the single place to hold or release this account in CLIProxy */}
        {onApplyHold && (
          <div style={{ background: 'var(--card-hi)', padding: 12, borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Routing</span>
              <span style={{ fontSize: 12 }}>
                {routing.effectiveState} · weight {routing.weight} · {routing.origin === 'manual' ? `manual ${accountView?.manualHold}` : 'automatic'}
              </span>
            </div>
            <input
              type="text"
              placeholder="Reason (optional)"
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              style={{ width: '100%', marginBottom: 8, padding: '6px 10px', fontSize: 12, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="filter-btn" disabled={holdBusy} onClick={() => applyHold('quarantine')} title="Take out of rotation (standby cooldown)">Quarantine</button>
              <button type="button" className="filter-btn" disabled={holdBusy} onClick={() => applyHold('airgap')} title="Remove from the CLIProxy pool immediately">Airgap</button>
              <button type="button" className="filter-btn" disabled={holdBusy || routing.origin !== 'manual'} onClick={() => applyHold('none')} title="Return to automatic routing">Clear hold</button>
            </div>
            {holdError && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--bad)' }}>{holdError}</div>}
          </div>
        )}

        {/* Telemetry info */}
        <div style={{ background: 'var(--card-hi)', padding: 12, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <b style={{ fontSize: 13, marginBottom: 2 }}>Proxy Router Telemetry</b>
          {telemetry ? (
            <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span className="muted">CLIProxy status:</span>
            <b>{telemetry.disabled ? 'Disabled' : capitalize(telemetry.proxyStatus || 'active')}</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span className="muted">Requests (last hour):</span>
            <b>{telemetry.requestsLastHour ?? 0} ({telemetry.failedLastHour ?? 0} failed)</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span className="muted">Requests (since proxy start):</span>
            <b>{telemetry.successCount ?? 0} ok / {telemetry.failedCount ?? 0} failed</b>
          </div>
              {telemetry.totalTokens > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span className="muted">Tokens (last 24h):</span>
            <b>{formatTokenCount(telemetry.totalTokens)}</b>
          </div>
              )}
              {telemetry.models?.map((m) => (
                <div key={m.model} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, paddingLeft: 8 }}>
                  <span className="muted">{m.model}</span>
                  <span>{m.requests} req · {formatTokenCount(m.totalTokens)} tokens</span>
                </div>
              ))}
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              No proxy telemetry for this account.
              {telemetryNotes && telemetryNotes.length > 0 && <div style={{ marginTop: 4 }}>{telemetryNotes[0]}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
