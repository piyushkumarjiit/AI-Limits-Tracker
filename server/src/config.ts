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

const HINT = 'Generate one with: openssl rand -hex 32';

const EMPTY_ADMIN_PASSWORD = `ADMIN_PASSWORD is empty. Set the web panel password. ${HINT}`;
const EMPTY_APP_SECRET = `APP_SECRET is empty. ${HINT}`;

export type Env = Record<string, string | undefined>;

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
 * missing password or session secret can never be downgraded to a warning.
 */
export function validateFatalConfig(env: Env): string[] {
  const fatal: string[] = [];
  if (!(env.ADMIN_PASSWORD ?? '')) fatal.push(EMPTY_ADMIN_PASSWORD);
  if (!(env.APP_SECRET ?? '')) fatal.push(EMPTY_APP_SECRET);
  return fatal;
}

/**
 * Every problem that must stop startup. `ALLOW_WEAK_SECRETS=1` downgrades these
 * to warnings for operators who know what they are doing, except the empty
 * secrets reported by `validateFatalConfig`, which stay fatal.
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
