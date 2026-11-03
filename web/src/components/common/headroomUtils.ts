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
  reqs: number;
}

export function getSlotHeadroom(a: Account, idx: number): SlotHeadroomInfo {
  const isClaude = a.providerType === 'claude';
  const ring = dualRingData(a.latestSnapshot);
  const rawRem = ring.outer !== undefined && ring.outer !== null
    ? Math.round(ring.outer.remaining)
    : (ring.inner ? Math.round(ring.inner.remaining) : (isClaude ? 84 : (90 + ((idx * 3) % 10))));
  const rem = Math.max(0, Math.min(100, rawRem));
  const isExhausted = rem <= 15;
  const isTight = rem <= 35;
  const status: 'exhausted' | 'tight' | 'healthy' = isExhausted ? 'exhausted' : isTight ? 'tight' : 'healthy';
  const label = isExhausted ? 'Exhausted' : isTight ? 'Tight' : 'Healthy';
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
  const reqs = Math.round((rem / 100) * 156);
  return { rem, isTight, isExhausted, status, label, color, fill, waterlineColor, waterlineBg, badge, reqs };
}

export function getMockAgyAccounts(): Account[] {
  return Array.from({ length: 14 }).map((_, idx) => ({
    id: `mock-agy-${idx + 1}`,
    name: `Antigravity Slot ${idx + 1}`,
    email: idx === 13 ? 'vishakhagemini0@gmail.com' : (idx === 10 ? 'piyushkumar.jiit@gmail.com' : `slot_${String(idx + 1).padStart(2, '0')}@gmail.com`),
    providerType: 'antigravity' as const,
    plan: 'AI Pro',
    orderIndex: idx,
    isActive: true,
    lastStatus: 'ok' as const,
    createdAt: new Date().toISOString(),
  }));
}

export function getMockClaudeAccount(): Account {
  return {
    id: 'mock-claude-1',
    name: 'Claude Pro',
    email: 'claude-2f8e2ab5-piyush...',
    providerType: 'claude' as const,
    plan: 'Pro Tier',
    orderIndex: 0,
    isActive: true,
    lastStatus: 'ok' as const,
    createdAt: new Date().toISOString(),
  };
}
