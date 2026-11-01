import { AccountCredentials, QuotaBucket, UsageSnapshot } from '../../models/types';
import { isolatedFetch, readJsonSafe } from '../http';
import {
  CHATGPT_OAUTH,
  chatgptPlanTitle,
  identityFromTokens,
  refreshChatGPTToken,
} from '../oauth/chatgptOAuth';
import { failureSnapshot, makeBucket, needsRefresh } from './common';
import { ProviderFetchResult, UsageProvider } from './UsageProvider';
import { CODEX_USER_AGENT } from '../cpa/clientIdentity';

const BASE_HEADERS = {
  'User-Agent': CODEX_USER_AGENT,
  Accept: 'application/json',
  originator: 'codex_cli_rs',
};

function windowLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds <= 6 * 3600) return `Codex · ${Math.round(seconds / 3600)}h`;
  if (seconds >= 6 * 86400) return 'Codex · Weekly';
  return `Codex · ${Math.round(seconds / 86400)}d`;
}

function parseWindow(id: string, fallbackLabel: string, w: any): QuotaBucket | null {
  if (!w) return null;
  const raw = w.used_percent ?? w.usedPercent;
  const pct = typeof raw === 'number' ? raw : null;
  let resetsAt: string | null = null;
  const resetAt = w.reset_at ?? w.resets_at;
  if (typeof resetAt === 'number') resetsAt = new Date(resetAt * 1000).toISOString();
  else if (typeof resetAt === 'string') resetsAt = resetAt;
  else if (typeof w.reset_after_seconds === 'number')
    resetsAt = new Date(Date.now() + w.reset_after_seconds * 1000).toISOString();
  const seconds = w.limit_window_seconds;
  const type = seconds && seconds >= 6 * 86400 ? 'weekly_7d' : 'session_5h';
  return makeBucket(id, windowLabel(seconds, fallbackLabel), type, pct, resetsAt);
}

export function parseChatGPTUsage(body: any): { buckets: QuotaBucket[]; plan?: string; credits?: number } {
  const buckets: QuotaBucket[] = [];
  if (!body) return { buckets };
  const rl = body.rate_limit || body.rateLimits || {};
  const primary = parseWindow('primary', 'Codex · 5h', rl.primary_window || rl.primary);
  const secondary = parseWindow('secondary', 'Codex · Weekly', rl.secondary_window || rl.secondary);
  if (primary) buckets.push(primary);
  if (secondary) buckets.push(secondary);

  const review = body.code_review_rate_limit?.primary_window;
  const reviewBucket = parseWindow('code_review', 'Code Review', review);
  if (reviewBucket) {
    reviewBucket.label = 'Code Review';
    buckets.push(reviewBucket);
  }

  let credits: number | undefined;
  if (body.credits && typeof body.credits.balance !== 'undefined' && !body.credits.unlimited) {
    const b = Number(body.credits.balance);
    if (!isNaN(b)) credits = b;
  }

  return { buckets, plan: chatgptPlanTitle(body.plan_type), credits };
}

export class ChatGPTProvider implements UsageProvider {
  readonly id = 'chatgpt';
  readonly type = 'chatgpt' as const;
  readonly name = 'ChatGPT';

  validateCredentials(credentials: AccountCredentials): boolean {
    return Boolean(credentials.accessToken || credentials.cookies);
  }

  async fetchUsage(accountId: string, credentials: AccountCredentials): Promise<ProviderFetchResult> {
    if (!this.validateCredentials(credentials)) {
      return {
        snapshot: failureSnapshot(accountId, 'chatgpt', 'not_configured', 'Account not connected'),
      };
    }

    let creds = credentials;
    let changed = false;

    try {
      // 1. Make sure we have a valid access token
      if (creds.authType === 'oauth' && needsRefresh(creds.expiresAt)) {
        try {
          creds = await refreshChatGPTToken(creds);
          changed = true;
        } catch {
          return {
            snapshot: failureSnapshot(accountId, 'chatgpt', 'reauth_required', 'ChatGPT session expired — sign in again'),
          };
        }
      }

      if (!creds.accessToken && creds.cookies) {
        const sessResp = await isolatedFetch('https://chatgpt.com/api/auth/session', {
          headers: { ...BASE_HEADERS, Cookie: creds.cookies },
        });
        const session = sessResp.ok ? await readJsonSafe(sessResp) : null;
        if (!session?.accessToken) {
          return {
            snapshot: failureSnapshot(
              accountId,
              'chatgpt',
              'reauth_required',
              'ChatGPT cookies are outdated — reconnect the account'
            ),
          };
        }
        creds = { ...creds, accessToken: session.accessToken };
      }

      if (!creds.orgId || !creds.email) {
        const identity = identityFromTokens(creds.idToken, creds.accessToken);
        if ((identity.accountId && !creds.orgId) || (identity.email && !creds.email)) {
          creds = {
            ...creds,
            orgId: creds.orgId || identity.accountId,
            email: creds.email || identity.email,
          };
          changed = true;
        }
      }

      // 2. Codex / ChatGPT usage windows
      const call = (token: string) => {
        const headers: Record<string, string> = { ...BASE_HEADERS, Authorization: `Bearer ${token}` };
        if (creds.orgId) headers['ChatGPT-Account-Id'] = creds.orgId;
        return isolatedFetch(CHATGPT_OAUTH.usageUrl, { headers });
      };

      let resp = await call(creds.accessToken!);
      if (resp.status === 401 && creds.authType === 'oauth' && creds.refreshToken) {
        try {
          creds = await refreshChatGPTToken(creds);
          changed = true;
          resp = await call(creds.accessToken!);
        } catch {}
      }

      if (resp.status === 401 || resp.status === 403) {
        return {
          snapshot: failureSnapshot(accountId, 'chatgpt', 'reauth_required', 'ChatGPT session expired — sign in again'),
          updatedCredentials: changed ? creds : undefined,
        };
      }
      if (resp.status === 429) {
        return {
          snapshot: failureSnapshot(accountId, 'chatgpt', 'rate_limited', 'Too many requests — will retry later'),
          updatedCredentials: changed ? creds : undefined,
        };
      }
      if (!resp.ok) {
        return {
          snapshot: failureSnapshot(accountId, 'chatgpt', 'error', `ChatGPT returned HTTP ${resp.status}`),
          updatedCredentials: changed ? creds : undefined,
        };
      }

      const body = await readJsonSafe(resp);
      const parsed = parseChatGPTUsage(body);
      const identity = identityFromTokens(creds.idToken, creds.accessToken);
      const plan = parsed.plan || identity.plan || '';

      const snapshot: UsageSnapshot = {
        accountId,
        providerType: 'chatgpt',
        planName: plan,
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: parsed.buckets,
        email: creds.email,
        credits:
          typeof parsed.credits === 'number' ? { balance: parsed.credits, currency: 'credits' } : undefined,
        subscription: plan ? { planTitle: plan, isActive: plan !== 'Free' } : undefined,
      };

      // Bare cookie mode: never persist the short-lived token derived from cookies
      if (credentials.authType !== 'oauth' && !credentials.accessToken) {
        const { accessToken, ...rest } = creds;
        return { snapshot, updatedCredentials: changed ? rest : undefined };
      }
      return { snapshot, updatedCredentials: changed ? creds : undefined };
    } catch (err: any) {
      return {
        snapshot: failureSnapshot(
          accountId,
          'chatgpt',
          'error',
          err?.name === 'AbortError' ? 'ChatGPT did not respond in time' : err?.message || 'Connection to ChatGPT failed'
        ),
        updatedCredentials: changed ? creds : undefined,
      };
    }
  }
}
