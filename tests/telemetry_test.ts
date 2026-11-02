import { TelemetryService, validateTelemetryBaseUrl } from '../server/src/telemetry';
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

  // Suite 3: Telemetry URL Validation & SSRF Guard
  console.log('\nSuite 3: Telemetry URL Validation & SSRF Guard');
  // Safe loopback and RFC1918 addresses
  assert(validateTelemetryBaseUrl('http://127.0.0.1:8317') !== null, 'Accepts http://127.0.0.1:8317');
  assert(validateTelemetryBaseUrl('http://localhost:8317') !== null, 'Accepts http://localhost:8317');
  assert(validateTelemetryBaseUrl('http://sub.localhost:8317') !== null, 'Accepts http://sub.localhost:8317');
  assert(validateTelemetryBaseUrl('http://[::1]:8317') !== null, 'Accepts http://[::1]:8317');
  assert(validateTelemetryBaseUrl('http://10.0.0.1:8000') !== null, 'Accepts RFC1918 10.0.0.1');
  assert(validateTelemetryBaseUrl('http://172.16.0.1:8000') !== null, 'Accepts RFC1918 172.16.0.1');
  assert(validateTelemetryBaseUrl('http://192.168.1.1:8000') !== null, 'Accepts RFC1918 192.168.1.1');
  assert(validateTelemetryBaseUrl('https://proxy.example.com') !== null, 'Accepts public https URL');
  assert(validateTelemetryBaseUrl('https://litellm.openai.com/api') !== null, 'Accepts https with subpath');

  // Plain http on public address rejected
  assert(validateTelemetryBaseUrl('http://example.com') === null, 'Rejects plain http on public hostname');
  assert(validateTelemetryBaseUrl('http://8.8.8.8') === null, 'Rejects plain http on public IP');
  assert(validateTelemetryBaseUrl('http://1.1.1.1:8317') === null, 'Rejects plain http on public IP with port');

  // SSRF: Cloud metadata and link-local rejected
  assert(validateTelemetryBaseUrl('http://169.254.169.254/latest/meta-data') === null, 'Rejects http AWS metadata IP');
  assert(validateTelemetryBaseUrl('https://169.254.169.254') === null, 'Rejects https link-local IP');
  assert(validateTelemetryBaseUrl('http://0.0.0.0:8317') === null, 'Rejects 0.0.0.0');

  // SSRF: Credentials in URL rejected
  assert(validateTelemetryBaseUrl('http://user:pass@127.0.0.1:8317') === null, 'Rejects credentials in http URL');
  assert(validateTelemetryBaseUrl('https://user:pass@example.com') === null, 'Rejects credentials in https URL');

  // SSRF: Unsafe protocols rejected
  assert(validateTelemetryBaseUrl('file:///etc/passwd') === null, 'Rejects file: protocol');
  assert(validateTelemetryBaseUrl('gopher://127.0.0.1:8317') === null, 'Rejects gopher: protocol');
  assert(validateTelemetryBaseUrl('javascript:alert(1)') === null, 'Rejects javascript: protocol');
  assert(validateTelemetryBaseUrl('data:text/plain;base64,SGVsbG8=') === null, 'Rejects data: protocol');

  // Malformed and empty inputs
  assert(validateTelemetryBaseUrl('') === null, 'Rejects empty string');
  assert(validateTelemetryBaseUrl('   ') === null, 'Rejects whitespace string');
  assert(validateTelemetryBaseUrl(undefined) === null, 'Rejects undefined');
  assert(validateTelemetryBaseUrl(null) === null, 'Rejects null');
  assert(validateTelemetryBaseUrl('not-a-url') === null, 'Rejects unparseable URL');

  // Suite 4: TelemetryService Graceful Standby with Blocked SSRF Targets
  console.log('\nSuite 4: TelemetryService Standby with Blocked SSRF Targets');
  const ssrfSvc = new TelemetryService({
    cliProxyUrl: 'http://169.254.169.254/latest/meta-data',
    liteLlmUrl: 'http://evil.com/ssrf',
    liteLlmKey: 'sk-attack',
  });
  const ssrfRes = await ssrfSvc.getTelemetry(['acc-1']);
  assert(ssrfRes.global.connected === false, 'Blocked SSRF targets do not connect');
  assert(ssrfRes.global.mode === 'standby', 'SSRF targets degrade to standby mode');
  assert(ssrfRes.global.providers.cliproxy === false, 'CLIProxy provider is false');
  assert(ssrfRes.global.providers.litellm === false, 'LiteLLM provider is false');

  console.log(`\n========================================`);
  console.log(`SUMMARY: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
