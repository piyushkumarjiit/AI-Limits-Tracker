import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Store } from '../server/src/store';
import { Tracker } from '../server/src/tracker';
import { CpaSyncEngine } from '../server/src/cpaSync';
import { createApp } from '../server/src/app';
import { CpaTransport } from '../src/services/cpa/CpaTransport';
import {
  CpaCredential,
} from '../src/services/cpa/types';
import { UsageProvider, UsageResult } from '../src/services/providers/UsageProvider';
import {
  reconcile,
  buildIdentityKey,
  CpaLink,
  ServerAccount,
} from '../src/services/cpa/reconcile';

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
  return mkdtempSync(join(tmpdir(), 'cpa-sync-test-'));
}

async function runTests() {
  console.log('\n========================================');
  console.log('  CPA SYNC & RECONCILIATION TESTS       ');
  console.log('========================================\n');

  // Suite 1: Pure Reconcile Logic
  console.log('Suite 1: Pure Reconcile Logic');

  const now = 1700000000000;
  {
    // Case 1: Match by auth_index
    const entries: CpaCredential[] = [
      {
        name: 'acc-new-name',
        auth_index: 'idx-1',
        provider: 'claude',
        source: 'file',
        email: 'user1@example.com',
      },
    ];
    const existingAccounts: ServerAccount[] = [
      {
        id: 'acc-1',
        providerType: 'claude',
        name: 'acc-old-name',
        email: 'user1@example.com',
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(now - 10000).toISOString(),
      },
    ];
    const existingLinks: CpaLink[] = [
      {
        accountId: 'acc-1',
        identityKey: 'claude:user1@example.com',
        cpaName: 'acc-old-name',
        authIndex: 'idx-1',
        state: 'linked',
        lastSeenAt: now - 10000,
      },
    ];

    const result = reconcile(entries, existingLinks, existingAccounts, now, {
      purgeDays: 7,
      adoptExisting: true,
      emptyStreak: 0,
    });
    assertEquals(result.actions.length, 1, 'Exactly one action produced for auth_index match');
    assertEquals(result.actions[0].kind, 'updated', 'Action is updated');
    assertEquals(result.actions[0].accountId, 'acc-1', 'Updates acc-1');
    assertEquals(result.actions[0].cpaName, 'acc-new-name', 'Updates name');
  }

  {
    // Case 2: Adopt unlinked native account by identity key (email)
    const entries: CpaCredential[] = [
      {
        name: 'claude-native',
        provider: 'claude',
        source: 'file',
        auth_index: 'idx-native',
        email: 'native@example.com',
      },
    ];
    const existingAccounts: ServerAccount[] = [
      {
        id: 'native-1',
        providerType: 'claude',
        name: 'claude-native',
        email: 'native@example.com',
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(now - 10000).toISOString(),
      },
    ];
    const existingLinks: CpaLink[] = [];

    const result = reconcile(entries, existingLinks, existingAccounts, now, {
      purgeDays: 7,
      adoptExisting: true,
      emptyStreak: 0,
    });
    assertEquals(result.actions.length, 1, 'Exactly one action for adoption');
    assertEquals(result.actions[0].kind, 'adopted', 'Action is adopted');
    assertEquals(result.actions[0].accountId, 'native-1', 'Adopts native-1');
  }

  {
    // Case 3: Create new account if no match exists
    const entries: CpaCredential[] = [
      {
        name: 'new-acc',
        provider: 'codex',
        source: 'file',
        auth_index: 'idx-new',
        email: 'brandnew@example.com',
      },
    ];
    const result = reconcile(entries, [], [], now, {
      purgeDays: 7,
      adoptExisting: true,
      emptyStreak: 0,
    });
    assertEquals(result.actions.length, 1, 'Exactly one action for new account');
    assertEquals(result.actions[0].kind, 'created', 'Action is created');
    assertEquals(result.actions[0].cpaName, 'new-acc', 'Account name preserved');
    assertEquals(result.accountUpserts.length, 1, 'Account upserted');
    assertEquals(result.accountUpserts[0].providerType, 'chatgpt', 'codex mapped to chatgpt');
  }

  {
    // Case 4: Missing discovered account transitions to unlinked
    const entries: CpaCredential[] = [];
    const existingAccounts: ServerAccount[] = [
      {
        id: 'cpa-acc-1',
        providerType: 'claude',
        name: 'claude-cpa',
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(now - 10000).toISOString(),
      },
    ];
    const existingLinks: CpaLink[] = [
      {
        accountId: 'cpa-acc-1',
        identityKey: 'claude:claude-cpa',
        cpaName: 'claude-cpa',
        authIndex: 'idx-1',
        state: 'linked',
        lastSeenAt: now - 10000,
      },
    ];

    const result = reconcile(entries, existingLinks, existingAccounts, now, {
      purgeDays: 7,
      adoptExisting: true,
      emptyStreak: 3,
    });
    assertEquals(result.actions.length, 1, 'Missing account marked unlinked');
    assertEquals(result.actions[0].kind, 'unlinked', 'Action is unlinked');
    assertEquals(result.actions[0].accountId, 'cpa-acc-1', 'Correct account marked unlinked');
  }

  {
    // Case 5: Unlinked account beyond unlinkedPurgeDays is purged
    const entries: CpaCredential[] = [];
    const existingAccounts: ServerAccount[] = [
      {
        id: 'cpa-acc-old',
        providerType: 'claude',
        name: 'claude-old',
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(now - 20 * 86400000).toISOString(),
      },
    ];
    const eightDaysAgo = now - 8 * 86400000;
    const existingLinks: CpaLink[] = [
      {
        accountId: 'cpa-acc-old',
        identityKey: 'claude:claude-old',
        cpaName: 'claude-old',
        authIndex: 'idx-old',
        state: 'unlinked',
        lastSeenAt: eightDaysAgo,
        unlinkedAt: eightDaysAgo,
      },
    ];

    const result = reconcile(entries, existingLinks, existingAccounts, now, {
      purgeDays: 7,
      adoptExisting: true,
      emptyStreak: 3,
    });
    assertEquals(result.actions.length, 1, 'Unlinked account beyond purge threshold is purged');
    assertEquals(result.actions[0].kind, 'purged', 'Action is purged');
    assertEquals(result.deletes.length, 1, 'AccountId marked for delete');
  }

  // Suite 2: Store cpa_links SQLite CRUD
  console.log('\nSuite 2: Store cpa_links SQLite CRUD');
  const tempDir = createTempDir();
  const store = new Store(tempDir, 'tracker.db', APP_SECRET);

  try {
    const acc: ServerAccount = {
      id: 'claude-cpa-1',
      name: 'Claude CPA 1',
      providerType: 'claude',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
    };
    store.upsertAccount(acc);
    store.setCredentials(acc.id, { authType: 'cpa' });
    assertEquals(store.listCpaLinks().length, 0, 'No links initially');

    store.upsertCpaLink({
      accountId: acc.id,
      identityKey: 'claude:idx-1',
      cpaName: 'cpa-user',
      authIndex: 'idx-1',
      state: 'linked',
      lastSeenAt: Date.now(),
      routingJson: JSON.stringify({ priority: 1 }),
    });

    const link = store.getCpaLink(acc.id);
    assert(link !== null, 'Link was created');
    assertEquals(link?.identityKey, 'claude:idx-1', 'Identity key matches');
    assertEquals(link?.cpaName, 'cpa-user', 'cpaName matches');
    assertEquals(link?.state, 'linked', 'state matches');
    assertEquals(store.listCpaLinks().length, 1, 'listCpaLinks returns 1');

    // Update link
    store.upsertCpaLink({
      accountId: acc.id,
      identityKey: 'claude:idx-1',
      cpaName: 'cpa-user-updated',
      authIndex: 'idx-1',
      state: 'unlinked',
      lastSeenAt: Date.now(),
      unlinkedAt: Date.now(),
    });
    const updatedLink = store.getCpaLink(acc.id);
    assertEquals(updatedLink?.cpaName, 'cpa-user-updated', 'cpaName updated');
    assertEquals(updatedLink?.state, 'unlinked', 'state updated to unlinked');

    // Deleting account cascades to cpa_links
    store.deleteAccount(acc.id);
    assertEquals(store.getCpaLink(acc.id), null, 'Cascading delete removed cpa_link');
    assertEquals(store.listCpaLinks().length, 0, 'listCpaLinks is empty after delete');
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  // Suite 3: CpaSyncEngine Discovery & Empty Streak Guard
  console.log('\nSuite 3: CpaSyncEngine Discovery & Empty Streak Guard');
  {
    const dir = createTempDir();
    const testStore = new Store(dir, 'tracker.db', APP_SECRET);
    const testTracker = new Tracker(testStore);
    testTracker.cpaJitterEnabled = false;

    let mockDiscoveredAccounts: CpaCredential[] = [
      {
        name: 'claude-worker-1',
        provider: 'claude',
        source: 'file',
        email: 'w1@example.com',
        auth_index: 'w1',
      },
    ];

    const mockTransport = {
      listCredentials: async (): Promise<CpaCredential[]> => {
        return mockDiscoveredAccounts;
      },
    } as unknown as CpaTransport;

    const engine = new CpaSyncEngine(testStore, testTracker, mockTransport);

    // Run 1: Discover new account
    const actions1 = await engine.runOnce();
    assertEquals(actions1.length, 1, 'Run 1 produced 1 action');
    assertEquals(actions1[0].kind, 'created', 'Run 1 created account');
    const accounts = testStore.listAccounts();
    assertEquals(accounts.length, 1, '1 account in store');
    const createdLink = testStore.getCpaLink(accounts[0].id);
    assert(createdLink !== null, 'Link created');
    assertEquals(createdLink?.state, 'linked', 'Link is linked');

    // Run 2: Empty discovery 1 & 2 do NOT unlink (empty streak guard >= 3)
    mockDiscoveredAccounts = [];
    const actionsEmpty1 = await engine.runOnce();
    assertEquals(actionsEmpty1.length, 0, 'Empty run 1 produces 0 actions due to streak guard');
    const linkAfter1 = testStore.getCpaLink(accounts[0].id);
    assertEquals(linkAfter1?.state, 'linked', 'Link still linked after streak 1');

    const actionsEmpty2 = await engine.runOnce();
    assertEquals(actionsEmpty2.length, 0, 'Empty run 2 produces 0 actions due to streak guard');
    const linkAfter2 = testStore.getCpaLink(accounts[0].id);
    assertEquals(linkAfter2?.state, 'linked', 'Link still linked after streak 2');

    // Run 3: Empty discovery 3 reaches threshold -> mark_unlinked triggered
    const actionsEmpty3 = await engine.runOnce();
    assertEquals(actionsEmpty3.length, 1, 'Empty run 3 triggers unlinking');
    assertEquals(actionsEmpty3[0].kind, 'unlinked', 'Action is unlinked');
    const linkAfter3 = testStore.getCpaLink(accounts[0].id);
    assertEquals(linkAfter3?.state, 'unlinked', 'Link is now unlinked');

    testStore.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 4: Tracker CPA usage provider routing & unlinked account skipping
  console.log('\nSuite 4: Tracker CPA usage provider routing & unlinked skipping');
  {
    const dir = createTempDir();
    const testStore = new Store(dir, 'tracker.db', APP_SECRET);
    const testTracker = new Tracker(testStore);
    testTracker.cpaJitterEnabled = false;

    let cpaFetchCalled = false;
    const mockCpaProvider: UsageProvider = {
      fetchUsage: async (accountId: string, creds: any): Promise<UsageResult> => {
        cpaFetchCalled = true;
        return {
          snapshot: {
            status: 'ok',
            planName: 'CPA Plan',
            buckets: [],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    };
    testTracker.setCpaProvider(mockCpaProvider);

    const cpaAcc: ServerAccount = {
      id: 'claude-cpa-active',
      name: 'Claude CPA Active',
      providerType: 'claude',
      isActive: true,
      orderIndex: 0,
      createdAt: new Date().toISOString(),
    };
    testStore.upsertAccount(cpaAcc);
    testStore.setCredentials(cpaAcc.id, {
      authType: 'cpa',
      cpaName: 'claude-active',
    });
    testStore.upsertCpaLink({
      accountId: cpaAcc.id,
      identityKey: 'claude:claude-active',
      cpaName: 'claude-active',
      authIndex: 'cpa-active-idx',
      state: 'linked',
      lastSeenAt: Date.now(),
    });

    await testTracker.sync(cpaAcc.id);
    assert(cpaFetchCalled, 'CpaUsageProvider was invoked for active CPA account');

    // Mark link unlinked -> should be skipped
    cpaFetchCalled = false;
    testStore.upsertCpaLink({
      accountId: cpaAcc.id,
      identityKey: 'claude:claude-active',
      cpaName: 'claude-active',
      authIndex: 'cpa-active-idx',
      state: 'unlinked',
      lastSeenAt: Date.now(),
    });

    await testTracker.sync(cpaAcc.id);
    assert(!cpaFetchCalled, 'Unlinked CPA account was skipped');

    testStore.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // Suite 5: HTTP Endpoints POST /api/cpa/sync and GET /api/cpa/status
  console.log('\nSuite 5: HTTP Endpoints POST /api/cpa/sync and GET /api/cpa/status');
  {
    const dir = createTempDir();
    const testStore = new Store(dir, 'tracker.db', APP_SECRET);
    const testTracker = new Tracker(testStore);
    testTracker.cpaJitterEnabled = false;

    const mockTransport = {
      listCredentials: async (): Promise<CpaCredential[]> => {
        return [];
      },
    } as unknown as CpaTransport;

    const engine = new CpaSyncEngine(testStore, testTracker, mockTransport);

    const server = createApp(
      {
        adminPassword: ADMIN_PASSWORD,
        appSecret: APP_SECRET,
        apiToken: API_TOKEN,
        secureCookies: false,
        trustProxy: false,
        webDir: dir,
      },
      { store: testStore, tracker: testTracker, cpaSync: engine }
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      // 1. GET /api/cpa/status
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/cpa/status`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      assertEquals(statusRes.status, 200, 'GET /api/cpa/status returns 200');
      const statusJson = (await statusRes.json()) as any;
      assertEquals(statusJson.enabled, true, 'status.enabled is true');

      // 2. POST /api/cpa/sync
      const syncRes = await fetch(`http://127.0.0.1:${port}/api/cpa/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      assertEquals(syncRes.status, 200, 'POST /api/cpa/sync returns 200');
      const syncJson = (await syncRes.json()) as any;
      assertEquals(syncJson.ok, true, 'sync result ok is true');
      assert(Array.isArray(syncJson.actions), 'sync result actions is array');
    } finally {
      await new Promise<void>((resolve) => (server as any).close(() => resolve()));
      server.closeAllConnections();
      testStore.close();
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
