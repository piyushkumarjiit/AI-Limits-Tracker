import { AntigravityProvider } from '../src/services/providers/AntigravityProvider';
import { getProvider } from '../src/services/providers';
import { parseManualInput } from '../src/services/curlParser';
import { ANTIGRAVITY_OAUTH } from '../src/services/oauth/antigravityOAuth';
import type { AccountCredentials } from '../src/models/types';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, extraInfo?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  ✗ [FAIL] ${testName} ${extraInfo ? `-> ${extraInfo}` : ''}`);
    console.log(
      `::error file=tests/antigravity_provider_tests.ts::[FAIL] ${testName} ${
        extraInfo ? `-> ${extraInfo.replace(/\r?\n/g, ' ')}` : ''
      }`
    );
  }
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  credentials?: string;
  body?: string;
}

/** Replaces global fetch with a router; returns the recorded calls. */
function mockFetch(handler: (url: string, init: any) => { status: number; body: any }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    calls.push({ url, headers: init.headers || {}, credentials: init.credentials, body: init.body });
    const { status, body } = handler(url, init);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as any;
  };
  return calls;
}

const FIXTURE = {
  groups: [
    {
      displayName: 'Gemini',
      buckets: [
        {
          bucketId: 'gemini-5h',
          displayName: 'Five Hour Limit Remaining',
          window: '5h',
          remainingFraction: 0.75,
          resetTime: '2026-11-01T03:00:00Z',
        },
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          remainingFraction: 0.4,
          resetTime: '2026-11-05T00:00:00Z',
        },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        {
          bucketId: '3p-5h',
          remainingFraction: 1,
        },
        {
          bucketId: '3p-weekly',
          remaining: { case: 'remainingFraction', value: 0.1 },
          resetTime: '2026-11-06T00:00:00Z',
        },
      ],
    },
    {
      displayName: 'Gemini Argon',
      buckets: [
        {
          bucketId: 'gemini-argon-weekly',
          remainingFraction: 0.9,
        },
        {
          bucketId: 'argon-legacy',
          disabled: true,
          remainingFraction: 0,
        },
      ],
    },
  ],
};

async function runAllTests() {
  const realFetch = globalThis.fetch;
  const provider = new AntigravityProvider();

  // Accumulate all error messages across tests for Case 17
  const observedErrorMessages: string[] = [];
  const recordError = (msg?: string) => {
    if (msg) observedErrorMessages.push(msg);
  };

  try {
    console.log('Antigravity provider unit tests');

    // Case 1: Valid access token (not expiring) + 200 FIXTURE
    // -> status 'ok', 5 buckets, no token call recorded, request carries Authorization: Bearer ya29.…,
    // User-Agent starting with antigravity/, and credentials:'omit'.
    {
      const recorded = mockFetch((url) => {
        if (url.includes('loadCodeAssist')) {
          return { status: 200, body: {} };
        }
        if (url.includes('retrieveUserQuotaSummary')) {
          return { status: 200, body: FIXTURE };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token-12345',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-1', creds);
      recordError(result.snapshot.errorMessage);

      const tokenCalls = recorded.filter((c) => c.url.includes('oauth2.googleapis.com/token'));
      const quotaCalls = recorded.filter((c) => c.url.includes('retrieveUserQuotaSummary'));

      assert(
        result.snapshot.status === 'ok' &&
          result.snapshot.buckets.length === 5 &&
          tokenCalls.length === 0 &&
          quotaCalls.length === 1 &&
          quotaCalls[0].headers['Authorization'] === 'Bearer ya29.valid-token-12345' &&
          quotaCalls[0].headers['User-Agent']?.startsWith('antigravity/') &&
          quotaCalls[0].credentials === 'omit',
        'Case 1: Valid access token + 200 FIXTURE -> status ok, 5 buckets, correct headers'
      );
    }

    // Case 2: Expired token -> the token endpoint is called first, then quota;
    // updatedCredentials.accessToken is the new value.
    {
      const callSequence: string[] = [];
      mockFetch((url) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          callSequence.push('token');
          return {
            status: 200,
            body: { access_token: 'ya29.refreshed-new-token', expires_in: 3600 },
          };
        }
        if (url.includes('retrieveUserQuotaSummary')) {
          callSequence.push('quota');
          return { status: 200, body: FIXTURE };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.expired-token',
        refreshToken: '1//refresh-token-val',
        expiresAt: Date.now() - 10000, // expired
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-2', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'ok' &&
          callSequence[0] === 'token' &&
          callSequence[1] === 'quota' &&
          result.updatedCredentials?.accessToken === 'ya29.refreshed-new-token',
        'Case 2: Expired token -> token endpoint called first, updatedCredentials carries new token'
      );
    }

    // Case 3: Refresh invalid_grant -> reauth_required, and the quota endpoint is never called.
    {
      const recorded = mockFetch((url) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return {
            status: 400,
            body: { error: 'invalid_grant', error_description: 'Token revoked' },
          };
        }
        if (url.includes('retrieveUserQuotaSummary')) {
          return { status: 200, body: FIXTURE };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.expired-token',
        refreshToken: '1//revoked-refresh-token',
        expiresAt: Date.now() - 10000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-3', creds);
      recordError(result.snapshot.errorMessage);

      const quotaCalls = recorded.filter((c) => c.url.includes('retrieveUserQuotaSummary'));

      assert(
        result.snapshot.status === 'reauth_required' && quotaCalls.length === 0,
        'Case 3: Refresh invalid_grant -> reauth_required, quota endpoint never called'
      );
    }

    // Case 4: Quota 401 then (after refresh) 200 -> ok, exactly 1 token call.
    {
      let quotaAttempt = 0;
      let tokenCallsCount = 0;
      mockFetch((url) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          tokenCallsCount++;
          return {
            status: 200,
            body: { access_token: 'ya29.fresh-after-401', expires_in: 3600 },
          };
        }
        if (url.includes('retrieveUserQuotaSummary')) {
          quotaAttempt++;
          if (quotaAttempt === 1) {
            return { status: 401, body: { error: 'unauthenticated' } };
          }
          return { status: 200, body: FIXTURE };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.initially-valid-seeming',
        refreshToken: '1//valid-refresh-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-4', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'ok' &&
          tokenCallsCount === 1 &&
          result.updatedCredentials?.accessToken === 'ya29.fresh-after-401',
        'Case 4: Quota 401 then 200 -> ok, exactly 1 token call'
      );
    }

    // Case 5: Quota 401 twice -> reauth_required.
    {
      let tokenCallsCount = 0;
      mockFetch((url) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          tokenCallsCount++;
          return {
            status: 200,
            body: { access_token: 'ya29.refreshed-but-still-bad', expires_in: 3600 },
          };
        }
        if (url.includes('retrieveUserQuotaSummary')) {
          return { status: 401, body: { error: 'still 401' } };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.token-1',
        refreshToken: '1//refresh-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-5', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'reauth_required' && tokenCallsCount === 1,
        'Case 5: Quota 401 twice -> reauth_required'
      );
    }

    // Case 6: Quota 403 with body "…has been disabled in this account for violation of Terms of Service…"
    // -> reauth_required, message mentions disabled.
    {
      mockFetch((url) => {
        if (url.includes('retrieveUserQuotaSummary')) {
          return {
            status: 403,
            body: 'Access has been disabled in this account for violation of Terms of Service.',
          };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-6', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'reauth_required' &&
          /disabled/i.test(result.snapshot.errorMessage || ''),
        'Case 6: Quota 403 Terms of Service violation -> reauth_required, message mentions disabled'
      );
    }

    // Case 7: Quota 403 other -> error.
    {
      mockFetch((url) => {
        if (url.includes('retrieveUserQuotaSummary')) {
          return {
            status: 403,
            body: { error: { message: 'The caller does not have permission' } },
          };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-7', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'error' &&
          /403/i.test(result.snapshot.errorMessage || ''),
        'Case 7: Quota 403 other -> error'
      );
    }

    // Case 8: Quota 429 -> rate_limited.
    {
      mockFetch((url) => {
        if (url.includes('retrieveUserQuotaSummary')) {
          return {
            status: 429,
            body: { error: 'rate limit exceeded' },
          };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-8', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'rate_limited',
        'Case 8: Quota 429 -> rate_limited'
      );
    }

    // Case 9: Daily host 503 + prod host 200 -> ok, two quota calls, the second to cloudcode-pa.googleapis.com.
    {
      const quotaCalls: string[] = [];
      mockFetch((url) => {
        if (url.includes('retrieveUserQuotaSummary')) {
          quotaCalls.push(url);
          if (url.includes('daily-cloudcode-pa')) {
            return { status: 503, body: 'Service Unavailable' };
          }
          return { status: 200, body: FIXTURE };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-9', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'ok' &&
          quotaCalls.length === 2 &&
          quotaCalls[0].includes('daily-cloudcode-pa.googleapis.com') &&
          quotaCalls[1].includes('cloudcode-pa.googleapis.com'),
        'Case 9: Daily host 503 + prod host 200 -> ok, two quota calls, second to cloudcode-pa'
      );
    }

    // Case 10: Both hosts throwing -> error.
    {
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes('retrieveUserQuotaSummary')) {
          throw new Error('Connection refused');
        }
        return {
          ok: false,
          status: 404,
          text: async () => '404',
          json: async () => ({}),
        };
      };

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-10', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'error' &&
          result.snapshot.errorMessage === 'Network error while requesting Antigravity',
        'Case 10: Both hosts throwing -> error'
      );
    }

    // Case 11: 200 {groups:[]} -> error, message no quota buckets.
    {
      mockFetch((url) => {
        if (url.includes('retrieveUserQuotaSummary')) {
          return { status: 200, body: { groups: [] } };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        plan: 'Antigravity',
        projectId: 'proj-1',
        profileFetchedAt: Date.now(),
      };

      const result = await provider.fetchUsage('acc-11', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'error' &&
          /no quota buckets/i.test(result.snapshot.errorMessage || ''),
        'Case 11: 200 {groups:[]} -> error, message mentions no quota buckets'
      );
    }

    // Case 12: loadCodeAssist {paidTier:{name:'Google AI Pro'},cloudaicompanionProject:'p-1'}
    // -> snapshot.planName 'Google AI Pro', updatedCredentials.projectId 'p-1', and quota request body is {"project":"p-1"}.
    {
      const recorded = mockFetch((url) => {
        if (url.includes('loadCodeAssist')) {
          return {
            status: 200,
            body: {
              paidTier: { name: 'Google AI Pro' },
              cloudaicompanionProject: 'p-1',
            },
          };
        }
        if (url.includes('retrieveUserQuotaSummary')) {
          return { status: 200, body: FIXTURE };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        // No plan, no projectId, profileFetchedAt = 0 -> triggers loadCodeAssist
      };

      const result = await provider.fetchUsage('acc-12', creds);
      recordError(result.snapshot.errorMessage);

      const quotaCalls = recorded.filter((c) => c.url.includes('retrieveUserQuotaSummary'));

      assert(
        result.snapshot.status === 'ok' &&
          result.snapshot.planName === 'Google AI Pro' &&
          result.updatedCredentials?.projectId === 'p-1' &&
          result.updatedCredentials?.plan === 'Google AI Pro' &&
          quotaCalls.length === 1 &&
          quotaCalls[0].body === JSON.stringify({ project: 'p-1' }),
        'Case 12: loadCodeAssist populates plan and project, quota body includes project'
      );
    }

    // Case 13: loadCodeAssist 500 -> still ok, planName 'Antigravity'.
    {
      mockFetch((url) => {
        if (url.includes('loadCodeAssist')) {
          return { status: 500, body: 'Server error' };
        }
        if (url.includes('retrieveUserQuotaSummary')) {
          return { status: 200, body: FIXTURE };
        }
        return { status: 404, body: 'not found' };
      });

      const creds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.valid-token',
        expiresAt: Date.now() + 3600 * 1000,
        // No plan -> loadCodeAssist fails with 500
      };

      const result = await provider.fetchUsage('acc-13', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'ok' &&
          result.snapshot.planName === 'Antigravity',
        'Case 13: loadCodeAssist 500 -> still ok, planName Antigravity'
      );
    }

    // Case 14: {} creds -> not_configured.
    {
      const creds: AccountCredentials = {};
      const result = await provider.fetchUsage('acc-14', creds);
      recordError(result.snapshot.errorMessage);

      assert(
        result.snapshot.status === 'not_configured' &&
          result.snapshot.errorMessage === 'Account not connected',
        'Case 14: {} creds -> not_configured'
      );
    }

    // Case 15: getProvider('antigravity') is an AntigravityProvider instance.
    {
      const p = getProvider('antigravity');
      assert(
        p instanceof AntigravityProvider &&
          p.id === 'antigravity' &&
          p.type === 'antigravity' &&
          p.name === 'Antigravity',
        'Case 15: getProvider("antigravity") is an AntigravityProvider instance'
      );
    }

    // Case 16: parseManualInput tests
    {
      const r1 = parseManualInput('1//0gABCDEFGHIJKLMNOPQRSTUV', 'antigravity');
      assert(
        r1.ok === true &&
          r1.credentials?.refreshToken === '1//0gABCDEFGHIJKLMNOPQRSTUV' &&
          r1.credentials?.authType === 'oauth',
        'Case 16a: parseManualInput refresh token regex'
      );

      const r2 = parseManualInput(
        '{"refresh_token":"1//0gABCDEFGHIJKLMNOPQRSTUV","access_token":"ya29.x12345678901234567890"}',
        'antigravity'
      );
      assert(
        r2.ok === true &&
          r2.credentials?.refreshToken === '1//0gABCDEFGHIJKLMNOPQRSTUV' &&
          r2.credentials?.accessToken === 'ya29.x12345678901234567890' &&
          r2.credentials?.authType === 'oauth',
        'Case 16b: parseManualInput JSON with both tokens'
      );

      const r3 = parseManualInput('ya29.' + 'a'.repeat(30), 'antigravity');
      assert(
        r3.ok === true &&
          r3.credentials?.accessToken === 'ya29.' + 'a'.repeat(30) &&
          typeof r3.credentials?.expiresAt === 'number' &&
          r3.credentials.expiresAt > Date.now(),
        'Case 16c: parseManualInput bare access token with expiresAt'
      );

      const r4 = parseManualInput('hello', 'antigravity');
      recordError(r4.error);
      assert(r4.ok === false, 'Case 16d: parseManualInput hello -> ok false');

      const r5 = parseManualInput('{bad', 'antigravity');
      recordError(r5.error);
      assert(r5.ok === false, 'Case 16e: parseManualInput {bad -> ok false');

      const r6 = parseManualInput('a'.repeat(20000), 'antigravity');
      recordError(r6.error);
      assert(r6.ok === false, 'Case 16f: parseManualInput 20 KB -> ok false');
    }

    // Case 17: No error message from any test case contains the substrings ya29. or 1// (no token leakage).
    {
      const leaked = observedErrorMessages.filter((msg) => {
        // Exclude the static hint from parseManualInput which guides the user that tokens start with 1//
        const cleaned = msg.replace('starts with 1//', '');
        return cleaned.includes('1//') || cleaned.includes('ya29.');
      });
      assert(
        leaked.length === 0,
        'Case 17: No error message from any test case contains the substrings ya29. or 1// (no token leakage)',
        leaked.join('; ')
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${totalTests - failedTests}/${totalTests} passed`);
  if (failedTests > 0) process.exit(1);
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
