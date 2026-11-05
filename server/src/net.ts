import { lookup } from 'node:dns/promises';
import { setHostResolver, setMaxResponseBytes } from '../../src/services/http';

/** Largest body the server will read from an outbound request (1 MB). */
export const SERVER_RESPONSE_BYTES = 1024 * 1024;

/**
 * Installs the server-only outbound guard: every hostname is resolved before it
 * is fetched and refused when any address is private or reserved, and response
 * bodies are capped. Shared provider code stays environment-neutral; only the
 * server installs this guard.
 */
export function installServerNetworking(): void {
  setHostResolver(async (hostname) =>
    (await lookup(hostname, { all: true })).map((entry) => entry.address)
  );
  setMaxResponseBytes(SERVER_RESPONSE_BYTES);
}
