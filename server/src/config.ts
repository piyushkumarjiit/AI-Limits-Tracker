/**
 * Startup secret validation. `index.ts` calls this before it touches the
 * database or opens a socket so a placeholder deployment fails loudly instead
 * of silently running with a guessable admin password or session secret.
 */

/** Values copied from the example files (or the usual weak choices) that must never ship. */
const PLACEHOLDER_PASSWORDS = new Set(['change-me', 'password', 'admin', 'changeme']);

/** Secrets shorter than this are refused outright. */
const MIN_SECRET_LENGTH = 16;
/** Secrets shorter than this start the server but log a warning. */
const RECOMMENDED_SECRET_LENGTH = 32;
/** Minimum length for an explicitly configured API_TOKEN. */
const MIN_API_TOKEN_LENGTH = 24;
/** Bounds for an explicitly configured SESSION_DAYS value. */
const MIN_SESSION_DAYS = 1;
const MAX_SESSION_DAYS = 365;

/** Bounds for CPA configuration */
const MIN_CPA_TIMEOUT_MS = 1000;
const MAX_CPA_TIMEOUT_MS = 60000;
const MIN_CPA_POLL_INTERVAL_SEC = 5;
const MAX_CPA_POLL_INTERVAL_SEC = 3600;

const HINT = 'Generate one with: openssl rand -hex 32';

const EMPTY_ADMIN_PASSWORD = `ADMIN_PASSWORD is empty. Set the web panel password. ${HINT}`;
const EMPTY_APP_SECRET = `APP_SECRET is empty. ${HINT}`;

export type Env = Record<string, string | undefined>;

export interface CpaResolvedConfig {
  baseUrl: string;
  managementKey: string;
  timeoutMs: number;
  pollIntervalSec: number;
}

function isLoopbackOrPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 || // Loopback
    a === 10 || // RFC1918 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // RFC1918 172.16.0.0/12
    (a === 192 && b === 168) // RFC1918 192.168.0.0/16
  );
}

function isLoopbackIPv6(host: string): boolean {
  return host === '::1' || host === '0:0:0:0:0:0:0:1';
}

function isAllowedHttpHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isLoopbackOrPrivateIPv4(h)) return true;
  if (isLoopbackIPv6(h)) return true;
  return false;
}

/**
 * Validates CPA configuration options.
 */
export function validateCpaConfig(env: Env): string[] {
  const errors: string[] = [];
  const rawBaseUrl = (env.CPA_BASE_URL ?? '').trim();
  const rawMgmtKey = (env.CPA_MANAGEMENT_KEY ?? '').trim();
  const rawTimeout = (env.CPA_TIMEOUT_MS ?? '').trim();
  const rawPollKey = env.CPA_SYNC_INTERVAL_SEC ? 'CPA_SYNC_INTERVAL_SEC' : 'CPA_POLL_INTERVAL_SEC';
  const rawPoll = (env.CPA_SYNC_INTERVAL_SEC ?? env.CPA_POLL_INTERVAL_SEC ?? '').trim();

  // If both base URL and management key are unset, CPA is disabled (valid)
  if (!rawBaseUrl && !rawMgmtKey) {
    if (rawTimeout) {
      errors.push('CPA_TIMEOUT_MS is configured but CPA_BASE_URL is not set.');
    }
    if (rawPoll) {
      errors.push(`${rawPollKey} is configured but CPA_BASE_URL is not set.`);
    }
    return errors;
  }

  if (rawBaseUrl && !rawMgmtKey) {
    errors.push('CPA_MANAGEMENT_KEY must be provided when CPA_BASE_URL is set.');
  }

  if (!rawBaseUrl && rawMgmtKey) {
    errors.push('CPA_BASE_URL must be provided when CPA_MANAGEMENT_KEY is set.');
  }

  if (rawBaseUrl) {
    try {
      const parsed = new URL(rawBaseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(`CPA_BASE_URL must use http: or https: protocol, got ${parsed.protocol}`);
      } else if (parsed.protocol === 'http:') {
        if (!isAllowedHttpHost(parsed.hostname)) {
          errors.push(
            `CPA_BASE_URL plain http: is only allowed for loopback or RFC1918 private network addresses (got ${parsed.hostname}). Use https: for public endpoints.`
          );
        }
      }
      if (parsed.username || parsed.password) {
        errors.push('CPA_BASE_URL must not contain credentials.');
      }
    } catch {
      errors.push(`CPA_BASE_URL is not a valid URL: ${JSON.stringify(rawBaseUrl)}`);
    }
  }

  if (rawTimeout) {
    if (!/^\d+$/.test(rawTimeout)) {
      errors.push(`CPA_TIMEOUT_MS must be a positive integer between ${MIN_CPA_TIMEOUT_MS} and ${MAX_CPA_TIMEOUT_MS}. Got ${JSON.stringify(rawTimeout)}.`);
    } else {
      const ms = Number(rawTimeout);
      if (ms < MIN_CPA_TIMEOUT_MS || ms > MAX_CPA_TIMEOUT_MS) {
        errors.push(`CPA_TIMEOUT_MS must be between ${MIN_CPA_TIMEOUT_MS} and ${MAX_CPA_TIMEOUT_MS}. Got ${ms}.`);
      }
    }
  }

  if (rawPoll) {
    if (!/^\d+$/.test(rawPoll)) {
      errors.push(`${rawPollKey} must be a positive integer between ${MIN_CPA_POLL_INTERVAL_SEC} and ${MAX_CPA_POLL_INTERVAL_SEC}. Got ${JSON.stringify(rawPoll)}.`);
    } else {
      const sec = Number(rawPoll);
      if (sec < MIN_CPA_POLL_INTERVAL_SEC || sec > MAX_CPA_POLL_INTERVAL_SEC) {
        errors.push(`${rawPollKey} must be between ${MIN_CPA_POLL_INTERVAL_SEC} and ${MAX_CPA_POLL_INTERVAL_SEC}. Got ${sec}.`);
      }
    }
  }

  return errors;
}

