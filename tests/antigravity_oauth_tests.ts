import {
  ANTIGRAVITY_OAUTH,
  AntigravityAuthError,
  buildAntigravityAuthorizeUrl,
  exchangeAntigravityCode,
  fetchGoogleEmail,
  isAntigravityCallbackUrl,
  refreshAntigravityToken,
  tokensToCredentials,
} from '../src/services/oauth/antigravityOAuth';
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
      `::error file=tests/antigravity_oauth_tests.ts::[FAIL] ${testName} ${
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

async function runAllTests() {
  const realFetch = globalThis.fetch;
  try {
    console.log('Antigravity OAuth unit tests');

    // Case 1: buildAntigravityAuthorizeUrl('CH', 'ST')
    {
      const url = buildAntigravityAuthorizeUrl('CH', 'ST');
      assert(
        url.startsWith(ANTIGRAVITY_OAUTH.authorizeUrl + '?') &&
          url.includes('client_id=1071006060591-') &&
          url.includes(`redirect_uri=${encodeURIComponent('http://localhost:51121/oauth-callback')}`) &&
          url.includes('code_challenge=CH') &&
          url.includes('code_challenge_method=S256') &&
          url.includes('state=ST') &&
          url.includes('access_type=offline') &&
          url.includes('prompt=consent') &&
          url.includes('scope=') &&
          url.includes(encodeURIComponent('https://www.googleapis.com/auth/cloud-platform')),
        'Case 1: buildAntigravityAuthorizeUrl contains required parameters and scopes'
      );
    }

    // Case 2: isAntigravityCallbackUrl
    {
      assert(
        isAntigravityCallbackUrl('http://localhost:51121/oauth-callback?code=abc&state=x') === true,
        'Case 2a: localhost callback recognized'
      );
      assert(
        isAntigravityCallbackUrl('http://127.0.0.1:51121/oauth-callback?code=abc&state=x') === true,
        'Case 2b: 127.0.0.1 callback recognized'
      );
      assert(
        isAntigravityCallbackUrl('http://localhost:1455/auth/callback?code=a') === false,
        'Case 2c: non-antigravity callback rejected'
      );
      assert(
        isAntigravityCallbackUrl('http://localhost:51121/oauth-callback?state=x') === false,
        'Case 2d: callback without code rejected'
      );
    }

    // Case 3: Exchange success
    {
      const recorded = mockFetch((url) => {
        if (url === ANTIGRAVITY_OAUTH.tokenUrl) {
          return {
            status: 200,
            body: { access_token: 'ya29.A', refresh_token: '1//R', expires_in: 3599 },
          };
        }
        if (url === ANTIGRAVITY_OAUTH.userInfoUrl) {
          return {
            status: 200,
            body: { email: 'u@x.com' },
          };
        }
        return { status: 404, body: 'not found' };
      });

      const before = Date.now();
      const creds = await exchangeAntigravityCode('code123', 'verifier456');
      const after = Date.now();

      const tokenCall = recorded.find((c) => c.url === ANTIGRAVITY_OAUTH.tokenUrl);
      const params = new URLSearchParams(tokenCall?.body || '');

      assert(
        creds.authType === 'oauth' &&
          creds.accessToken === 'ya29.A' &&
          creds.refreshToken === '1//R' &&
          creds.email === 'u@x.com' &&
          typeof creds.expiresAt === 'number' &&
          Math.abs(creds.expiresAt - (before + 3599 * 1000)) <= 5000 &&
          tokenCall?.credentials === 'omit' &&
          params.get('grant_type') === 'authorization_code' &&
          params.get('code_verifier') === 'verifier456' &&
          Boolean(params.get('client_secret')),
        'Case 3: Exchange success maps credentials and sends authorization_code payload with credentials: omit'
      );
    }

    // Case 4: Exchange without refresh_token -> throws containing 'refresh token'
    {
      mockFetch((url) => {
        if (url === ANTIGRAVITY_OAUTH.tokenUrl) {
          return {
            status: 200,
            body: { access_token: 'ya29.A', expires_in: 3599 },
          };
        }
        return { status: 200, body: {} };
      });

      let thrownMessage = '';
      try {
        await exchangeAntigravityCode('code123', 'verifier456');
      } catch (e: any) {
        thrownMessage = String(e?.message || e);
      }
      assert(
        thrownMessage.toLowerCase().includes('refresh token'),
        'Case 4: Exchange without refresh_token throws an error mentioning refresh token'
      );
    }

    // Case 5: Refresh success keeps old refreshToken when omitted and updates accessToken
    {
      mockFetch((url) => {
        if (url === ANTIGRAVITY_OAUTH.tokenUrl) {
          return {
            status: 200,
            body: { access_token: 'ya29.NEW', expires_in: 3600 },
          };
        }
        return { status: 404, body: {} };
      });

      const oldCreds: AccountCredentials = {
        authType: 'oauth',
        accessToken: 'ya29.OLD',
        refreshToken: '1//OLD_REFRESH',
        email: 'user@example.com',
      };

      const refreshed = await refreshAntigravityToken(oldCreds);
      assert(
        refreshed.accessToken === 'ya29.NEW' &&
          refreshed.refreshToken === '1//OLD_REFRESH' &&
          refreshed.authType === 'oauth' &&
          refreshed.email === 'user@example.com',
        'Case 5: Refresh success preserves previous refresh_token and updates accessToken'
      );
    }

    // Case 6: Refresh {error:'invalid_grant'} with status 400 -> throws AntigravityAuthError
    {
      mockFetch((url) => {
        if (url === ANTIGRAVITY_OAUTH.tokenUrl) {
          return {
            status: 400,
            body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          };
        }
        return { status: 404, body: {} };
      });

      let thrownErr: any = null;
      try {
        await refreshAntigravityToken({
          authType: 'oauth',
          refreshToken: '1//REVOKED',
        });
      } catch (e: any) {
        thrownErr = e;
      }
      assert(
        thrownErr instanceof AntigravityAuthError && thrownErr.name === 'AntigravityAuthError',
        'Case 6: Refresh with invalid_grant throws AntigravityAuthError'
      );
    }

    // Case 7: Refresh with status 500 -> throws plain Error (not AntigravityAuthError)
    {
      mockFetch((url) => {
        if (url === ANTIGRAVITY_OAUTH.tokenUrl) {
          return {
            status: 500,
            body: { error: 'internal_server_error' },
          };
        }
        return { status: 404, body: {} };
      });

      let thrownErr: any = null;
      try {
        await refreshAntigravityToken({
          authType: 'oauth',
          refreshToken: '1//SERVER_FAIL',
        });
      } catch (e: any) {
        thrownErr = e;
      }
      assert(
        thrownErr instanceof Error && !(thrownErr instanceof AntigravityAuthError),
        'Case 7: Refresh with status 500 throws plain Error, not AntigravityAuthError'
      );
    }

    // Case 8: Refresh with no refreshToken -> AntigravityAuthError
    {
      let thrownErr: any = null;
      try {
        await refreshAntigravityToken({
          authType: 'oauth',
          accessToken: 'ya29.NO_REFRESH',
        });
      } catch (e: any) {
        thrownErr = e;
      }
      assert(
        thrownErr instanceof AntigravityAuthError && thrownErr.name === 'AntigravityAuthError',
        'Case 8: Refresh with no refreshToken throws AntigravityAuthError'
      );
    }

    // Case 9: userinfo 401 -> exchangeAntigravityCode still succeeds with email undefined
    {
      mockFetch((url) => {
        if (url === ANTIGRAVITY_OAUTH.tokenUrl) {
          return {
            status: 200,
            body: { access_token: 'ya29.A', refresh_token: '1//R', expires_in: 3600 },
          };
        }
        if (url === ANTIGRAVITY_OAUTH.userInfoUrl) {
          return {
            status: 401,
            body: { error: 'unauthorized' },
          };
        }
        return { status: 404, body: {} };
      });

      const creds = await exchangeAntigravityCode('code123', 'verifier456');
      assert(
        creds.authType === 'oauth' &&
          creds.accessToken === 'ya29.A' &&
          creds.refreshToken === '1//R' &&
          creds.email === undefined,
        'Case 9: userinfo 401 allows exchangeAntigravityCode to succeed with email undefined'
      );
    }

    console.log(`\n${passedTests}/${totalTests} passed`);
    if (failedTests > 0) process.exit(1);
  } finally {
    globalThis.fetch = realFetch;
  }
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
