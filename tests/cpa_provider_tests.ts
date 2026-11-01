import { CpaTransport, CpaError } from '../src/services/cpa/CpaTransport';
import { CpaUsageProvider, MemoryRefreshGate } from '../src/services/cpa/CpaUsageProvider';
import {
  bucketsFromClaudeSignals,
  bucketsFromCodexSignals,
  isSignalFresh,
  parseRatioOrPercent,
  parseResetEpochOrIso,
} from '../src/services/cpa/signals';
import { Account } from '../src/models/types';
import { CpaApiCallResponse } from '../src/services/cpa/types';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

function assertEquals<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// Mock transport helper
function createMockTransport(options: {
  apiCallMock?: (req: any) => Promise<CpaApiCallResponse>;
  forceRefreshMock?: (name?: any, authIndex?: string) => Promise<any>;
}): CpaTransport {
  const transport = new CpaTransport({ baseUrl: 'http://localhost:8317', managementKey: 'secret-key' });
  if (options.apiCallMock) {
    transport.apiCall = options.apiCallMock as any;
  }
  if (options.forceRefreshMock) {
    transport.forceRefresh = options.forceRefreshMock as any;
  }
  return transport;
}

async function runTests() {
  console.log('--- Running CPA Signals Tests ---');

  // Test isSignalFresh
  {
    const now = 1700000000000;
    assert(isSignalFresh(new Date(now - 10000).toISOString(), now), '10s old should be fresh');
    assert(isSignalFresh(new Date(now - 119000).toISOString(), now), '119s old should be fresh');
    assert(!isSignalFresh(new Date(now - 121000).toISOString(), now), '121s old should be stale');
    assert(isSignalFresh(String(Math.floor((now - 30000) / 1000)), now), 'epoch seconds should work');
    assert(!isSignalFresh('', now), 'empty string should be stale');
    assert(!isSignalFresh('invalid-date', now), 'invalid date should be stale');
  }

  // Test parseRatioOrPercent
  {
    assertEquals(parseRatioOrPercent('0.42'), 42, 'ratio 0.42 -> 42%');
    assertEquals(parseRatioOrPercent('0.425'), 42.5, 'ratio 0.425 -> 42.5%');
    assertEquals(parseRatioOrPercent('1.0'), 100, 'ratio 1.0 -> 100%');
    assertEquals(parseRatioOrPercent('42%'), 42, 'percent string 42% -> 42%');
    assertEquals(parseRatioOrPercent('85.5'), 85.5, 'number > 2.0 -> 85.5%');
    assertEquals(parseRatioOrPercent(undefined), null, 'undefined -> null');
    assertEquals(parseRatioOrPercent('invalid'), null, 'invalid -> null');
  }

  // Test parseResetEpochOrIso
  {
    const now = 1700000000000;
    const epochSec = 1700003600;
    assertEquals(
      parseResetEpochOrIso(String(epochSec), now),
      new Date(epochSec * 1000).toISOString(),
      'epoch seconds parsed to ISO'
    );
    const iso = '2025-01-01T12:00:00.000Z';
    assertEquals(parseResetEpochOrIso(iso, now), iso, 'iso string parsed');
    assertEquals(parseResetEpochOrIso('invalid', now), null, 'invalid reset -> null');
  }

  // Test bucketsFromClaudeSignals
  {
    const now = 1700000000000;
    const observedAt = new Date(now - 10000).toISOString();
    const signals = {
      'anthropic-ratelimit-unified-5h-utilization': '0.35',
      'anthropic-ratelimit-unified-5h-reset': '1700010000',
      'anthropic-ratelimit-unified-7d-utilization': '75%',
      'anthropic-ratelimit-unified-7d-reset': '2025-02-01T00:00:00Z',
    };
    const buckets = bucketsFromClaudeSignals(signals, observedAt, now);
    assertEquals(buckets.length, 2, 'Should extract 2 Claude buckets');
    assertEquals(buckets[0].id, 'five_hour', 'First bucket is five_hour');
    assertEquals(buckets[0].utilizationPercent, 35, '5h utilization is 35%');
    assertEquals(buckets[0].remainingPercent, 65, '5h remaining is 65%');
    assertEquals(buckets[0].severity, 'normal', '35% is normal severity');
    assertEquals(buckets[1].id, 'seven_day', 'Second bucket is seven_day');
    assertEquals(buckets[1].utilizationPercent, 75, '7d utilization is 75%');
    assertEquals(buckets[1].severity, 'warning', '75% is warning severity');
  }

  // Test bucketsFromClaudeSignals stale
  {
    const now = 1700000000000;
    const observedAt = new Date(now - 150000).toISOString(); // 150s old
    const signals = {
      'anthropic-ratelimit-unified-5h-utilization': '0.35',
    };
    const buckets = bucketsFromClaudeSignals(signals, observedAt, now);
    assertEquals(buckets.length, 0, 'Stale signals should produce 0 buckets');
  }

  // Test bucketsFromCodexSignals
  {
    const now = 1700000000000;
    const observedAt = new Date(now - 10000).toISOString();
    const signals = {
      'x-codex-primary-used-percent': '45',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1700010000',
      'x-codex-secondary-used-percent': '92',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1700500000',
      'x-codex-code-review-primary-used-percent': '10',
    };
    const buckets = bucketsFromCodexSignals(signals, observedAt, now);
    assertEquals(buckets.length, 3, 'Should extract 3 Codex buckets');
    assertEquals(buckets[0].id, 'primary', 'First bucket primary');
    assertEquals(buckets[0].utilizationPercent, 45, 'primary used 45%');
    assertEquals(buckets[0].label, 'Codex · 5h', 'primary label 5h');
    assertEquals(buckets[1].id, 'secondary', 'Second bucket secondary');
    assertEquals(buckets[1].utilizationPercent, 92, 'secondary used 92%');
    assertEquals(buckets[1].severity, 'critical', 'secondary severity critical');
    assertEquals(buckets[1].label, 'Codex · Weekly', 'secondary label Weekly');
    assertEquals(buckets[2].id, 'code_review', 'Third bucket code review');
    assertEquals(buckets[2].utilizationPercent, 10, 'cr used 10%');
  }

  console.log('--- Running CpaUsageProvider Tests ---');

  // Test 1: Guard - missing cpaAuthIndex and cpaName
  {
    const transport = createMockTransport({});
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = { authType: 'cpa' };
    const res = await provider.fetchUsage('acc-1', creds);
    assertEquals(res.snapshot.status, 'error', 'Missing credentials should return error');
    assert(res.snapshot.errorMessage?.includes('Missing cpaAuthIndex') ?? false, 'Helpful error message');
  }

  // Test 2: Passive signals fast-path
  {
    const transport = createMockTransport({
      apiCallMock: async () => {
        throw new Error('apiCall should not be invoked when fresh signals exist');
      },
    });
    const provider = new CpaUsageProvider(transport);
    const now = Date.now();
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'cpa-idx-1',
      cpaSignals: {
        'anthropic-ratelimit-unified-5h-utilization': '0.50',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 3600000) / 1000)),
      },
      cpaObservedAt: new Date(now - 5000).toISOString(),
    };
    const res = await provider.fetchUsage('acc-passive', creds);
    assertEquals(res.snapshot.status, 'ok', 'Status should be ok');
    assertEquals(res.snapshot.buckets.length, 1, 'One bucket parsed');
    assertEquals(res.snapshot.buckets[0].utilizationPercent, 50, 'Utilization 50%');
  }

  // Test 3: Active probe Claude
  {
    let interceptedReq: any = null;
    const transport = createMockTransport({
      apiCallMock: async (req) => {
        interceptedReq = req;
        return {
          status_code: 200,
          header: {},
          body: JSON.stringify({
            five_hour: { utilization: 25, resets_at: '2025-01-01T15:00:00Z' },
          }),
        };
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'claude-idx',
    };
    const res = await provider.fetchUsage('acc-claude', creds);
    assertEquals(res.snapshot.status, 'ok', 'Active probe status ok');
    assertEquals(interceptedReq?.header?.Authorization, 'Bearer $TOKEN$', 'Uses $TOKEN$ placeholder');
    assertEquals(interceptedReq?.header?.['anthropic-beta'], 'oauth-2025-04-20', 'Uses oauth beta header');
    assertEquals(res.snapshot.buckets.length, 1, '1 bucket parsed');
    assertEquals(res.snapshot.buckets[0].utilizationPercent, 25, '25% utilization');
  }

  // Test 4: Active probe Codex with ChatGPT-Account-Id
  {
    let interceptedReq: any = null;
    const transport = createMockTransport({
      apiCallMock: async (req) => {
        interceptedReq = req;
        return {
          status_code: 200,
          header: {},
          body: JSON.stringify({
            plan_type: 'team',
            rate_limit: {
              primary_window: {
                used_percent: 60,
                limit_window_seconds: 18000,
                reset_at: 1700005000,
              },
            },
          }),
        };
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'codex',
      cpaAuthIndex: 'codex-idx',
      cpaAccountId: 'org-12345',
    };
    const res = await provider.fetchUsage('acc-codex', creds);
    assertEquals(res.snapshot.status, 'ok', 'Active probe status ok');
    assertEquals(interceptedReq?.header?.Authorization, 'Bearer $TOKEN$', 'Uses $TOKEN$ placeholder');
    assertEquals(interceptedReq?.header?.['ChatGPT-Account-Id'], 'org-12345', 'Passes ChatGPT-Account-Id');
    assertEquals(res.snapshot.planName, 'Team', 'Parsed plan name Team');
    assertEquals(res.snapshot.buckets.length, 1, 'Parsed 1 bucket');
    assertEquals(res.snapshot.buckets[0].utilizationPercent, 60, '60% utilization');
    assertEquals(res.updatedCredentials?.plan, 'Team', 'Plan updated');
    assertEquals(res.updatedCredentials?.accessToken, undefined, 'Never exposes token in credentials');
  }

  // Test 5: Active probe Antigravity with 404 fallback
  {
    const requestedUrls: string[] = [];
    const transport = createMockTransport({
      apiCallMock: async (req) => {
        requestedUrls.push(req.url);
        if (req.url.includes('daily-cloudcode-pa')) {
          return { status_code: 404, header: {}, body: 'Not found' };
        }
        return {
          status_code: 200,
          header: {},
          body: JSON.stringify({
            groups: [
              {
                displayName: 'Gemini',
                buckets: [
                  {
                    bucketId: 'gemini-5h',
                    displayName: 'Five Hour Limit Remaining',
                    window: '5h',
                    remainingFraction: 0.8,
                    resetTime: '2026-11-01T03:00:00Z',
                  },
                ],
              },
            ],
          }),
        };
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'antigravity',
      cpaAuthIndex: 'anti-idx',
      cpaProjectId: 'project-999',
    };
    const res = await provider.fetchUsage('acc-antigravity', creds);
    assertEquals(requestedUrls.length, 2, 'Fallback should trigger second request');
    assert(requestedUrls[0].includes('daily-cloudcode-pa'), 'First url was daily endpoint');
    assert(requestedUrls[1].includes('cloudcode-pa.googleapis.com'), 'Second url was prod endpoint');
    assertEquals(res.snapshot.status, 'ok', 'Status ok after fallback');
    assert(Boolean(res.snapshot.buckets), 'res.snapshot.buckets exists');
    assertEquals(res.snapshot.buckets.length, 1, 'Parsed Antigravity bucket');
    assertEquals(res.snapshot.buckets[0].utilizationPercent, 20, '20% utilization');
  }

  // Test 6: 401 handling with RefreshGate and retry
  {
    let callCount = 0;
    let refreshCount = 0;
    const transport = createMockTransport({
      apiCallMock: async () => {
        callCount++;
        if (callCount === 1) {
          return { status_code: 401, header: {}, body: 'Unauthorized' };
        }
        return {
          status_code: 200,
          header: {},
          body: JSON.stringify({
            five_hour: { utilization: 10, resets_at: null },
          }),
        };
      },
      forceRefreshMock: async () => {
        refreshCount++;
        return { ok: true };
      },
    });

    const refreshGate = new MemoryRefreshGate(600000);
    const provider = new CpaUsageProvider(transport, refreshGate);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'claude-refresh-idx',
    };

    const res = await provider.fetchUsage('acc-refresh-success', creds);
    assertEquals(refreshCount, 1, 'Should call forceRefresh once');
    assertEquals(callCount, 2, 'Should retry probe once after refresh');
    assertEquals(res.snapshot.status, 'ok', 'Status should be ok after retry');
    assertEquals(res.snapshot.buckets[0].utilizationPercent, 10, '10% utilization');
  }

  // Test 7: 401 handling when cooldown active (prevent second refresh)
  {
    let callCount = 0;
    let refreshCount = 0;
    const transport = createMockTransport({
      apiCallMock: async () => {
        callCount++;
        return { status_code: 401, header: {}, body: 'Unauthorized' };
      },
      forceRefreshMock: async () => {
        refreshCount++;
        return { ok: true };
      },
    });

    const refreshGate = new MemoryRefreshGate(600000);
    // Mark as recently refreshed
    refreshGate.markRefreshed('claude-cooling-idx');

    const provider = new CpaUsageProvider(transport, refreshGate);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'claude-cooling-idx',
    };

    const res = await provider.fetchUsage('acc-cooling', creds);
    assertEquals(refreshCount, 0, 'Should not refresh when cooling down');
    assertEquals(callCount, 1, 'Only one apiCall made');
    assertEquals(res.snapshot.status, 'reauth_required', 'Status should be reauth_required');
    assertEquals(res.snapshot.errorMessage, 'CPA token stale; CPA refresh pending', 'Expected message');
  }

  // Test 8: 429 Rate limited mapping
  {
    const transport = createMockTransport({
      apiCallMock: async () => {
        return { status_code: 429, header: {}, body: 'Too Many Requests' };
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'rate-limit-idx',
    };
    const res = await provider.fetchUsage('acc-429', creds);
    assertEquals(res.snapshot.status, 'rate_limited', 'Status should be rate_limited');
  }

  // Test 9: 5xx Upstream Server Error mapping
  {
    const transport = createMockTransport({
      apiCallMock: async () => {
        return { status_code: 502, header: {}, body: 'Bad Gateway' };
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'error-idx',
    };
    const res = await provider.fetchUsage('acc-502', creds);
    assertEquals(res.snapshot.status, 'error', 'Status should be error');
    assert(res.snapshot.errorMessage?.includes('502') ?? false, 'Mentions 502');
  }

  // Test 10: Unreachable error mapping
  {
    const transport = createMockTransport({
      apiCallMock: async () => {
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:8317');
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'unreachable-idx',
    };
    const res = await provider.fetchUsage('acc-unreachable', creds);
    assertEquals(res.snapshot.status, 'error', 'Status should be error');
    assertEquals(res.snapshot.errorMessage, 'CLIProxy unreachable', 'Mapped to CLIProxy unreachable');
  }

  // Test 11: cpaStatus error or disabled directly produces reauth_required without network call
  {
    const transport = createMockTransport({
      apiCallMock: async () => {
        throw new Error('Should not make network call for error/disabled cpaStatus');
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'status-disabled-idx',
      cpaStatus: 'disabled',
    };
    const res = await provider.fetchUsage('acc-disabled', creds);
    assertEquals(res.snapshot.status, 'reauth_required', 'Status should be reauth_required');
    assert(res.snapshot.errorMessage?.includes('disabled') ?? false, 'Mentions disabled status');
  }

  // Test 12: validateCredentials
  {
    const transport = createMockTransport({});
    const provider = new CpaUsageProvider(transport);
    assertEquals(provider.validateCredentials({ authType: 'cpa', cpaAuthIndex: 'idx-1' }), true, 'cpa with authIndex is valid');
    assertEquals(provider.validateCredentials({ authType: 'cpa', cpaName: 'name-1' }), true, 'cpa with name is valid');
    assertEquals(provider.validateCredentials({ authType: 'cpa' }), false, 'cpa without authIndex/name is invalid');
    assertEquals(provider.validateCredentials({ authType: 'oauth', accessToken: 'token' }), false, 'non-cpa is invalid');
  }

  // Test 13: 403 Forbidden handling
  {
    const transport = createMockTransport({
      apiCallMock: async () => {
        return { status_code: 403, header: {}, body: 'Forbidden' };
      },
    });
    const provider = new CpaUsageProvider(transport);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'auth-403',
    };
    const res = await provider.fetchUsage('acc-403', creds);
    assertEquals(res.snapshot.status, 'reauth_required', '403 maps to reauth_required');
  }

  // Test 14: Second 401 after refresh returns reauth_required (max 1 retry)
  {
    let callCount = 0;
    let refreshCount = 0;
    const transport = createMockTransport({
      apiCallMock: async () => {
        callCount++;
        return { status_code: 401, header: {}, body: 'Unauthorized' };
      },
      forceRefreshMock: async () => {
        refreshCount++;
        return { ok: true };
      },
    });

    const refreshGate = new MemoryRefreshGate(600000);
    const provider = new CpaUsageProvider(transport, refreshGate);
    const creds: AccountCredentials = {
      authType: 'cpa',
      cpaProvider: 'claude',
      cpaAuthIndex: 'claude-double-401',
    };

    const res = await provider.fetchUsage('acc-double-401', creds);
    assertEquals(refreshCount, 1, 'Refreshed once');
    assertEquals(callCount, 2, 'Made 2 calls (initial + 1 retry)');
    assertEquals(res.snapshot.status, 'reauth_required', 'Failed retry gives reauth_required');
    assertEquals(res.snapshot.errorMessage, 'Authentication failed (401)', 'Expected error message');
  }

  console.log('All CPA provider tests passed successfully!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
