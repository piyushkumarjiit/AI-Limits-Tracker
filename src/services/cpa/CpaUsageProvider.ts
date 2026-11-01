import {
  AccountCredentials,
  ProviderType,
  QuotaBucket,
  UsageSnapshot,
} from '../../models/types';
import { failureSnapshot } from '../providers/common';
import { ProviderFetchResult, UsageProvider } from '../providers/UsageProvider';
import { parseClaudeUsage } from '../providers/ClaudeProvider';
import { parseChatGPTUsage } from '../providers/ChatGPTProvider';
import { parseAntigravityQuotaSummary } from '../providers/antigravityQuota';
import { CpaTransport, CpaError } from './CpaTransport';
import { CpaApiCallResponse } from './types';
import { bucketsFromClaudeSignals, bucketsFromCodexSignals } from './signals';
import { CODEX_USER_AGENT, getAntigravityUserAgent } from './clientIdentity';

/** 10 minutes refresh cooldown per credential (§3.2). */
export const CPA_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

export function isTerminalQuarantineError(body: unknown): { isQuarantined: boolean; reason: string } {
  if (!body) return { isQuarantined: false, reason: '' };
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = str.toLowerCase();

  if (str.includes('TOS_VIOLATION') || lower.includes('tos_violation')) {
    return { isQuarantined: true, reason: 'Terms of Service violation (TOS_VIOLATION)' };
  }
  if (str.includes('invalid_grant') || lower.includes('invalid_grant')) {
    return { isQuarantined: true, reason: 'Token revoked or invalid grant (invalid_grant)' };
  }
  if (lower.includes('only authorized for use with claude code')) {
    return { isQuarantined: true, reason: 'Credential only authorized for use with Claude Code' };
  }
  if (lower.includes('account suspended') || lower.includes('account disabled') || lower.includes('account deactivated')) {
    return { isQuarantined: true, reason: 'Account suspended or disabled' };
  }
  if (lower.includes('out of extra usage')) {
    return { isQuarantined: true, reason: 'Out of extra usage' };
  }
  if (lower.includes('third-party apps now draw from')) {
    return { isQuarantined: true, reason: 'Third-party app extra usage exhausted' };
  }

  return { isQuarantined: false, reason: '' };
}

function makeQuarantinedCredentials(creds: AccountCredentials, reason: string): AccountCredentials {
  return {
    ...creds,
    authType: 'cpa',
    cpaAuthIndex: creds.cpaAuthIndex,
    cpaName: creds.cpaName,
    cpaProvider: creds.cpaProvider,
    cpaAccountId: creds.cpaAccountId,
    cpaProjectId: creds.cpaProjectId,
    cpaStatus: 'disabled',
    quarantined: true,
    quarantinedAt: new Date().toISOString(),
    quarantineReason: reason,
    cpaRisk: 'suspended',
  };
}

export interface RefreshGate {
  canRefresh(key: string, now?: number): boolean;
  markRefreshed(key: string, now?: number): void;
}

export class MemoryRefreshGate implements RefreshGate {
  private lastRefresh = new Map<string, number>();

  constructor(private readonly cooldownMs: number = CPA_REFRESH_COOLDOWN_MS) {}

  canRefresh(key: string, now: number = Date.now()): boolean {
    const last = this.lastRefresh.get(key);
    if (!last) return true;
    return now - last >= this.cooldownMs;
  }

  markRefreshed(key: string, now: number = Date.now()): void {
    this.lastRefresh.set(key, now);
  }
}

export interface CpaUsageProviderOptions {
  usePassiveSignals?: boolean;
}

/**
 * Universal UsageProvider for CLIProxyAPI (CPA) managed credentials.
 * Implements §2.4, §2.5, §3.2 of CLIProxy Quota Integration Spec.
 */
export class CpaUsageProvider implements UsageProvider {
  readonly id = 'cpa';
  readonly type: ProviderType = 'claude'; // default fallback for interface
  readonly name = 'CLIProxy Provider';

  private transport: CpaTransport;
  private refreshGate: RefreshGate;
  private usePassiveSignals: boolean;

  constructor(
    transport: CpaTransport,
    refreshGate?: RefreshGate,
    options?: CpaUsageProviderOptions
  ) {
    this.transport = transport;
    this.refreshGate = refreshGate ?? new MemoryRefreshGate();
    this.usePassiveSignals = options?.usePassiveSignals ?? false;
  }

