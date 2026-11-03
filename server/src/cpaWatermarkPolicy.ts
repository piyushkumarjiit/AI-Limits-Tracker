import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { WatermarkPolicyConfig } from './cpaWatermarkEngine';

/**
 * Maximum allowed YAML policy file size in bytes (256 KB) to prevent DoS.
 */
export const MAX_POLICY_FILE_SIZE = 256 * 1024;

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

  // Numeric helper with finite number validation (H2)
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
    if (typeof val !== 'number' || !Number.isFinite(n) || Number.isNaN(n)) {
      errors.push(`Property '${camelName}' must be a valid finite number, got ${typeof val === 'number' ? val : typeof val}`);
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

  // 4. Interval and dwell checks (H2: intervalSec > 0 and <= 86400)
  if (intervalSec <= 0 || intervalSec > 86400) {
    errors.push(`intervalSec must be strictly positive and at most 86400 seconds (24h), got ${intervalSec}`);
  }
  const nonNegatives: [string, number][] = [
    ['burnRateMax', burnRateMax],
    ['applyLatencySec', applyLatencySec],
    ['fallbackMinDwellSec', fallbackMinDwellSec],
    ['recoveryDwellSec', recoveryDwellSec],
  ];
  for (const [name, val] of nonNegatives) {
    if (val < 0) {
      errors.push(`Duration/rate '${name}' must be non-negative, got ${val}`);
    }
  }

  // 5. Classification rules validation (B4: strict boolean check and default false)
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
        if (typeof item.pattern !== 'string' || !item.pattern.trim()) {
          errors.push(`Classification rule at index ${idx} pattern must be a non-empty string`);
        }
        if (typeof item.provider !== 'string' || !item.provider.trim()) {
          errors.push(`Classification rule at index ${idx} provider must be a non-empty string`);
        }
        const pattern = typeof item.pattern === 'string' ? item.pattern.trim() : '';
        const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
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

        // B4: Rule-level managed defaults (fail-safe false; reject non-boolean types)
        let managed = false;
        if (item.managed === undefined) {
          managed = false;
        } else if (typeof item.managed === 'boolean') {
          managed = item.managed;
        } else {
          errors.push(
            `Classification rule at index ${idx} 'managed' must be a boolean (true/false), got ${typeof item.managed}`
          );
        }

        if (
          typeof item.pattern === 'string' &&
          typeof item.provider === 'string' &&
          pattern &&
          provider &&
          (tier === 'pro' || tier === 'non_pro') &&
          (modality === 'subscription_pool' || modality === 'budgeted_allowance' || modality === 'direct_api') &&
          typeof managed === 'boolean'
        ) {
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
  pollIntervalMs?: number;
  onPolicyChange?: (newPolicy: FullWatermarkPolicy, oldPolicy: FullWatermarkPolicy) => void;
  onError?: (error: Error) => void;
}

/**
 * Policy loader and hot-reload watcher with SHA-256 change detection,
 * directory-level watching for atomic renames, polling fallback, and safe shadow fallback.
 */
export class CpaPolicyLoader {
  private currentPolicy: FullWatermarkPolicy = structuredClone(DEFAULT_WATERMARK_POLICY);
  private resolvedPath: string | null = null;
  private lastFileHash: string | null = null;
  private lastErrorSignature: string | null = null;
  private customFilePath?: string;
  private debounceMs: number;
  private pollIntervalMs: number;
  private onPolicyChange?: (newPolicy: FullWatermarkPolicy, oldPolicy: FullWatermarkPolicy) => void;
  private onError?: (error: Error) => void;
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(options: CpaPolicyLoaderOptions = {}) {
    this.customFilePath = options.customFilePath;
    this.debounceMs = options.debounceMs ?? 150;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
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

  private errorSignature(err: any): string {
    return `err:${err?.code || err?.message || String(err)}`;
  }

  /**
   * Current active policy (deep clone to prevent mutation of internal state).
   */
  public getPolicy(): FullWatermarkPolicy {
    return structuredClone(this.currentPolicy);
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
   * On validation failure or file cap excess, falls back safely to shadow mode without crashing.
   */
  public loadPolicy(): FullWatermarkPolicy {
    const filePath = this.resolvePolicyFile();
    this.resolvedPath = filePath;

    if (!filePath) {
      this.currentPolicy = structuredClone(DEFAULT_WATERMARK_POLICY);
      this.lastFileHash = null;
      return this.getPolicy();
    }

    try {
      // M2: Cap file size at 256 KB
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_POLICY_FILE_SIZE) {
        const oversizeSentinel = `oversize:${stat.size}:${stat.mtimeMs}`;
        const err = new Error(
          `Policy file at ${filePath} exceeds maximum allowed size of 256 KB (${stat.size} bytes)`
        );
        this.emitError(err, oversizeSentinel);
        this.currentPolicy = structuredClone(DEFAULT_WATERMARK_POLICY);
        this.currentPolicy.mode = 'shadow';
        this.lastFileHash = oversizeSentinel;
        return this.getPolicy();
      }

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
        this.emitError(err, `yaml_parse:${hash}`);
        this.currentPolicy = structuredClone(DEFAULT_WATERMARK_POLICY);
        this.currentPolicy.mode = 'shadow';
        this.lastFileHash = hash;
        return this.getPolicy();
      }

      const validation = validateWatermarkPolicy(parsed);
      if (!validation.ok) {
        const err = new Error(
          `Policy validation failed at ${filePath}:\n${validation.errors.join('\n')}`
        );
        this.emitError(err, `validation:${hash}`);
        this.currentPolicy = structuredClone(DEFAULT_WATERMARK_POLICY);
        this.currentPolicy.mode = 'shadow';
        this.lastFileHash = hash;
        return this.getPolicy();
      }

      this.currentPolicy = validation.policy;
      this.lastFileHash = hash;
      this.lastErrorSignature = null;
      return this.getPolicy();
    } catch (readErr) {
      // M3: Set this.lastFileHash = null on read error
      this.lastFileHash = null;
      const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
      const err = new Error(
        `Failed to read policy file at ${filePath}: ${errMsg}`
      );
      this.emitError(err, this.errorSignature(readErr));
      this.currentPolicy = structuredClone(DEFAULT_WATERMARK_POLICY);
      this.currentPolicy.mode = 'shadow';
      return this.getPolicy();
    }
  }

  public emitError(err: Error, signature?: string): void {
    if (signature) {
      if (this.lastErrorSignature === signature) {
        return;
      }
      this.lastErrorSignature = signature;
    }
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
   * Debounces notifications and handles atomic replaces (B2 & B3).
   */
  public handleFileChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // B3: Wrap entire debounce execution in try/catch to protect Node process
      try {
        if (!this.resolvedPath || !fs.existsSync(this.resolvedPath)) {
          // File may have been deleted, replaced atomically, or moved
          const newlyResolved = this.resolvePolicyFile();
          if (newlyResolved !== this.resolvedPath || (newlyResolved && fs.existsSync(newlyResolved))) {
            const oldPolicy = structuredClone(this.currentPolicy);
            this.loadPolicy();
            this.notifyChange(this.getPolicy(), oldPolicy);
          }
          return;
        }

        const stat = fs.statSync(this.resolvedPath);
        const oversizeSentinel = `oversize:${stat.size}:${stat.mtimeMs}`;
        if (stat.size > MAX_POLICY_FILE_SIZE) {
          if (this.lastFileHash !== oversizeSentinel) {
            const oldPolicy = structuredClone(this.currentPolicy);
            this.loadPolicy();
            this.notifyChange(this.getPolicy(), oldPolicy);
          }
          return;
        }

        const content = fs.readFileSync(this.resolvedPath, 'utf8');
        const hash = this.computeHash(content);
        if (hash === this.lastFileHash) {
          // Content unchanged (spurious notification)
          return;
        }

        const oldPolicy = structuredClone(this.currentPolicy);
        this.loadPolicy();
        this.notifyChange(this.getPolicy(), oldPolicy);
        this.lastErrorSignature = null;
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)), this.errorSignature(err));
      }
    }, this.debounceMs);
  }

  private notifyChange(newPolicy: FullWatermarkPolicy, oldPolicy: FullWatermarkPolicy): void {
    if (JSON.stringify(newPolicy) === JSON.stringify(oldPolicy)) {
      return;
    }
    if (this.onPolicyChange) {
      try {
        this.onPolicyChange(newPolicy, oldPolicy);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Checks policy file directly for changes (used by periodic polling fallback).
   */
  public checkFileForChanges(): void {
    try {
      const targetPath = this.resolvedPath || this.resolvePolicyFile();
      if (!targetPath) {
        if (this.lastFileHash !== null) {
          this.handleFileChange();
        }
        return;
      }

      if (!fs.existsSync(targetPath)) {
        if (this.lastFileHash !== null) {
          this.handleFileChange();
        }
        return;
      }

      // Check stat first before reading into memory (R2-B2)
      const stat = fs.statSync(targetPath);
      const oversizeSentinel = `oversize:${stat.size}:${stat.mtimeMs}`;
      if (stat.size > MAX_POLICY_FILE_SIZE) {
        if (this.lastFileHash !== oversizeSentinel) {
          this.handleFileChange();
        }
        return;
      }

      const content = fs.readFileSync(targetPath, 'utf8');
      const hash = this.computeHash(content);
      if (hash !== this.lastFileHash) {
        this.handleFileChange();
      }
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)), this.errorSignature(err));
    }
  }

  /**
   * Starts hot-reload file watching on directory of resolvedPolicyFile (B2)
   * with atomic replace resilience and periodic polling fallback.
   */
  public startWatcher(): void {
    this.stopWatcher();

    const filePath = this.resolvedPath || this.resolvePolicyFile();
    if (!filePath) {
      return;
    }

    const dir = path.dirname(filePath);
    const targetFile = path.basename(filePath);

    try {
      // B2: Watch parent directory to survive inode rebinding on atomic mv
      this.watcher = fs.watch(dir, (_eventType, filename) => {
        if (!filename || filename === targetFile) {
          this.handleFileChange();
        }
      });
      this.watcher.on('error', (err) => {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }

    // B2: Periodic polling fallback for Docker mounts / network storage
    if (this.pollIntervalMs > 0) {
      this.pollInterval = setInterval(() => {
        this.checkFileForChanges();
      }, this.pollIntervalMs);
    }
  }

  /**
   * Stops the hot-reload watcher and polling timer.
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
