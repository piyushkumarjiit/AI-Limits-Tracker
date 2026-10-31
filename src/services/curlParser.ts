import { AccountCredentials, ProviderType, RECIPE_PROVIDERS } from '../models/types';

export function extractDelimitedHeaders(curlText: string, headerName: string): string | null {
  const normalized = headerName.toLowerCase();
  const headerRegex = /(?:-H|--header)\s+['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;

  while ((match = headerRegex.exec(curlText)) !== null) {
    const rawHeader = match[1];
    const colonIdx = rawHeader.indexOf(':');
    if (colonIdx > -1) {
      const key = rawHeader.substring(0, colonIdx).trim().toLowerCase();
      if (key === normalized) {
        return rawHeader.substring(colonIdx + 1).trim();
      }
    }
  }
  return null;
}

export function extractUrl(curlText: string): string | null {
  // 1. Explicit --url flag
  const urlFlagMatch = /--url\s+['"]([^'"]+)['"]/i.exec(curlText);
  if (urlFlagMatch) return urlFlagMatch[1];

  // 2. Quoted URL after curl
  const curlQuotedMatch = /curl(?:\.exe)?\s+['"](https?:\/\/[^'"]+)['"]/i.exec(curlText);
  if (curlQuotedMatch) return curlQuotedMatch[1];

  // 3. Any quoted URL
  const anyQuotedMatch = /['"](https?:\/\/[^'"]+)['"]/i.exec(curlText);
  if (anyQuotedMatch) return anyQuotedMatch[1];

  // 4. Any unquoted URL
  const unquotedMatch = /(https?:\/\/[^\s'"]+)/i.exec(curlText);
  if (unquotedMatch) return unquotedMatch[1];

  return null;
}

export function extractCookies(curlText: string): string | null {
  const fromHeader = extractDelimitedHeaders(curlText, 'cookie');
  if (fromHeader) return fromHeader;

  const cookieFlagMatch = /(?:-b|--cookie)\s+['"]([^'"]+)['"]/i.exec(curlText);
  if (cookieFlagMatch) return cookieFlagMatch[1];

  return null;
}

/** Chrome's "Copy as cURL (cmd)" escapes quotes with ^ — normalise to the bash form. */
export function normalizeCurl(text: string): string {
  return text
    .replace(/\^\r?\n/g, ' ')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^"/g, '"')
    .replace(/\^\^/g, '^')
    .replace(/\^%/g, '%')
    .replace(/\^&/g, '&');
}

export function parseCurlForProvider(
  rawCurlText: string,
  providerType: ProviderType
): AccountCredentials {
  const curlText = normalizeCurl(rawCurlText);
  const url = extractUrl(curlText);
  const cookies = extractCookies(curlText) || undefined;
  const authHeader = extractDelimitedHeaders(curlText, 'authorization');

  let accessToken: string | undefined;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    accessToken = authHeader.substring(7).trim();
  }

  const credentials: AccountCredentials = {
    cookies,
    accessToken,
  };

  if (providerType === 'claude') {
    if (url) {
      credentials.orgUrl = url;
      const orgMatch = /organizations\/([^/]+)/.exec(url);
      if (orgMatch) {
        credentials.orgId = orgMatch[1];
      }
    }
    // Also extract sessionKey if passed directly in cookies
    if (cookies) {
      const sessionKeyMatch = /sessionKey=([^;]+)/.exec(cookies);
      if (sessionKeyMatch) {
        credentials.sessionKey = sessionKeyMatch[1].trim();
      }
    }
  } else if (providerType === 'chatgpt') {
    const acctHeader = extractDelimitedHeaders(curlText, 'chatgpt-account-id');
    if (acctHeader) {
      credentials.orgId = acctHeader;
    }
    if (url) {
      const acctMatch = /account_id=([^&'"]+)/.exec(url);
      if (acctMatch) {
        credentials.orgId = acctMatch[1];
      }
    }
  } else if (providerType === 'gemini') {
    const blMatch = /bl=([^&'"]+)/.exec(curlText);
    if (blMatch) credentials.bl = decodeURIComponent(blMatch[1]);

    const sidMatch = /f\.sid=([^&'"]+)/.exec(curlText);
    if (sidMatch) credentials.sid = decodeURIComponent(sidMatch[1]);

    const atMatch = /(?:[?&]at=|at=)([^&'"\s]+)/.exec(curlText);
    if (atMatch) credentials.atToken = decodeURIComponent(atMatch[1]);
  }

  return credentials;
}

export type ManualParseResult = { ok: true; credentials: AccountCredentials } | { ok: false; error: string };

/**
 * Accepts whatever the user pasted for manual connection — a cURL command,
 * a raw cookie string, a Claude sessionKey or a ChatGPT access token.
 */
const RECIPE_SET = new Set(RECIPE_PROVIDERS as string[]);

export function parseManualInput(input: string, providerType: ProviderType): ManualParseResult {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Field is empty' };
  const isCurl = /^curl(\.exe)?\s/i.test(text) || /\s-H\s/.test(text);

  // --- Native providers (bespoke adapters) ---
  if (providerType === 'claude') {
    if (isCurl) {
      const parsed = parseCurlForProvider(text, providerType);
      if (!parsed.sessionKey) return { ok: false, error: 'No sessionKey cookie in cURL' };
      return { ok: true, credentials: { ...parsed, authType: 'cookie' } };
    }
    const fromCookie = /sessionKey=([^;\s]+)/.exec(text);
    const key = fromCookie ? fromCookie[1] : /^sk-ant-[\w-]+$/.test(text) ? text : null;
    if (!key) return { ok: false, error: 'Expected a sessionKey (sk-ant-sid…) or cURL' };
    return { ok: true, credentials: { authType: 'cookie', sessionKey: key } };
  }

  if (providerType === 'chatgpt') {
    if (isCurl) {
      const parsed = parseCurlForProvider(text, providerType);
      if (!parsed.accessToken && !parsed.cookies) return { ok: false, error: 'No Authorization or cookie in cURL' };
      if (parsed.cookies?.includes('next-auth.session-token')) {
        const { accessToken, ...rest } = parsed;
        return { ok: true, credentials: { ...rest, authType: 'cookie' } };
      }
      return { ok: true, credentials: { ...parsed, authType: parsed.accessToken ? 'token' : 'cookie' } };
    }
    const bearer = text.replace(/^bearer\s+/i, '');
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(bearer)) return { ok: true, credentials: { authType: 'token', accessToken: bearer } };
    if (text.includes('=')) return { ok: true, credentials: { authType: 'cookie', cookies: text } };
    return { ok: false, error: 'Expected an access token (eyJ…), cookie, or cURL' };
  }

  if (providerType === 'gemini') {
    if (isCurl) {
      const parsed = parseCurlForProvider(text, providerType);
      if (!parsed.cookies?.includes('PSID')) return { ok: false, error: 'No __Secure-1PSID cookie in cURL' };
      return { ok: true, credentials: { ...parsed, authType: 'cookie' } };
    }
    if (text.includes('PSID')) return { ok: true, credentials: { authType: 'cookie', cookies: text } };
    return { ok: false, error: 'Expected Google cookies (__Secure-1PSID…) or cURL' };
  }

  if (providerType === 'antigravity') {
    if (text.length > 16384) {
      return { ok: false, error: 'Manual input too large' };
    }
    let refreshToken: string | undefined;
    let accessToken: string | undefined;
    let expiresAt: number | undefined;

    if (text.startsWith('{')) {
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, error: 'Invalid JSON' };
      }
      refreshToken = json.refresh_token ?? json.refreshToken;
      accessToken = json.access_token ?? json.accessToken;
      if (typeof json.expiry_date === 'number') {
        expiresAt = json.expiry_date;
      }
    } else {
      const mRefresh = /1\/\/[A-Za-z0-9_\-]{20,}/.exec(text);
      if (mRefresh) {
        refreshToken = mRefresh[0];
      } else if (/^ya29\.[A-Za-z0-9_\-\.]{20,}$/.test(text)) {
        accessToken = text;
      }
    }

    if (!refreshToken && !accessToken) {
      return {
        ok: false,
        error: 'Paste a Google refresh token (starts with 1//) or the JSON that contains one.',
      };
    }

    if (accessToken && !refreshToken && expiresAt === undefined) {
      expiresAt = Date.now() + 50 * 60 * 1000;
    }

    return {
      ok: true,
      credentials: {
        authType: 'oauth',
        refreshToken,
        accessToken,
        expiresAt,
      },
    };
  }

  // --- Custom: build a recipe straight from the pasted cURL ---
  if (providerType === 'custom') {
    if (!isCurl) return { ok: false, error: 'Paste the cURL of the request that returns your limits' };
    const url = extractUrl(text);
    if (!url) return { ok: false, error: 'No URL found in cURL' };
    const cookies = extractCookies(text) || undefined;
    const auth = extractDelimitedHeaders(text, 'authorization');
    const bearer = auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : undefined;
    const isPost = /-X\s+POST|--data|--data-raw|-d\s/i.test(text);
    const bodyMatch = /(?:--data-raw|--data|-d)\s+'([^']*)'/.exec(text) || /(?:--data-raw|--data|-d)\s+"([^"]*)"/.exec(text);
    if (!cookies && !bearer) return { ok: false, error: 'No cookie or Authorization in cURL' };
    return {
      ok: true,
      credentials: {
        authType: bearer ? 'token' : 'cookie',
        cookies,
        accessToken: bearer,
        recipe: {
          title: 'Custom',
          usageUrl: url,
          method: isPost ? 'POST' : 'GET',
          body: bodyMatch ? bodyMatch[1] : undefined,
          auth: bearer ? 'bearer' : 'cookie',
          windows: [], // auto-detected from the response at sync time
          needsVerification: true,
        },
      },
    };
  }

  // --- Recipe-driven services (Cursor, Copilot, Perplexity, Grok, …) ---
  if (RECIPE_SET.has(providerType)) {
    let cookies: string | undefined;
    let bearer: string | undefined;
    if (isCurl) {
      cookies = extractCookies(text) || undefined;
      const auth = extractDelimitedHeaders(text, 'authorization');
      bearer = auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : undefined;
    } else if (/^(bearer\s+)?(eyJ|gho_|ghu_|github_pat_)[\w.\-]+$/i.test(text)) {
      bearer = text.replace(/^bearer\s+/i, '');
    } else if (text.includes('=')) {
      cookies = text;
    }
    if (!cookies && !bearer) return { ok: false, error: 'Paste the cURL for this service (Network → Copy as cURL), a cookie, or a token' };
    return { ok: true, credentials: { authType: bearer ? 'token' : 'cookie', cookies, accessToken: bearer } };
  }

  return { ok: false, error: 'Unknown service' };
}
