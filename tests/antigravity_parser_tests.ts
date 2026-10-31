import {
  parseAntigravityQuotaSummary,
  agyFamily,
  agyWindow,
  agyRemainingFraction,
} from '../src/services/providers/antigravityQuota';

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

const FIXTURE = {
  groups: [
    {
      displayName: 'Gemini',
      buckets: [
        {
          bucketId: 'gemini-5h',
          displayName: 'Five Hour Limit Remaining',
          window: '5h',
          remainingFraction: 0.75,
          resetTime: '2026-11-01T03:00:00Z',
        },
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          remainingFraction: 0.4,
          resetTime: '2026-11-05T00:00:00Z',
        },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        {
          bucketId: '3p-5h',
          remainingFraction: 1,
        },
        {
          bucketId: '3p-weekly',
          remaining: { case: 'remainingFraction', value: 0.1 },
          resetTime: '2026-11-06T00:00:00Z',
        },
      ],
    },
    {
      displayName: 'Gemini Argon',
      buckets: [
        {
          bucketId: 'gemini-argon-weekly',
          remainingFraction: 0.9,
        },
        {
          bucketId: 'argon-legacy',
          disabled: true,
          remainingFraction: 0,
        },
      ],
    },
  ],
};

async function runAllTests() {
  console.log('Antigravity parser tests');

  // Test 1: FIXTURE -> 5 buckets with ids in order gemini_5h, gemini_weekly, 3p_5h, 3p_weekly, argon_weekly
  const buckets = parseAntigravityQuotaSummary(FIXTURE);
  const ids = buckets.map((b) => b.id);
  assert(
    buckets.length === 5 &&
      ids[0] === 'gemini_5h' &&
      ids[1] === 'gemini_weekly' &&
      ids[2] === '3p_5h' &&
      ids[3] === '3p_weekly' &&
      ids[4] === 'argon_weekly',
    '1. FIXTURE produces 5 buckets in canonical order (gemini_5h, gemini_weekly, 3p_5h, 3p_weekly, argon_weekly)',
    `got: ${JSON.stringify(ids)}`
  );

  // Test 2: gemini_5h assertions
  const gemini5h = buckets.find((b) => b.id === 'gemini_5h');
  assert(
    gemini5h !== undefined &&
      gemini5h.utilizationPercent === 25 &&
      gemini5h.remainingPercent === 75 &&
      gemini5h.windowType === 'session_5h' &&
      gemini5h.label === 'Gemini · 5-hour' &&
      gemini5h.resetsAt === '2026-11-01T03:00:00Z',
    '2. gemini_5h: utilizationPercent 25, remainingPercent 75, windowType session_5h, label "Gemini · 5-hour", resetsAt',
    `got: ${JSON.stringify(gemini5h)}`
  );

  // Test 3: gemini_weekly assertions
  const geminiWeekly = buckets.find((b) => b.id === 'gemini_weekly');
  assert(
    geminiWeekly !== undefined &&
      geminiWeekly.utilizationPercent === 60 &&
      geminiWeekly.windowType === 'weekly_7d',
    '3. gemini_weekly: utilization 60, windowType weekly_7d',
    `got: ${JSON.stringify(geminiWeekly)}`
  );

  // Test 4: 3p_weekly (oneof remaining)
  const p3Weekly = buckets.find((b) => b.id === '3p_weekly');
  assert(
    p3Weekly !== undefined &&
      p3Weekly.utilizationPercent === 90 &&
      p3Weekly.severity === 'critical',
    '4. 3p_weekly (oneof remaining): utilization 90, severity critical',
    `got: ${JSON.stringify(p3Weekly)}`
  );

  // Test 5: 3p_5h assertions
  const p35h = buckets.find((b) => b.id === '3p_5h');
  assert(
    p35h !== undefined &&
      p35h.utilizationPercent === 0 &&
      p35h.resetsAt === null,
    '5. 3p_5h: utilization 0, resetsAt null',
    `got: ${JSON.stringify(p35h)}`
  );

  // Test 6: argon_weekly exists, details.family === 'argon', disabled bucket skipped
  const argonWeekly = buckets.find((b) => b.id === 'argon_weekly');
  const disabledLegacy = buckets.find((b) => b.id.includes('legacy'));
  assert(
    argonWeekly !== undefined &&
      argonWeekly.details?.family === 'argon' &&
      disabledLegacy === undefined,
    '6. argon_weekly exists with details.family === "argon", disabled bucket is skipped',
    `argon: ${JSON.stringify(argonWeekly)}, disabled: ${JSON.stringify(disabledLegacy)}`
  );

  // Test 7: envelope { response: FIXTURE } gives the same result as FIXTURE
  const envelopedBuckets = parseAntigravityQuotaSummary({ response: FIXTURE });
  assert(
    JSON.stringify(envelopedBuckets) === JSON.stringify(buckets),
    '7. envelope { response: FIXTURE } gives identical result to FIXTURE'
  );

  // Test 8: bucket with no fraction but a resetTime -> utilization 100, isExhausted true
  const exhaustedRaw = {
    groups: [
      {
        displayName: 'Gemini',
        buckets: [
          {
            bucketId: 'gemini-5h',
            resetTime: '2026-11-01T03:00:00Z',
          },
        ],
      },
    ],
  };
  const exhaustedBuckets = parseAntigravityQuotaSummary(exhaustedRaw);
  assert(
    exhaustedBuckets.length === 1 &&
      exhaustedBuckets[0].utilizationPercent === 100 &&
      exhaustedBuckets[0].isExhausted === true,
    '8. bucket with no fraction but resetTime -> utilization 100, isExhausted true',
    `got: ${JSON.stringify(exhaustedBuckets[0])}`
  );

  // Test 9: bucket with no fraction and no reset -> utilizationPercent null, severity 'unavailable'
  const unavailableRaw = {
    groups: [
      {
        displayName: 'Gemini',
        buckets: [
          {
            bucketId: 'gemini-5h',
          },
        ],
      },
    ],
  };
  const unavailableBuckets = parseAntigravityQuotaSummary(unavailableRaw);
  assert(
    unavailableBuckets.length === 1 &&
      unavailableBuckets[0].utilizationPercent === null &&
      unavailableBuckets[0].severity === 'unavailable',
    '9. bucket with no fraction and no reset -> utilizationPercent null, severity "unavailable"',
    `got: ${JSON.stringify(unavailableBuckets[0])}`
  );

  // Test 10: remainingFraction: 1.7 clamped to utilization 0; -0.2 clamped to utilization 100
  const clampedRaw = {
    groups: [
      {
        displayName: 'Gemini',
        buckets: [
          {
            bucketId: 'gemini-5h',
            remainingFraction: 1.7,
          },
          {
            bucketId: 'gemini-weekly',
            remainingFraction: -0.2,
          },
        ],
      },
    ],
  };
  const clampedBuckets = parseAntigravityQuotaSummary(clampedRaw);
  const bOver = clampedBuckets.find((b) => b.id === 'gemini_5h');
  const bUnder = clampedBuckets.find((b) => b.id === 'gemini_weekly');
  assert(
    bOver?.utilizationPercent === 0 && bUnder?.utilizationPercent === 100,
    '10. remainingFraction 1.7 clamped to utilization 0, -0.2 clamped to utilization 100',
    `over: ${bOver?.utilizationPercent}, under: ${bUnder?.utilizationPercent}`
  );

  // Test 11: unknown bucket {bucketId:'mystery'} in group Other with fraction 0.5 -> id other_quota, label Other · Quota, windowType sliding_window
  const unknownRaw = {
    groups: [
      {
        displayName: 'Other',
        buckets: [
          {
            bucketId: 'mystery',
            remainingFraction: 0.5,
          },
        ],
      },
    ],
  };
  const unknownBuckets = parseAntigravityQuotaSummary(unknownRaw);
  assert(
    unknownBuckets.length === 1 &&
      unknownBuckets[0].id === 'other_quota' &&
      unknownBuckets[0].label === 'Other · Quota' &&
      unknownBuckets[0].windowType === 'sliding_window' &&
      unknownBuckets[0].utilizationPercent === 50,
    '11. unknown bucket in group Other -> id "other_quota", label "Other · Quota", windowType "sliding_window"',
    `got: ${JSON.stringify(unknownBuckets[0])}`
  );

  // Test 12: two buckets that map to the same id -> second gets the _2 suffix
  const duplicateRaw = {
    groups: [
      {
        displayName: 'Gemini',
        buckets: [
          {
            bucketId: 'gemini-5h-a',
            window: '5h',
            remainingFraction: 0.8,
          },
          {
            bucketId: 'gemini-5h-b',
            window: '5h',
            remainingFraction: 0.5,
          },
        ],
      },
    ],
  };
  const duplicateBuckets = parseAntigravityQuotaSummary(duplicateRaw);
  assert(
    duplicateBuckets.length === 2 &&
      duplicateBuckets[0].id === 'gemini_5h' &&
      duplicateBuckets[1].id === 'gemini_5h_2',
    '12. two buckets mapping to same base id -> second gets _2 suffix',
    `got: ${JSON.stringify(duplicateBuckets.map((b) => b.id))}`
  );

  // Test 13: parseAntigravityQuotaSummary(null), ('x'), ({}), ({groups:'bad'}) -> [] with no throw
  const rNull = parseAntigravityQuotaSummary(null);
  const rStr = parseAntigravityQuotaSummary('x');
  const rEmpty = parseAntigravityQuotaSummary({});
  const rBadGroups = parseAntigravityQuotaSummary({ groups: 'bad' });
  assert(
    Array.isArray(rNull) && rNull.length === 0 &&
      Array.isArray(rStr) && rStr.length === 0 &&
      Array.isArray(rEmpty) && rEmpty.length === 0 &&
      Array.isArray(rBadGroups) && rBadGroups.length === 0,
    '13. parseAntigravityQuotaSummary handles null, string, empty object, invalid groups safely -> []'
  );

  // Test 14: snake_case bucket_id / remaining_fraction are accepted
  const snakeRaw = {
    groups: [
      {
        displayName: 'Gemini',
        buckets: [
          {
            bucket_id: 'gemini-5h',
            remaining_fraction: 0.25,
          },
        ],
      },
    ],
  };
  const snakeBuckets = parseAntigravityQuotaSummary(snakeRaw);
  assert(
    snakeBuckets.length === 1 &&
      snakeBuckets[0].id === 'gemini_5h' &&
      snakeBuckets[0].utilizationPercent === 75,
    '14. snake_case bucket_id and remaining_fraction are accepted',
    `got: ${JSON.stringify(snakeBuckets[0])}`
  );

  console.log(`\n${totalTests - failedTests}/${totalTests} passed`);
  if (failedTests > 0) process.exit(1);
}

runAllTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