  validateCredentials(credentials: AccountCredentials): boolean {
    if (credentials.authType !== 'cpa') return false;
    return Boolean(credentials.cpaAuthIndex || credentials.cpaName);
  }

  async fetchUsage(
    accountId: string,
    credentials: AccountCredentials
  ): Promise<ProviderFetchResult> {
    const creds = credentials;
    const provider = this.resolveProviderType(creds);

    // Guard: credentials must be valid CPA credentials
    if (!this.validateCredentials(creds)) {
      return {
        snapshot: failureSnapshot(
          accountId,
          provider,
          'error',
          'Missing cpaAuthIndex or cpaName'
        ),
      };
    }

    // Check if account has been marked quarantined or suspended
    if (creds.quarantined || creds.cpaRisk === 'suspended') {
      return {
        snapshot: failureSnapshot(
          accountId,
          provider,
          'quarantined',
          creds.quarantineReason || 'Account quarantined due to terminal error'
        ),
      };
    }

    // 1. Check if CPA credential state flags indicate reauth required without network call
    if (creds.cpaStatus === 'error' || creds.cpaStatus === 'disabled') {
      return {
        snapshot: failureSnapshot(
          accountId,
          provider,
          'reauth_required',
          `CPA credential status is ${creds.cpaStatus}`
        ),
      };
    }

    // 2. Try passive quota signals if enabled and fresh
    if (this.usePassiveSignals) {
      const passiveResult = this.tryPassiveSignals(accountId, creds, provider);
      if (passiveResult) {
        return passiveResult;
      }
    }

    // 3. Active probe via CpaTransport.apiCall
    return this.executeActiveProbe(accountId, creds, provider);
  }

  private resolveProviderType(creds: AccountCredentials): ProviderType {
    if (creds.cpaProvider) {
      const p = creds.cpaProvider.toLowerCase();
      if (p === 'claude') return 'claude';
      if (p === 'codex' || p === 'chatgpt') return 'chatgpt';
      if (p === 'antigravity') return 'antigravity';
    }
    return 'claude';
  }

  private tryPassiveSignals(
    accountId: string,
    creds: AccountCredentials,
    provider: ProviderType
  ): ProviderFetchResult | null {
    const signals = creds.cpaSignals ?? creds.cpaQuota?.signals;
    const observedAt = creds.cpaObservedAt ?? creds.cpaQuota?.observed_at;

    if (!signals || !observedAt) return null;

    let buckets: QuotaBucket[] = [];
    if (provider === 'claude') {
      buckets = bucketsFromClaudeSignals(signals, observedAt);
    } else if (provider === 'chatgpt') {
      buckets = bucketsFromCodexSignals(signals, observedAt);
    }

    if (buckets.length > 0) {
      const snapshot: UsageSnapshot = {
        accountId,
        providerType: provider,
        planName: creds.plan || '',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets,
      };
      return { snapshot };
    }

    return null;
  }