/**
 * Resolves CPA configuration or null if not enabled. Throws Error on validation error.
 */
export function resolveCpaConfig(env: Env): CpaResolvedConfig | null {
  const errors = validateCpaConfig(env);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  const rawBaseUrl = (env.CPA_BASE_URL ?? '').trim();
  const rawMgmtKey = (env.CPA_MANAGEMENT_KEY ?? '').trim();
  if (!rawBaseUrl || !rawMgmtKey) {
    return null;
  }

  let cleanBaseUrl = rawBaseUrl;
  while (cleanBaseUrl.endsWith('/')) {
    cleanBaseUrl = cleanBaseUrl.slice(0, -1);
  }

  let timeoutMs = 10000;
  if (env.CPA_TIMEOUT_MS?.trim()) {
    const parsed = Number(env.CPA_TIMEOUT_MS.trim());
    if (!Number.isNaN(parsed) && parsed >= 1000 && parsed <= 120000) {
      timeoutMs = parsed;
    }
  }
  const pollIntervalSec = (env.CPA_SYNC_INTERVAL_SEC ?? env.CPA_POLL_INTERVAL_SEC)?.trim()
    ? Number((env.CPA_SYNC_INTERVAL_SEC ?? env.CPA_POLL_INTERVAL_SEC)!.trim())
    : 60;

  return {
    baseUrl: cleanBaseUrl,
    managementKey: rawMgmtKey,
    timeoutMs,
    pollIntervalSec,
  };
}

function isPlaceholderPassword(value: string): boolean {
  const v = value.trim().toLowerCase();
  return PLACEHOLDER_PASSWORDS.has(v) || v.startsWith('change-me');
}

/** True when the value repeats the same character, or uses fewer than 8 distinct ones. */
function isLowEntropy(value: string): boolean {
  return new Set(value).size < 8;
}

/**
 * Problems that must stop startup even when `ALLOW_WEAK_SECRETS=1` is set: a
 * missing password or session secret and an out-of-range SESSION_DAYS can never
 * be downgraded to a warning.
 */
export function validateFatalConfig(env: Env): string[] {
  const fatal: string[] = [];
  if (!(env.ADMIN_PASSWORD ?? '')) fatal.push(EMPTY_ADMIN_PASSWORD);
  if (!(env.APP_SECRET ?? '')) fatal.push(EMPTY_APP_SECRET);
  const sessionDays = sessionDaysProblem(env);
  if (sessionDays) fatal.push(sessionDays);
  const cpaErrors = validateCpaConfig(env);
  fatal.push(...cpaErrors);
  return fatal;
}

/**
 * Problem with an explicitly configured SESSION_DAYS, or null when it is absent or
 * a whole number of days between 1 and 365.
 */
