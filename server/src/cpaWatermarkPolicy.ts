import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { WatermarkPolicyConfig } from './cpaWatermarkEngine';

/**
 * Classification rule defining glob pattern matching on account credentials or CPA names,
 * assigning provider, tier, modality, and managed status.
 */
export interface ClassificationRule {
  pattern: string;
  provider: string;
  tier: 'pro' | 'non_pro';
  modality: 'subscription_pool' | 'budgeted_allowance' | 'direct_api';
  managed: boolean;
}

/**
 * Complete Watermark Policy configuration including operational mode, thresholds,
 * intervals, dwell durations, and pattern classification rules.
 */
export interface FullWatermarkPolicy extends WatermarkPolicyConfig {
  mode: 'off' | 'shadow' | 'enforce';
  intervalSec: number;
  applyLatencySec: number;
  burnRateMax: number;
  pro: {
    drainPct: number;
    drainRecoveryPct: number;
    hardStopPct: number;
    hardStopRecoveryPct: number;
    fallbackMinDwellSec: number;
    recoveryDwellSec: number;
  };
  nonPro: {
    drainPct: number;
    drainRecoveryPct: number;
    hardStopPct: number;
    hardStopRecoveryPct: number;
  };
  classificationRules: ClassificationRule[];
}

/**
 * Safe default watermark policy defaulting to 'shadow' mode.
 */
export const DEFAULT_WATERMARK_POLICY: FullWatermarkPolicy = {
  mode: 'shadow',
  intervalSec: 60,
  applyLatencySec: 5,
  burnRateMax: 15,
  pro: {
    drainPct: 20,
    drainRecoveryPct: 24,
    hardStopPct: 5,
    hardStopRecoveryPct: 8,
    fallbackMinDwellSec: 600,
    recoveryDwellSec: 600,
  },
  nonPro: {
    drainPct: 40,
    drainRecoveryPct: 44,
    hardStopPct: 2,
    hardStopRecoveryPct: 5,
  },
  classificationRules: [],
};

export interface AccountClassification {
  provider: string;
  tier: 'pro' | 'non_pro';
  modality: 'subscription_pool' | 'budgeted_allowance' | 'direct_api';
  managed: boolean;
}

export const DEFAULT_ACCOUNT_CLASSIFICATION: AccountClassification = {
  provider: 'unknown',
  tier: 'pro',
  modality: 'subscription_pool',
  managed: false,
};

/**
 * Converts a simple glob pattern containing '*' and '?' into a regular expression.
 */
function globToRegExp(pattern: string): RegExp {
  let escaped = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      escaped += '.*';
    } else if (char === '?') {
      escaped += '.';
    } else if ('\\.+^$()|[]{}!'.includes(char)) {
      escaped += `\\${char}`;
    } else {
      escaped += char;
    }
  }
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Match a string against a glob pattern supporting `*` and `?`.
 */
export function matchGlob(pattern: string, input: string): boolean {
  return globToRegExp(pattern).test(input);
}

/**
 * Classifies an account filename or CPA identifier against classification rules.
 * Uses first-match semantics. If no rule matches, returns safe defaults.
 */
export function classifyAccount(
  authFilenameOrCpaName: string,
  rules: ClassificationRule[] = []
): AccountClassification {
  for (const rule of rules) {
    if (matchGlob(rule.pattern, authFilenameOrCpaName)) {
      return {
        provider: rule.provider,
        tier: rule.tier,
        modality: rule.modality,
        managed: rule.managed,
      };
    }
  }
  return { ...DEFAULT_ACCOUNT_CLASSIFICATION };
}

export interface PolicyValidationSuccess {
  ok: true;
  policy: FullWatermarkPolicy;
  warnings?: string[];
}

export interface PolicyValidationFailure {
  ok: false;
  errors: string[];
}

export type PolicyValidationResult = PolicyValidationSuccess | PolicyValidationFailure;

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function getProp(obj: Record<string, unknown>, camelKey: string, snakeKey: string): unknown {
  return obj[camelKey] !== undefined ? obj[camelKey] : obj[snakeKey];
}

/**
 * Validates raw object structure against FullWatermarkPolicy schema and invariants.
 * Supports both camelCase and snake_case keys for YAML friendliness.
 */
