import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingMessage } from 'node:http';

/** Session lifetime: 180 days. */
export const DEFAULT_SESSION_DAYS = 180;

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

export function createSession(secret: string): string {
  const issued = String(Date.now());
  return `${issued}.${sign(issued, secret)}`;
}

export function verifySession(raw: string | undefined, secret: string, sessionDays: number): boolean {
  if (!raw) return false;
  const [issued, sig] = raw.split('.');
  if (!issued || !sig || !safeEqual(sig, sign(issued, secret))) return false;
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
}

export function isAuthed(req: IncomingMessage, config: AuthConfig): boolean {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (config.apiToken && bearer && safeEqual(bearer, config.apiToken)) return true;
  // NOTE: bearer attempts are not counted toward the login limiter; use a long random API_TOKEN.
  return isBrowserAuthed(req, config);
}

export function isBrowserAuthed(req: IncomingMessage, config: AuthConfig): boolean {
  return verifySession(parseCookies(req).get('alt_session'), config.appSecret, config.sessionDays);
}

export interface LoginLimiter {
  tooManyAttempts(ip: string): boolean;
}

/** Per-IP login throttle: more than 10 attempts inside 15 minutes is refused. */
export function createLoginLimiter(): LoginLimiter {
  const loginAttempts = new Map<string, { count: number; first: number }>();
  function tooManyAttempts(ip: string): boolean {
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (!rec || now - rec.first > 15 * 60 * 1000) {
      loginAttempts.set(ip, { count: 1, first: now });
      return false;
    }
    rec.count++;
    return rec.count > 10;
  }
  return { tooManyAttempts };
}
