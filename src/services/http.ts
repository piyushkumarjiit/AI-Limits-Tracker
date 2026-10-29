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
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * SSRF guard: only https, and never localhost, loopback, link-local or
 * private (RFC 1918) addresses. Throws on anything unsafe; returns the parsed URL.
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
  if (isPrivateIPv4(host)) throw new Error('Private addresses are not allowed');
  if (host.includes(':')) {
    // IPv6 literal: block loopback, unspecified, unique-local, link-local and IPv4-mapped
    const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (
      host === '::1' ||
      host === '::' ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith('::ffff:') ||
      (v4mapped && isPrivateIPv4(v4mapped[1]))
    ) {
      throw new Error('Private addresses are not allowed');
    }
  }
  return u;
}

export async function isolatedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 15000, ...rest } = init;
  assertSafeUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      credentials: 'omit',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonSafe(resp: Response): Promise<any> {
  try {
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  } catch {
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
