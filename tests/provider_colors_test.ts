import {
  LAB_BRAND_PALETTES,
  getProviderAccountShades,
  getAccessibleSegmentTextColor,
  hexToHsl,
  hslToHex,
  hashStringToHue,
} from '../src/constants/theme';
import type { ProviderType } from '../src/models/types';

function runTests() {
  console.log('========================================');
  console.log('  PROVIDER BRAND COLOR & SHADES TESTS   ');
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

  // Suite 1: Canonical Hex Definitions
  console.log('Suite 1: Canonical Lab Brand Registry Hex Codes');
  assert(LAB_BRAND_PALETTES.claude.primary.toLowerCase() === '#d97757', 'Claude is official Terracotta #d97757');
  assert(LAB_BRAND_PALETTES.chatgpt.primary.toLowerCase() === '#10a37f', 'ChatGPT is official Emerald #10a37f');
  assert(LAB_BRAND_PALETTES.gemini.primary.toLowerCase() === '#1a73e8', 'Gemini is official Google Blue #1a73e8');
  assert(LAB_BRAND_PALETTES.antigravity.primary.toLowerCase() === '#4285f4', 'Antigravity is Google AI Blue #4285f4');
  assert(LAB_BRAND_PALETTES.deepseek.primary.toLowerCase() === '#0066ff', 'DeepSeek is #0066ff');
  assert(LAB_BRAND_PALETTES.qwen.primary.toLowerCase() === '#615ced', 'Qwen is #615ced');
  assert(LAB_BRAND_PALETTES.mistral.primary.toLowerCase() === '#ff7000', 'Mistral is #ff7000');
  assert(LAB_BRAND_PALETTES.groq.primary.toLowerCase() === '#f55036', 'Groq is #f55036');
  assert(LAB_BRAND_PALETTES.cursor.primary.toLowerCase() === '#000000', 'Cursor is #000000');

  // Suite 2: Hue Preservation (within +/- 2 degrees)
  console.log('\nSuite 2: Monochromatic Purity & Hue Preservation');
  const providersToTest: ProviderType[] = ['claude', 'chatgpt', 'gemini', 'antigravity', 'deepseek', 'mistral', 'groq'];
  for (const p of providersToTest) {
    const canonical = LAB_BRAND_PALETTES[p].primary;
    const [targetH] = hexToHsl(canonical);
    for (let count = 1; count <= 20; count++) {
      const shades = getProviderAccountShades(p, count);
      assert(shades.length === count, `${p} returns exactly ${count} shades for count=${count}`);
      for (const s of shades) {
        const [h] = hexToHsl(s);
        // Angular difference on circular hue ring
        let diff = Math.abs(h - targetH);
        if (diff > 180) diff = 360 - diff;
        assert(diff <= 2.0, `${p} shade ${s} preserves hue (${h.toFixed(1)} vs target ${targetH.toFixed(1)}, diff ${diff.toFixed(2)} deg <= 2 deg)`);
      }
    }
  }

  // Suite 3: Dead zone avoidance (L in [0.46, 0.54])
  console.log('\nSuite 3: Contrast Dead Zone Avoidance (L=46-54%)');
  for (const p of providersToTest) {
    const shades = getProviderAccountShades(p, 15);
    for (const s of shades) {
      const [, , l] = hexToHsl(s);
      const inDeadZone = l > 0.45 && l < 0.55;
      assert(!inDeadZone, `${p} shade ${s} avoids dead zone (L=${(l * 100).toFixed(1)}%)`);
    }
  }

  // Suite 4: Contrast Text Color Helper
  console.log('\nSuite 4: Accessible Text Color Computation');
  const whiteTextOnDark = getAccessibleSegmentTextColor('#000000');
  assert(whiteTextOnDark === '#ffffff', 'Black background yields white text');
  const darkTextOnLight = getAccessibleSegmentTextColor('#ffffff');
  assert(darkTextOnLight === '#0f172a', 'White background yields dark text #0f172a');
  const claudeText = getAccessibleSegmentTextColor('#d97757');
  assert(claudeText === '#ffffff' || claudeText === '#0f172a', 'Claude #d97757 returns valid text color');

  // Suite 5: Fallback Hash for Unknown Provider
  console.log('\nSuite 5: Fallback Deterministic Hashing for Unknown Providers');
  const shadesCustom1 = getProviderAccountShades('my-custom-llm', 5);
  const shadesCustom2 = getProviderAccountShades('my-custom-llm', 5);
  assert(shadesCustom1.length === 5, 'Unknown provider generates 5 shades');
  assert(JSON.stringify(shadesCustom1) === JSON.stringify(shadesCustom2), 'Deterministic shades for unknown provider');

  console.log(`\n========================================`);
  console.log(`SUMMARY: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
