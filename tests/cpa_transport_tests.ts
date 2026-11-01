import assert from 'node:assert/strict';
import { resolveCpaConfig, validateCpaConfig } from '../server/src/config';
import { assertAllowedUpstream } from '../src/services/cpa/allowlist';
import { CpaError, CpaTransport } from '../src/services/cpa/CpaTransport';

console.log('Running CPA transport and configuration tests...');

// 1. Config validation tests
{
  // Clean default env (CPA unset) is valid
  const emptyCpa = validateCpaConfig({});
  assert.equal(emptyCpa.length, 0, 'Empty env produces no CPA errors');
  assert.equal(resolveCpaConfig({}), null, 'Empty env resolves to null CpaConfig');

  // CPA_BASE_URL set without CPA_MANAGEMENT_KEY
  const missingKey = validateCpaConfig({ CPA_BASE_URL: 'http://127.0.0.1:8313' });
  assert(missingKey.some((e) => e.includes('CPA_MANAGEMENT_KEY')), 'Rejects missing management key');

  // CPA_MANAGEMENT_KEY set without CPA_BASE_URL
  const missingUrl = validateCpaConfig({ CPA_MANAGEMENT_KEY: 'secret-key-123' });
  assert(missingUrl.some((e) => e.includes('CPA_BASE_URL')), 'Rejects missing base url');

  // Plain http on public address rejected
  const publicHttp = validateCpaConfig({
    CPA_BASE_URL: 'http://api.example.com',
    CPA_MANAGEMENT_KEY: 'secret-key-123',
  });
  assert(publicHttp.some((e) => e.includes('plain http: is only allowed')), 'Rejects public http URL');

  // Plain http on 127.0.0.1, localhost, 10.x, 192.168.x allowed
  for (const host of ['http://127.0.0.1:8313', 'http://localhost:8313', 'http://10.1.2.3:8000', 'http://192.168.1.50:8080', 'http://172.20.0.5:8080', 'https://cpa.example.com']) {
    const valid = validateCpaConfig({
      CPA_BASE_URL: host,
      CPA_MANAGEMENT_KEY: 'secret-key-123',
    });
    assert.equal(valid.length, 0, `Accepts valid URL ${host}`);
  }

  // URL with credentials rejected
  const withCreds = validateCpaConfig({
    CPA_BASE_URL: 'http://user:pass@127.0.0.1:8313',
    CPA_MANAGEMENT_KEY: 'secret-key-123',
  });
  assert(withCreds.some((e) => e.includes('credentials')), 'Rejects credentials in URL');

  // Timeout and poll bounds
  const outOfBounds = validateCpaConfig({
    CPA_BASE_URL: 'http://127.0.0.1:8313',
    CPA_MANAGEMENT_KEY: 'secret-key-123',
    CPA_TIMEOUT_MS: '500',
    CPA_POLL_INTERVAL_SEC: '2',
  });
  assert(outOfBounds.some((e) => e.includes('CPA_TIMEOUT_MS')), 'Rejects timeout < 1000ms');
  assert(outOfBounds.some((e) => e.includes('CPA_POLL_INTERVAL_SEC')), 'Rejects poll < 5s');

  // Successful resolution
  const resolved = resolveCpaConfig({
    CPA_BASE_URL: 'http://127.0.0.1:8313/',
    CPA_MANAGEMENT_KEY: 'secret-key-123',
    CPA_TIMEOUT_MS: '15000',
    CPA_POLL_INTERVAL_SEC: '30',
  });
  assert.deepEqual(resolved, {
    baseUrl: 'http://127.0.0.1:8313',
    managementKey: 'secret-key-123',
    timeoutMs: 15000,
    pollIntervalSec: 30,
  });
}

// 2. Allowlist tests
{
  assert.doesNotThrow(() => assertAllowedUpstream('https://api.anthropic.com/v1/messages'));
  assert.doesNotThrow(() => assertAllowedUpstream('https://chatgpt.com/backend-api/lat/rpts'));
  assert.doesNotThrow(() => assertAllowedUpstream('https://daily-cloudcode-pa.googleapis.com/v1/projects'));
  assert.doesNotThrow(() => assertAllowedUpstream('https://cloudcode-pa.googleapis.com/v1/projects'));

  // Disallowed hosts
  assert.throws(
    () => assertAllowedUpstream('https://evil.com/api'),
    /Upstream host 'evil.com' is not in the allowed quota endpoints/
  );
  // Disallowed scheme
  assert.throws(
    () => assertAllowedUpstream('http://api.anthropic.com/v1/messages'),
    /Upstream URL protocol must be https:/
  );
  // Credentials in URL
  assert.throws(
    () => assertAllowedUpstream('https://user:pass@api.anthropic.com/v1/messages'),
    /Upstream URL must not contain credentials/
  );
}

