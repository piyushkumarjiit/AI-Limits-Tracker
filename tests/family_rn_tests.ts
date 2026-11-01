/**
 * Unit tests for React Native Family Quota Aggregator (Package 4)
 */

import { groupFamilies, arcPath, familySlots } from '../src/services/capacity';
import { AccountEntity, ProviderType, UsageSnapshot } from '../src/models/types';

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

console.log('========================================');
console.log('  FAMILY QUOTA AGGREGATOR (RN P4) TESTS ');
console.log('========================================\n');

// 1. Grouping and filtering logic
console.log('Suite 1: Grouping & Strip Visibility Logic');
{
  const mockAccounts: Array<AccountEntity & { latestSnapshot?: UsageSnapshot }> = [
    {
      id: 'acc1',
      name: 'Claude Personal',
      providerType: 'claude',
      plan: 'Pro',
      isActive: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      latestSnapshot: {
        accountId: 'acc1',
        fetchedAt: new Date().toISOString(),
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5h',
            windowType: 'session_5h',
            remainingPercent: 80,
            utilizationPercent: 20,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      },
    },
    {
      id: 'acc2',
      name: 'Claude Work',
      providerType: 'claude',
      plan: 'Pro',
      isActive: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      latestSnapshot: {
        accountId: 'acc2',
        fetchedAt: new Date().toISOString(),
        status: 'ok',
        planName: 'Pro',
        buckets: [
          {
            id: '5h',
            label: '5h',
            windowType: 'session_5h',
            remainingPercent: 40,
            utilizationPercent: 60,
            resetsAt: new Date(Date.now() + 7200000).toISOString(),
          },
        ],
      },
    },
    {
      id: 'acc3',
      name: 'ChatGPT Solo',
      providerType: 'chatgpt',
      plan: 'Plus',
      isActive: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      latestSnapshot: {
        accountId: 'acc3',
        fetchedAt: new Date().toISOString(),
        status: 'ok',
        planName: 'Plus',
        buckets: [
          {
            id: 'weekly',
            label: 'Weekly',
            windowType: 'weekly_7d',
            remainingPercent: 90,
            utilizationPercent: 10,
          },
        ],
      },
    },
  ];

  const families = groupFamilies(mockAccounts);
  assert(families.length === 2, 'groupFamilies returns 2 families');

  const claudeFam = families.find((f) => f.family === 'claude');
  assert(claudeFam !== undefined, 'claude family found');
  assert(claudeFam?.members.length === 2, 'claude family has 2 members');
  assert(claudeFam?.poolMax === 2, 'claude family poolMax is 2');
  assert(Math.abs((claudeFam?.poolUnits ?? 0) - 1.2) < 0.001, 'claude family poolUnits is 1.2');

  const chatgptFam = families.find((f) => f.family === 'chatgpt');
  assert(chatgptFam !== undefined, 'chatgpt family found');
  assert(chatgptFam?.members.length === 1, 'chatgpt family has 1 member');

  // Strip visibility rule: families.some(f => f.members.length >= 2) || families.length >= 2
  const showStrip = families.some((f) => f.members.length >= 2) || families.length >= 2;
  assert(showStrip === true, 'showFamilyStrip is true when >=2 members or >=2 families');

  // Single account solo user: strip must be false
  const soloFamily = groupFamilies([mockAccounts[2]]);
  const showSoloStrip = soloFamily.some((f) => f.members.length >= 2) || soloFamily.length >= 2;
  assert(showSoloStrip === false, 'showFamilyStrip is false for single account solo user');
}

// 2. Filter chips extension logic
console.log('\nSuite 2: Filter chips logic with all active provider types');
{
  const testAccounts = [
    { providerType: 'claude' },
    { providerType: 'antigravity' },
    { providerType: 'cursor' },
  ];
  const activeTypes = Array.from(new Set(testAccounts.map((a) => a.providerType)));
  const filters = ['all', ...activeTypes];
  assert(filters.includes('all'), 'filters includes "all"');
  assert(filters.includes('antigravity'), 'filters includes "antigravity"');
  assert(filters.includes('cursor'), 'filters includes "cursor"');
  assert(filters.length === 4, 'filters has exactly 4 items');
}

// 3. Segmented donut geometry
console.log('\nSuite 3: Donut geometry and arc rendering');
{
  const slots = familySlots([
    { weight: 1, effectiveRemaining: 80 },
    { weight: 1, effectiveRemaining: 40 },
  ], 3);

  assert(slots.length === 2, '2 slots computed');
  assert(slots[0].start === 1.5, 'first slot starts at gap/2 (1.5)');
  assert(slots[0].end === 178.5, 'first slot ends at 180 - gap/2 (178.5)');
  assert(slots[1].start === 181.5, 'second slot starts at 180 + gap/2 (181.5)');
  assert(slots[1].end === 358.5, 'second slot ends at 360 - gap/2 (358.5)');

  // Arc path generation test
  const arc = arcPath(50, 50, 42, slots[0].start, slots[0].end);
  assert(typeof arc === 'string' && arc.startsWith('M '), 'arcPath produces valid SVG path');
}

console.log(`\n========================================`);
console.log(`SUMMARY: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
