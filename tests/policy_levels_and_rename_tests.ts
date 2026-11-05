/**
 * Policy-driven status levels, routing mode precedence, default classification,
 * and account rename persistence.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Store } from '../server/src/store';
import { Tracker } from '../server/src/tracker';
import { createApp, displayUrl } from '../server/src/app';
import {
  CpaPolicyLoader,
  DEFAULT_WATERMARK_POLICY,
  classifyAccount,
  effectiveRoutingMode,
  statusLevelsOf,
  validateWatermarkPolicy,
} from '../server/src/cpaWatermarkPolicy';
import { DEFAULT_EXHAUSTED_FLOOR_PCT, DEFAULT_TIGHT_FLOOR_PCT } from '../server/src/cpaTripwireEngine';
import { DEFAULT_STATUS_LEVELS } from '../src/constants/statusLevels';
import { severityOf } from '../src/services/capacity';
import type { UsageProvider } from '../src/services/providers/UsageProvider';
import { reconcile, type CpaLink, type ServerAccount } from '../src/services/cpa/reconcile';

let total = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  total++;
  if (cond) console.log(`  ✓ [PASS] ${msg}`);
  else {
    failed++;
    console.error(`  ✗ [FAIL] ${msg}`);
  }
}

const APP_SECRET = 'policy-levels-test-secret-0123456789';
const API_TOKEN = 'policy-levels-test-token-0123456789abcdef';

async function main() {
  console.log('Suite 1: one set of default levels');
  {
    const levels = statusLevelsOf(DEFAULT_WATERMARK_POLICY);
    assert(levels.pro.exhaustedPct === 2 && levels.nonPro.exhaustedPct === 5, 'Hard stop is 2% for Pro and 5% for Non-Pro');
    assert(levels.pro.tightPct === 20 && levels.nonPro.tightPct === 40, 'Drain is 20% for Pro and 40% for Non-Pro');
    assert(JSON.stringify(levels) === JSON.stringify(DEFAULT_STATUS_LEVELS), 'Policy defaults equal the shared status levels');
    assert(DEFAULT_WATERMARK_POLICY.pro.hardStopRecoveryPct === 5 && DEFAULT_WATERMARK_POLICY.nonPro.hardStopRecoveryPct === 8, 'Recovery points are 5% (Pro) and 8% (Non-Pro)');
    assert(DEFAULT_EXHAUSTED_FLOOR_PCT === 2 && DEFAULT_TIGHT_FLOOR_PCT === 20, 'Status check fallback floors match the Pro levels');
    assert(severityOf(20) === 'warning' && severityOf(2) === 'exhausted' && severityOf(21) === 'healthy', 'Bar colours use the same levels');
    const v = validateWatermarkPolicy({});
    assert(v.ok === true, 'The default levels pass policy validation');
  }

  console.log('Suite 2: default classification covers every account');
  {
    const cls = classifyAccount('claude-someone@example.com.json', DEFAULT_WATERMARK_POLICY.classificationRules);
    assert(cls.managed === true && cls.tier === 'pro' && cls.modality === 'subscription_pool', 'Built-in catch-all makes accounts managed Pro');
    const noRules = validateWatermarkPolicy({ mode: 'enforce' });
    assert(noRules.ok && noRules.policy.classificationRules.length === 1, 'A file without rules keeps the catch-all rule');
    const ownRules = validateWatermarkPolicy({
      classificationRules: [{ pattern: 'gemini-*', provider: 'antigravity', tier: 'non_pro', modality: 'subscription_pool', managed: true }],
    });
    assert(ownRules.ok && ownRules.policy.classificationRules.length === 1 && ownRules.policy.classificationRules[0].pattern === 'gemini-*', 'A file with its own rules replaces the catch-all');
    if (ownRules.ok) {
      const other = classifyAccount('claude-x.json', ownRules.policy.classificationRules);
      assert(other.managed === false, 'With explicit rules, an unmatched account stays unmanaged');
    }
  }

  console.log('Suite 3: routing mode precedence');
  {
    assert(effectiveRoutingMode('shadow', { CPA_ROUTING_MODE: 'enforce' }) === 'enforce', 'CPA_ROUTING_MODE overrides the policy mode');
    assert(effectiveRoutingMode('enforce', {}) === 'enforce', 'Without CPA_ROUTING_MODE the policy mode is used');
    assert(effectiveRoutingMode('enforce', { CPA_ROUTING_MODE: 'bogus' }) === 'enforce', 'An invalid CPA_ROUTING_MODE is ignored');
  }

  console.log('Suite 4: the policy file is read');
  {
    const dir = mkdtempSync(join(tmpdir(), 'policy-file-test-'));
    const file = join(dir, 'policy.yaml');
    writeFileSync(file, 'mode: enforce\npro:\n  drainPct: 30\n  drainRecoveryPct: 34\n  hardStopPct: 3\n  hardStopRecoveryPct: 6\n');
    const saved = process.env.CPA_ROUTING_MODE;
    delete process.env.CPA_ROUTING_MODE;
    try {
      const loader = new CpaPolicyLoader({ customFilePath: file, allowedRoots: [dir] });
      const policy = loader.loadPolicy();
      assert(policy.mode === 'enforce', 'Mode comes from the file');
      assert(statusLevelsOf(policy).pro.tightPct === 30 && statusLevelsOf(policy).pro.exhaustedPct === 3, 'Levels come from the file');
      process.env.CPA_ROUTING_MODE = 'shadow';
      assert(loader.getPolicy().mode === 'shadow', 'CPA_ROUTING_MODE still wins over the file');
      writeFileSync(file, 'mode: enforce\npro:\n  hardStopPct: 50\n');
      loader.loadPolicy();
      delete process.env.CPA_ROUTING_MODE;
      process.env.CPA_ROUTING_MODE = 'enforce';
      assert(loader.getPolicy().mode === 'shadow', 'A broken file falls back to shadow even when CPA_ROUTING_MODE is enforce');
    } finally {
      if (saved === undefined) delete process.env.CPA_ROUTING_MODE;
      else process.env.CPA_ROUTING_MODE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('Suite 5: gateway URLs never expose credentials');
  {
    assert(displayUrl('http://user:secret@litellm:4000/?key=abc') === 'http://litellm:4000', 'User info and query are stripped');
    assert(displayUrl(undefined) === null && displayUrl('not a url') === null, 'Missing or invalid URLs show nothing');
  }

  console.log('Suite 6: a renamed account keeps its name');
  {
    const dir = mkdtempSync(join(tmpdir(), 'rename-test-'));
    const store = new Store(dir, 'test.db', APP_SECRET);
    const tracker = new Tracker(store);
    const fake: UsageProvider = {
      id: 'fake',
      type: 'claude',
      name: 'Fake',
      validateCredentials: () => true,
      fetchUsage: async (accountId) => ({
        snapshot: {
          accountId,
          providerType: 'claude',
          status: 'ok',
          fetchedAt: new Date().toISOString(),
          buckets: [{ id: 'five_hour', label: 'Session (5h)', windowType: 'session_5h', utilizationPercent: 10, remainingPercent: 90, resetsAt: null }],
        } as any,
      }),
    };
    tracker.setCpaProvider(fake);
    store.upsertAccount({ id: 'acc-1', name: 'dev@example.com', providerType: 'claude', orderIndex: 0, isActive: true, plan: '', lastStatus: 'idle', createdAt: new Date(0).toISOString(), email: 'dev@example.com' });
    store.setCredentials('acc-1', { authType: 'cpa', cpaName: 'claude-dev@example.com.json' } as any);

    const app = createApp(
      { adminPassword: 'x'.repeat(40), appSecret: APP_SECRET, apiToken: API_TOKEN, secureCookies: false, trustProxy: false, webDir: dir },
      { store, tracker }
    );
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/accounts/acc-1`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Team seat 1' }),
      });
      assert(res.status === 200, 'PATCH /api/accounts/:id succeeds');
      assert(store.getAccount('acc-1')?.name === 'Team seat 1', 'The new name is stored in the database');

      await tracker.sync('acc-1');
      assert(store.getAccount('acc-1')?.latestSnapshot?.status === 'ok', 'A quota refresh ran');
      assert(store.getAccount('acc-1')?.name === 'Team seat 1', 'The name survives a quota refresh');

      const state = (await (await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${API_TOKEN}` } })).json()) as any;
      assert(state.accounts.find((a: any) => a.id === 'acc-1')?.name === 'Team seat 1', 'The panel receives the new name');

      const overview = (await (await fetch(`${base}/api/cpa/overview`, { headers: { Authorization: `Bearer ${API_TOKEN}` } })).json()) as any;
      assert(overview.statusLevels?.pro?.exhaustedPct === 2, 'The overview sends the policy levels to the panel');
      assert(overview.accounts.find((a: any) => a.accountId === 'acc-1')?.tier === 'pro', 'The overview sends each account tier');
    } finally {
      await new Promise<void>((resolve) => app.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('Suite 7: a CLIProxy sync keeps a renamed account name');
  {
    const now = Date.now();
    const accounts = [
      { id: 'acc-1', providerType: 'claude', name: 'Team seat 1', email: 'dev@example.com', isActive: true, orderIndex: 0, createdAt: now - 1000, lastStatus: 'reauth_required' },
    ] as unknown as ServerAccount[];
    const links = [
      { accountId: 'acc-1', identityKey: 'claude:dev@example.com', cpaName: 'claude-dev.json', authIndex: 'idx-1', state: 'linked', lastSeenAt: now - 1000 },
    ] as unknown as CpaLink[];
    // CLIProxy reports a different label and a status change, which forces an account write.
    const entries = [
      { name: 'claude-dev.json', auth_index: 'idx-1', provider: 'claude', source: 'file', email: 'dev@example.com', label: 'Label from CLIProxy', status: 'active' },
    ] as any[];
    const result = reconcile(entries, links, accounts, now, { purgeDays: 30, adoptExisting: true, emptyStreak: 0 });
    const written = result.accountUpserts.find((a) => a.id === 'acc-1');
    assert(!written || written.name === 'Team seat 1', 'Sync does not replace the name with the CLIProxy label');
    assert(result.deletes.length === 0, 'Sync does not delete the renamed account');
  }

  console.log(`\nSUMMARY: Total: ${total} | Passed: ${total - failed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
