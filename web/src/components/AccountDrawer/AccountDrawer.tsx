import React, { useEffect, useRef, useState } from 'react';
import type { Account } from '../../api';
import type { ProviderType, QuotaBucket } from '../../../../src/models/types';
import type { ManualHoldType, WatermarkAccountView } from '../../../../server/src/cpaWatermarkTypes';
import { LAB_BRAND_PALETTES, PROVIDER_NAMES } from '../../../../src/constants/theme';
import { formatTimeRemaining, formatResetCountdown } from '../../../../src/utils/formatters';
import { formatTokenCount } from '../../../../src/services/telemetryService';
import { deriveRoutingEnforcement } from '../common/cpaUiUtils';
import './AccountDrawer.css';

export interface AccountDrawerTelemetry {
  accountId?: string;
  lastRoutedAt?: string;
  proxySource?: string;
  slotId?: string;
  proxyPort?: number;
  tokensBurned24h?: number;
  activeBurstRequests?: number;
  primaryModel?: string;
  latencyMs?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  requestCount?: number;
}

export interface AccountDrawerProps {
  account: Account | null;
  telemetry?: AccountDrawerTelemetry;
  accountView?: WatermarkAccountView | null;
  onApplyHold?: (req: { accountId: string; hold: ManualHoldType; reason?: string }) => Promise<void>;
  onClose: () => void;
  onViewFleet?: () => void;
}

export const AccountDrawer: React.FC<AccountDrawerProps> = ({
  account,
  telemetry,
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
  const isExhausted = (account.latestSnapshot?.status === 'ok' ? false : account.latestSnapshot?.status === 'rate_limited') || weeklyRem <= 10 || rollingRem <= 10;
  const nearestReset = weekly?.resetsAt || rolling?.resetsAt;

  const handleCopy = () => {
    if (account.email) {
      navigator.clipboard?.writeText(account.email).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const slotId = telemetry?.slotId || `${account.providerType}_slot_01`;
  const proxyPort = telemetry?.proxyPort || 8317;

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
            ?
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
            background: isExhausted ? 'var(--bad-soft)' : 'var(--ok-soft)',
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
                background: isExhausted ? 'var(--bad)' : 'var(--ok)',
                display: 'inline-block',
              }}
            />
            <b style={{ color: isExhausted ? 'var(--bad)' : 'var(--ok)', fontSize: 13 }}>
              {isExhausted ? 'Cooldown Active' : 'Ready & Healthy'}
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
              style={{ width: '100%', marginBottom: 8, boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn small" disabled={holdBusy} onClick={() => applyHold('quarantine')} title="Take out of rotation (standby cooldown)">Quarantine</button>
              <button type="button" className="btn small" disabled={holdBusy} onClick={() => applyHold('airgap')} title="Remove from the CLIProxy pool immediately">Airgap</button>
              <button type="button" className="btn small" disabled={holdBusy || routing.origin !== 'manual'} onClick={() => applyHold('none')} title="Return to automatic routing">Clear hold</button>
            </div>
            {holdError && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--bad)' }}>{holdError}</div>}
          </div>
        )}

        {/* 7-Day Quota Cycle Strip */}
        <div style={{ background: 'var(--card-hi)', padding: 12, borderRadius: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>7-Day Quota Cycle</span>
            <b style={{ fontSize: 13, color: weeklyRem <= 35 ? 'var(--warn)' : 'var(--ok)' }}>
              {weeklyRem}% Balance ({Math.round(weeklyRem * 10)}k / 1M)
            </b>
          </div>
          <div style={{ height: 8, background: 'var(--track)', borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
            <div style={{ height: '100%', width: `${weeklyRem}%`, background: weeklyRem <= 35 ? 'linear-gradient(90deg, #f59e0b, #d97706)' : 'linear-gradient(90deg, #10b981, #059669)', borderRadius: 4 }} />
          </div>
          <div className="dh-calendar-strip" style={{ marginBottom: 8 }}>
            <div className="dh-day-pill past">D1</div>
            <div className="dh-day-pill past">D2</div>
            <div className={`dh-day-pill ${weeklyRem <= 35 ? 'tight' : 'current'}`}>D3</div>
            <div className="dh-day-pill">D4</div>
            <div className="dh-day-pill">D5</div>
            <div className="dh-day-pill">D6</div>
            <div className="dh-day-pill">D7</div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Weekly Reset: <strong style={{ color: '#e5e7eb' }}>{formatResetCountdown(weekly?.resetsAt || nearestReset)}</strong>
          </div>
        </div>

        {/* Telemetry info */}
        <div style={{ background: 'var(--card-hi)', padding: 12, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <b style={{ fontSize: 13, marginBottom: 2 }}>Proxy Router Telemetry</b>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span className="muted">Auth Slot:</span>
            <b>{slotId}</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span className="muted">Proxy Port:</span>
            <b>{proxyPort} (CLIProxy pool)</b>
          </div>
          {telemetry && (
            <>
              {telemetry.totalTokens !== undefined && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="muted">Total Routed:</span>
                  <b>{formatTokenCount(telemetry.totalTokens)} tokens</b>
                </div>
              )}
              {telemetry.tokensBurned24h !== undefined && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="muted">24h Tokens Burned:</span>
                  <b>{formatTokenCount(telemetry.tokensBurned24h)} tokens</b>
                </div>
              )}
              {telemetry.primaryModel && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="muted">Primary Model:</span>
                  <b>{telemetry.primaryModel}</b>
                </div>
              )}
              {telemetry.promptTokens !== undefined && telemetry.completionTokens !== undefined && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="muted">Prompt / Completion:</span>
                  <b>{formatTokenCount(telemetry.promptTokens)} / {formatTokenCount(telemetry.completionTokens)}</b>
                </div>
              )}
              {telemetry.requestCount !== undefined && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="muted">Request Count:</span>
                  <b>{telemetry.requestCount} requests</b>
                </div>
              )}
              {telemetry.activeBurstRequests !== undefined && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="muted">Active Burst Requests:</span>
                  <b>{telemetry.activeBurstRequests} reqs</b>
                </div>
              )}
              {telemetry.latencyMs !== undefined && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="muted">Proxy Latency:</span>
                  <b>{telemetry.latencyMs}ms</b>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