// 3. CpaTransport HTTP tunneling & API calls
async function testTransport() {
  const secretKey = 'super-secret-mgmt-key-999';

  // 3a. apiCall successful
  {
    const calls: Array<{ url: string; headers: Headers; body: string | undefined }> = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url, headers, body: init?.body as string });
      return new Response(
        JSON.stringify({
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: JSON.stringify({ rate_limit: 'ok' }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const transport = new CpaTransport({
      baseUrl: 'http://127.0.0.1:8313',
      managementKey: secretKey,
      fetchImpl: mockFetch,
    });

    const res = await transport.apiCall({
      auth_index: 'auth-1',
      method: 'GET',
      url: 'https://api.anthropic.com/v1/models',
    });

    assert.equal(res.status_code, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8313/v8/management/requests/api-call');
    assert.equal(calls[0].headers.get('Authorization'), `Bearer ${secretKey}`);
    const reqBody = JSON.parse(calls[0].body!);
    assert.equal(reqBody.auth_index, 'auth-1');
  }

  // 3b. Fallback from v8 route (404) to v0 route
  {
    const calledUrls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calledUrls.push(url);
      if (url.includes('/v8/management/requests/api-call')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(
        JSON.stringify({
          status_code: 200,
          header: {},
          body: '{"v0":true}',
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const transport = new CpaTransport({
      baseUrl: 'http://127.0.0.1:8313',
      managementKey: secretKey,
      fetchImpl: mockFetch,
    });

    const res = await transport.apiCall({
      auth_index: 'auth-2',
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/lat/rpts',
    });

    assert.equal(res.status_code, 200);
    assert.equal(calledUrls.length, 2);
    assert.equal(calledUrls[0], 'http://127.0.0.1:8313/v8/management/requests/api-call');
    assert.equal(calledUrls[1], 'http://127.0.0.1:8313/v0/management/api-call');
  }

  // 3c. listCredentials, patchFields, forceRefresh, getRoutingStrategy
  {
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/credentials')) {
        return new Response(
          JSON.stringify({
            observed_at: '2026-11-01T00:00:00Z',
            files: [
              {
                auth_index: 'idx-1',
                name: 'cpa-ant-1.json',
                provider: 'anthropic',
                status: 'active',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/credentials/fields') && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/credentials/refresh') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/routing/strategy')) {
        return new Response(JSON.stringify({ strategy: 'round-robin' }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const transport = new CpaTransport({
      baseUrl: 'http://127.0.0.1:8313',
      managementKey: secretKey,
      fetchImpl: mockFetch,
    });

    const list = await transport.listCredentials();
    assert.equal(list.files.length, 1);
    assert.equal(list.files[0].auth_index, 'idx-1');

    await assert.doesNotReject(() => transport.patchFields({ name: 'cpa-ant-1.json', priority: 1 }));
    const refRes = await transport.forceRefresh({ name: 'cpa-ant-1.json' });
    assert.equal(refRes.ok, true);

    const strat = await transport.getRoutingStrategy();
    assert.equal(strat, 'round-robin');
  }

  // 3d. Secret sanitization in error messages
  {
    const mockFetch = (async () => {
      // Simulate CPA server echoing back authorization token or secret in error
      return new Response(
        JSON.stringify({ error: `Unauthorized access with key: ${secretKey}` }),
        { status: 401 }
      );
    }) as typeof fetch;

    const transport = new CpaTransport({
      baseUrl: 'http://127.0.0.1:8313',
      managementKey: secretKey,
      fetchImpl: mockFetch,
    });

    try {
      await transport.listCredentials();
      assert.fail('Should have thrown CpaError');
    } catch (err) {
      assert(err instanceof CpaError);
      assert.equal(err.status, 401);
      assert(!err.message.includes(secretKey), 'Secret key must NOT appear in error message');
      assert(err.message.includes('[REDACTED]'), 'Secret key should be replaced with [REDACTED]');
    }
  }

  // 3e. Oversized response cap (1 MB)
  {
    const mockFetch = (async () => {
      // Create stream yielding > 1 MB
      const bigString = 'x'.repeat(1024 * 1024 + 50);
      return new Response(bigString, { status: 200 });
    }) as typeof fetch;

    const transport = new CpaTransport({
      baseUrl: 'http://127.0.0.1:8313',
      managementKey: secretKey,
      fetchImpl: mockFetch,
    });

    try {
      await transport.getRoutingStrategy();
      assert.fail('Should have failed on oversized response');
    } catch (err) {
      assert(err instanceof CpaError);
      assert(err.message.includes('limit'), 'Error mentions limit');
    }
  }

  // 3f. Timeout handling
  {
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    }) as typeof fetch;

    const transport = new CpaTransport({
      baseUrl: 'http://127.0.0.1:8313',
      managementKey: secretKey,
      timeoutMs: 50,
      fetchImpl: mockFetch,
    });

    try {
      await transport.getRoutingStrategy();
      assert.fail('Should have timed out');
    } catch (err) {
      assert(err instanceof CpaError);
      assert.equal(err.status, 408);
      assert(err.message.includes('timed out'), 'Error indicates timeout');
    }
  }
}

testTransport()
  .then(() => {
    console.log('All CPA transport tests passed successfully!');
  })
  .catch((err) => {
    console.error('Test failure:', err);
    process.exit(1);
  });
