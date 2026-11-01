/**
 * Single source of truth for client User-Agent strings.
 * Ensures consistent client identity across all tracker outbound probes (§2.4 Architect Review).
 */

export const CODEX_USER_AGENT = 'codex_cli_rs/0.159.0 (terminal)';

/**
 * Derives Antigravity User-Agent dynamically from Node process platform and architecture.
 * Default version 2.24.0 matches CPA's fallback constant and changelist 1000335682.
 */
export function getAntigravityUserAgent(version = '2.24.0', cl = '1000335682'): string {
  const proc = (globalThis as any).process;
  const platform = proc?.platform;
  const procArch = proc?.arch;
  const osType = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : (platform || 'linux');
  const arch = procArch === 'x64' ? 'amd64' : procArch === 'arm64' ? 'arm64' : (procArch || 'arm64');
  return `antigravity/hub/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${cl})`;
}
