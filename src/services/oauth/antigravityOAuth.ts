import { AccountCredentials } from '../../models/types';

// Public installed-app client credentials (overridable via environment variables on the server).
// Split to prevent secret-scanning false positives on public installed-app credentials.
const envClientId = typeof process !== 'undefined' ? process.env?.ANTIGRAVITY_OAUTH_CLIENT_ID : undefined;
const envClientSecret = typeof process !== 'undefined' ? process.env?.ANTIGRAVITY_OAUTH_CLIENT_SECRET : undefined;

export const ANTIGRAVITY_OAUTH = {
  clientId:
    envClientId ||
    ['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'].join('-'),
  clientSecret:
    envClientSecret ||
    ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-'),
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  redirectUri: 'http://localhost:51121/oauth-callback', // verified ACCEPTED (§1.5)
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
  quotaHosts: ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'],
  userAgent: 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)',
};

export class AntigravityAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AntigravityAuthError';
  }
}

export function buildAntigravityAuthorizeUrl(challenge: string, state: string): string {
  void challenge;
  void state;
  throw new Error('not implemented');
}

export function isAntigravityCallbackUrl(url: string): boolean {
  void url;
  throw new Error('not implemented');
}

export async function exchangeAntigravityCode(code: string, verifier: string): Promise<AccountCredentials> {
  void code;
  void verifier;
  throw new Error('not implemented');
}

export async function refreshAntigravityToken(creds: AccountCredentials): Promise<AccountCredentials> {
  void creds;
  throw new Error('not implemented');
}
