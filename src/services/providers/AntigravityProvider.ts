import { AccountCredentials, UsageSnapshot } from '../../models/types';
import { isolatedFetch, readJsonSafe, readTextSafe } from '../http';
import {
  ANTIGRAVITY_OAUTH,
  AntigravityAuthError,
  fetchGoogleEmail,
  refreshAntigravityToken,
} from '../oauth/antigravityOAuth';
import { failureSnapshot, needsRefresh } from './common';
import { parseAntigravityQuotaSummary } from './antigravityQuota';
import { ProviderFetchResult, UsageProvider } from './UsageProvider';

export class AntigravityProvider implements UsageProvider {
  readonly id = 'antigravity';
  readonly type = 'antigravity' as const;
  readonly name = 'Antigravity';

  validateCredentials(c: AccountCredentials): boolean {
    return Boolean(c.refreshToken || c.accessToken);
  }

  async fetchUsage(accountId: string, c: AccountCredentials): Promise<ProviderFetchResult> {
    if (!this.validateCredentials(c)) {
      return {
        snapshot: failureSnapshot(accountId, 'antigravity', 'not_configured', 'Account not connected'),
      };
    }

    let creds: AccountCredentials = c;
    let changed = false;

    try {
      // Step 2: Token refresh check
      if (!creds.accessToken || needsRefresh(creds.expiresAt)) {
        if (!creds.refreshToken) {
          return {
            snapshot: failureSnapshot(
              accountId,
              'antigravity',
              'reauth_required',
              'Antigravity session expired — sign in again'
            ),
          };
        }
        try {
          creds = await refreshAntigravityToken(creds);
          changed = true;
        } catch (e: any) {
          if (e instanceof AntigravityAuthError) {
            return {
              snapshot: failureSnapshot(
                accountId,
                'antigravity',
                'reauth_required',
                e.message || 'Antigravity sign-in expired or was revoked — sign in again'
              ),
            };
          }
          return {
            snapshot: failureSnapshot(
              accountId,
              'antigravity',
              'error',
              'Could not refresh the Antigravity sign-in'
            ),
          };
        }
      }

      // Step 3: Profile (plan / project / email)
      const profileAge = Date.now() - (creds.profileFetchedAt || 0);
      if (!creds.plan || !creds.projectId || profileAge > 12 * 60 * 60 * 1000) {
        try {
          const profileHost = ANTIGRAVITY_OAUTH.quotaHosts[0];
          const profileResp = await isolatedFetch(`${profileHost}/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${creds.accessToken}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': ANTIGRAVITY_OAUTH.userAgent,
            },
            body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
          });
          if (profileResp.ok) {
            const data = await readJsonSafe(profileResp);
            const plan = data?.paidTier?.name ?? data?.currentTier?.name ?? 'Antigravity';
            const companion = data?.cloudaicompanionProject;
            const projectId = typeof companion === 'string' ? companion : companion?.id;
            creds = {
              ...creds,
              plan,
              projectId: projectId ?? creds.projectId,
              profileFetchedAt: Date.now(),
            };
            changed = true;
          }
        } catch {
          // A failed plan lookup is non-fatal: keep cached credentials
        }

        if (!creds.email && creds.accessToken) {
          try {
            const email = await fetchGoogleEmail(creds.accessToken);
            if (email) {
              creds = { ...creds, email };
              changed = true;
            }
          } catch {
            // Ignore email lookup failure
          }
        }
      }

      // Helper to post retrieveUserQuotaSummary
      const callQuota = (token: string, host: string) => {
        const bodyObj = creds.projectId ? { project: creds.projectId } : {};
        return isolatedFetch(`${host}/v1internal:retrieveUserQuotaSummary`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': ANTIGRAVITY_OAUTH.userAgent,
          },
          body: JSON.stringify(bodyObj),
        });
      };

      // Step 4 & 5: Loop over candidate hosts
      let resp: Response | undefined;
      let lastNetworkErr: any = null;
      let usedHost: string = ANTIGRAVITY_OAUTH.quotaHosts[0];

      for (const host of ANTIGRAVITY_OAUTH.quotaHosts) {
        usedHost = host;
        try {
          resp = await callQuota(creds.accessToken!, host);
        } catch (err) {
          lastNetworkErr = err;
          continue;
        }

        if (resp.status === 404 || resp.status >= 500) {
          continue;
        }
        break;
      }

      if (!resp) {
        throw lastNetworkErr || new Error('All quota hosts failed');
      }

      // Step 6: 401 retry with refresh
      if (resp.status === 401 && creds.refreshToken) {
        try {
          creds = await refreshAntigravityToken(creds);
          changed = true;
          resp = await callQuota(creds.accessToken!, usedHost);
        } catch (e: any) {
          if (e instanceof AntigravityAuthError) {
            return {
              snapshot: failureSnapshot(
                accountId,
                'antigravity',
                'reauth_required',
                e.message || 'Antigravity sign-in expired or was revoked — sign in again'
              ),
              updatedCredentials: changed ? creds : undefined,
            };
          }
          return {
            snapshot: failureSnapshot(
              accountId,
              'antigravity',
              'error',
              'Could not refresh the Antigravity sign-in'
            ),
            updatedCredentials: changed ? creds : undefined,
          };
        }
      }

      // Step 7: Map the final status per §2.3 table
      if (resp.status === 401) {
        return {
          snapshot: failureSnapshot(
            accountId,
            'antigravity',
            'reauth_required',
            'Antigravity sign-in expired — sign in again'
          ),
          updatedCredentials: changed ? creds : undefined,
        };
      }

      if (resp.status === 403) {
        const bodyText = await readTextSafe(resp);
        const isToS =
          /violation of terms of service/i.test(bodyText) ||
          /has been disabled/i.test(bodyText);
        return {
          snapshot: failureSnapshot(
            accountId,
            'antigravity',
            isToS ? 'reauth_required' : 'error',
            isToS
              ? 'Google has disabled Antigravity access for this account'
              : 'This Google account has no Antigravity access (HTTP 403)'
          ),
          updatedCredentials: changed ? creds : undefined,
        };
      }

      if (resp.status === 429) {
        return {
          snapshot: failureSnapshot(
            accountId,
            'antigravity',
            'rate_limited',
            'Too many requests — will retry later'
          ),
          updatedCredentials: changed ? creds : undefined,
        };
      }

      if (!resp.ok) {
        return {
          snapshot: failureSnapshot(
            accountId,
            'antigravity',
            'error',
            `Antigravity returned HTTP ${resp.status}`
          ),
          updatedCredentials: changed ? creds : undefined,
        };
      }

      // Step 8: Parse quota buckets
      const rawData = await readJsonSafe(resp);
      const buckets = parseAntigravityQuotaSummary(rawData);
      if (buckets.length === 0) {
        return {
          snapshot: failureSnapshot(
            accountId,
            'antigravity',
            'error',
            'Antigravity returned no quota buckets',
            creds.plan || 'Antigravity'
          ),
          updatedCredentials: changed ? creds : undefined,
        };
      }

      // Step 9: Return success snapshot
      const snapshot: UsageSnapshot = {
        accountId,
        providerType: 'antigravity',
        planName: creds.plan || 'Antigravity',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets,
        email: creds.email,
      };

      return {
        snapshot,
        updatedCredentials: changed ? creds : undefined,
      };
    } catch (err: any) {
      // Step 10: Error handling
      const aborted = err?.name === 'AbortError' || /timed out/i.test(err?.message || '');
      return {
        snapshot: failureSnapshot(
          accountId,
          'antigravity',
          'error',
          aborted ? 'Antigravity did not respond in time' : 'Network error while requesting Antigravity'
        ),
        updatedCredentials: changed ? creds : undefined,
      };
    }
  }
}
