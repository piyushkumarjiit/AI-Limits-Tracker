import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/src/store';
import { CpaWatermarkService } from '../server/src/cpaWatermarkService';
import { CpaPolicyLoader, FullWatermarkPolicy, DEFAULT_WATERMARK_POLICY } from '../server/src/cpaWatermarkPolicy';
import { CpaWatermarkStore } from '../server/src/cpaWatermarkStore';
import { CpaTransport } from '../src/services/cpa/CpaTransport';
import { CpaCredential } from '../src/services/cpa/types';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function pass(name: string) {
  totalTests++;
  passedTests++;
  console.log(`  ✓ [PASS] ${name}`);
}

function fail(name: string, error: unknown) {
  totalTests++;
  failedTests++;
  console.error(`  ✗ [FAIL] ${name}`);
  console.error(error);
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

function assertEquals<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

const APP_SECRET = '0123456789abcdef0123456789abcdef';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cpa-watermark-service-test-'));
}

class MockPolicyLoader extends CpaPolicyLoader {
  constructor(private customPolicy: FullWatermarkPolicy) {
    super();
  }
  public override getPolicy(): FullWatermarkPolicy {
    return structuredClone(this.customPolicy);
  }
}

async function runTests() {
  console.log('\n========================================================');
  console.log('  CPA WATERMARK SERVICE RUNTIME & READ-BACK TESTS (WP-3)');
  console.log('========================================================\n');

  // --------------------------------------------------------------------------
  // Suite 1: Single-flight serialization of concurrent run() calls
  // --------------------------------------------------------------------------
  console.log('Suite 1: Single-Flight Serialization of Concurrent run() Calls');
  try {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    let patchCount = 0;
    let strategyCount = 0;
    let listCount = 0;

    const mockTransport = {
      async getRoutingStrategy() {
        strategyCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'weighted-round-robin';
      },
      async listCredentials() {
        listCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [
          { name: 'claude-1.json', weight: 50, type: 'claude' },
        ];
      },
      async patchCredentialWeight(_name: string, _weight: number) {
        patchCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
    } as unknown as CpaTransport;

    const policy: FullWatermarkPolicy = {
      ...DEFAULT_WATERMARK_POLICY,
      mode: 'enforce',
      classificationRules: [
        { pattern: 'claude-*', provider: 'claude', tier: 'pro', modality: 'subscription_pool', managed: true },
      ],
    };
    const policyLoader = new MockPolicyLoader(policy);

    store.upsertAccount({
      id: 'acc-1',
      name: 'Claude Account 1',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-1',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 80,
            utilizationPercent: 20,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: false,
            severity: 'healthy',
          },
        ],
      },
    });

    store.upsertCpaLink({
      accountId: 'acc-1',
      cpaName: 'claude-1.json',
      authIndex: 'idx-1',
      identityKey: 'claude:idx-1',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 50, managed: true }),
    });

    const service = new CpaWatermarkService({
      store,
      transport: mockTransport,
      policyLoader,
    });

    // Launch 3 concurrent runs
    const [res1, res2, res3] = await Promise.all([
      service.run(),
      service.run(),
      service.run(),
    ]);

    assertEquals(res1.mode, 'enforce', 'Result mode is enforce');
    assertEquals(res1, res2, 'res1 and res2 share identical run promise');
    assertEquals(res2, res3, 'res2 and res3 share identical run promise');
    assertEquals(strategyCount, 1, 'Only 1 getRoutingStrategy call made during concurrent run');
    // listCredentials called once during run and once during read-back verification
    assert(listCount <= 2, 'listCredentials not executed redundantly');
    assertEquals(patchCount, 1, 'Only 1 patch executed across concurrent runs');

    pass('Single-flight guarantee serializes overlapping run() invocations');
  } catch (err) {
    fail('Single-flight guarantee serializes overlapping run() invocations', err);
  }

  // --------------------------------------------------------------------------
  // Suite 2: Non-WRR strategy blocks enforce mode
  // --------------------------------------------------------------------------
  console.log('\nSuite 2: Non-WRR Strategy Blocks Enforce Mode');
  try {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    let patchCalled = false;

    const mockTransport = {
      async getRoutingStrategy() {
        return 'round-robin'; // Non-WRR strategy
      },
      async listCredentials() {
        return [{ name: 'claude-1.json', weight: 50, type: 'claude' }];
      },
      async patchCredentialWeight() {
        patchCalled = true;
        return { ok: true };
      },
    } as unknown as CpaTransport;

    const policy: FullWatermarkPolicy = {
      ...DEFAULT_WATERMARK_POLICY,
      mode: 'enforce',
      classificationRules: [
        { pattern: 'claude-*', provider: 'claude', tier: 'pro', modality: 'subscription_pool', managed: true },
      ],
    };
    const policyLoader = new MockPolicyLoader(policy);

    store.upsertAccount({
      id: 'acc-1',
      name: 'Claude Account 1',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-1',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 80,
            utilizationPercent: 20,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: false,
            severity: 'healthy',
          },
        ],
      },
    });

    store.upsertCpaLink({
      accountId: 'acc-1',
      cpaName: 'claude-1.json',
      authIndex: 'idx-1',
      identityKey: 'claude:idx-1',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 50, managed: true }),
    });

    const service = new CpaWatermarkService({
      store,
      transport: mockTransport,
      policyLoader,
    });

    const res = await service.run();
    assertEquals(res.blocked, 'strategy', 'Blocked reason is strategy');
    assertEquals(res.applied, false, 'applied is false when strategy is non-WRR');
    assertEquals(res.writes, 0, 'Zero writes executed');
    assert(!patchCalled, 'No PATCH calls dispatched when blocked by non-WRR strategy');

    const routingContext = service.getRoutingContext();
    assertEquals(routingContext.blockedReason, 'strategy', 'RoutingContext blockedReason is strategy');

    pass('Non-WRR strategy gracefully flags blockedReason="strategy" and prevents writes');
  } catch (err) {
    fail('Non-WRR strategy gracefully flags blockedReason="strategy" and prevents writes', err);
  }

  // --------------------------------------------------------------------------
  // Suite 3: Make-before-break write ordering (promotions before demotions)
  // --------------------------------------------------------------------------
  console.log('\nSuite 3: Make-Before-Break Write Ordering (Promotions Before Demotions)');
  try {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const writeLog: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async listCredentials() {
        return [
          { name: 'claude-low.json', weight: 100, type: 'claude' },
          { name: 'claude-high.json', weight: 0, type: 'claude' },
        ];
      },
      async patchCredentialWeight(name: string, weight: number) {
        writeLog.push({ name, weight });
        return { ok: true };
      },
    } as unknown as CpaTransport;

    const policy: FullWatermarkPolicy = {
      ...DEFAULT_WATERMARK_POLICY,
      mode: 'enforce',
      classificationRules: [
        { pattern: 'claude-*', provider: 'claude', tier: 'pro', modality: 'subscription_pool', managed: true },
      ],
    };
    const policyLoader = new MockPolicyLoader(policy);

    // claude-low has 2% remaining -> will demote to hard_stop (W=0)
    store.upsertAccount({
      id: 'acc-low',
      name: 'Claude Low',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-low',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 2,
            utilizationPercent: 98,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: true,
            severity: 'exhausted',
          },
        ],
      },
    });

    // claude-high has 90% remaining -> will promote to W=100
    store.upsertAccount({
      id: 'acc-high',
      name: 'Claude High',
      providerType: 'claude',
      orderIndex: 1,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-high',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 90,
            utilizationPercent: 10,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: false,
            severity: 'healthy',
          },
        ],
      },
    });

    store.upsertCpaLink({
      accountId: 'acc-low',
      cpaName: 'claude-low.json',
      authIndex: 'idx-low',
      identityKey: 'claude:idx-low',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 100, managed: true }),
    });

    store.upsertCpaLink({
      accountId: 'acc-high',
      cpaName: 'claude-high.json',
      authIndex: 'idx-high',
      identityKey: 'claude:idx-high',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 0, managed: true }),
    });

    const service = new CpaWatermarkService({
      store,
      transport: mockTransport,
      policyLoader,
    });

    const res = await service.run();
    assertEquals(res.writes, 2, 'Two writes executed');
    assertEquals(writeLog.length, 2, 'Two writes logged');

    // Make-before-break verification:
    // First write MUST be claude-high promotion (0 -> 100)
    assertEquals(writeLog[0].name, 'claude-high.json', 'Promotion executed first');
    assertEquals(writeLog[0].weight, 100, 'claude-high weight is 100');

    // Second write MUST be claude-low demotion (100 -> 0)
    assertEquals(writeLog[1].name, 'claude-low.json', 'Demotion executed second');
    assertEquals(writeLog[1].weight, 0, 'claude-low weight is 0');

    pass('Make-before-break ordering schedules promotions before demotions');
  } catch (err) {
    fail('Make-before-break ordering schedules promotions before demotions', err);
  }

  // --------------------------------------------------------------------------
  // Suite 4: Token bucket rate limiter & emergency bypass
  // --------------------------------------------------------------------------
  console.log('\nSuite 4: Token Bucket Rate Limiter and Emergency Bypass');
  try {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const patched: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async listCredentials() {
        return [
          { name: 'claude-pro-1.json', weight: 0, type: 'claude' },
          { name: 'claude-pro-2.json', weight: 0, type: 'claude' },
          { name: 'claude-emergency.json', weight: 100, type: 'claude' },
        ];
      },
      async patchCredentialWeight(name: string, weight: number) {
        patched.push({ name, weight });
        return { ok: true };
      },
    } as unknown as CpaTransport;

    // Rate limit of 1 write per minute
    const policy: FullWatermarkPolicy = {
      ...DEFAULT_WATERMARK_POLICY,
      mode: 'enforce',
      classificationRules: [
        { pattern: 'claude-*', provider: 'claude', tier: 'pro', modality: 'subscription_pool', managed: true },
      ],
    };
    (policy as any).maxWritesPerMin = 1;
    const policyLoader = new MockPolicyLoader(policy);

    // Account 1: Healthy (will want promotion to 100)
    store.upsertAccount({
      id: 'acc-1',
      name: 'Claude 1',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-1',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 90,
            utilizationPercent: 10,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: false,
            severity: 'healthy',
          },
        ],
      },
    });

    // Account 2: Healthy (will want promotion to 100)
    store.upsertAccount({
      id: 'acc-2',
      name: 'Claude 2',
      providerType: 'claude',
      orderIndex: 1,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-2',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 90,
            utilizationPercent: 10,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: false,
            severity: 'healthy',
          },
        ],
      },
    });

    // Account 3: Hard floor breach (<5%) -> EMERGENCY demotion to 0
    store.upsertAccount({
      id: 'acc-emg',
      name: 'Claude Emergency',
      providerType: 'claude',
      orderIndex: 2,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-emg',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 2,
            utilizationPercent: 98,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: true,
            severity: 'exhausted',
          },
        ],
      },
    });

    store.upsertCpaLink({
      accountId: 'acc-1',
      cpaName: 'claude-pro-1.json',
      authIndex: 'idx-1',
      identityKey: 'claude:idx-1',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 0, managed: true }),
    });

    store.upsertCpaLink({
      accountId: 'acc-2',
      cpaName: 'claude-pro-2.json',
      authIndex: 'idx-2',
      identityKey: 'claude:idx-2',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 0, managed: true }),
    });

    store.upsertCpaLink({
      accountId: 'acc-emg',
      cpaName: 'claude-emergency.json',
      authIndex: 'idx-emg',
      identityKey: 'claude:idx-emg',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 100, managed: true }),
    });

    const service = new CpaWatermarkService({
      store,
      transport: mockTransport,
      policyLoader,
    });

    const res = await service.run();
    // Capacity = 1: one regular promotion consumed the token.
    // The second regular promotion was throttled.
    // The emergency write bypassed the exhausted token bucket!
    assertEquals(res.writes, 2, '2 writes executed (1 normal + 1 emergency bypass)');
    assert(
      patched.some((p) => p.name === 'claude-emergency.json' && p.weight === 0),
      'Emergency hard stop write executed despite rate limit exhaustion'
    );

    pass('Rate limiter constrains normal promotions while emergency hard-stop writes bypass');
  } catch (err) {
    fail('Rate limiter constrains normal promotions while emergency hard-stop writes bypass', err);
  }

  // --------------------------------------------------------------------------
  // Suite 5: Post-write read-back verification detects discrepancies
  // --------------------------------------------------------------------------
  console.log('\nSuite 5: Post-Write Read-Back Verification');
  try {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    let patchCount = 0;

    // Simulate CPA returning outdated weight on read-back list
    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async listCredentials() {
        if (patchCount === 0) {
          return [{ name: 'claude-rb.json', weight: 0, type: 'claude' }];
        }
        // CPA failed to apply the patch internally or returned stale cache
        return [{ name: 'claude-rb.json', weight: 0, type: 'claude' }];
      },
      async patchCredentialWeight(_name: string, _weight: number) {
        patchCount++;
        return { ok: true };
      },
    } as unknown as CpaTransport;

    const policy: FullWatermarkPolicy = {
      ...DEFAULT_WATERMARK_POLICY,
      mode: 'enforce',
      classificationRules: [
        { pattern: 'claude-*', provider: 'claude', tier: 'pro', modality: 'subscription_pool', managed: true },
      ],
    };
    const policyLoader = new MockPolicyLoader(policy);

    store.upsertAccount({
      id: 'acc-rb',
      name: 'Claude Readback',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-rb',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 80,
            utilizationPercent: 20,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: false,
            severity: 'healthy',
          },
        ],
      },
    });

    store.upsertCpaLink({
      accountId: 'acc-rb',
      cpaName: 'claude-rb.json',
      authIndex: 'idx-rb',
      identityKey: 'claude:idx-rb',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 0, managed: true }),
    });

    const service = new CpaWatermarkService({
      store,
      transport: mockTransport,
      policyLoader,
    });

    const res = await service.run();
    assertEquals(res.writes, 1, 'Patch executed');
    assertEquals(res.readBackDiscrepancies, 1, 'Read-back mismatch detected discrepancy');

    pass('Read-back verification reliably detects mismatches between patched target and CPA state');
  } catch (err) {
    fail('Read-back verification reliably detects mismatches between patched target and CPA state', err);
  }

  // --------------------------------------------------------------------------
  // Suite 6: State persistence and restoration across service restarts
  // --------------------------------------------------------------------------
  console.log('\nSuite 6: State Persistence & Restoration Across Restarts');
  try {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async listCredentials() {
        return [{ name: 'claude-persist.json', weight: 100, type: 'claude' }];
      },
      async patchCredentialWeight(_name: string, _weight: number) {
        return { ok: true };
      },
    } as unknown as CpaTransport;

    const policy: FullWatermarkPolicy = {
      ...DEFAULT_WATERMARK_POLICY,
      mode: 'shadow',
      classificationRules: [
        { pattern: 'claude-*', provider: 'claude', tier: 'pro', modality: 'subscription_pool', managed: true },
      ],
    };
    const policyLoader = new MockPolicyLoader(policy);

    store.upsertAccount({
      id: 'acc-p',
      name: 'Claude Persist',
      providerType: 'claude',
      orderIndex: 0,
      isActive: true,
      createdAt: Date.now(),
      latestSnapshot: {
        accountId: 'acc-p',
        providerType: 'claude',
        planName: 'Pro',
        status: 'ok',
        fetchedAt: new Date().toISOString(),
        buckets: [
          {
            id: 'five_hour',
            label: '5-hour',
            windowType: 'session_5h',
            remainingPercent: 80,
            utilizationPercent: 20,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
            isExhausted: false,
            severity: 'healthy',
          },
        ],
      },
    });

    store.upsertCpaLink({
      accountId: 'acc-p',
      cpaName: 'claude-persist.json',
      authIndex: 'idx-p',
      identityKey: 'claude:idx-p',
      state: 'linked',
      lastSeenAt: Date.now(),
      unlinkedAt: null,
      routingJson: JSON.stringify({ applied: 100, managed: true }),
    });

    const service1 = new CpaWatermarkService({
      store,
      transport: mockTransport,
      policyLoader,
    });

    await service1.run();
    const state1 = service1.getEngineState();
    assertEquals(state1.generation, 1, 'Generation incremented to 1');

    // Simulate restart: construct new CpaWatermarkService from the same store
    const service2 = new CpaWatermarkService({
      store,
      transport: mockTransport,
      policyLoader,
    });

    const state2 = service2.getEngineState();
    assertEquals(state2.generation, 1, 'Loaded generation 1 on restart');
    assertEquals(
      state2.accountStates['claude-persist.json']?.targetWeight,
      100,
      'Restored account target weight'
    );

    // Running again increments generation to 2
    await service2.run();
    assertEquals(service2.getEngineState().generation, 2, 'Generation incremented to 2 on next run');

    pass('Engine state and generation persist to SQLite and restore cleanly across service restarts');
  } catch (err) {
    fail('Engine state and generation persist to SQLite and restore cleanly across service restarts', err);
  }

  console.log('\n========================================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('========================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test run failed with unhandled error:', err);
  process.exit(1);
});
