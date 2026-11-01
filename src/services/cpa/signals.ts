import { QuotaBucket, QuotaWindowType } from '../../models/types';
import { makeBucket } from '../providers/common';

/** Maximum allowed age of passive signals before they are considered stale (120 seconds). */
export const PASSIVE_SIGNAL_MAX_AGE_SEC = 120;

/**
 * Checks if the observedAt timestamp is fresh (< 120s old).
 */
export function isSignalFresh(observedAt: string, now: number = Date.now()): boolean {
  if (!observedAt) return false;
  const trimmed = observedAt.trim();
  const obsMs = /^\d+$/.test(trimmed)
    ? (trimmed.length <= 10 ? parseInt(trimmed, 10) * 1000 : parseInt(trimmed, 10))
    : new Date(trimmed).getTime();

  if (isNaN(obsMs)) return false;
  const ageSec = (now - obsMs) / 1000;
  // Ignore observations older than 120s or skewed into future by > 60s
  return ageSec >= -60 && ageSec <= PASSIVE_SIGNAL_MAX_AGE_SEC;
}

/**
 * Helper to look up a header in a case-insensitive manner from normalized map.
 */
function findHeader(normalized: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const val = normalized[k.toLowerCase()];
    if (val !== undefined && val.trim().length > 0) return val.trim();
  }
  return undefined;
}

/**
 * Parse a Codex utilization percentage.
 * Unlike Claude ratio headers, Codex X-Codex-*-Used-Percent headers are already
 * in percentage units (0 to 100). Do NOT scale <= 2.0 to 100.
 */
export function parseCodexPercent(raw: string | undefined): number | null {
  if (!raw) return null;
  let trimmed = raw.trim();
  if (trimmed.endsWith('%')) {
    trimmed = trimmed.slice(0, -1).trim();
  }
  const num = parseFloat(trimmed);
  return isNaN(num) ? null : num;
}
export function parseRatioOrPercent(raw: string | undefined): number | null {
  if (!raw) return null;
  let trimmed = raw.trim();
  if (trimmed.endsWith('%')) {
    trimmed = trimmed.slice(0, -1).trim();
    const num = parseFloat(trimmed);
    return isNaN(num) ? null : num;
  }
  const num = parseFloat(trimmed);
  if (isNaN(num)) return null;
  // If value is a ratio <= 2.0 (like 0.42 -> 42%, 1.0 -> 100%, 1.02 -> 102%), scale to 100
  if (num <= 2.0) {
    return Math.round(num * 1000) / 10;
  }
  return num;
}

/**
 * Parse a reset value (epoch seconds, epoch ms, or ISO 8601 string).
 */
export function parseResetEpochOrIso(raw: string | undefined, now: number = Date.now()): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    const ms = trimmed.length <= 10 ? num * 1000 : num;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Builds window label for Codex limits matching ChatGPTProvider logic.
 */
function codexWindowLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds <= 6 * 3600) return `Codex · ${Math.round(seconds / 3600)}h`;
  if (seconds >= 6 * 86400) return 'Codex · Weekly';
  return `Codex · ${Math.round(seconds / 86400)}d`;
}

/**
 * Extract quota buckets from Claude passive response headers.
 * Supported headers:
 * - Anthropic-Ratelimit-Unified-5h-Utilization / -5h-Reset
 * - Anthropic-Ratelimit-Unified-7d-Utilization / -7d-Reset
 * - Anthropic-Ratelimit-Unified-7d_opus-Utilization / -7d_opus-Reset
 * - Anthropic-Ratelimit-Unified-7d_sonnet-Utilization / -7d_sonnet-Reset
 */
export function bucketsFromClaudeSignals(
  sig: Record<string, string>,
  observedAt: string,
  now: number = Date.now()
): QuotaBucket[] {
  if (!sig || !isSignalFresh(observedAt, now)) {
    return [];
  }

  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(sig)) {
    norm[k.toLowerCase()] = v;
  }

  const buckets: QuotaBucket[] = [];

  const definitions: Array<{
    id: string;
    label: string;
    type: QuotaWindowType;
    utilKeys: string[];
    resetKeys: string[];
  }> = [
    {
      id: 'five_hour',
      label: 'Session (5h)',
      type: 'session_5h',
      utilKeys: [
        'anthropic-ratelimit-unified-5h-utilization',
        '5h-utilization',
        'utilization',
      ],
      resetKeys: [
        'anthropic-ratelimit-unified-5h-reset',
        '5h-reset',
        'anthropic-ratelimit-unified-reset',
        'reset',
      ],
    },
    {
      id: 'seven_day',
      label: 'Weekly',
      type: 'weekly_7d',
      utilKeys: [
        'anthropic-ratelimit-unified-7d-utilization',
        '7d-utilization',
      ],
      resetKeys: [
        'anthropic-ratelimit-unified-7d-reset',
        '7d-reset',
      ],
    },
    {
      id: 'seven_day_opus',
      label: 'Weekly · Opus',
      type: 'weekly_7d',
      utilKeys: [
        'anthropic-ratelimit-unified-7d_opus-utilization',
        'anthropic-ratelimit-unified-7d-opus-utilization',
        '7d_opus-utilization',
      ],
      resetKeys: [
        'anthropic-ratelimit-unified-7d_opus-reset',
        'anthropic-ratelimit-unified-7d-opus-reset',
        '7d_opus-reset',
      ],
    },
    {
      id: 'seven_day_sonnet',
      label: 'Weekly · Sonnet',
      type: 'weekly_7d',
      utilKeys: [
        'anthropic-ratelimit-unified-7d_sonnet-utilization',
        'anthropic-ratelimit-unified-7d-sonnet-utilization',
        '7d_sonnet-utilization',
      ],
      resetKeys: [
        'anthropic-ratelimit-unified-7d_sonnet-reset',
        'anthropic-ratelimit-unified-7d-sonnet-reset',
        '7d_sonnet-reset',
      ],
    },
  ];

  for (const def of definitions) {
    const rawUtil = findHeader(norm, ...def.utilKeys);
    const rawReset = findHeader(norm, ...def.resetKeys);
    if (rawUtil !== undefined) {
      const utilPct = parseRatioOrPercent(rawUtil);
      const resetsAt = parseResetEpochOrIso(rawReset, now);
      buckets.push(makeBucket(def.id, def.label, def.type, utilPct, resetsAt));
    }
  }

  return buckets;
}

