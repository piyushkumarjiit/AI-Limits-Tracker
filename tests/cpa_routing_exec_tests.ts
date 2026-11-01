import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Store } from '../server/src/store';
import { Tracker } from '../server/src/tracker';
import { CpaRoutingExecutor } from '../server/src/cpaRouting';
import { CpaSyncEngine } from '../server/src/cpaSync';
import { createApp } from '../server/src/app';
import { CpaTransport } from '../src/services/cpa/CpaTransport';
import { CpaCredential } from '../src/services/cpa/types';
import { UsageProvider, UsageResult } from '../src/services/providers/UsageProvider';

let totalTests = 0;
let failedTests = 0;

function assert(condition: boolean, msg: string) {
  totalTests++;
  if (!condition) {
    failedTests++;
    console.error(`  ✗ [FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ [PASS] ${msg}`);
  }
}

function assertEquals<T>(actual: T, expected: T, msg: string) {
  totalTests++;
  if (actual !== expected) {
    failedTests++;
    console.error(
      `  ✗ [FAIL] ${msg} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`
    );
    throw new Error(
      `Assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  } else {
    console.log(`  ✓ [PASS] ${msg}`);
  }
}

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const ADMIN_PASSWORD = 'test-admin-password-12345';
const API_TOKEN = 'test-api-token-abcdef0123456789';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cpa-routing-exec-test-'));
}

class MockUsageProvider implements UsageProvider {
  status: 'active' | 'beta' | 'deprecated' = 'active';
  supportsBurnRate = true;
  constructor(private readonly result: UsageResult) {}
  async fetchUsage(): Promise<UsageResult> {
    return this.result;
  }
}

async function runTests() {
  console.log('\n========================================');
  console.log('  CPA ROUTING EXECUTOR TESTS (WP5)      ');
  console.log('========================================\n');

  // Suite 1: Shadow Mode
  console.log('Suite 1: Shadow Mode (0 PATCH calls, returns computed plan)');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const patchCalls: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(name: string, weight: number) {
        patchCalls.push({ name, weight });
        return { ok: true, name, weight };
      },
    } as unknown as CpaTransport;

    store.setCpaRoutingConfig({ mode: 'shadow' });
    const executor = new CpaRoutingExecutor(store, mockTransport);

    // Create an account in store with cpa_link
    const accountId = 'acc-claude-1';
    const now = Date.now();
    store.upsertAccount({
      id: accountId,
      name: 'Claude Pro',
      providerType: 'claude',
      plan: 'Pro',
      email: 'claude-1@example.com',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 20,
            remainingPercent: 80,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: false,
          },
        ],
      },
    });
    store.upsertCpaLink({
      accountId,
      cpaName: 'claude-cred-1',
      identityKey: 'claude:claude-cred-1',
      authIndex: 'claude-cred-1',
      state: 'linked',
    });

    const entries: CpaCredential[] = [
      {
        name: 'claude-cred-1',
        type: 'claude',
        weight: 100,
      },
    ];

    const result = await executor.run(entries, now);
    assertEquals(result.mode, 'shadow', 'mode is shadow');
    assertEquals(result.applied, false, 'applied is false in shadow mode');
    assertEquals(patchCalls.length, 0, 'Shadow mode makes 0 PATCH calls');
    assertEquals(result.plans.length, 1, 'Plan was computed');
    assert(result.plans[0].target > 0, 'Target weight was computed');

    // Routing state in DB should not have routing_json.applied set to true or updated weight
    const linkRouting = store.getCpaLinkRouting(accountId);
    assertEquals(linkRouting?.managed ?? true, true, 'Link remains managed');
    assertEquals(linkRouting?.applied, undefined, 'No applied weight in shadow mode');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 2: Enforce Mode with WRR
  console.log('\nSuite 2: Enforce Mode with WRR (sends PATCH calls with target weight)');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const patchCalls: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(name: string, weight: number) {
        patchCalls.push({ name, weight });
        return { ok: true, name, weight };
      },
    } as unknown as CpaTransport;

    store.setCpaRoutingConfig({ mode: 'enforce' });
    const executor = new CpaRoutingExecutor(store, mockTransport);

    const accountId = 'acc-claude-2';
    const now = Date.now();
    store.upsertAccount({
      id: accountId,
      name: 'Claude Pro',
      providerType: 'claude',
      plan: 'Pro',
      email: 'claude-2@example.com',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: false,
          },
        ],
      },
    });
    store.upsertCpaLink({
      accountId,
      cpaName: 'claude-cred-2',
      identityKey: 'claude:claude-cred-2',
      authIndex: 'claude-cred-2',
      state: 'linked',
    });

    // Initial CPA weight is 50, but full headroom for Pro -> target 100
    const entries: CpaCredential[] = [
      {
        name: 'claude-cred-2',
        type: 'claude',
        weight: 50,
      },
    ];

    const result = await executor.run(entries, now);
    assertEquals(result.mode, 'enforce', 'mode is enforce');
    assertEquals(result.applied, true, 'applied is true in enforce mode');
    assertEquals(patchCalls.length, 1, 'Exactly 1 PATCH call sent');
    assertEquals(patchCalls[0].name, 'claude-cred-2', 'PATCH target credential name matches');
    assertEquals(patchCalls[0].weight, 100, 'PATCH target weight is 100');

    // Routing state in DB was updated
    const linkRouting = store.getCpaLinkRouting(accountId);
    assertEquals(linkRouting?.managed, true, 'Link remains managed');
    assertEquals(linkRouting?.applied, 100, 'routing.applied is 100 in DB');
    assertEquals(linkRouting?.at, now, 'routing.at updated');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 3: Non-WRR Strategy blocks enforce mode
  console.log('\nSuite 3: Non-WRR Strategy blocks enforce mode (blocked = "strategy", 0 writes)');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const patchCalls: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'round-robin';
      },
      async patchCredentialWeight(name: string, weight: number) {
        patchCalls.push({ name, weight });
        return { ok: true, name, weight };
      },
    } as unknown as CpaTransport;

    store.setCpaRoutingConfig({ mode: 'enforce' });
    const executor = new CpaRoutingExecutor(store, mockTransport);

    const accountId = 'acc-claude-3';
    const now = Date.now();
    store.upsertAccount({
      id: accountId,
      name: 'Claude Pro',
      providerType: 'claude',
      plan: 'Pro',
      email: 'claude-3@example.com',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: false,
          },
        ],
      },
    });
    store.upsertCpaLink({
      accountId,
      cpaName: 'claude-cred-3',
      identityKey: 'claude:claude-cred-3',
      authIndex: 'claude-cred-3',
      state: 'linked',
    });

    const entries: CpaCredential[] = [
      {
        name: 'claude-cred-3',
        type: 'claude',
        weight: 50,
      },
    ];

    const result = await executor.run(entries, now);
    assertEquals(result.mode, 'enforce', 'mode is enforce');
    assertEquals(result.blocked, 'strategy', 'blocked reason is "strategy"');
    assertEquals(result.applied, false, 'applied is false when blocked');
    assertEquals(patchCalls.length, 0, 'No PATCH calls when strategy is not WRR');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 4: Token-bucket Rate Limiter
  console.log('\nSuite 4: Token-bucket Rate Limiter (enforces write ceiling)');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const patchCalls: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(name: string, weight: number) {
        patchCalls.push({ name, weight });
        return { ok: true, name, weight };
      },
    } as unknown as CpaTransport;

    // Configure rate limit of 2 writes/min
    store.setCpaRoutingConfig({ mode: 'enforce', maxWritesPerMin: 2 });
    const executor = new CpaRoutingExecutor(store, mockTransport);

    const entries: CpaCredential[] = [];
    const now = Date.now();

    for (let i = 1; i <= 5; i++) {
      const name = `claude-rate-${i}`;
      const accountId = `acc-rate-${i}`;
      store.upsertAccount({
        id: accountId,
        name: `Claude Pro ${i}`,
        providerType: 'claude',
        plan: 'Pro',
        email: `rate-${i}@example.com`,
        isActive: true,
        orderIndex: i,
        createdAt: new Date().toISOString(),
        latestSnapshot: {
          timestamp: now,
          status: 'ok',
          planName: 'Pro',
          buckets: [
            {
              id: '5h',
              label: '5-hour',
              windowType: 'session_5h',
              utilizationPercent: 0,
              remainingPercent: 100,
              resetsAt: new Date(now + 3600000).toISOString(),
              isExhausted: false,
            },
          ],
        },
      });
      store.upsertCpaLink({
        accountId,
        cpaName: name,
        identityKey: `claude:${name}`,
        authIndex: name,
        state: 'linked',
      });
      entries.push({
        name,
        type: 'claude',
        weight: 10, // requires write to 100
      });
    }

    const result = await executor.run(entries, now);
    assertEquals(patchCalls.length, 2, 'Capped at maxWritesPerMin (2 writes executed)');
    assertEquals(result.applied, true, 'applied is true for executed writes');

    // 2 links updated with applied: 100, remaining 3 links not written yet
    let appliedCount = 0;
    for (let i = 1; i <= 5; i++) {
      const link = store.getCpaLinkRouting(`acc-rate-${i}`);
      if (link?.applied === 100) {
        appliedCount++;
      }
    }
    assertEquals(appliedCount, 2, 'Exactly 2 links updated in store');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 5: Human Edit Detection
  console.log('\nSuite 5: Human Edit Detection (entry.weight != routing.applied marks managed=false)');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const patchCalls: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(name: string, weight: number) {
        patchCalls.push({ name, weight });
        return { ok: true, name, weight };
      },
    } as unknown as CpaTransport;

    store.setCpaRoutingConfig({ mode: 'enforce' });
    const executor = new CpaRoutingExecutor(store, mockTransport);

    const accountId = 'acc-claude-human';
    const now = Date.now();
    store.upsertAccount({
      id: accountId,
      name: 'Claude Pro',
      providerType: 'claude',
      plan: 'Pro',
      email: 'human@example.com',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 50,
            remainingPercent: 50,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: false,
          },
        ],
      },
    });
    store.upsertCpaLink({
      accountId,
      cpaName: 'claude-human',
      identityKey: 'claude:claude-human',
      authIndex: 'claude-human',
      state: 'linked',
    });

    // Simulate previous write where routing.applied was recorded as 100
    store.updateCpaLinkRouting(accountId, {
      applied: 100,
      at: now - 1000,
    });

    // Human changed weight to 42 in CLIProxy directly
    const entries: CpaCredential[] = [
      {
        name: 'claude-human',
        type: 'claude',
        weight: 42,
      },
    ];

    await executor.run(entries, now);
    assertEquals(patchCalls.length, 0, 'No PATCH calls made after human edit detected');

    const routingState = store.getCpaLinkRouting(accountId);
    assertEquals(routingState?.managed, false, 'Link marked managed = false due to human edit');

    // Run again - unmanaged account should never be written to
    await executor.run(entries, now + 1000);
    assertEquals(patchCalls.length, 0, 'Still no PATCH calls on subsequent runs');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 6: PATCH 400 Marks Credential Unmanaged
  console.log('\nSuite 6: PATCH 400 marks credential unmanaged (managed=false)');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    let patchAttempted = 0;

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(name: string, _weight: number) {
        patchAttempted++;
        const err = new Error(`PATCH /v1/management/credentials/${name} returned 400: invalid weight`);
        (err as any).status = 400;
        throw err;
      },
    } as unknown as CpaTransport;

    store.setCpaRoutingConfig({ mode: 'enforce' });
    const executor = new CpaRoutingExecutor(store, mockTransport);

    const accountId = 'acc-claude-400';
    const now = Date.now();
    store.upsertAccount({
      id: accountId,
      name: 'Claude Pro',
      providerType: 'claude',
      plan: 'Pro',
      email: 'patch400@example.com',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: false,
          },
        ],
      },
    });
    store.upsertCpaLink({
      accountId,
      cpaName: 'claude-400',
      identityKey: 'claude:claude-400',
      authIndex: 'claude-400',
      state: 'linked',
    });

    const entries: CpaCredential[] = [
      {
        name: 'claude-400',
        type: 'claude',
        weight: 50,
      },
    ];

    await executor.run(entries, now);
    assertEquals(patchAttempted, 1, 'PATCH was attempted');

    const routingState = store.getCpaLinkRouting(accountId);
    assertEquals(routingState?.managed, false, 'Link marked managed=false after 400 response');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 7: Weight 0 Transition Sent Immediately (bypasses min interval)
  console.log('\nSuite 7: Weight 0 Transition sent immediately (bypasses min interval)');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const patchCalls: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(name: string, weight: number) {
        patchCalls.push({ name, weight });
        return { ok: true, name, weight };
      },
    } as unknown as CpaTransport;

    store.setCpaRoutingConfig({ mode: 'enforce', minWriteIntervalSec: 600 }); // 10 minutes interval
    const executor = new CpaRoutingExecutor(store, mockTransport);

    const accountId = 'acc-claude-zero';
    const now = Date.now();
    store.upsertAccount({
      id: accountId,
      name: 'Claude Pro',
      providerType: 'claude',
      plan: 'Pro',
      email: 'zero@example.com',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 100,
            remainingPercent: 0,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: true,
          },
        ],
      },
    });
    store.upsertCpaLink({
      accountId,
      cpaName: 'claude-zero',
      identityKey: 'claude:claude-zero',
      authIndex: 'claude-zero',
      state: 'linked',
    });

    // Recently written (only 30 seconds ago) with weight 100
    store.updateCpaLinkRouting(accountId, {
      applied: 100,
      at: now - 30000,
    });

    // Add a second account that is healthy, so starvation guard doesn't boost zero to 1
    const healthyId = 'acc-claude-healthy';
    store.upsertAccount({
      id: healthyId,
      name: 'Claude Healthy',
      providerType: 'claude',
      plan: 'Pro',
      email: 'healthy@example.com',
      isActive: true,
      orderIndex: 1,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: false,
          },
        ],
      },
    });
    store.upsertCpaLink({
      accountId: healthyId,
      cpaName: 'claude-healthy',
      identityKey: 'claude:claude-healthy',
      authIndex: 'claude-healthy',
      state: 'linked',
    });
    store.updateCpaLinkRouting(healthyId, {
      applied: 100,
      at: now - 30000,
    });

    const entries: CpaCredential[] = [
      {
        name: 'claude-zero',
        type: 'claude',
        weight: 100,
      },
      {
        name: 'claude-healthy',
        type: 'claude',
        weight: 100,
      },
    ];

    await executor.run(entries, now);
    assertEquals(patchCalls.length, 1, 'PATCH sent despite recent write interval');
    assertEquals(patchCalls[0].weight, 0, 'Target weight 0 written immediately');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 8: Persistence across Reloads (does not re-write unchanged values)
  console.log('\nSuite 8: Persistence across reloads (does not re-write unchanged values)');
  {
    const dir = createTempDir();
    const store1 = new Store(dir, 'test.db', APP_SECRET);
    const patchCalls: Array<{ name: string; weight: number }> = [];

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(name: string, weight: number) {
        patchCalls.push({ name, weight });
        return { ok: true, name, weight };
      },
    } as unknown as CpaTransport;

    store1.setCpaRoutingConfig({ mode: 'enforce' });
    const accountId = 'acc-claude-persist';
    const now = Date.now();
    store1.upsertAccount({
      id: accountId,
      name: 'Claude Pro',
      providerType: 'claude',
      plan: 'Pro',
      email: 'persist@example.com',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
      latestSnapshot: {
        timestamp: now,
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5-hour',
            windowType: 'session_5h',
            utilizationPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now + 3600000).toISOString(),
            isExhausted: false,
          },
        ],
      },
    });
    store1.upsertCpaLink({
      accountId,
      cpaName: 'claude-persist',
      identityKey: 'claude:claude-persist',
      authIndex: 'claude-persist',
      state: 'linked',
    });

    const entries: CpaCredential[] = [
      {
        name: 'claude-persist',
        type: 'claude',
        weight: 50,
      },
    ];

    const exec1 = new CpaRoutingExecutor(store1, mockTransport);
    await exec1.run(entries, now);
    assertEquals(patchCalls.length, 1, 'First run writes target 100');
    assertEquals(patchCalls[0].weight, 100, 'Weight is 100');

    // Simulate process reload: close store1, open new store2 from same DB file
    store1.close();
    const store2 = new Store(dir, 'test.db', APP_SECRET);
    const exec2 = new CpaRoutingExecutor(store2, mockTransport);

    // Run again with CPA entry having weight 100 (which was applied previously)
    const reloadedEntries: CpaCredential[] = [
      {
        name: 'claude-persist',
        type: 'claude',
        weight: 100,
      },
    ];

    await exec2.run(reloadedEntries, now + 1000);
    assertEquals(patchCalls.length, 1, 'No new PATCH calls made after reload when weight is unchanged');

    store2.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 9: End-to-end integration via App Settings & State API
  console.log('\nSuite 9: App Settings & State API integration');
  {
    const dir = createTempDir();
    const store = new Store(dir, 'test.db', APP_SECRET);
    const tracker = new Tracker(store, {
      claude: new MockUsageProvider({
        status: 'ok',
        plan: 'Pro',
        buckets: [],
      }),
    });

    const mockTransport = {
      async getRoutingStrategy() {
        return 'weighted-round-robin';
      },
      async patchCredentialWeight(_name: string, _weight: number) {
        return { ok: true };
      },
    } as unknown as CpaTransport;

    const executor = new CpaRoutingExecutor(store, mockTransport);
    const syncEngine = new CpaSyncEngine(mockTransport, store, tracker, executor);

    const server = createApp(
      {
        adminPassword: ADMIN_PASSWORD,
        appSecret: APP_SECRET,
        apiToken: API_TOKEN,
        secureCookies: false,
        trustProxy: false,
        webDir: dir,
      },
      { store, tracker, cpaSync: syncEngine, cpaRouting: executor }
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      // 1. GET /api/state returns cpaRouting config
      const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      assertEquals(stateRes.status, 200, 'GET /api/state is 200');
      const stateJson = (await stateRes.json()) as any;
      assert(stateJson.cpaRouting !== undefined, 'state includes cpaRouting');
      assertEquals(stateJson.cpaRouting.mode, 'shadow', 'default mode is shadow');

      // 2. PUT /api/settings updates cpaRouting config
      const updateRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cpaRouting: {
            mode: 'enforce',
            minDeltaRatio: 0.3,
          },
        }),
      });
      assertEquals(updateRes.status, 200, 'PUT /api/settings is 200');

      // 3. Verify in store
      const updatedConfig = store.getCpaRoutingConfig();
      assertEquals(updatedConfig.mode, 'enforce', 'Store config mode updated to enforce');
      assertEquals(updatedConfig.minDeltaRatio, 0.3, 'Store config minDeltaRatio updated');

      // 4. PUT /api/settings with invalid mode returns 400
      const invalidRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cpaRouting: {
            mode: 'invalid_mode',
          },
        }),
      });
      assertEquals(invalidRes.status, 400, 'PUT invalid mode returns 400');
    } finally {
      await new Promise<void>((resolve) => (server as any).close(() => resolve()));
      server.closeAllConnections();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n========================================`);
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${totalTests - failedTests} | Failed: ${failedTests}`);
  console.log(`========================================\n`);

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Unhandled test failure:', e);
  process.exit(1);
});
