import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/src/store';
import { CpaUsageCollector, toUsageRow } from '../server/src/cpaUsageCollector';
import { TelemetryService } from '../server/src/telemetry';

let failed = 0;
function assert(condition: boolean, name: string) {
  console.log(`  ${condition ? '✓ [PASS]' : '✗ [FAIL]'} ${name}`);
  if (!condition) failed++;
}

const record = (id: string, total: number, extra: Record<string, unknown> = {}) => ({
  request_id: id,
  timestamp: new Date().toISOString(),
  source: 'User@Example.com',
  model: 'gemini-3.8-flash-high',
  tokens: { input_tokens: total - 10, output_tokens: 10, total_tokens: total },
  failed: false,
  ...extra,
});

(async () => {
  console.log('CPA usage collector tests');

  const row = toUsageRow(record('r1', 110));
  assert(row?.email === 'user@example.com' && row.totalTokens === 110 && row.inputTokens === 100, 'parses a v8 usage record');
  assert(toUsageRow({ model: 'x', source: 'a@b.c' }) === null, 'skips records without a request id');
  assert(toUsageRow(record('r2', 5, { source: undefined })) === null, 'skips records without an account');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqd-usage-'));
  const store = new Store(dir, 'test.db', 'x'.repeat(32));
  let queue: any[] = [record('r1', 110), record('r2', 50, { model: 'claude-sonnet' })];
  const transport = { getUsageQueue: async () => queue } as any;
  const collector = new CpaUsageCollector(store, transport, 60_000);

  assert((await collector.pollOnce()) === 2, 'first poll saves both records');
  assert((await collector.pollOnce()) === 0, 'repeat poll of the same queue saves nothing');
  queue = [...queue, record('r3', 40)];
  assert((await collector.pollOnce()) === 1, 'only the new record is saved');

  const summary = store.cpaUsageSummary(Date.now() - 86_400_000);
  const gemini = summary.find((s) => s.model === 'gemini-3.8-flash-high');
  assert(gemini?.requests === 2 && gemini.totalTokens === 150, 'summary groups by account and model');

  const telemetry = await new TelemetryService({ cliProxyUrl: 'http://127.0.0.1:1', usageSummary: (s) => store.cpaUsageSummary(s) }).getTelemetry([
    { id: 'acc-1', email: 'user@example.com' },
  ]);
  assert(telemetry.models?.[0]?.model === 'gemini-3.8-flash-high', 'telemetry falls back to CLIProxy per-model totals');

  queue = [];
  transport.getUsageQueue = async () => {
    throw new Error('404');
  };
  assert((await collector.pollOnce()) === 0, 'an unavailable queue is tolerated');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'All passed' : `${failed} failed`}`);
  if (failed) process.exit(1);
})();
