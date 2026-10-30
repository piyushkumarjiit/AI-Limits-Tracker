import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** Session lifetime: 30 days. */
export const DEFAULT_SESSION_DAYS = 30;

/** Settings key holding the current session epoch; absent means 0. */
export const SESSION_EPOCH_KEY = 'session_epoch';

/** Reads the current session epoch from a value read out of the settings table. */
export function parseSessionEpoch(raw: string | null | undefined): number {
  const n = Number(raw);
  return raw !== null && raw !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Constant-time comparison of two secrets: both buffers are padded to a common
 * length so `timingSafeEqual` always scans the same number of bytes.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  return timingSafeEqual(pa, pb) && ba.length === bb.length;
}

/**
 * Session cookie (`alt_session`) format: `<epoch>.<issued-ms>.<base64url HMAC-SHA256(epoch.issued, APP_SECRET)>`.
 * The signature binds the session to APP_SECRET and covers the epoch the cookie was
 * issued under; `verifySession` also enforces the age limit and rejects a cookie whose
 * epoch no longer matches the current one (so a revoke-all ends every older session).
 * The earlier two-part `<issued>.<sig>` format is rejected outright.
 */
export function createSession(secret: string, epoch: number): string {
  const issued = String(Date.now());
  const payload = `${epoch}.${issued}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(
  raw: string | undefined,
  secret: string,
  sessionDays: number,
  currentEpoch: number
): boolean {
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [epoch, issued, sig] = parts;
  if (!epoch || !issued || !sig || !/^\d+$/.test(epoch)) return false;
  if (!safeEqual(sig, sign(`${epoch}.${issued}`, secret))) return false;
  if (Number(epoch) !== currentEpoch) return false;
  const age = Date.now() - Number(issued);
  return age >= 0 && age < sessionDays * 86400 * 1000;
}

export function parseCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (UNSAFE_KEYS.has(key)) continue;
    try {
      out.set(key, decodeURIComponent(part.slice(i + 1).trim()));
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

export interface AuthConfig {
  appSecret: string;
  apiToken: string;
  sessionDays: number;
  /** Current session epoch; cookies issued under any other epoch are refused. */
  sessionEpoch: () => number;
}

export function isAuthed(req: IncomingMessage, config: AuthConfig): boolean {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (config.apiToken && bearer && safeEqual(bearer, config.apiToken)) return true;
  // The API checks a separate per-address and global bearer limiter before calling this.
  return isBrowserAuthed(req, config);
}

export function isBrowserAuthed(req: IncomingMessage, config: AuthConfig): boolean {
  return verifySession(
    parseCookies(req).get('alt_session'),
    config.appSecret,
    config.sessionDays,
    config.sessionEpoch()
  );
}

/**
 * Client address for rate limiting. With `trustProxy` the address comes from the
 * proxy header (X-Real-IP, else the last X-Forwarded-For hop) — and only when it
 * looks like an IP, since the header is client-controlled otherwise.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const socketAddress = req.socket.remoteAddress || '';
  if (!trustProxy) return socketAddress;
  const realIp = (req.headers['x-real-ip'] as string | undefined)?.trim();
  if (realIp && isIP(realIp)) return realIp;
  const forwarded = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const last = hops[hops.length - 1];
  if (last && isIP(last)) return last;
  return socketAddress;
}

export interface LoginLimiterOptions {
  /** Failed attempts allowed per address inside the window before refusing. */
  maxPerIp?: number;
  /** Window in milliseconds for the per-address counter. */
  windowMs?: number;
  /** Failed attempts allowed in total inside the window (spoofed-address backstop). */
  maxGlobal?: number;
  /** Hard cap on tracked addresses; the oldest entry is evicted first. */
  maxEntries?: number;
  /** First retry delay, doubled per consecutive failure. */
  baseDelayMs?: number;
  /** Upper bound for the retry delay. */
  maxDelayMs?: number;
}

export interface LoginLimiter {
  /** True when this address is at its own failure ceiling. Does not count as a failure. */
  tooManyAttempts(ip: string): boolean;
  /** True when the instance-wide failure ceiling for the current window is reached. */
  globalExceeded(): boolean;
  /** Records a failed attempt and returns the new consecutive-failure count. */
  recordFailure(ip: string): number;
  /** Clears the per-address window after a successful login. */
  reset(ip: string): void;
  /** Exponential backoff for the given consecutive-failure count. */
  delayMs(failures: number): number;
}

interface Rec {
  count: number;
  last: number;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Failure-only throttle: 10 failed attempts per address inside 15 minutes, plus a
 * global 60-failure ceiling so rotating spoofed addresses still hits a wall. Callers
 * check both ceilings before any credential is compared, so a tripped ceiling refuses
 * even valid credentials for up to the window (a restart clears the in-memory
 * counters). Successful logins reset the address; expired records are pruned
 * on every call and the map is capped so it cannot grow without bound.
 */
export function createLoginLimiter(opts: LoginLimiterOptions = {}): LoginLimiter {
  const maxPerIp = opts.maxPerIp ?? 10;
  const windowMs = opts.windowMs ?? FIFTEEN_MINUTES;
  const maxGlobal = opts.maxGlobal ?? 60;
  const maxEntries = opts.maxEntries ?? 10_000;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const maxDelayMs = opts.maxDelayMs ?? 2000;

  const attempts = new Map<string, Rec>();
  let globalWindowStart = Date.now();
  let globalCount = 0;

  function prune(now: number): void {
    for (const [key, rec] of attempts) {
      if (now - rec.last > windowMs) attempts.delete(key);
    }
    if (now - globalWindowStart > windowMs) {
      globalWindowStart = now;
      globalCount = 0;
    }
  }

  function tooManyAttempts(ip: string): boolean {
    const now = Date.now();
    prune(now);
    const rec = attempts.get(ip);
    return Boolean(rec && rec.count >= maxPerIp);
  }

  function globalExceeded(): boolean {
    prune(Date.now());
    return globalCount >= maxGlobal;
  }

  function recordFailure(ip: string): number {
    const now = Date.now();
    prune(now);
    let rec = attempts.get(ip);
    if (!rec) {
      // Cap the map: Map iteration order is insertion order, so this drops the oldest address.
      while (attempts.size >= maxEntries) {
        const oldest = attempts.keys().next();
        if (oldest.done) break;
        attempts.delete(oldest.value);
      }
      rec = { count: 0, last: now };
      attempts.set(ip, rec);
    }
    rec.count++;
    rec.last = now;
    globalCount++;
    return rec.count;
  }

  function reset(ip: string): void {
    attempts.delete(ip);
  }

  function delayMs(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - 1));
  }

  return { tooManyAttempts, globalExceeded, recordFailure, reset, delayMs };
}
