import type { Account } from '../../api';
import { dualRingData } from '../../../../src/services/capacity';

export interface SlotHeadroomInfo {
  rem: number;
  isTight: boolean;
  isExhausted: boolean;
  status: 'exhausted' | 'tight' | 'healthy';
  label: string;
  color: string;
  fill: string;
  waterlineColor: string;
  waterlineBg: string;
  badge: string;
}

export function getSlotHeadroom(a: Account, _idx: number): SlotHeadroomInfo {
  const isClaude = a.providerType === 'claude';
  const ring = dualRingData(a.latestSnapshot);
  // Tightest of the 5-hour and weekly windows; accounts without data read as 0 and are labelled 'No data'.
  const hasData = Boolean(ring.binding);
  const rem = hasData ? Math.max(0, Math.min(100, Math.round(ring.binding!.remaining))) : 0;
  const isExhausted = hasData && rem <= 0;
  const isTight = hasData && rem <= 35;
  const status: 'exhausted' | 'tight' | 'healthy' = isExhausted ? 'exhausted' : isTight ? 'tight' : 'healthy';
  const label = !hasData ? 'No data' : isExhausted ? 'Exhausted' : isTight ? 'Tight' : 'Healthy';
  const color = isExhausted ? '#ef4444' : isTight ? '#fbbf24' : '#4ade80';
  const fill = isExhausted
    ? 'linear-gradient(0deg, #7f1d1d, #ef4444)'
    : isTight
    ? 'linear-gradient(0deg, #78350f, #d97706)'
    : isClaude
    ? 'linear-gradient(0deg, #7c2d12, #ea580c)'
    : 'linear-gradient(0deg, #1e3a8a, #2563eb)';
  const waterlineColor = isExhausted ? '#fca5a5' : isTight ? '#fef08a' : isClaude ? '#fdba74' : '#93c5fd';
  const waterlineBg = isExhausted ? '#ef4444' : isTight ? '#f59e0b' : isClaude ? '#ea580c' : '#60a5fa';
  const badge = isExhausted ? 'badge-bad' : isTight ? 'badge-warn' : 'badge-ok';
  return { rem, isTight, isExhausted, status, label, color, fill, waterlineColor, waterlineBg, badge };
}
