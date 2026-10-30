import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { NATIVE_PROVIDERS, type ProviderType, RECIPE_PROVIDERS } from '../../src/models/types';
import { computeStats, forecastWindow } from '../../src/services/stats';
import {
  AuthConfig,
  clientIp,
  createLoginLimiter,
  createSession,
  DEFAULT_SESSION_DAYS,
  isAuthed,
  isBrowserAuthed,
  safeEqual,
  UNSAFE_KEYS,
} from './auth';
import { serveStatic } from './static';
import { Store } from './store';
import { Tracker } from './tracker';

export interface AppConfig {
  adminPassword: string;
  appSecret: string;
  apiToken: string;
  secureCookies: boolean;
  trustProxy: boolean;
  webDir: string;
  /** Session lifetime in days. Defaults to 180. */
  sessionDays?: number;
  /** Whether the Telegram alert channel is configured. */
  telegram?: boolean;
  /** When set, requests whose Host is not listed are refused with 421. */
  allowedHosts?: string[];
  /** Maximum accepted size of the request line plus headers. Defaults to 8 KiB. */
  maxHeaderSize?: number;
}

export interface AppDeps {
  store: Store;
  tracker: Tracker;
}

/* ---------------- HTTP helpers ---------------- */

/** Body exceeded the read limit; answered with 413. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('Body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** Body was not valid JSON; answered with 400. */
export class InvalidJsonError extends Error {
  constructor() {
    super('Invalid JSON body');
    this.name = 'InvalidJsonError';
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Reads a JSON body. An empty body is `{}`; oversized bodies throw
 * `BodyTooLargeError` (413) and malformed JSON throws `InvalidJsonError` (400),
 * both answered by the server-wide catch.
 */
async function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<any> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume(); // drain what the client is already sending
    throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new BodyTooLargeError();
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    // Drop prototype-pollution keys at every depth
    return JSON.parse(Buffer.concat(chunks).toString('utf8'), (k, v) => (UNSAFE_KEYS.has(k) ? undefined : v));
  } catch {
    throw new InvalidJsonError();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True for `application/json`, with or without parameters such as charset. */
function isJsonContentType(value: string | undefined): boolean {
  return (value || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Splits a Host header or allowlist entry into a lowercased hostname and optional
 * port; null when the value cannot be interpreted (for example a bare IPv6 address
 * or a port without a hostname).
 */
function parseHost(value: string): { hostname: string; port: string } | null {
  const host = value.trim().toLowerCase();
  if (!host) return null;
  let hostname: string;
  let rest: string;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end <= 1) return null;
    hostname = host.slice(1, end);
    rest = host.slice(end + 1);
  } else {
    const colon = host.indexOf(':');
    if (colon === -1) {
      hostname = host;
      rest = '';
    } else {
      hostname = host.slice(0, colon);
      rest = host.slice(colon);
    }
  }
  if (!hostname) return null;
  if (!rest) return { hostname, port: '' };
  if (!rest.startsWith(':') || !/^\d+$/.test(rest.slice(1))) return null;
  return { hostname, port: rest.slice(1) };
}

/** Hostname from a Host header or allowlist entry, without port or IPv6 brackets. */
export function hostnameOf(value: string): string | null {
  return parseHost(value)?.hostname ?? null;
}

/**
 * Same-origin test for the Origin header against the request Host header. Both
 * sides are compared as hostname plus port, with an omitted port standing for the
 * scheme's default so a port-forwarding proxy does not break same-origin calls.
 */
function sameOrigin(origin: string, hostHeader: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  const parts = parseHost(hostHeader);
  if (!parts) return false;
  const originHostname = url.hostname.replace(/^\[|\]$/g, '');
  if (parts.hostname !== originHostname) return false;
  const originPort = url.port || (protocol === 'https:' ? '443' : '80');
  const hostPort = parts.port || (protocol === 'https:' ? '443' : '80');
  return hostPort === originPort;
}

const ALL_PROVIDERS: ProviderType[] = [...NATIVE_PROVIDERS, ...RECIPE_PROVIDERS, 'custom'];

/* ---------------- Routes ---------------- */

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: AppConfig,
  auth: AuthConfig,
  { store, tracker }: AppDeps,
  limiter: ReturnType<typeof createLoginLimiter>,
  bearerLimiter: ReturnType<typeof createLoginLimiter>
) {
  const path = url.pathname;
  const method = req.method || 'GET';

  if (path === '/api/health') return send(res, 200, { ok: true });

  if (path === '/api/login' && method === 'POST') {
    const ip = clientIp(req, config.trustProxy);
    // Deliberate tradeoff: once the global ceiling is reached every login is refused
    // for up to the window, even with the correct password, so rotated addresses
    // cannot keep guessing. Restarting the process clears the in-memory counters.
    if (limiter.tooManyAttempts(ip) || limiter.globalExceeded()) {
      return send(res, 429, { error: 'Too many attempts, please wait 15 minutes' });
    }
    const { password } = await readBody(req);
    if (limiter.tooManyAttempts(ip) || limiter.globalExceeded()) {
      return send(res, 429, { error: 'Too many attempts, please wait 15 minutes' });
    }
    if (typeof password !== 'string' || !safeEqual(password, config.adminPassword)) {
      // Only failures count toward the throttle; back off exponentially (never log the password).
      const failures = limiter.recordFailure(ip);
      const ipForLog = ip.replace(/[\r\n]/g, '');
      console.log(`login_failed ip=${ipForLog} ts=${Math.floor(Date.now() / 1000)}`);
      await sleep(limiter.delayMs(failures));
      return send(res, 401, { error: 'Incorrect password' });
    }
    limiter.reset(ip);
    const cookie = [
      `alt_session=${createSession(auth.appSecret)}`,
      'Path=/',
      'HttpOnly',
      ...(config.secureCookies ? ['Secure'] : []),
      'SameSite=Lax',
      `Max-Age=${auth.sessionDays * 86400}`,
    ].join('; ');
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (path === '/api/logout' && method === 'POST') {
    const cookie = [
      'alt_session=',
      'Path=/',
      'HttpOnly',
      ...(config.secureCookies ? ['Secure'] : []),
      'SameSite=Lax',
      'Max-Age=0',
    ].join('; ');
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (/^Bearer\s+/i.test(req.headers.authorization || '')) {
    // Bearer attempts are throttled per address and by the global ceiling, both
    // checked before the token is compared so a tripped limiter never verifies a guess.
    const ip = clientIp(req, config.trustProxy);
    if (bearerLimiter.tooManyAttempts(ip) || bearerLimiter.globalExceeded()) {
      return send(res, 429, { error: 'Too many attempts, please wait 15 minutes' });
    }
    if (!isAuthed(req, auth)) {
      const failures = bearerLimiter.recordFailure(ip);
      await sleep(bearerLimiter.delayMs(failures));
      return send(res, 401, { error: 'unauthorized' });
    }
  } else if (!isAuthed(req, auth)) {
    return send(res, 401, { error: 'unauthorized' });
  }

  if (path === '/api/state' && method === 'GET') {
    return send(res, 200, {
      accounts: store.listAccounts(), // credentials are never part of the account object
      lastSyncAllAt: tracker.lastSyncAllAt,
      intervalMin: tracker.intervalMin(),
      telegram: Boolean(config.telegram),
    });
  }

  if (path === '/api/refresh' && method === 'POST') {
    await tracker.syncAll();
    return send(res, 200, { ok: true });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    if (typeof body.intervalMin === 'number') tracker.setIntervalMin(body.intervalMin);
    return send(res, 200, { ok: true, intervalMin: tracker.intervalMin() });
  }

  if (path === '/api/oauth/start' && method === 'POST') {
    const { provider, accountId } = await readBody(req);
    try {
      return send(res, 200, tracker.startOAuth(provider, accountId));
    } catch (e: any) {
      return send(res, 400, { error: e.message });
    }
  }

  if (path === '/api/oauth/finish' && method === 'POST') {
    const { state, input } = await readBody(req);
    const result = await tracker.finishOAuth(String(state || ''), String(input || ''));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (path === '/api/accounts/manual' && method === 'POST') {
    const { provider, input, accountId } = await readBody(req);
    if (!ALL_PROVIDERS.includes(provider)) return send(res, 400, { error: 'Unknown provider' });
    const result = await tracker.connectManual(provider, String(input || ''), accountId);
    return send(res, result.ok ? 200 : 400, result);
  }

  if (path === '/api/accounts/reorder' && method === 'POST') {
    const { ids } = await readBody(req);
    if (Array.isArray(ids)) tracker.reorder(ids.map(String));
    return send(res, 200, { ok: true });
  }

  const m = /^\/api\/accounts\/([\w-]+)(\/refresh)?$/.exec(path);
  if (m) {
    const id = m[1];
    const account = store.getAccount(id);
    if (!account) return send(res, 404, { error: 'not found' });
    if (m[2] && method === 'POST') {
      await tracker.sync(id);
      return send(res, 200, { account: store.getAccount(id) });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const next = { ...account };
      if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim().slice(0, 80);
      if (typeof body.isActive === 'boolean') next.isActive = body.isActive;
      store.upsertAccount(next);
      return send(res, 200, { account: next });
    }
    if (method === 'DELETE') {
      store.deleteAccount(id);
      return send(res, 200, { ok: true });
    }
  }

  if (path === '/api/history' && method === 'GET') {
    const days = Math.min(400, Number(url.searchParams.get('days')) || 7);
    const accountId = url.searchParams.get('accountId') || undefined;
    return send(res, 200, { points: store.history(Date.now() - days * 86400000, accountId) });
  }

  if (path === '/api/stats' && method === 'GET') {
    const days = Math.min(400, Number(url.searchParams.get('days')) || 30);
    let tz = url.searchParams.get('tz') || undefined;
    try {
      if (tz) new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      tz = undefined;
    }
    const accounts = store.listAccounts();
    const points = store.history(Date.now() - days * 86400000);
    const stats = computeStats(points, accounts.map((a) => a.id), { timeZone: tz, days });
    const recent = Date.now() - 3 * 3600000;
    const forecasts: Record<string, ReturnType<typeof forecastWindow>> = {};
    for (const a of accounts) {
      const session = a.latestSnapshot?.buckets.find((b) => b.windowType === 'session_5h');
      forecasts[a.id] = forecastWindow(
        points.filter((p) => p.accountId === a.id && p.t >= recent).map((p) => ({ t: p.t, value: p.session })),
        session?.utilizationPercent ?? null,
        session?.resetsAt ?? null
      );
    }
    return send(res, 200, { stats, forecasts });
  }

  if (path === '/api/alerts' && method === 'GET') return send(res, 200, { alerts: store.alerts(100) });
  if (path === '/api/alerts' && method === 'DELETE') {
    store.clearAlerts();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // The web build ships one external stylesheet and no inline <style> blocks;
  // React's inline style attributes are covered by style-src-attr.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * Cross-site request checks for cookie-authenticated, state-changing API calls.
 * Bearer-token callers are not subject to them (browsers never attach the token
 * implicitly), and unauthenticated calls are answered with 401 by the API.
 */
function csrfError(req: IncomingMessage, auth: AuthConfig): { status: number; error: string } | null {
  if (/^Bearer\s+/i.test(req.headers.authorization || '')) return null;
  if (!isBrowserAuthed(req, auth)) return null;
  if (!isJsonContentType(req.headers['content-type'])) {
    return { status: 403, error: 'Content-Type must be application/json' };
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!sameOrigin(origin, req.headers.host || '')) {
      return { status: 403, error: 'Cross-origin request refused' };
    }
  }
  return null;
}

/**
 * Builds the HTTP server without side effects: it does not read the environment,
 * start the tracker or listen. The caller owns `listen`.
 */
export function createApp(config: AppConfig, deps: AppDeps) {
  const auth: AuthConfig = {
    appSecret: config.appSecret,
    apiToken: config.apiToken,
    sessionDays: config.sessionDays ?? DEFAULT_SESSION_DAYS,
  };
  const limiter = createLoginLimiter();
  const bearerLimiter = createLoginLimiter();
  const allowedHosts = (config.allowedHosts || []).map((entry) => {
    const hostname = hostnameOf(entry);
    if (!hostname) throw new Error(`Invalid ALLOWED_HOSTS entry: ${JSON.stringify(entry)}`);
    return hostname;
  });

  const server = createServer({ maxHeaderSize: config.maxHeaderSize ?? 8192 }, async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      let url: URL;
      try {
        url = new URL(req.url || '/', 'http://localhost');
      } catch {
        // A malformed request target must never take the process down.
        return send(res, 400, { error: 'bad request' });
      }
      const method = req.method || 'GET';
      const healthProbe = method === 'GET' && url.pathname === '/api/health';
      const requestHost = hostnameOf(req.headers.host || '');
      if (allowedHosts.length && !healthProbe && (!requestHost || !allowedHosts.includes(requestHost))) {
        return send(res, 421, { error: 'misdirected request' });
      }
      if (url.pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') {
        const csrf = csrfError(req, auth);
        if (csrf) return send(res, csrf.status, { error: csrf.error });
      }
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, config, auth, deps, limiter, bearerLimiter);
      else serveStatic(req, res, url.pathname, config.webDir);
    } catch (e: any) {
      if (e instanceof BodyTooLargeError) {
        if (!res.headersSent) send(res, 413, { error: 'payload too large' });
        return;
      }
      if (e instanceof InvalidJsonError) {
        if (!res.headersSent) send(res, 400, { error: 'bad request' });
        return;
      }
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  });

  // Node's own parser rejects unparsable request lines/headers before the handler;
  // answer those clients explicitly instead of leaving the socket hanging.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  return server;
}
