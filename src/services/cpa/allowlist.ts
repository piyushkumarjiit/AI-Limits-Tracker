/**
 * Upstream host allowlist for CLIProxyAPI (CPA) /requests/api-call tunneling.
 * Implements §2.3 of CLIProxy Quota Integration Spec.
 */

export const ALLOWED_UPSTREAM_HOSTS: readonly string[] = Object.freeze([
  'api.anthropic.com',
  'chatgpt.com',
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
]);

/**
 * Validates that an upstream URL belongs to the allowed quota endpoint hosts.
 * Throws an Error if the URL is invalid, non-HTTPS, contains credentials, or targets an unauthorized host.
 *
 * @param url The absolute upstream URL string to validate
 * @returns The parsed URL object
 */
export function assertAllowedUpstream(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid upstream URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Upstream URL protocol must be https:, got ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Upstream URL must not contain credentials');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!ALLOWED_UPSTREAM_HOSTS.includes(hostname)) {
    throw new Error(`Upstream host '${hostname}' is not in the allowed quota endpoints`);
  }

  return parsed;
}
