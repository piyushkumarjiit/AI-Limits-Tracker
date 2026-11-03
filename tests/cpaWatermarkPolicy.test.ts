import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import {
  CpaPolicyLoader,
  DEFAULT_WATERMARK_POLICY,
  classifyAccount,
  matchGlob,
  validateWatermarkPolicy,
  type ClassificationRule,
  type FullWatermarkPolicy,
} from '../server/src/cpaWatermarkPolicy';
import { CpaWatermarkStore } from '../server/src/cpaWatermarkStore';
import { Store } from '../server/src/store';
import type { EngineState } from '../server/src/cpaWatermarkEngine';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function pass(name: string) {
  totalTests++;
  passedTests++;
  console.log(`  [PASS] ${name}`);
}

function fail(name: string, error: unknown) {
  totalTests++;
  failedTests++;
  console.error(`  [FAIL] ${name}`);
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

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('\n======================================================');
  console.log('  CPA WATERMARK POLICY & STORAGE TESTS (WP-2)');
  console.log('======================================================\n');

  // --------------------------------------------------------------------------
  // Suite 1: Glob Wildcard Matching & Credential Pattern Classification
  // --------------------------------------------------------------------------
  console.log('Suite 1: Glob Matching & Credential Pattern Classification');
  try {
    assert(matchGlob('*antigravity*', 'acc-antigravity-01.json'), 'Antigravity glob matches');
    assert(matchGlob('claude-*-pro', 'claude-east-pro'), 'Wildcard middle matches');
    assert(!matchGlob('claude-*-pro', 'claude-east-team'), 'Wildcard mismatch returns false');
    assert(matchGlob('codex-?.json', 'codex-1.json'), 'Question mark matches single char');
    assert(!matchGlob('codex-?.json', 'codex-10.json'), 'Question mark fails multi char');
    pass('Glob pattern matcher supports * and ? correctly');
  } catch (err) {
    fail('Glob pattern matcher supports * and ? correctly', err);
  }

  try {
    const rules: ClassificationRule[] = [
      {
        pattern: '*antigravity*',
        provider: 'antigravity',
        tier: 'pro',
        modality: 'subscription_pool',
        managed: true,
      },
      {
        pattern: '*claude-pro*',
        provider: 'claude',
        tier: 'pro',
        modality: 'subscription_pool',
        managed: true,
      },
      {
        pattern: '*claude-free*',
        provider: 'claude',
        tier: 'non_pro',
        modality: 'subscription_pool',
        managed: true,
      },
      {
        pattern: '*budgeted*',
        provider: 'codex',
        tier: 'pro',
        modality: 'budgeted_allowance',
        managed: false,
      },
    ];

    const match1 = classifyAccount('acc-antigravity-slot1.json', rules);
    assertEquals(match1.provider, 'antigravity', 'Match 1 provider');
    assertEquals(match1.tier, 'pro', 'Match 1 tier');
    assertEquals(match1.modality, 'subscription_pool', 'Match 1 modality');
    assertEquals(match1.managed, true, 'Match 1 managed');

    const match2 = classifyAccount('my-claude-free-02.json', rules);
    assertEquals(match2.provider, 'claude', 'Match 2 provider');
    assertEquals(match2.tier, 'non_pro', 'Match 2 tier');

    const match3 = classifyAccount('deepseek-unrecognized.json', rules);
    assertEquals(match3.provider, 'unknown', 'Unmatched provider defaults to unknown');
    assertEquals(match3.tier, 'pro', 'Unmatched tier defaults to pro');
    assertEquals(match3.modality, 'subscription_pool', 'Unmatched modality defaults to subscription_pool');
    assertEquals(match3.managed, false, 'Unmatched managed defaults to false');

    pass('classifyAccount applies first-match rules and defaults unmatched to safe unmanaged unknown');
  } catch (err) {
    fail('classifyAccount applies first-match rules and defaults unmatched to safe unmanaged unknown', err);
  }

  // --------------------------------------------------------------------------
  // Suite 2: YAML Policy Validation & Boundary Sanity Checks
  // --------------------------------------------------------------------------
  console.log('\nSuite 2: Policy Validation & Boundary Sanity Checks');
  try {
    const validRaw = {
      mode: 'enforce',
      interval_sec: 45,
      apply_latency_sec: 10,
      burn_rate_max: 20,
      pro: {
        drain_pct: 25,
        drain_recovery_pct: 28,
        hard_stop_pct: 6,
        hard_stop_recovery_pct: 9,
        fallback_min_dwell_sec: 300,
        recovery_dwell_sec: 400,
      },
      non_pro: {
        drain_pct: 45,
        drain_recovery_pct: 50,
        hard_stop_pct: 3,
        hard_stop_recovery_pct: 6,
      },
      classification_rules: [
        {
          pattern: 'ag-*',
          provider: 'antigravity',
          tier: 'pro',
          modality: 'subscription_pool',
          managed: true,
        },
      ],
    };

    const res = validateWatermarkPolicy(validRaw);
    assert(res.ok, 'Validation should succeed for valid policy');
    if (res.ok) {
      assertEquals(res.policy.mode, 'enforce', 'Policy mode enforce');
      assertEquals(res.policy.intervalSec, 45, 'Policy intervalSec');
      assertEquals(res.policy.pro.drainPct, 25, 'pro drainPct');
      assertEquals(res.policy.pro.drainRecoveryPct, 28, 'pro drainRecoveryPct');
      assertEquals(res.policy.pro.hardStopPct, 6, 'pro hardStopPct');
      assertEquals(res.policy.pro.hardStopRecoveryPct, 9, 'pro hardStopRecoveryPct');
      assertEquals(res.policy.classificationRules.length, 1, 'classification rules length');
    }
    pass('validateWatermarkPolicy correctly normalizes snake_case nested YAML input');
  } catch (err) {
    fail('validateWatermarkPolicy correctly normalizes snake_case nested YAML input', err);
  }

  try {
    const invalidMode = validateWatermarkPolicy({ mode: 'invalid_mode' });
    assert(!invalidMode.ok, 'Invalid mode rejected');

    const invertedHardStopDrain = validateWatermarkPolicy({
      pro: {
        drain_pct: 10,
        hard_stop_pct: 15, // hardStop > drain -> invalid!
      },
    });
    assert(!invertedHardStopDrain.ok, 'hardStopPct >= drainPct rejected');

    const invalidRecovery = validateWatermarkPolicy({
      pro: {
        drain_pct: 20,
        drain_recovery_pct: 18, // recovery <= drain -> invalid!
      },
    });
    assert(!invalidRecovery.ok, 'drainRecoveryPct <= drainPct rejected');

    const invalidHardStopRecovery = validateWatermarkPolicy({
      pro: {
        drain_pct: 20,
        hard_stop_pct: 5,
        hard_stop_recovery_pct: 22, // hardStopRecovery >= drain -> invalid!
      },
    });
    assert(!invalidHardStopRecovery.ok, 'hardStopRecoveryPct >= drainPct rejected');

    const negativeInterval = validateWatermarkPolicy({
      interval_sec: -10,
    });
    assert(!negativeInterval.ok, 'Negative interval rejected');

    // B4: managed strictly boolean validation
    const nonBooleanManaged = validateWatermarkPolicy({
      classification_rules: [
        {
          pattern: 'test-*',
          provider: 'test',
          tier: 'pro',
          modality: 'subscription_pool',
          managed: 'not_a_boolean',
        },
      ],
    });
    assert(!nonBooleanManaged.ok, 'Non-boolean managed field must be rejected');

    // B4: omission defaults to false
    const omittedManaged = validateWatermarkPolicy({
      classification_rules: [
        {
          pattern: 'test-*',
          provider: 'test',
          tier: 'pro',
          modality: 'subscription_pool',
        },
      ],
    });
    assert(omittedManaged.ok, 'Omitted managed field should be accepted');
    if (omittedManaged.ok) {
      assertEquals(omittedManaged.policy.classificationRules[0].managed, false, 'Omitted managed defaults strictly to false');
    }

    pass('validateWatermarkPolicy enforces mode, ordering invariants, non-negative durations, and strict managed boolean');
  } catch (err) {
    fail('validateWatermarkPolicy enforces mode, ordering invariants, non-negative durations, and strict managed boolean', err);
  }

  // --------------------------------------------------------------------------
  // Suite 3: Policy Loader Priority & Safe Shadow Fallback
  // --------------------------------------------------------------------------
  console.log('\nSuite 3: Policy Loader Priority & Safe Shadow Fallback');
  try {
    // When no file exists, defaults to safe shadow mode
    const emptyLoader = new CpaPolicyLoader({ customFilePath: '/tmp/nonexistent-policy-fqd-xyz.yaml' });
    const policy = emptyLoader.loadPolicy();
    assertEquals(policy.mode, 'shadow', 'Nonexistent policy defaults to shadow mode');
    assertEquals(policy.burnRateMax, 15, 'Default burn rate 15');
    pass('PolicyLoader safely defaults to shadow mode when no config file exists');
  } catch (err) {
    fail('PolicyLoader safely defaults to shadow mode when no config file exists', err);
  }

  try {
    const tempDir = createTempDir('cpa-policy-test-');
    const invalidYamlPath = path.join(tempDir, 'invalid.yaml');
    fs.writeFileSync(invalidYamlPath, 'mode: [unclosed brackets', 'utf8');

    let errorReported = false;
    const loader = new CpaPolicyLoader({
      customFilePath: invalidYamlPath,
      onError: () => {
        errorReported = true;
      },
    });

    const fallbackPolicy = loader.loadPolicy();
    assert(errorReported, 'Error callback fired on corrupted YAML');
    assertEquals(fallbackPolicy.mode, 'shadow', 'Corrupted YAML falls back to shadow mode safely');

    fs.rmSync(tempDir, { recursive: true, force: true });
    pass('PolicyLoader catches syntax errors and gracefully falls back to shadow mode without crashing');
  } catch (err) {
    fail('PolicyLoader catches syntax errors and gracefully falls back to shadow mode without crashing', err);
  }

  try {
    const tempDir = createTempDir('cpa-policy-prio-');
    const customPath = path.join(tempDir, 'custom.yaml');
    const envPath = path.join(tempDir, 'env.yaml');

    fs.writeFileSync(
      customPath,
      yaml.stringify({ mode: 'enforce', pro: { drain_pct: 22, drain_recovery_pct: 26, hard_stop_pct: 5, hard_stop_recovery_pct: 8 } }),
      'utf8'
    );
    fs.writeFileSync(
      envPath,
      yaml.stringify({ mode: 'shadow', pro: { drain_pct: 19, drain_recovery_pct: 23, hard_stop_pct: 5, hard_stop_recovery_pct: 8 } }),
      'utf8'
    );

    const oldEnv = process.env.CPA_WATERMARK_POLICY_FILE;
    try {
      process.env.CPA_WATERMARK_POLICY_FILE = envPath;
      const loader = new CpaPolicyLoader({ customFilePath: customPath });
      const loaded = loader.loadPolicy();
      assertEquals(loaded.mode, 'enforce', 'customFilePath takes priority over CPA_WATERMARK_POLICY_FILE');
      assertEquals(loader.getResolvedPath(), customPath, 'resolvedPath matches customFilePath');
    } finally {
      if (oldEnv) {
        process.env.CPA_WATERMARK_POLICY_FILE = oldEnv;
      } else {
        delete process.env.CPA_WATERMARK_POLICY_FILE;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    pass('PolicyLoader resolves file candidates in strict priority order');
  } catch (err) {
    fail('PolicyLoader resolves file candidates in strict priority order', err);
  }

  // --------------------------------------------------------------------------
  // Suite 4: Hot-Reload File Watching & SHA-256 Debouncing (including Atomic Replace B2/B3)
  // --------------------------------------------------------------------------
  console.log('\nSuite 4: Hot-Reload File Watching & SHA-256 Debouncing');
  try {
    const tempDir = createTempDir('cpa-policy-watch-');
    const policyFile = path.join(tempDir, 'active-policy.yaml');

    fs.writeFileSync(
      policyFile,
      yaml.stringify({
        mode: 'shadow',
        interval_sec: 60,
        pro: { drain_pct: 20, drain_recovery_pct: 24, hard_stop_pct: 5, hard_stop_recovery_pct: 8 },
      }),
      'utf8'
    );

    let reloadCount = 0;
    let latestMode = '';

    const loader = new CpaPolicyLoader({
      customFilePath: policyFile,
      debounceMs: 50,
      onPolicyChange: (newPol) => {
        reloadCount++;
        latestMode = newPol.mode;
      },
    });

    loader.loadPolicy();
    loader.startWatcher();

    // Spurious touch without content change
    fs.writeFileSync(
      policyFile,
      yaml.stringify({
        mode: 'shadow',
        interval_sec: 60,
        pro: { drain_pct: 20, drain_recovery_pct: 24, hard_stop_pct: 5, hard_stop_recovery_pct: 8 },
      }),
      'utf8'
    );
    await sleep(150);
    assertEquals(reloadCount, 0, 'Spurious write with identical SHA-256 does not trigger onPolicyChange');

    // Real change to enforce mode
    fs.writeFileSync(
      policyFile,
      yaml.stringify({
        mode: 'enforce',
        interval_sec: 30,
        pro: { drain_pct: 20, drain_recovery_pct: 24, hard_stop_pct: 5, hard_stop_recovery_pct: 8 },
      }),
      'utf8'
    );
    await sleep(200);

    assertEquals(reloadCount, 1, 'Content change triggers hot-reload callback');
    assertEquals(latestMode, 'enforce', 'Hot reloaded policy has new enforce mode');

    // B2: Atomic file replacement (write to temp file then rename over target)
    const atomicTempFile = path.join(tempDir, 'temp-replace.yaml');
    fs.writeFileSync(
      atomicTempFile,
      yaml.stringify({
        mode: 'off',
        interval_sec: 120,
        pro: { drain_pct: 25, drain_recovery_pct: 30, hard_stop_pct: 5, hard_stop_recovery_pct: 8 },
      }),
      'utf8'
    );
    fs.renameSync(atomicTempFile, policyFile);
    await sleep(250);

    assertEquals(reloadCount, 2, 'Atomic rename replace triggers hot-reload callback without unbinding watcher');
    assertEquals(latestMode, 'off', 'Atomic replace loaded mode off');

    loader.stopWatcher();
    fs.rmSync(tempDir, { recursive: true, force: true });
    pass('Hot-reload watcher debounces updates and detects SHA-256 content changes across atomic renames');
  } catch (err) {
    fail('Hot-reload watcher debounces updates and detects SHA-256 content changes across atomic renames', err);
  }

  // --------------------------------------------------------------------------
  // Suite 5: SQLite Watermark Store Persistence (node:sqlite DatabaseSync)
  // --------------------------------------------------------------------------
  console.log('\nSuite 5: SQLite Watermark Store Persistence (node:sqlite)');
  try {
    const db = new DatabaseSync(':memory:');
    const store = new CpaWatermarkStore(db);

    const initial = store.loadState();
    assertEquals(initial, null, 'Initial state is null');

    const dummyState: EngineState = {
      mode: 'shadow',
      generation: 1,
      tierStates: {
        antigravity_pro: 'normal',
      },
      accountStates: {
        'acc-ag-1': {
          state: 'healthy',
          enteredAt: 1000,
          targetWeight: 100,
        },
      },
    };

    store.saveState(dummyState, 'init_tick', DEFAULT_WATERMARK_POLICY);

    const loaded = store.loadState();
    assert(loaded !== null, 'Loaded state should not be null');
    if (loaded) {
      assertEquals(loaded.generation, 1, 'Generation matches');
      assertEquals(loaded.state.mode, 'shadow', 'Engine mode matches');
      assertEquals(loaded.state.tierStates.antigravity_pro, 'normal', 'Tier state matches');
      assertEquals(loaded.state.accountStates['acc-ag-1'].targetWeight, 100, 'Account weight matches');
      assertEquals(loaded.policy?.mode, 'shadow', 'Persisted policy matches');
    }

    const history = store.getHistory(10);
    assertEquals(history.length, 1, 'Audit history has 1 record');
    assertEquals(history[0].eventType, 'init_tick', 'Event type matches');
    assertEquals(history[0].generation, 1, 'Audit history generation matches');

    // Update state to generation 2
    dummyState.generation = 2;
    dummyState.accountStates['acc-ag-1'].targetWeight = 1;
    dummyState.accountStates['acc-ag-1'].state = 'drain';
    store.saveState(dummyState, 'drain_transition');

    const updated = store.loadState();
    assert(updated !== null, 'Updated state exists');
    if (updated) {
      assertEquals(updated.generation, 2, 'Updated generation 2');
      assertEquals(updated.state.accountStates['acc-ag-1'].state, 'drain', 'Updated account state drain');
    }

    const updatedHistory = store.getHistory(10);
    assertEquals(updatedHistory.length, 2, 'Audit history contains 2 entries in reverse chronological order');
    assertEquals(updatedHistory[0].generation, 2, 'Newest history entry is generation 2');

    // B1: Test savepoint release on error injection
    let saveFailed = false;
    try {
      // Intentionally cause failure during saveState by corrupting table schema with conflicting trigger
      db.exec(`
        CREATE TRIGGER fail_trigger BEFORE INSERT ON cpa_watermark_history
        BEGIN
          SELECT RAISE(FAIL, 'simulated store failure');
        END;
      `);
      store.saveState(dummyState, 'failing_tick');
    } catch {
      saveFailed = true;
    }
    assert(saveFailed, 'Injected failure properly threw');

    // Remove trigger and verify store can continue using savepoints without transaction leak
    db.exec('DROP TRIGGER fail_trigger;');
    dummyState.generation = 3;
    store.saveState(dummyState, 'recovered_tick');
    const recovered = store.loadState();
    assertEquals(recovered?.generation, 3, 'Savepoint succeeded after failure without transaction leak');

    pass('CpaWatermarkStore atomically saves, loads, appends audit history, and cleans savepoints on failure');
  } catch (err) {
    fail('CpaWatermarkStore atomically saves, loads, appends audit history, and cleans savepoints on failure', err);
  }

  // --------------------------------------------------------------------------
  // Suite 6: Store History Pruning & Clear
  // --------------------------------------------------------------------------
  console.log('\nSuite 6: History Pruning & Clear Operations');
  try {
    const db = new DatabaseSync(':memory:');
    const store = new CpaWatermarkStore(db);

    const dummyState: EngineState = {
      mode: 'shadow',
      generation: 1,
      tierStates: {},
      accountStates: {},
    };

    store.saveState(dummyState, 'tick_1');
    store.saveState(dummyState, 'tick_2');
    assertEquals(store.getHistory().length, 2, 'Two records present');

    // Prune with future cutoff
    const pruned = store.pruneHistory(-1000); // cutoff in future deletes all
    assert(pruned >= 2, 'Pruned at least 2 records');
    assertEquals(store.getHistory().length, 0, 'History empty after pruning');

    store.saveState(dummyState, 'tick_3');
    store.clear();
    assertEquals(store.loadState(), null, 'State cleared');
    assertEquals(store.getHistory().length, 0, 'History cleared');

    pass('History pruning and store clear execute successfully');
  } catch (err) {
    fail('History pruning and store clear execute successfully', err);
  }

  // --------------------------------------------------------------------------
  // Suite 7: Integration with Main Server Store
  // --------------------------------------------------------------------------
  console.log('\nSuite 7: Integration with Main Server Store');
  try {
    const tempDir = createTempDir('fqd-store-test-');
    const secret = '0123456789abcdef0123456789abcdef';
    const mainStore = new Store(tempDir, 'test.db', secret);

    assert(Boolean(mainStore.watermarkStore), 'mainStore exposes watermarkStore instance');

    const dummyState: EngineState = {
      mode: 'shadow',
      generation: 5,
      tierStates: {
        codex_pro: 'normal',
      },
      accountStates: {},
    };

    mainStore.watermarkStore.saveState(dummyState, 'server_init');
    const retrieved = mainStore.watermarkStore.loadState();
    assert(retrieved !== null, 'Retrieved watermark state from server store');
    if (retrieved) {
      assertEquals(retrieved.generation, 5, 'Retrieved generation 5');
    }

    mainStore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    pass('Server Store exposes watermarkStore seamlessly');
  } catch (err) {
    fail('Server Store exposes watermarkStore seamlessly', err);
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`SUMMARY: Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('Fatal test runner error:', e);
  process.exit(1);
});
