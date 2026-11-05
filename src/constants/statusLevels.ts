/**
 * Default quota levels that decide when an account counts as tight or exhausted.
 *
 * These are the built-in defaults of the watermark policy (policy.yaml):
 * tight = drainPct, exhausted = hardStopPct. Routing, account status, bar colours
 * and Telegram alerts all read the same numbers, so a policy file that overrides
 * them changes every one of those together. Nothing else should hardcode a threshold.
 */
export interface StatusLevels {
  /** At or below this remaining %, the account is tight (policy drainPct). */
  tightPct: number;
  /** At or below this remaining %, the account is exhausted (policy hardStopPct). */
  exhaustedPct: number;
}

export interface TieredStatusLevels {
  pro: StatusLevels;
  nonPro: StatusLevels;
}

export const DEFAULT_STATUS_LEVELS: TieredStatusLevels = {
  pro: { tightPct: 20, exhaustedPct: 2 },
  nonPro: { tightPct: 40, exhaustedPct: 5 },
};

/** Levels for one account tier; accounts with no known tier use the Pro levels. */
export function levelsForTier(levels: TieredStatusLevels, tier?: 'pro' | 'non_pro' | null): StatusLevels {
  return tier === 'non_pro' ? levels.nonPro : levels.pro;
}
