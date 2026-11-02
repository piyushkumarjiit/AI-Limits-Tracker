import { TelemetryService } from '../server/src/telemetry';
import { formatTokenCount } from '../src/services/telemetryService';

async function runTests() {
  console.log('========================================');
  console.log('       PASSIVE TELEMETRY TESTS          ');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ [FAIL] ${msg}`);
      failed++;
    }
  }

  // Suite 1: SI Suffix Formatting
  console.log('Suite 1: Token Formatting (SI Suffixes)');
  assert(formatTokenCount(0) === '0', 'formatTokenCount(0) is 0');
  assert(formatTokenCount(450) === '450', 'formatTokenCount(450) is 450');
  assert(formatTokenCount(1200) === '1.2k', 'formatTokenCount(1200) is 1.2k');
  assert(formatTokenCount(780240) === '780k', 'formatTokenCount(780240) is 780k');
  assert(formatTokenCount(1240000) === '1.24M', 'formatTokenCount(1240000) is 1.24M');
  assert(formatTokenCount(50000000) === '50M', 'formatTokenCount(50000000) is 50M');

  // Suite 2: Passive Telemetry Standby Degradation
  console.log('\nSuite 2: Passive Fallback when Proxy is Unconfigured / Unreachable');
  // Use invalid ports to test passive degradation without network crashes
  const svc = new TelemetryService({
    cliProxyUrl: 'http://127.0.0.1:59999',
    liteLlmUrl: 'http://127.0.0.1:59998',
    liteLlmKey: 'sk-invalid',
  });

  const res = await svc.getTelemetry(['acc-1', 'acc-2']);
  assert(res.global.connected === false, 'Connected is false when unreachable');
  assert(res.global.mode === 'standby', 'Mode degrades to standby');
  assert(res.global.statusText === 'Telemetry: Standby (Direct Mode)', 'Status pill shows Telemetry: Standby (Direct Mode)');
  assert(typeof res.accounts === 'object', 'Accounts map is present');

  console.log(`\n========================================`);
  console.log(`SUMMARY: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
