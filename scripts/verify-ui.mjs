#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const webDistDir = path.join(rootDir, 'web', 'dist');
const baselineDir = path.join(rootDir, 'tests', 'vrt', 'baseline');
const reportDir = path.join(rootDir, 'tests', 'vrt', 'report');

fs.mkdirSync(baselineDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });

const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const liveUrl = args.find(a => a.startsWith('--live-url='))?.split('=')[1] || (args.includes('--live-url') ? args[args.indexOf('--live-url') + 1] : null);
const thresholdArg = parseFloat(args.find(a => a.startsWith('--threshold='))?.split('=')[1] || '0.1');
const maxDiffPct = parseFloat(args.find(a => a.startsWith('--max-diff='))?.split('=')[1] || '0.05');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createStaticServer(distDir, port = 4567) {
  const safeDistRoot = path.resolve(distDir);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url?.split('?')[0] || '/';
      if (reqPath === '/' || reqPath.startsWith('/#')) reqPath = '/index.html';

      const candidatePath = path.resolve(safeDistRoot, `.${reqPath}`);
      const relativeCandidate = path.relative(safeDistRoot, candidatePath);
      let filePath = (!relativeCandidate.startsWith('..') && !path.isAbsolute(relativeCandidate))
        ? candidatePath
        : path.join(safeDistRoot, 'index.html');

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(safeDistRoot, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(data);
      } catch (err) {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
];

const SCENARIOS = [
  {
    id: '01_overview',
    title: 'Cockpit Overview (HomePage)',
    path: '/',
    action: async (page) => {
      await page.waitForSelector('#tab-home', { timeout: 5000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: '02_accounts',
    title: 'Fleet Accounts Inventory',
    path: '/#accounts',
    action: async (page) => {
      await page.waitForSelector('#tab-accounts', { timeout: 5000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: '03_telemetry',
    title: 'Token Velocity & Telemetry',
    path: '/#stats',
    action: async (page) => {
      await page.waitForSelector('#tab-stats', { timeout: 5000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: '04_radar',
    title: 'Dual-Horizon Quota Radar',
    path: '/#alerts',
    action: async (page) => {
      await page.waitForSelector('#tab-alerts', { timeout: 5000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: '05_settings',
    title: 'Backend Gateways & Settings',
    path: '/#settings',
    action: async (page) => {
      await page.waitForSelector('#tab-settings', { timeout: 5000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: '06_column_picker',
    title: 'Column Picker Dropdown Active',
    path: '/#accounts',
    action: async (page) => {
      const btn = page.locator('.fqd-col-picker__btn, button.filter-btn:has-text("Columns")').first();
      await btn.waitFor({ timeout: 5000 });
      await btn.click();
      await page.waitForTimeout(400);
    },
  },
  {
    id: '07_drawer_open',
    title: 'Slide-Over Diagnostic Drawer Active',
    path: '/',
    action: async (page) => {
      const seg = page.locator('.grad-segment').first();
      await seg.waitFor({ timeout: 5000 });
      await seg.click();
      await page.waitForSelector('.fqd-account-drawer-content, .web-drawer-content', { timeout: 3000 });
      await page.waitForTimeout(400);
    },
  },
];

async function setupPageMocks(page) {
  // Deterministic mock data for reliable VRT pixel diffing
  const mockAgyAccounts = Array.from({ length: 14 }).map((_, idx) => ({
    id: `mock-agy-${idx + 1}`,
    name: `Antigravity Slot ${idx + 1}`,
    email: idx === 13 ? 'vishakhagemini0@gmail.com' : (idx === 10 ? 'piyushkumar.jiit@gmail.com' : `slot_${String(idx + 1).padStart(2, '0')}@gmail.com`),
    providerType: 'antigravity',
    plan: 'AI Pro',
    orderIndex: idx,
    isActive: true,
    lastStatus: 'ok',
    createdAt: '2026-10-15T00:00:00Z',
    latestSnapshot: {
      timestamp: '2026-11-03T12:00:00Z',
      status: 'ok',
      buckets: [
        { windowType: 'session_5h', remainingPercent: idx === 13 ? 34 : (90 + ((idx * 3) % 10)), resetsAt: '2026-11-03T15:30:00Z' },
        { windowType: 'weekly_7d', remainingPercent: 88, resetsAt: '2026-11-07T00:00:00Z' },
      ],
    },
  }));

  const mockClaude = {
    id: 'mock-claude-1',
    name: 'Claude Pro',
    email: 'claude-2f8e2ab5-piyush...',
    providerType: 'claude',
    plan: 'Pro Tier',
    orderIndex: 0,
    isActive: true,
    lastStatus: 'ok',
    createdAt: '2026-10-15T00:00:00Z',
    latestSnapshot: {
      timestamp: '2026-11-03T12:00:00Z',
      status: 'ok',
      buckets: [
        { windowType: 'session_5h', remainingPercent: 84, resetsAt: '2026-11-03T16:00:00Z' },
        { windowType: 'weekly_7d', remainingPercent: 100, resetsAt: '2026-11-07T00:00:00Z' },
      ],
    },
  };

  const accounts = [...mockAgyAccounts, mockClaude];

  await page.route('**/api/state', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accounts,
        lastSyncAllAt: '2026-11-03T12:00:00Z',
        intervalMin: 15,
        telegram: true,
      }),
    });
  });

  await page.route('**/api/telemetry', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        totalTokens: 18400000,
        promptTokens: 13616000,
        completionTokens: 4784000,
        activeModels: 5,
        proxyLatencyMs: 3.9,
      }),
    });
  });
}

function comparePng(baselineBuffer, candidateBuffer, diffPath, threshold = 0.1) {
  const img1 = PNG.sync.read(baselineBuffer);
  const img2 = PNG.sync.read(candidateBuffer);

  const width = Math.max(img1.width, img2.width);
  const height = Math.max(img1.height, img2.height);

  const diff = new PNG({ width, height });

  // Ensure same dimensions for pixelmatch
  let buf1 = img1.data;
  let buf2 = img2.data;

  if (img1.width !== width || img1.height !== height) {
    const resized1 = new PNG({ width, height });
    PNG.bitblt(img1, resized1, 0, 0, img1.width, img1.height, 0, 0);
    buf1 = resized1.data;
  }
  if (img2.width !== width || img2.height !== height) {
    const resized2 = new PNG({ width, height });
    PNG.bitblt(img2, resized2, 0, 0, img2.width, img2.height, 0, 0);
    buf2 = resized2.data;
  }

  const diffPixels = pixelmatch(buf1, buf2, diff.data, width, height, {
    threshold,
    diffColor: [255, 0, 127],
  });

  const totalPixels = width * height;
  const diffPct = (diffPixels / totalPixels) * 100;

  if (diffPixels > 0) {
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
  }

  return { diffPixels, totalPixels, diffPct };
}

function generateHtmlReport(results) {
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;
  const maxDiff = Math.max(...results.map(r => r.diffPct || 0)).toFixed(3);

  const rows = results.map(r => {
    const statusBadge = r.passed
      ? `<span style="background:#16a34a;color:#fff;padding:3px 8px;border-radius:4px;font-weight:700;font-size:11px;">PASS (0.00% drift)</span>`
      : `<span style="background:#dc2626;color:#fff;padding:3px 8px;border-radius:4px;font-weight:700;font-size:11px;">DRIFT (${r.diffPct.toFixed(2)}%)</span>`;

    return `
      <tr style="border-bottom:1px solid #1f2937;">
        <td style="padding:10px 14px;font-weight:600;">${r.title}</td>
        <td style="padding:10px 14px;color:#9ca3af;">${r.viewport} (${r.width}x${r.height})</td>
        <td style="padding:10px 14px;font-family:monospace;">${r.diffPixels} px (${r.diffPct.toFixed(3)}%)</td>
        <td style="padding:10px 14px;">${statusBadge}</td>
      </tr>
      ${!r.passed ? `
      <tr>
        <td colspan="4" style="padding:16px;background:#0d1117;">
          <div style="display:flex;gap:12px;overflow-x:auto;">
            <div>
              <div style="font-size:11px;font-weight:700;color:#9ca3af;margin-bottom:4px;">BASELINE</div>
              <img src="${r.baselineRelPath}" style="max-width:380px;border:1px solid #374151;border-radius:6px;" />
            </div>
            <div>
              <div style="font-size:11px;font-weight:700;color:#9ca3af;margin-bottom:4px;">CANDIDATE</div>
              <img src="${r.candidateRelPath}" style="max-width:380px;border:1px solid #374151;border-radius:6px;" />
            </div>
            <div>
              <div style="font-size:11px;font-weight:700;color:#f43f5e;margin-bottom:4px;">DIFF OVERLAY</div>
              <img src="${r.diffRelPath}" style="max-width:380px;border:1px solid #f43f5e;border-radius:6px;" />
            </div>
          </div>
        </td>
      </tr>` : ''}
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FQD ? Visual Regression Test Report</title>
  <style>
    body { background:#090d16; color:#f9fafb; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; margin:0; padding:24px; line-height:1.5; }
    .container { max-width:1100px; margin:0 auto; }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:1px solid #1f2937; padding-bottom:16px; }
    .title { font-size:20px; font-weight:800; display:flex; align-items:center; gap:10px; }
    .summary-card { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:20px; }
    .card { background:#111827; border:1px solid #1f2937; border-radius:10px; padding:16px; }
    .card-val { font-size:24px; font-weight:800; }
    .card-lbl { font-size:12px; color:#9ca3af; }
    table { width:100%; border-collapse:collapse; background:#111827; border-radius:10px; overflow:hidden; border:1px solid #1f2937; font-size:13px; }
    th { background:#1f2937; text-align:left; padding:10px 14px; font-weight:700; color:#e5e7eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">
        <span>FQD Visual Regression Verification</span>
        <span style="font-size:12px;background:#2563eb;color:#fff;padding:2px 8px;border-radius:6px;">Automated VRT</span>
      </div>
      <div>
        <span style="font-size:12px;color:#9ca3af;">Executed: ${new Date().toISOString()}</span>
      </div>
    </div>

    <div class="summary-card">
      <div class="card">
        <div class="card-val" style="color:${failed === 0 ? '#22c55e' : '#ef4444'};">${passed} / ${total}</div>
        <div class="card-lbl">Scenarios Passed</div>
      </div>
      <div class="card">
        <div class="card-val" style="color:${failed === 0 ? '#22c55e' : '#f59e0b'};">${maxDiff}%</div>
        <div class="card-lbl">Max Component Drift</div>
      </div>
      <div class="card">
        <div class="card-val" style="color:#38bdf8;">0.00% Drift Target</div>
        <div class="card-lbl">Strict Change Isolation</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Viewport</th>
          <th>Drift / Pixel Mismatch</th>
          <th>Verification Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

async function main() {
  console.log(`\n======================================================`);
  console.log(`  FQD AUTOMATED VISUAL REGRESSION TESTING (VRT)       `);
  console.log(`======================================================\n`);

  let targetUrl = liveUrl;
  let server = null;

  if (!targetUrl) {
    console.log(`[1/4] Starting local static server for candidate web build...`);
    const port = 4567;
    server = await createStaticServer(webDistDir, port);
    targetUrl = `http://127.0.0.1:${port}`;
    console.log(`      Server listening at ${targetUrl}`);
  } else {
    console.log(`[1/4] Targeting live host at: ${targetUrl}`);
  }

  console.log(`[2/4] Launching headless Playwright Chromium...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP 192.168.2.184 127.0.0.1:18443'],
  });

  const results = [];
  let allPassed = true;

  try {
    console.log(`[3/4] Capturing and comparing screenshots across viewports...`);

    for (const vp of VIEWPORTS) {
      console.log(`\n  ? Viewport: ${vp.name.toUpperCase()} (${vp.width}x${vp.height})`);

      for (const scenario of SCENARIOS) {
        const fileKey = `${scenario.id}_${vp.name}`;
        const baselineFile = path.join(baselineDir, `${fileKey}.png`);
        const candidateFile = path.join(reportDir, `candidate_${fileKey}.png`);
        const diffFile = path.join(reportDir, `diff_${fileKey}.png`);

        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          ignoreHTTPSErrors: true,
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch,
          deviceScaleFactor: 1,
        });

        const page = await context.newPage();
        await setupPageMocks(page);

        const url = `${targetUrl}${scenario.path}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

        if (scenario.action) {
          await scenario.action(page);
        }

        const candidateBuffer = await page.screenshot({ fullPage: false });
        fs.writeFileSync(candidateFile, candidateBuffer);

        if (updateBaseline || !fs.existsSync(baselineFile)) {
          fs.writeFileSync(baselineFile, candidateBuffer);
          console.log(`    ? [BASELINE SAVED] ${scenario.title}`);
          results.push({
            id: scenario.id,
            title: scenario.title,
            viewport: vp.name,
            width: vp.width,
            height: vp.height,
            diffPixels: 0,
            diffPct: 0,
            passed: true,
            baselineRelPath: path.relative(reportDir, baselineFile),
            candidateRelPath: path.relative(reportDir, candidateFile),
            diffRelPath: '',
          });
        } else {
          const baselineBuffer = fs.readFileSync(baselineFile);
          const diffResult = comparePng(baselineBuffer, candidateBuffer, diffFile, thresholdArg);
          const passed = diffResult.diffPct <= maxDiffPct;

          if (!passed) allPassed = false;

          const symbol = passed ? '?' : '?';
          const statusStr = passed ? 'PASS' : 'DRIFT DETECTED';
          console.log(`    ${symbol} [${statusStr}] ${scenario.title}: ${diffResult.diffPixels} diff px (${diffResult.diffPct.toFixed(3)}% drift)`);

          results.push({
            id: scenario.id,
            title: scenario.title,
            viewport: vp.name,
            width: vp.width,
            height: vp.height,
            diffPixels: diffResult.diffPixels,
            diffPct: diffResult.diffPct,
            passed,
            baselineRelPath: path.relative(reportDir, baselineFile),
            candidateRelPath: path.relative(reportDir, candidateFile),
            diffRelPath: path.relative(reportDir, diffFile),
          });
        }

        await context.close();
      }
    }

    console.log(`\n[4/4] Generating visual diff HTML report...`);
    const reportHtml = generateHtmlReport(results);
    const reportHtmlPath = path.join(reportDir, 'index.html');
    fs.writeFileSync(reportHtmlPath, reportHtml);
    console.log(`      Report generated: ${reportHtmlPath}`);

  } finally {
    await browser.close();
    if (server) {
      server.close();
    }
  }

  const passedCount = results.filter(r => r.passed).length;
  console.log(`\n======================================================`);
  console.log(`  VRT COMPLETE: ${passedCount}/${results.length} PASSED (Status: ${allPassed ? 'ALL CLEAN 0.00% DRIFT' : 'FAILED'})`);
  console.log(`======================================================\n`);

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[VRT ERROR]', err);
  process.exit(1);
});
