let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, extraInfo?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  ✗ [FAIL] ${testName} ${extraInfo ? `-> ${extraInfo}` : ''}`);
    console.log(`::error file=tests/antigravity_parser_tests.ts::[FAIL] ${testName} ${extraInfo ? `-> ${extraInfo.replace(/\r?\n/g, ' ')}` : ''}`);
  }
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  credentials?: string;
  body?: string;
}

/** Replaces global fetch with a router; returns the recorded calls. */
function mockFetch(handler: (url: string, init: any) => { status: number; body: any }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    calls.push({ url, headers: init.headers || {}, credentials: init.credentials, body: init.body });
    const { status, body } = handler(url, init);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as any;
  };
  return calls;
}

void assert;
void mockFetch;

async function runAllTests() {
  console.log('Antigravity parser tests (stub)');

  console.log(`\n${totalTests - failedTests}/${totalTests} passed`);
  if (failedTests > 0) process.exit(1);
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
