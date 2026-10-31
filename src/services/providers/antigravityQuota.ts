import { QuotaBucket, QuotaWindowType } from '../../models/types';
import { makeBucket } from './common';

export type AgyFamily = 'gemini' | '3p' | 'argon' | 'other';

const FAMILY_PREFIXES: Record<AgyFamily, string> = {
  gemini: 'Gemini',
  '3p': 'Claude/GPT',
  argon: 'Argon',
  other: 'Quota',
};

const WINDOW_LABELS: Record<'5h' | 'weekly' | 'quota', string> = {
  '5h': '5-hour',
  weekly: 'Weekly',
  quota: 'Quota',
};

const FAMILY_ORDER: Record<AgyFamily, number> = {
  gemini: 0,
  '3p': 1,
  argon: 2,
  other: 3,
};

const WINDOW_ORDER: Record<'5h' | 'weekly' | 'quota', number> = {
  '5h': 0,
  weekly: 1,
  quota: 2,
};

/**
 * Normalizes group name and bucket id to one of the canonical families:
 * - contains 'argon' -> 'argon'
 * - else contains 'gemini' -> 'gemini'
 * - else contains '3p', 'claude', 'gpt', or 'third' -> '3p'
 * - else -> 'other'
 */
export function agyFamily(groupName: string, bucketId: string): AgyFamily {
  const text = `${groupName || ''} ${bucketId || ''}`.toLowerCase();
  if (text.includes('argon')) return 'argon';
  if (text.includes('gemini')) return 'gemini';
  if (
    text.includes('3p') ||
    text.includes('claude') ||
    text.includes('gpt') ||
    text.includes('third')
  ) {
    return '3p';
  }
  return 'other';
}

/**
 * Resolves the window type and suffix from window, id, and displayName:
 * - matches /(^|[-_ ])(5h|5-hour|five[ _-]hour)/ -> session_5h, suffix '5h'
 * - matches /weekly|7d|7-day|week/ -> weekly_7d, suffix 'weekly'
 * - else -> sliding_window, suffix 'quota'
 */
export function agyWindow(bucket: any): { windowType: QuotaWindowType; suffix: '5h' | 'weekly' | 'quota' } {
  const windowStr = typeof bucket?.window === 'string' ? bucket.window : '';
  const idStr =
    typeof bucket?.bucketId === 'string'
      ? bucket.bucketId
      : typeof bucket?.bucket_id === 'string'
        ? bucket.bucket_id
        : '';
  const displayStr =
    typeof bucket?.displayName === 'string'
      ? bucket.displayName
      : typeof bucket?.display_name === 'string'
        ? bucket.display_name
        : '';

  const candidates = [windowStr, idStr, displayStr].filter(Boolean);
  const text = candidates.join(' ').toLowerCase();

  if (
    candidates.some((c) => /(^|[-_ ])(5h|5-hour|five[ _-]hour)/i.test(c)) ||
    /(^|[-_ ])(5h|5-hour|five[ _-]hour)/i.test(text)
  ) {
    return { windowType: 'session_5h', suffix: '5h' };
  }

  if (
    candidates.some((c) => /weekly|7d|7-day|week/i.test(c)) ||
    /weekly|7d|7-day|week/i.test(text)
  ) {
    return { windowType: 'weekly_7d', suffix: 'weekly' };
  }

  return { windowType: 'sliding_window', suffix: 'quota' };
}

/**
 * Extracts remaining fraction (0..1) from a bucket representation.
 * Handles proto3 JSON omission: does NOT apply the resetTime -> 0 rule here.
 */
export function agyRemainingFraction(bucket: any): number | undefined {
  if (!bucket || typeof bucket !== 'object') return undefined;

  if (typeof bucket.remainingFraction === 'number' && !Number.isNaN(bucket.remainingFraction)) {
    return bucket.remainingFraction;
  }
  if (typeof bucket.remaining_fraction === 'number' && !Number.isNaN(bucket.remaining_fraction)) {
    return bucket.remaining_fraction;
  }
  if (typeof bucket.remaining === 'number' && !Number.isNaN(bucket.remaining)) {
    return bucket.remaining;
  }
  if (typeof bucket.remaining === 'object' && bucket.remaining !== null) {
    if (
      typeof bucket.remaining.remainingFraction === 'number' &&
      !Number.isNaN(bucket.remaining.remainingFraction)
    ) {
      return bucket.remaining.remainingFraction;
    }
    if (
      typeof bucket.remaining.remaining_fraction === 'number' &&
      !Number.isNaN(bucket.remaining.remaining_fraction)
    ) {
      return bucket.remaining.remaining_fraction;
    }
    if (
      (bucket.remaining.case === 'remainingFraction' || bucket.remaining.case === 'remaining_fraction') &&
      typeof bucket.remaining.value === 'number' &&
      !Number.isNaN(bucket.remaining.value)
    ) {
      return bucket.remaining.value;
    }
  }

  return undefined;
}

