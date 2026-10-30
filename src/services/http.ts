/**
 * Network helpers shared by all providers.
 *
 * Every request is sent with `credentials: 'omit'`. On Android, React Native's
 * networking stack shares one cookie jar with every WebView in the app; without
 * this flag a request for account #2 would silently carry the cookies of
 * whichever account last logged in through a WebView, and both accounts would
 * show identical numbers. With it, the only identity a request carries is the
 * token / cookie header we attach explicitly for that account.
 */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    // 0.0.0.0/8, RFC 1918, loopback, CGNAT, link-local
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    // 198.18.0.0/15 benchmarking, 192.0.0.0/24 IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 0) ||
    // Documentation ranges: TEST-NET-1/2/3
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved (includes 255.255.255.255)
    (a >= 224 && a <= 239) ||
    a >= 240
  );
}

function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Expands an IPv6 literal (lowercase, brackets stripped) to eight 16-bit groups. */
function parseIPv6Groups(host: string): number[] | null {
  let h = host;
  if (h.includes('.')) {
    const idx = h.lastIndexOf(':');
    if (idx < 0) return null;
    const parts = h.slice(idx + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    h = `${h.slice(0, idx + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${(
      (parts[2] << 8) |
      parts[3]
    ).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/** IPv6 literal check; the input is already lowercased and stripped of brackets. */
function isBlockedIPv6(host: string): boolean {
  const groups = parseIPv6Groups(host);
  if (!groups) {
    return /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host);
  }
  const embeddedIPv4 = (hi: number, lo: number) =>
    isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  if (groups.every((g) => g === 0)) return true; // unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // loopback
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((groups[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation 2001:db8::/32
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return true; // IPv4-mapped
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((g) => g === 0)
  ) {
    return embeddedIPv4(groups[6], groups[7]); // NAT64 64:ff9b::/96
  }
  if (groups[0] === 0x2002) return embeddedIPv4(groups[1], groups[2]); // 6to4 2002::/16
  return false;
}

/**
 * True for an address that must never be connected to: private, loopback,
 * link-local, multicast, documentation or otherwise reserved. Accepts a bare
 * IPv4/IPv6 literal, with or without brackets.
 */
export function isBlockedAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isPrivateIPv4(host)) return true;
  if (host.includes(':')) return isBlockedIPv6(host);
  return false;
}

/**
 * SSRF guard: only https, and never localhost, loopback, link-local, private
 * (RFC 1918) or otherwise reserved addresses. Single-label hostnames are
 * refused so an internal short name cannot be reached. Throws on anything
 * unsafe; returns the parsed URL.
 */
export function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  if (u.username || u.password) throw new Error('URL must not contain credentials');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Host is not allowed');
  }
  // A single-label name has no public suffix to anchor it to the internet.
  if (!host.includes('.') && !host.includes(':') && !isIPv4Literal(host)) {
    throw new Error('Host must be a fully qualified domain name');
  }
  if (isBlockedAddress(host)) throw new Error('Private addresses are not allowed');
  return u;
}

/**
 * Optional DNS resolver, installed by the server at startup. Mobile and the
 * extension leave it unset, so they connect to whatever the platform resolves.
 */
export type HostResolver = (hostname: string) => Promise<string[]>;
let hostResolver: HostResolver | null = null;

export function setHostResolver(fn: HostResolver | null): void {
  hostResolver = fn;
}

/**
 * Refuses a URL whose hostname resolves to any blocked address. IP literals are
 * already covered by `assertSafeUrl`. Residual risk: the name is resolved once
 * here and again when the socket connects, so DNS rebinding between the two is
 * not detected; closing that would need a custom connection agent.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Request timed out'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function assertHostResolvesSafe(u: URL, signal: AbortSignal): Promise<void> {
  if (!hostResolver) return;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIPv4Literal(host) || host.includes(':')) return;
  let addresses: string[];
  try {
    addresses = await abortable(hostResolver(host), signal);
  } catch {
    throw new Error(signal.aborted ? 'Request timed out' : 'Host could not be resolved');
  }
  if (!addresses.length) throw new Error('Host could not be resolved');
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new Error('Host resolves to a private address');
  }
}

/** Response bodies above this many bytes are refused (server installs 1 MB). */
let maxResponseBytes: number | null = null;

export function setMaxResponseBytes(bytes: number | null): void {
  maxResponseBytes = bytes;
}

/** Response body exceeded the installed limit. */
export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeded the ${limit} byte limit`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Reads a response body as text, refusing anything above the installed limit. */
export async function readTextSafe(resp: Response): Promise<string> {
  const limit = maxResponseBytes;
  if (limit === null || !resp.body) return resp.text();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // already closed
        }
        throw new ResponseTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'host']);

/** Copies headers, dropping credentials that must not cross origins. */
function withoutCredentialHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const keep = (key: string, value: string) => {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) out[key] = value;
  };
  if (!headers) return out;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => keep(key, value));
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) keep(key, value);
  } else {
    for (const [key, value] of Object.entries(headers)) keep(key, String(value));
  }
  return out;
}

/**
 * Fetches a URL after passing it through the SSRF guard. Redirects are followed
 * manually, at most three hops, and every Location is re-checked against the
 * same guard before it is fetched. Only GET and HEAD are followed.
 */
export async function isolatedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 15000, ...rest } = init;
  const method = (rest.method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = assertSafeUrl(url);
    let headers = rest.headers;
    await assertHostResolvesSafe(current, controller.signal);
    for (let hop = 0; ; hop++) {
      const resp = await fetch(current.toString(), {
        ...rest,
        headers,
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!REDIRECT_STATUSES.has(resp.status)) {
        // Callers use `response.redirected` to spot a login/consent page, which
        // `redirect: 'manual'` no longer sets by itself.
        if (hop > 0) {
          try {
            Object.defineProperty(resp, 'redirected', { value: true, configurable: true });
          } catch {
            // Informational only; never fail the request over it.
          }
        }
        return resp;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          await resp.body?.cancel();
        } catch {
          // already closed
        }
        throw new Error('Redirects are not followed for this request method');
      }
      if (hop >= MAX_REDIRECTS) {
        try {
          await resp.body?.cancel();
        } catch {
          // already closed
        }
        throw new Error('Too many redirects');
      }
      const location = resp.headers.get('location');
      try {
        await resp.body?.cancel();
      } catch {
        // already closed
      }
      if (!location) throw new Error('Redirect without a Location header');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('Invalid redirect URL');
      }
      const nextSafe = assertSafeUrl(next.toString());
      if (nextSafe.origin !== current.origin) headers = withoutCredentialHeaders(headers);
      current = nextSafe;
      await assertHostResolvesSafe(current, controller.signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonSafe(resp: Response): Promise<any> {
  try {
    const text = await readTextSafe(resp);
    return text ? JSON.parse(text) : null;
  } catch (e) {
    // A body over the limit is a real failure, not unparsable JSON.
    if (e instanceof ResponseTooLargeError) throw e;
    return null;
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(n >> 18) & 63] +
      B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] +
      B64_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63];
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_');
}

export function base64ToBase64Url(b64: string): string {
  return b64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecodeToString(input: string): string {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // UTF-8 decode
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f));
    else if (b < 0xf0)
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f)
      );
    else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[++i] & 0x3f) << 12) |
        ((bytes[++i] & 0x3f) << 6) |
        (bytes[++i] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

export function decodeJwtPayload(token: string | undefined | null): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecodeToString(parts[1]));
  } catch {
    return null;
  }
}
