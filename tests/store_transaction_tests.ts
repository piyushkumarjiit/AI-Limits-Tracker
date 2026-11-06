/**
 * Store transaction rollback error preservation tests.
 *
 * Public behavior under test:
 * - Store.transaction() must preserve and rethrow the original error that caused a transaction to fail,
 *   even when SQLite has already rolled back the transaction and a subsequent ROLLBACK fails.
 * - Store.transaction() must leave no transaction active after a failed rollback, so subsequent
 *   transactions can begin, write data, and commit cleanly.
 * - Store.transaction() must roll back mutations performed inside fn when an error is thrown
 *   and rethrow that error.
 *
 * Independent oracles:
 * - Specification: Item 2 of FQD spec sync single-flight, transaction rollback, ramp visibility.
 * - Observable SQLite state: records queried from the DB after commit or rollback.
 * - Observable exception: error instance and error message caught from transaction().
 *
 * Plausible wrong behaviors rejected:
 * - Overwriting the original error with "cannot rollback - no transaction is active"
 * - Leaving an uncommitted or broken transaction state blocking subsequent transactions
 * - Persisting mutations made during a failed transaction
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ServerAccount } from '../server/src/store';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, msg: string) {
  totalTests++;
  if (!condition) {
    failedTests++;
    console.error(`  ✗ [FAIL] ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    passedTests++;
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
    passedTests++;
    console.log(`  ✓ [PASS] ${msg}`);
  }
}

const APP_SECRET = '0123456789abcdef0123456789abcdef';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fqd-store-tx-test-'));
}

function runTests() {
  console.log('\n========================================');
  console.log('  STORE TRANSACTION ROLLBACK TESTS      ');
  console.log('========================================');

  const dir = createTempDir();
  const store = new Store(dir, 'test.db', APP_SECRET);

  try {
    // -------------------------------------------------------------------------
    // Test 1: Inside fn, run ROLLBACK on the underlying db, then throw new Error('original').
    // Verify transaction() throws an error with message 'original'.
    // -------------------------------------------------------------------------
    console.log('\nTest 1: Preserves original error when underlying db rollback fails');
    let caughtTest1Error: any = null;
    try {
      store.transaction(() => {
        // Force the underlying SQLite connection to rollback early (simulating SQLite
        // having already rolled back due to disk full, I/O error, or constraint violation).
        (store as any).db.exec('ROLLBACK');
        throw new Error('original');
      });
    } catch (err: any) {
      caughtTest1Error = err;
    }

    assert(caughtTest1Error !== null, 'Test 1: transaction() threw an error');
    assert(caughtTest1Error instanceof Error, 'Test 1: thrown value is an Error instance');
    assertEquals(
      caughtTest1Error?.message,
      'original',
      'Test 1: original error message "original" is preserved rather than overwritten by ROLLBACK failure'
    );

    // -------------------------------------------------------------------------
    // Test 2: Verify a normal transaction() call after Test 1 writes a row and commits cleanly
    // (proving no transaction was left open).
    // -------------------------------------------------------------------------
    console.log('\nTest 2: Normal transaction after Test 1 writes a row and commits cleanly');
    const testAccount: ServerAccount = {
      id: 'acc-tx-test-2',
      name: 'Account Test 2',
      providerType: 'claude',
      plan: 'pro',
      email: 'tx2@example.com',
      orderIndex: 0,
      isActive: true,
      lastStatus: 'idle',
      createdAt: new Date().toISOString(),
    };

    const txResult = store.transaction(() => {
      store.upsertAccount(testAccount);
      return 'commit-success';
    });

    assertEquals(txResult, 'commit-success', 'Test 2: transaction returned expected result');
    const retrievedAccount = store.getAccount('acc-tx-test-2');
    assert(retrievedAccount !== null, 'Test 2: row was written and persisted in database');
    assertEquals(retrievedAccount?.name, 'Account Test 2', 'Test 2: account row committed cleanly with correct name');
    assertEquals(retrievedAccount?.email, 'tx2@example.com', 'Test 2: account row committed cleanly with correct email');

    // -------------------------------------------------------------------------
    // Test 3: Verify a plain throw inside fn rolls back writes made inside fn and rethrows the same error.
    // -------------------------------------------------------------------------
    console.log('\nTest 3: Plain throw inside fn rolls back writes and rethrows same error');
    const rollbackAccount: ServerAccount = {
      id: 'acc-tx-test-3',
      name: 'Account Test 3 (Should Rollback)',
      providerType: 'chatgpt',
      plan: 'plus',
      email: 'tx3@example.com',
      orderIndex: 1,
      isActive: true,
      lastStatus: 'idle',
      createdAt: new Date().toISOString(),
    };

    let caughtTest3Error: any = null;
    try {
      store.transaction(() => {
        store.upsertAccount(rollbackAccount);
        // Verify that the row is visible inside the uncommitted transaction
        const inTxAccount = store.getAccount('acc-tx-test-3');
        assert(inTxAccount !== null, 'Test 3: row is visible within the transaction before rollback');
        throw new Error('plain rollback error');
      });
    } catch (err: any) {
      caughtTest3Error = err;
    }

    assert(caughtTest3Error !== null, 'Test 3: transaction() threw an error');
    assertEquals(
      caughtTest3Error?.message,
      'plain rollback error',
      'Test 3: rethrows the exact error thrown inside fn'
    );
    const afterRollbackAccount = store.getAccount('acc-tx-test-3');
    assertEquals(
      afterRollbackAccount,
      null,
      'Test 3: writes made inside fn were rolled back and row does not exist in store'
    );

    // Verify subsequent transaction still works cleanly after Test 3 rollback
    const postRollbackTx = store.transaction(() => {
      return store.listAccounts().length;
    });
    assertEquals(postRollbackTx, 1, 'Post-rollback: only account from Test 2 exists in store');

  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n========================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('========================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

try {
  runTests();
} catch (e) {
  console.error('Unhandled test failure in store_transaction_tests:', e);
  process.exit(1);
}
