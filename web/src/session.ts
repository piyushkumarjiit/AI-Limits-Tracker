/** Hostnames that are safe to reach over plain HTTP (the loopback interface). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * True when the panel was loaded over plain HTTP from a host other than the
 * loopback ones. In that case the session cookie cannot be sent with `Secure`
 * and travels unencrypted, so the UI warns about it.
 */
export function isInsecureContext(protocol: string, hostname: string): boolean {
  if (protocol !== 'http:') return false;
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return !LOOPBACK_HOSTS.has(host);
}

/** True for the current page. */
export function isInsecurePage(): boolean {
  return isInsecureContext(location.protocol, location.hostname);
}
