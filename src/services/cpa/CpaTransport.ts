/**
 * CpaTransport implements low-level HTTP transport communication with CLIProxyAPI (CPA).
 * Implements §2.2 of CLIProxy Quota Integration Spec.
 */

import { assertAllowedUpstream } from './allowlist';
import type {
  CpaApiCallRequest,
  CpaApiCallResponse,
  CpaCredential,
  CpaForceRefreshRequest,
  CpaForceRefreshResult,
  CpaListResponse,
  CpaPatchFieldsRequest,
  CpaRoutingStrategyResponse,
} from './types';

export class CpaError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'CpaError';
    this.status = status;
    this.code = code;
  }
}

export interface CpaTransportOptions {
  baseUrl: string;
  managementKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class CpaTransport {
  private readonly baseUrl: string;
  private readonly managementKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CpaTransportOptions) {
    let cleanBase = opts.baseUrl.trim();
    while (cleanBase.endsWith('/')) {
      cleanBase = cleanBase.slice(0, -1);
    }
    this.baseUrl = cleanBase;
    this.managementKey = opts.managementKey;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Internal wrapper for calling CPA management endpoints.
   */
  private async cpaFetch(
    path: string,
    init: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${cleanPath}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.managementKey}`,
      ...init.headers,
    };
    if (init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        redirect: 'error',
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorMessage = `CPA returned HTTP ${response.status}`;
        let errorCode: string | undefined;

        try {
          const bodyText = await response.text();
          if (bodyText) {
            try {
              const parsed = JSON.parse(bodyText);
              if (parsed && typeof parsed === 'object') {
                if (typeof parsed.error === 'string') {
                  errorMessage = parsed.error;
                } else if (typeof parsed.message === 'string') {
                  errorMessage = parsed.message;
                }
                if (typeof parsed.code === 'string') {
                  errorCode = parsed.code;
                }
              }
            } catch {
              // Not JSON; use raw text if short and safe
              const trimmed = bodyText.trim();
              if (trimmed.length > 0 && trimmed.length < 200) {
                errorMessage = trimmed;
              }
            }
          }
        } catch {
          // ignore error reading body
        }

        // Sanitize error message to ensure managementKey is never leaked
        if (this.managementKey) {
          errorMessage = errorMessage.split(this.managementKey).join('[REDACTED]');
        }

        throw new CpaError(response.status, errorMessage, errorCode);
      }

      return response;
    } catch (err) {
      if (err instanceof CpaError) {
        throw err;
      }
      let errMessage = err instanceof Error ? err.message : String(err);
      if (this.managementKey) {
        errMessage = errMessage.split(this.managementKey).join('[REDACTED]');
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CpaError(408, `CPA request timed out after ${this.timeoutMs}ms`);
      }
      throw new CpaError(500, `CPA transport error: ${errMessage}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Reads up to 1 MB of response text, throwing if the response exceeds 1 MB.
   */
  private async readResponseText(response: Response): Promise<string> {
    const limit = 1024 * 1024; // 1 MB
    if (!response.body) {
      const text = await response.text();
      if (text.length > limit) {
        throw new CpaError(500, `CPA response exceeded the ${limit} byte limit`);
      }
      return text;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            // reader might already be cancelled
          }
          throw new CpaError(500, `CPA response exceeded the ${limit} byte limit`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  /**
   * Tunnel an HTTP request to an upstream provider via CPA.
   * Path: POST /v8/management/requests/api-call (fallback to POST /v0/management/api-call).
   * URL must pass assertAllowedUpstream.
   */
  async apiCall(req: CpaApiCallRequest): Promise<CpaApiCallResponse> {
    assertAllowedUpstream(req.url);

    let response: Response;
    try {
      response = await this.cpaFetch('/v8/management/requests/api-call', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    } catch (err) {
      // If 404 on v8 route, fallback to v0 route
      if (err instanceof CpaError && err.status === 404) {
        response = await this.cpaFetch('/v0/management/api-call', {
          method: 'POST',
          body: JSON.stringify(req),
        });
      } else {
        throw err;
      }
    }

    const text = await this.readResponseText(response);
    try {
      return JSON.parse(text) as CpaApiCallResponse;
    } catch {
      throw new CpaError(500, 'Invalid JSON received from CPA api-call');
    }
  }

  /**
   * List credentials from CPA.
   * Path: GET /v8/management/credentials (fallback to GET /v0/management/auth-files).
   */
  async listCredentials(): Promise<CpaListResponse> {
    let response: Response;
    try {
      response = await this.cpaFetch('/v8/management/credentials');
    } catch (err) {
      if (err instanceof CpaError && err.status === 404) {
        response = await this.cpaFetch('/v0/management/auth-files');
      } else {
        throw err;
      }
    }

    const text = await this.readResponseText(response);
    try {
      return JSON.parse(text) as CpaListResponse;
    } catch {
      throw new CpaError(500, 'Invalid JSON received from CPA listCredentials');
    }
  }

  /**
   * Update metadata fields for a credential in CPA.
   * Path: PATCH /v8/management/credentials/fields (fallback to PATCH /v0/management/auth-files/fields).
   */
  async patchFields(req: CpaPatchFieldsRequest): Promise<void> {
    try {
      await this.cpaFetch('/v8/management/credentials/fields', {
        method: 'PATCH',
        body: JSON.stringify(req),
      });
    } catch (err) {
      if (err instanceof CpaError && err.status === 404) {
        await this.cpaFetch('/v0/management/auth-files/fields', {
          method: 'PATCH',
          body: JSON.stringify(req),
        });
      } else {
        throw err;
      }
    }
  }

  /**
   * Force refresh credential(s) in CPA.
   * Path: POST /v8/management/credentials/refresh (fallback to POST /v0/management/auth-files/refresh).
   */
  async forceRefresh(
    nameOrReq?: string | CpaForceRefreshRequest,
    authIndex?: string
  ): Promise<CpaForceRefreshResult> {
    const req: CpaForceRefreshRequest =
      typeof nameOrReq === 'string'
        ? { name: nameOrReq, auth_index: authIndex }
        : nameOrReq ?? (authIndex ? { auth_index: authIndex } : {});

    let response: Response;
    try {
      response = await this.cpaFetch('/v8/management/credentials/refresh', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    } catch (err) {
      if (err instanceof CpaError && err.status === 404) {
        response = await this.cpaFetch('/v0/management/auth-files/refresh', {
          method: 'POST',
          body: JSON.stringify(req),
        });
      } else {
        throw err;
      }
    }

    const text = await this.readResponseText(response);
    try {
      return JSON.parse(text) as CpaForceRefreshResult;
    } catch {
      throw new CpaError(500, 'Invalid JSON received from CPA forceRefresh');
    }
  }

  /**
   * Get routing strategy from CPA.
   * Path: GET /v0/management/routing/strategy.
   */
  async getRoutingStrategy(): Promise<string> {
    const response = await this.cpaFetch('/v0/management/routing/strategy');
    const text = await this.readResponseText(response);
    try {
      const parsed = JSON.parse(text) as CpaRoutingStrategyResponse;
      return parsed.strategy;
    } catch {
      throw new CpaError(500, 'Invalid JSON received from CPA getRoutingStrategy');
    }
  }
}