  private async executeActiveProbe(
    accountId: string,
    creds: AccountCredentials,
    provider: ProviderType,
    hasRetried = false
  ): Promise<ProviderFetchResult> {
    const authTarget = creds.cpaAuthIndex ? creds.cpaAuthIndex : creds.cpaName;

    try {
      let apiResp: CpaApiCallResponse;

      if (provider === 'claude') {
        apiResp = await this.probeClaude(creds);
      } else if (provider === 'chatgpt') {
        apiResp = await this.probeCodex(creds);
      } else if (provider === 'antigravity') {
        apiResp = await this.probeAntigravity(creds);
      } else {
        return {
          snapshot: failureSnapshot(
            accountId,
            provider,
            'error',
            `Unsupported CPA provider: ${provider}`
          ),
        };
      }

      // Handle response status
      if (apiResp.status_code >= 200 && apiResp.status_code < 300) {
        return this.parseProviderResponse(accountId, creds, provider, apiResp);
      }

      // Check for terminal quarantine patterns across 403, 400, or any non-2xx
      const quarantineCheck = isTerminalQuarantineError(apiResp.body);
      if (quarantineCheck.isQuarantined) {
        return {
          snapshot: failureSnapshot(
            accountId,
            provider,
            'quarantined',
            quarantineCheck.reason
          ),
          updatedCredentials: makeQuarantinedCredentials(creds, quarantineCheck.reason),
        };
      }

      // Handle 401 Unauthorized from upstream provider
      if (apiResp.status_code === 401) {
        return this.handleUpstream401(accountId, creds, provider, authTarget, hasRetried);
      }

      // Handle 403 Forbidden
      if (apiResp.status_code === 403) {
        return {
          snapshot: failureSnapshot(
            accountId,
            provider,
            'reauth_required',
            'Authentication forbidden (403)'
          ),
        };
      }

      // Handle 429 Rate Limited
      if (apiResp.status_code === 429) {
        return {
          snapshot: failureSnapshot(
            accountId,
            provider,
            'rate_limited',
            'Rate limit exceeded'
          ),
        };
      }

      // Handle 5xx Upstream Server Error
      if (apiResp.status_code >= 500) {
        return {
          snapshot: failureSnapshot(
            accountId,
            provider,
            'error',
            `Upstream server error (${apiResp.status_code})`
          ),
        };
      }

      // Other 4xx or unexpected status
      return {
        snapshot: failureSnapshot(
          accountId,
          provider,
          'error',
          `Upstream request failed with status ${apiResp.status_code}`
        ),
      };
    } catch (err: any) {
      // Check if caught error represents a terminal quarantine error
      const errQuarantine = isTerminalQuarantineError(err?.message || err?.body || String(err));
      if (errQuarantine.isQuarantined) {
        return {
          snapshot: failureSnapshot(
            accountId,
            provider,
            'quarantined',
            errQuarantine.reason
          ),
          updatedCredentials: makeQuarantinedCredentials(creds, errQuarantine.reason),
        };
      }

      if (err instanceof CpaError) {
        // Management 401 or 403 -> operator problem, surface as account error, NOT reauth_required and NO forceRefresh
        if (err.status === 401 || err.status === 403) {
          return {
            snapshot: failureSnapshot(
              accountId,
              provider,
              'error',
              'CPA management unauthorized'
            ),
          };
        }

        // CPA 400 "auth token not found" from $TOKEN$ -> maps to account reauth_required
        if (err.status === 400 && err.message.toLowerCase().includes('auth token not found')) {
          return {
            snapshot: failureSnapshot(
              accountId,
              provider,
              'reauth_required',
              'Authentication failed (auth token not found)'
            ),
          };
        }

        if (err.status === 429) {
          return {
            snapshot: failureSnapshot(
              accountId,
              provider,
              'rate_limited',
              'Rate limit exceeded'
            ),
          };
        }
      }

      // Distinguish unreachable / network errors
      const msg = err?.message || String(err);
      const isUnreachable =
        msg.includes('fetch failed') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('Failed to fetch') ||
        msg.includes('CLIProxy unreachable');

      return {
        snapshot: failureSnapshot(
          accountId,
          provider,
          'error',
          isUnreachable ? 'CLIProxy unreachable' : msg
        ),
      };
    }
  }

  private async handleUpstream401(
    accountId: string,
    creds: AccountCredentials,
    provider: ProviderType,
    authTarget: string | undefined,
    hasRetried: boolean
  ): Promise<ProviderFetchResult> {
    if (!hasRetried && authTarget && this.refreshGate.canRefresh(authTarget)) {
      this.refreshGate.markRefreshed(authTarget);
      try {
        await this.transport.forceRefresh(
          creds.cpaName ? creds.cpaName : (creds.cpaAuthIndex ? { auth_index: creds.cpaAuthIndex } : undefined),
          creds.cpaAuthIndex
        );
        return await this.executeActiveProbe(accountId, creds, provider, true);
      } catch (refreshErr: any) {
        const refreshQuarantine = isTerminalQuarantineError(refreshErr?.message || refreshErr?.body || String(refreshErr));
        if (refreshQuarantine.isQuarantined) {
          return {
            snapshot: failureSnapshot(
              accountId,
              provider,
              'quarantined',
              refreshQuarantine.reason
            ),
            updatedCredentials: makeQuarantinedCredentials(creds, refreshQuarantine.reason),
          };
        }
        return {
          snapshot: failureSnapshot(
            accountId,
            provider,
            'reauth_required',
            'Authentication failed, refresh attempt failed'
          ),
        };
      }
    }
    return {
      snapshot: failureSnapshot(
        accountId,
        provider,
        'reauth_required',
        hasRetried
          ? 'Authentication failed (401)'
          : 'CPA token stale; CPA refresh pending'
      ),
    };
  }