export function validateWatermarkPolicy(raw: unknown): PolicyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: ['Policy configuration must be a non-null object'] };
  }

  // 1. Mode check
  const rawMode = raw.mode !== undefined ? raw.mode : 'shadow';
  if (rawMode !== 'off' && rawMode !== 'shadow' && rawMode !== 'enforce') {
    errors.push(`Invalid mode '${String(rawMode)}': must be 'off', 'shadow', or 'enforce'`);
  }
  const mode = (errors.length === 0 ? rawMode : 'shadow') as 'off' | 'shadow' | 'enforce';

  // Read nested sections or flat properties
  const thresholds = isObject(raw.thresholds) ? raw.thresholds : {};
  const proObj = isObject(raw.pro) ? raw.pro : thresholds;
  const nonProObj = isObject(raw.nonPro)
    ? raw.nonPro
    : isObject(raw.non_pro)
    ? raw.non_pro
    : thresholds;
  const intervals = isObject(raw.intervals) ? raw.intervals : {};
  const dwell = isObject(raw.dwell) ? raw.dwell : {};

  // Numeric helper
  const readNumber = (
    camelName: string,
    snakeName: string,
    defaultValue: number,
    sourceObj: Record<string, unknown> = raw
  ): number => {
    // Check nested source first, then root
    const val = getProp(sourceObj, camelName, snakeName) !== undefined
      ? getProp(sourceObj, camelName, snakeName)
      : getProp(raw, camelName, snakeName);

    if (val === undefined || val === null) {
      return defaultValue;
    }
    const n = Number(val);
    if (typeof val !== 'number' || Number.isNaN(n)) {
      errors.push(`Property '${camelName}' must be a valid number, got ${typeof val}`);
      return defaultValue;
    }
    return n;
  };

  const proDrainPct = readNumber(
    'drainPct',
    'drain_pct',
    readNumber('proDrainPct', 'pro_drain_pct', DEFAULT_WATERMARK_POLICY.pro.drainPct, proObj),
    proObj
  );
  const proDrainRecoveryPct = readNumber(
    'drainRecoveryPct',
    'drain_recovery_pct',
    readNumber('proDrainRecoveryPct', 'pro_drain_recovery_pct', DEFAULT_WATERMARK_POLICY.pro.drainRecoveryPct, proObj),
    proObj
  );
  const proHardStopPct = readNumber(
    'hardStopPct',
    'hard_stop_pct',
    readNumber('proHardStopPct', 'pro_hard_stop_pct', DEFAULT_WATERMARK_POLICY.pro.hardStopPct, proObj),
    proObj
  );
  const proHardStopRecoveryPct = readNumber(
    'hardStopRecoveryPct',
    'hard_stop_recovery_pct',
    readNumber('proHardStopRecoveryPct', 'pro_hard_stop_recovery_pct', DEFAULT_WATERMARK_POLICY.pro.hardStopRecoveryPct, proObj),
    proObj
  );

  const nonProDrainPct = readNumber(
    'drainPct',
    'drain_pct',
    readNumber('nonProDrainPct', 'non_pro_drain_pct', DEFAULT_WATERMARK_POLICY.nonPro.drainPct, nonProObj),
    nonProObj
  );
  const nonProDrainRecoveryPct = readNumber(
    'drainRecoveryPct',
    'drain_recovery_pct',
    readNumber('nonProDrainRecoveryPct', 'non_pro_drain_recovery_pct', DEFAULT_WATERMARK_POLICY.nonPro.drainRecoveryPct, nonProObj),
    nonProObj
  );
  const nonProHardStopPct = readNumber(
    'hardStopPct',
    'hard_stop_pct',
    readNumber('nonProHardStopPct', 'non_pro_hard_stop_pct', DEFAULT_WATERMARK_POLICY.nonPro.hardStopPct, nonProObj),
    nonProObj
  );
  const nonProHardStopRecoveryPct = readNumber(
    'hardStopRecoveryPct',
    'hard_stop_recovery_pct',
    readNumber('nonProHardStopRecoveryPct', 'non_pro_hard_stop_recovery_pct', DEFAULT_WATERMARK_POLICY.nonPro.hardStopRecoveryPct, nonProObj),
    nonProObj
  );

  const burnRateMax = readNumber('burnRateMax', 'burn_rate_max', DEFAULT_WATERMARK_POLICY.burnRateMax, intervals);
  const intervalSec = readNumber('intervalSec', 'interval_sec', DEFAULT_WATERMARK_POLICY.intervalSec, intervals);
  const applyLatencySec = readNumber('applyLatencySec', 'apply_latency_sec', DEFAULT_WATERMARK_POLICY.applyLatencySec, intervals);
  const fallbackMinDwellSec = readNumber(
    'fallbackMinDwellSec',
    'fallback_min_dwell_sec',
    readNumber('fallbackMinDwellSec', 'fallback_min_dwell_sec', DEFAULT_WATERMARK_POLICY.pro.fallbackMinDwellSec, proObj),
    dwell
  );
  const recoveryDwellSec = readNumber(
    'recoveryDwellSec',
    'recovery_dwell_sec',
    readNumber('recoveryDwellSec', 'recovery_dwell_sec', DEFAULT_WATERMARK_POLICY.pro.recoveryDwellSec, proObj),
    dwell
  );

  // 2. Percentage bounds [0, 100]
  const pctValues: [string, number][] = [
    ['proDrainPct', proDrainPct],
    ['proDrainRecoveryPct', proDrainRecoveryPct],
    ['proHardStopPct', proHardStopPct],
    ['proHardStopRecoveryPct', proHardStopRecoveryPct],
    ['nonProDrainPct', nonProDrainPct],
    ['nonProDrainRecoveryPct', nonProDrainRecoveryPct],
    ['nonProHardStopPct', nonProHardStopPct],
    ['nonProHardStopRecoveryPct', nonProHardStopRecoveryPct],
  ];
  for (const [name, val] of pctValues) {
    if (val < 0 || val > 100) {
      errors.push(`Percentage '${name}' must be between 0 and 100, got ${val}`);
    }
  }

  // 3. Percentage sanity checks: hardStop < drain and recovery > threshold
  if (proHardStopPct >= proDrainPct) {
    errors.push(`proHardStopPct (${proHardStopPct}) must be strictly less than proDrainPct (${proDrainPct})`);
  }
  if (proDrainRecoveryPct <= proDrainPct) {
    errors.push(
      `proDrainRecoveryPct (${proDrainRecoveryPct}) must be strictly greater than proDrainPct (${proDrainPct})`
    );
  }
  if (proHardStopRecoveryPct <= proHardStopPct) {
    errors.push(
      `proHardStopRecoveryPct (${proHardStopRecoveryPct}) must be strictly greater than proHardStopPct (${proHardStopPct})`
    );
  }
  if (proHardStopRecoveryPct >= proDrainPct) {
    errors.push(
      `proHardStopRecoveryPct (${proHardStopRecoveryPct}) must be strictly less than proDrainPct (${proDrainPct})`
    );
  }

  if (nonProHardStopPct >= nonProDrainPct) {
    errors.push(
      `nonProHardStopPct (${nonProHardStopPct}) must be strictly less than nonProDrainPct (${nonProDrainPct})`
    );
  }
  if (nonProDrainRecoveryPct <= nonProDrainPct) {
    errors.push(
      `nonProDrainRecoveryPct (${nonProDrainRecoveryPct}) must be strictly greater than nonProDrainPct (${nonProDrainPct})`
    );
  }
  if (nonProHardStopRecoveryPct <= nonProHardStopPct) {
    errors.push(
      `nonProHardStopRecoveryPct (${nonProHardStopRecoveryPct}) must be strictly greater than nonProHardStopPct (${nonProHardStopPct})`
    );
  }
  if (nonProHardStopRecoveryPct >= nonProDrainPct) {
    errors.push(
      `nonProHardStopRecoveryPct (${nonProHardStopRecoveryPct}) must be strictly less than nonProDrainPct (${nonProDrainPct})`
    );
  }

  // 4. Non-negative dwell and interval checks
  const nonNegatives: [string, number][] = [
    ['burnRateMax', burnRateMax],
    ['intervalSec', intervalSec],
    ['applyLatencySec', applyLatencySec],
    ['fallbackMinDwellSec', fallbackMinDwellSec],
    ['recoveryDwellSec', recoveryDwellSec],
  ];
  for (const [name, val] of nonNegatives) {
    if (val < 0) {
      errors.push(`Duration/rate '${name}' must be non-negative, got ${val}`);
    }
  }

  // 5. Classification rules validation
  const rawRules = getProp(raw, 'classificationRules', 'classification_rules');
  const classificationRules: ClassificationRule[] = [];
  if (rawRules !== undefined) {
    if (!Array.isArray(rawRules)) {
      errors.push(`classificationRules must be an array, got ${typeof rawRules}`);
    } else {
      for (let idx = 0; idx < rawRules.length; idx++) {
        const item = rawRules[idx];
        if (!isObject(item)) {
          errors.push(`Classification rule at index ${idx} must be an object`);
          continue;
        }
        const pattern = String(item.pattern || '').trim();
        if (!pattern) {
          errors.push(`Classification rule at index ${idx} missing non-empty pattern`);
        }
        const provider = String(item.provider || '').trim();
        if (!provider) {
          errors.push(`Classification rule at index ${idx} missing non-empty provider`);
        }
        const tier = item.tier;
        if (tier !== 'pro' && tier !== 'non_pro') {
          errors.push(`Classification rule at index ${idx} tier must be 'pro' or 'non_pro', got '${String(tier)}'`);
        }
        const modality = item.modality;
        if (
          modality !== 'subscription_pool' &&
          modality !== 'budgeted_allowance' &&
          modality !== 'direct_api'
        ) {
          errors.push(
            `Classification rule at index ${idx} modality must be 'subscription_pool', 'budgeted_allowance', or 'direct_api', got '${String(modality)}'`
          );
        }
        const managed = typeof item.managed === 'boolean' ? item.managed : true;

        if (pattern && provider && (tier === 'pro' || tier === 'non_pro') && (modality === 'subscription_pool' || modality === 'budgeted_allowance' || modality === 'direct_api')) {
          classificationRules.push({
            pattern,
            provider,
            tier,
            modality,
            managed,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    warnings: warnings.length > 0 ? warnings : undefined,
    policy: {
      mode,
      intervalSec,
      applyLatencySec,
      burnRateMax,
      pro: {
        drainPct: proDrainPct,
        drainRecoveryPct: proDrainRecoveryPct,
        hardStopPct: proHardStopPct,
        hardStopRecoveryPct: proHardStopRecoveryPct,
        fallbackMinDwellSec,
        recoveryDwellSec,
      },
      nonPro: {
        drainPct: nonProDrainPct,
        drainRecoveryPct: nonProDrainRecoveryPct,
        hardStopPct: nonProHardStopPct,
        hardStopRecoveryPct: nonProHardStopRecoveryPct,
      },
      classificationRules,
    },
  };
}

export interface CpaPolicyLoaderOptions {
  customFilePath?: string;
  debounceMs?: number;
  onPolicyChange?: (newPolicy: FullWatermarkPolicy, oldPolicy: FullWatermarkPolicy) => void;
  onError?: (error: Error) => void;
}

/**
 * Policy loader and hot-reload watcher with SHA-256 change detection and safe shadow fallback.
 */
export class CpaPolicyLoader {
  private currentPolicy: FullWatermarkPolicy = { ...DEFAULT_WATERMARK_POLICY };
  private resolvedPath: string | null = null;
  private lastFileHash: string | null = null;
  private customFilePath?: string;
  private debounceMs: number;
  private onPolicyChange?: (newPolicy: FullWatermarkPolicy, oldPolicy: FullWatermarkPolicy) => void;
  private onError?: (error: Error) => void;
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(options: CpaPolicyLoaderOptions = {}) {
    this.customFilePath = options.customFilePath;
    this.debounceMs = options.debounceMs ?? 150;
    this.onPolicyChange = options.onPolicyChange;
    this.onError = options.onError;
  }

  /**
   * Search candidates in priority order:
   * 1. customFilePath (constructor option)
   * 2. CPA_WATERMARK_POLICY_FILE (environment variable)
   * 3. /app/config/policy.yaml
   * 4. /opt/agentic-services/tracker/watermark-policy.yaml
   * 5. ./watermark-policy.yaml
   */
  public resolveCandidatePaths(): string[] {
    const list: string[] = [];
    if (this.customFilePath) {
      list.push(this.customFilePath);
    }
    const envPath = process.env.CPA_WATERMARK_POLICY_FILE;
    if (envPath) {
      list.push(envPath);
    }
    list.push('/app/config/policy.yaml');
    list.push('/opt/agentic-services/tracker/watermark-policy.yaml');
    list.push(path.resolve(process.cwd(), 'watermark-policy.yaml'));
    return list;
  }

  /**
   * Resolves the first existing file path among candidates.
   */
  public resolvePolicyFile(): string | null {
    const candidates = this.resolveCandidatePaths();
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            return candidate;
          }
        } catch {
          // Ignore unreadable paths and continue search
        }
      }
    }
    return null;
  }

  /**
   * Computes SHA-256 hash of a string content.
   */
  public computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Current active policy.
   */
  public getPolicy(): FullWatermarkPolicy {
    return { ...this.currentPolicy };
  }

  /**
   * Currently resolved file path, or null if no policy file was found.
   */
  public getResolvedPath(): string | null {
    return this.resolvedPath;
  }

  /**
   * Current file content SHA-256 hash.
   */
  public getLastFileHash(): string | null {
    return this.lastFileHash;
  }

  /**
   * Loads the watermark policy from file or falls back to shadow defaults.
   * On validation failure, falls back safely to shadow mode without crashing.
   */
  public loadPolicy(): FullWatermarkPolicy {
    const filePath = this.resolvePolicyFile();
    this.resolvedPath = filePath;

    if (!filePath) {
      this.currentPolicy = { ...DEFAULT_WATERMARK_POLICY };
      this.lastFileHash = null;
      return this.getPolicy();
    }

    try {
      const rawContent = fs.readFileSync(filePath, 'utf8');
      const hash = this.computeHash(rawContent);

      let parsed: unknown;
      try {
        parsed = yaml.parse(rawContent);
      } catch (parseErr) {
        const err = new Error(
          `Failed to parse YAML policy at ${filePath}: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`
        );
        this.emitError(err);
        this.currentPolicy = { ...DEFAULT_WATERMARK_POLICY, mode: 'shadow' };
        this.lastFileHash = hash;
        return this.getPolicy();
      }

      const validation = validateWatermarkPolicy(parsed);
      if (!validation.ok) {
        const err = new Error(
          `Policy validation failed at ${filePath}:\n${validation.errors.join('\n')}`
        );
        this.emitError(err);
        this.currentPolicy = { ...DEFAULT_WATERMARK_POLICY, mode: 'shadow' };
        this.lastFileHash = hash;
        return this.getPolicy();
      }

      this.currentPolicy = validation.policy;
      this.lastFileHash = hash;
      return this.getPolicy();
    } catch (readErr) {
      const err = new Error(
        `Failed to read policy file at ${filePath}: ${
          readErr instanceof Error ? readErr.message : String(readErr)
        }`
      );
      this.emitError(err);
      this.currentPolicy = { ...DEFAULT_WATERMARK_POLICY, mode: 'shadow' };
      return this.getPolicy();
    }
  }

  private emitError(err: Error): void {
    if (this.onError) {
      try {
        this.onError(err);
      } catch {
        // Prevent onError callback exceptions from crashing the process
      }
    }
  }

  /**
   * Reload handler invoked when file change is detected.
   */
  private handleFileChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.resolvedPath || !fs.existsSync(this.resolvedPath)) {
        // File may have been deleted or moved
        const newlyResolved = this.resolvePolicyFile();
        if (newlyResolved !== this.resolvedPath) {
          const oldPolicy = this.currentPolicy;
          this.loadPolicy();
          if (this.onPolicyChange) {
            this.onPolicyChange(this.getPolicy(), oldPolicy);
          }
        }
        return;
      }

      try {
        const content = fs.readFileSync(this.resolvedPath, 'utf8');
        const hash = this.computeHash(content);
        if (hash === this.lastFileHash) {
          // File content unchanged (spurious notification)
          return;
        }

        const oldPolicy = this.currentPolicy;
        this.loadPolicy();
        if (this.onPolicyChange) {
          this.onPolicyChange(this.getPolicy(), oldPolicy);
        }
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }, this.debounceMs);
  }

  /**
   * Starts hot-reload file watching on resolvedPolicyFile (or candidate directory).
   */
  public startWatcher(): void {
    this.stopWatcher();

    const filePath = this.resolvedPath || this.resolvePolicyFile();
    if (!filePath) {
      return;
    }

    try {
      this.watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          this.handleFileChange();
        }
      });
      this.watcher.on('error', (err) => {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Stops the hot-reload watcher.
   */
  public stopWatcher(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Ignore watcher close error
      }
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