export function sessionDaysProblem(env: Env): string | null {
  const raw = (env.SESSION_DAYS ?? '').trim();
  if (!raw) return null;
  const hint = `SESSION_DAYS must be a whole number of days between ${MIN_SESSION_DAYS} and ${MAX_SESSION_DAYS}.`;
  if (!/^\d+$/.test(raw)) return `${hint} Got ${JSON.stringify(raw)}.`;
  const days = Number(raw);
  if (days < MIN_SESSION_DAYS || days > MAX_SESSION_DAYS) return `${hint} Got ${raw}.`;
  return null;
}

/**
 * Session lifetime in days: SESSION_DAYS when it is valid, otherwise a fatal
 * configuration problem. `index.ts` validates before this is called.
 */
export function resolveSessionDays(env: Env, fallback: number): number {
  const problem = sessionDaysProblem(env);
  if (problem) throw new Error(problem);
  const raw = (env.SESSION_DAYS ?? '').trim();
  return raw ? Number(raw) : fallback;
}

/**
 * Every problem that must stop startup. `ALLOW_WEAK_SECRETS=1` downgrades these
 * to warnings for operators who know what they are doing, except the problems
 * reported by `validateFatalConfig` (empty secrets, invalid SESSION_DAYS), which
 * stay fatal.
 */
export function validateConfig(env: Env): string[] {
  const errors: string[] = [];
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  const appSecret = env.APP_SECRET ?? '';
  const apiToken = env.API_TOKEN ?? '';

  if (!adminPassword) {
    errors.push(EMPTY_ADMIN_PASSWORD);
  } else if (isPlaceholderPassword(adminPassword)) {
    errors.push(`ADMIN_PASSWORD is a known placeholder. Choose a unique password. ${HINT}`);
  }

  if (!appSecret) {
    errors.push(EMPTY_APP_SECRET);
  } else if (appSecret.trim().toLowerCase().startsWith('change-me')) {
    errors.push(`APP_SECRET is still the placeholder from the example file. ${HINT}`);
  } else if (appSecret.length < MIN_SECRET_LENGTH) {
    errors.push(`APP_SECRET must be at least ${MIN_SECRET_LENGTH} characters. ${HINT}`);
  } else if (isLowEntropy(appSecret)) {
    errors.push(`APP_SECRET is too predictable (use at least 8 distinct characters, not a repeated one). ${HINT}`);
  }

  if (apiToken && apiToken.length < MIN_API_TOKEN_LENGTH) {
    errors.push(`API_TOKEN must be at least ${MIN_API_TOKEN_LENGTH} characters. ${HINT}`);
  }

  const sessionDays = sessionDaysProblem(env);
  if (sessionDays) errors.push(sessionDays);

  const cpaErrors = validateCpaConfig(env);
  errors.push(...cpaErrors);

  return errors;
}

/**
 * Non-fatal problems: a secret that is fine but short enough to be worth
 * flagging. Existing deployments with 16–31 character secrets keep starting.
 */
export function validateConfigWarnings(env: Env): string[] {
  const warnings: string[] = [];
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  const appSecret = env.APP_SECRET ?? '';
  const apiToken = env.API_TOKEN ?? '';

  if (adminPassword && adminPassword.length < RECOMMENDED_SECRET_LENGTH && !isPlaceholderPassword(adminPassword)) {
    warnings.push(`ADMIN_PASSWORD is shorter than ${RECOMMENDED_SECRET_LENGTH} characters; consider a longer one.`);
  }
  if (
    appSecret &&
    appSecret.length >= MIN_SECRET_LENGTH &&
    appSecret.length < RECOMMENDED_SECRET_LENGTH &&
    !appSecret.trim().toLowerCase().startsWith('change-me')
  ) {
    warnings.push(`APP_SECRET is shorter than ${RECOMMENDED_SECRET_LENGTH} characters; ${HINT}`);
  }
  if (apiToken && apiToken.length >= MIN_API_TOKEN_LENGTH && apiToken.length < RECOMMENDED_SECRET_LENGTH) {
    warnings.push(`API_TOKEN is shorter than ${RECOMMENDED_SECRET_LENGTH} characters; ${HINT}`);
  }

  return warnings;
}

/** True when the operator asked for the weak-secret escape hatch. */
export function allowsWeakSecrets(env: Env): boolean {
  return env.ALLOW_WEAK_SECRETS === '1';
}