  private async probeClaude(creds: AccountCredentials): Promise<CpaApiCallResponse> {
    const headers: Record<string, string> = {
      Authorization: 'Bearer $TOKEN$',
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    };

    return this.transport.apiCall({
      url: 'https://api.anthropic.com/api/oauth/usage',
      method: 'GET',
      header: headers,
      auth_index: creds.cpaAuthIndex || creds.cpaName || '',
    });
  }

  private async probeCodex(creds: AccountCredentials): Promise<CpaApiCallResponse> {
    const headers: Record<string, string> = {
      Authorization: 'Bearer $TOKEN$',
      'User-Agent': CODEX_USER_AGENT,
      Accept: 'application/json',
      originator: 'codex_cli_rs',
    };

    if (creds.cpaAccountId) {
      headers['ChatGPT-Account-Id'] = creds.cpaAccountId;
    }

    return this.transport.apiCall({
      url: 'https://chatgpt.com/backend-api/wham/usage',
      method: 'GET',
      header: headers,
      auth_index: creds.cpaAuthIndex || creds.cpaName || '',
    });
  }

  private async probeAntigravity(creds: AccountCredentials): Promise<CpaApiCallResponse> {
    const projectId = creds.cpaProjectId || creds.projectId || '';
    const bodyObj: Record<string, unknown> = {};
    if (projectId) {
      bodyObj.project = projectId;
    }
    const body = JSON.stringify(bodyObj);

    const headers: Record<string, string> = {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': getAntigravityUserAgent(),
    };

    const quotaHosts = [
      'https://daily-cloudcode-pa.googleapis.com',
      'https://cloudcode-pa.googleapis.com',
    ];

    let lastErr: any = null;
    for (let i = 0; i < quotaHosts.length; i++) {
      const host = quotaHosts[i];
      try {
        const resp = await this.transport.apiCall({
          url: `${host}/v1internal:retrieveUserQuotaSummary`,
          method: 'POST',
          header: headers,
          data: body,
          auth_index: creds.cpaAuthIndex || creds.cpaName || '',
        });

        if (resp.status_code === 404 || resp.status_code >= 500) {
          // If not the last host, try fallback
          if (i < quotaHosts.length - 1) {
            continue;
          }
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (err instanceof CpaError && (err.status === 404 || err.status >= 500)) {
          if (i < quotaHosts.length - 1) {
            continue;
          }
        }
        if (i === quotaHosts.length - 1) {
          throw err;
        }
      }
    }

    throw lastErr || new Error('All quota hosts failed');
  }

  private parseProviderResponse(
    accountId: string,
    creds: AccountCredentials,
    provider: ProviderType,
    resp: CpaApiCallResponse
  ): ProviderFetchResult {
    let rawBody: any = null;
    if (resp.body) {
      try {
        rawBody = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body;
      } catch {
        rawBody = resp.body;
      }
    }

    let buckets: QuotaBucket[] = [];
    let planName = creds.plan || '';

    if (provider === 'claude') {
      buckets = parseClaudeUsage(rawBody);
    } else if (provider === 'chatgpt') {
      const parsed = parseChatGPTUsage(rawBody);
      buckets = parsed.buckets;
      if (parsed.plan) {
        planName = parsed.plan;
      }
    } else if (provider === 'antigravity') {
      buckets = parseAntigravityQuotaSummary(rawBody);
    }

    const snapshot: UsageSnapshot = {
      accountId,
      providerType: provider,
      planName,
      status: 'ok',
      fetchedAt: new Date().toISOString(),
      buckets,
    };

    const updatedCredentials: AccountCredentials | undefined =
      planName && planName !== creds.plan
        ? {
            ...creds,
            plan: planName,
            authType: 'cpa',
            cpaAuthIndex: creds.cpaAuthIndex,
            cpaName: creds.cpaName,
            cpaProvider: creds.cpaProvider,
            cpaAccountId: creds.cpaAccountId,
            cpaProjectId: creds.cpaProjectId,
          }
        : undefined;

    return {
      snapshot,
      updatedCredentials,
    };
  }
}