/**
 * Extract quota buckets from Codex passive response headers.
 * Supported headers:
 * - X-Codex-Primary-Used-Percent / -Reset-At / -Reset-After-Seconds / -Window-Minutes
 * - X-Codex-Secondary-Used-Percent / -Reset-At / -Reset-After-Seconds / -Window-Minutes
 * - X-Codex-Code-Review-Primary-Used-Percent / -Reset-At
 */
export function bucketsFromCodexSignals(
  sig: Record<string, string>,
  observedAt: string,
  now: number = Date.now()
): QuotaBucket[] {
  if (!sig || !isSignalFresh(observedAt, now)) {
    return [];
  }

  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(sig)) {
    norm[k.toLowerCase()] = v;
  }

  const buckets: QuotaBucket[] = [];

  // 1. Primary window
  const primaryUsed = findHeader(
    norm,
    'x-codex-primary-used-percent',
    'primary-used-percent',
    'used-percent'
  );
  if (primaryUsed !== undefined) {
    const pct = parseCodexPercent(primaryUsed);
    const rawResetAt = findHeader(
      norm,
      'x-codex-primary-reset-at',
      'primary-reset-at',
      'reset-at'
    );
    const rawResetAfter = findHeader(
      norm,
      'x-codex-primary-reset-after-seconds',
      'primary-reset-after-seconds',
      'reset-after-seconds'
    );
    let resetsAt: string | null = parseResetEpochOrIso(rawResetAt, now);
    if (!resetsAt && rawResetAfter && /^\d+$/.test(rawResetAfter)) {
      resetsAt = new Date(now + parseInt(rawResetAfter, 10) * 1000).toISOString();
    }

    const rawMinutes = findHeader(
      norm,
      'x-codex-primary-window-minutes',
      'primary-window-minutes',
      'window-minutes'
    );
    const minutes = rawMinutes && /^\d+$/.test(rawMinutes) ? parseInt(rawMinutes, 10) : undefined;
    const seconds = minutes ? minutes * 60 : undefined;
    const windowType: QuotaWindowType = seconds && seconds >= 6 * 86400 ? 'weekly_7d' : 'session_5h';
    const label = codexWindowLabel(seconds, 'Codex · 5h');

    buckets.push(makeBucket('primary', label, windowType, pct, resetsAt));
  }

  // 2. Secondary window
  const secUsed = findHeader(
    norm,
    'x-codex-secondary-used-percent',
    'secondary-used-percent'
  );
  if (secUsed !== undefined) {
    const pct = parseCodexPercent(secUsed);
    const rawResetAt = findHeader(
      norm,
      'x-codex-secondary-reset-at',
      'secondary-reset-at'
    );
    const rawResetAfter = findHeader(
      norm,
      'x-codex-secondary-reset-after-seconds',
      'secondary-reset-after-seconds'
    );
    let resetsAt: string | null = parseResetEpochOrIso(rawResetAt, now);
    if (!resetsAt && rawResetAfter && /^\d+$/.test(rawResetAfter)) {
      resetsAt = new Date(now + parseInt(rawResetAfter, 10) * 1000).toISOString();
    }

    const rawMinutes = findHeader(
      norm,
      'x-codex-secondary-window-minutes',
      'secondary-window-minutes'
    );
    const minutes = rawMinutes && /^\d+$/.test(rawMinutes) ? parseInt(rawMinutes, 10) : undefined;
    const seconds = minutes ? minutes * 60 : 7 * 86400;
    const windowType: QuotaWindowType = seconds && seconds >= 6 * 86400 ? 'weekly_7d' : 'session_5h';
    const label = codexWindowLabel(seconds, 'Codex · Weekly');

    buckets.push(makeBucket('secondary', label, windowType, pct, resetsAt));
  }

  // 3. Code review window
  const crUsed = findHeader(
    norm,
    'x-codex-code-review-primary-used-percent',
    'x-codex-code-review-used-percent'
  );
  if (crUsed !== undefined) {
    const pct = parseCodexPercent(crUsed);
    const rawResetAt = findHeader(
      norm,
      'x-codex-code-review-primary-reset-at',
      'x-codex-code-review-reset-at'
    );
    const resetsAt = parseResetEpochOrIso(rawResetAt, now);
    buckets.push(makeBucket('code_review', 'Code Review', 'session_5h', pct, resetsAt));
  }

  return buckets;
}