interface ParsedItem {
  family: AgyFamily;
  windowSuffix: '5h' | 'weekly' | 'quota';
  windowType: QuotaWindowType;
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  upstreamId: string;
  description?: string;
  originalIndex: number;
}

/**
 * Parses raw Antigravity RetrieveUserQuotaSummary JSON into QuotaBucket[].
 * Pure function: no network or I/O.
 */
export function parseAntigravityQuotaSummary(raw: unknown): QuotaBucket[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }

  const envelope = raw as any;
  const groups = Array.isArray(envelope.groups)
    ? envelope.groups
    : Array.isArray(envelope.response?.groups)
      ? envelope.response.groups
      : null;

  if (!groups || !Array.isArray(groups)) {
    return [];
  }

  const parsedItems: ParsedItem[] = [];
  let itemIndex = 0;

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;

    const groupName =
      typeof group.displayName === 'string' && group.displayName.trim()
        ? group.displayName.trim()
        : typeof group.display_name === 'string' && group.display_name.trim()
          ? group.display_name.trim()
          : typeof group.name === 'string' && group.name.trim()
            ? group.name.trim()
            : '';

    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      if (bucket.disabled === true) continue;

      const id = bucket.bucketId ?? bucket.bucket_id;
      if (typeof id !== 'string' || !id) continue;

      const family = agyFamily(groupName, id);
      const { windowType, suffix: windowSuffix } = agyWindow(bucket);

      const prefix =
        family === 'other'
          ? (groupName || 'Quota')
          : FAMILY_PREFIXES[family];

      const windowLabel = WINDOW_LABELS[windowSuffix];
      const label = `${prefix} · ${windowLabel}`;

      const r = agyRemainingFraction(bucket);
      const resetTime =
        typeof bucket.resetTime === 'string'
          ? bucket.resetTime
          : typeof bucket.reset_time === 'string'
            ? bucket.reset_time
            : null;

      let utilization: number | null = null;
      if (r !== undefined) {
        const clampedR = Math.max(0, Math.min(1, r));
        utilization = Math.max(0, Math.min(100, (1 - clampedR) * 100));
      } else if (resetTime) {
        // Proto3 JSON omission: if remainingFraction is absent but resetTime exists,
        // treat remaining fraction as 0.0 (utilization 100%, exhausted)
        utilization = 100;
      }

      const description =
        typeof bucket.description === 'string' ? bucket.description : undefined;

      parsedItems.push({
        family,
        windowSuffix,
        windowType,
        label,
        utilization,
        resetsAt: resetTime,
        upstreamId: id,
        description,
        originalIndex: itemIndex++,
      });
    }
  }

  // Canonical ordering: gemini, then 3p, then argon, then other; 5h before weekly before quota
  parsedItems.sort((a, b) => {
    const fDiff = FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family];
    if (fDiff !== 0) return fDiff;
    const wDiff = WINDOW_ORDER[a.windowSuffix] - WINDOW_ORDER[b.windowSuffix];
    if (wDiff !== 0) return wDiff;
    return a.originalIndex - b.originalIndex;
  });

  const idCounts = new Map<string, number>();
  const result: QuotaBucket[] = [];

  for (const item of parsedItems) {
    const baseId = `${item.family}_${item.windowSuffix}`;
    const count = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, count);
    const id = count === 1 ? baseId : `${baseId}_${count}`;

    result.push(
      makeBucket(
        id,
        item.label,
        item.windowType,
        item.utilization,
        item.resetsAt,
        {
          family: item.family,
          upstreamId: item.upstreamId,
          description: item.description,
        }
      )
    );
  }

  return result;
}
