#!/usr/bin/env node
// @ts-nocheck
/**
 * qa-sat-worker — before/after main-thread long-task measurement for the
 * satellite propagation worker (perf-sat-worker mission).
 *
 * "Before" and "after" are the SAME running build: the "before" page has
 * `window.Worker` deleted before any app script runs, which forces
 * satellites.js down its documented fallback path (_propagateAll /
 * _propagateDenseChunk on the main thread — see _createPropagationWorker in
 * src/data/satellites.js). The "after" page runs unmodified, so bulk
 * propagation goes through satellitesPropagation.worker.js. Comparing the
 * two against one build isolates the worker's effect from build/runtime
 * drift a separate "before" checkout would introduce.
 *
 * For each mode: enable the satellites layer, switch on the dense (Starlink)
 * catalog so the ~7k-object round-robin path is exercised, let it settle,
 * then record 10 s of long tasks (PerformanceObserver 'longtask', the
 * standard >50ms main-thread blocking-task signal) via the page's own
 * observer — no puppeteer-side polling, so the measurement isn't itself a
 * source of long tasks. Also records rAF-to-rAF frame gaps over the same
 * window: the existing dense round-robin fallback was deliberately tuned to
 * stay under the 50ms long-task threshold (small per-frame slices), so frame
 * time is the metric that actually shows what moving that work off-thread
 * buys — long-task count/total stay as the mission's required headline.
 *
 * Usage: node scripts/qa-sat-worker.mjs [--url http://localhost:4201]
 * Requires a running dev server (PORT=4201 npm run dev, per COMMON.md).
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4201';
const LONGTASK_WINDOW_MS = 10_000;

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1440,900',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

/**
 * Run one measurement pass.
 * @param {boolean} disableWorker true = delete window.Worker before app boot (fallback path).
 */
async function runPass(disableWorker) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  if (disableWorker) {
    await page.evaluateOnNewDocument(() => {
      // Force satellites.js's `typeof Worker === 'undefined'` fallback branch.
      delete window.Worker;
    });
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 15_000)); // boot flyTo + tile warm + deferred init

  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    await gev.dataManager.setEnabled('satellites', true, { origin: 'user' });
    gev.dataManager.setLayerParams('satellites', { catalog: 'dense' }, { origin: 'user' });
  });
  // Let the ~7k-object dense (Starlink) fetch + chunked satrec build settle.
  await new Promise((r) => setTimeout(r, 15_000));

  const result = await page.evaluate((windowMs) => new Promise((resolve) => {
    const tasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });

    // Long tasks (>50ms) are the mission's required metric, but the existing
    // dense round-robin fallback was deliberately engineered to stay under
    // that threshold (see _propagateDenseChunk's comment in satellites.js) —
    // so also record rAF-to-rAF frame gaps, which show the main-thread cost
    // this worker removes even when it never crossed 50ms.
    const frameGaps = [];
    let last = performance.now();
    let rafId = requestAnimationFrame(function tick(t) {
      frameGaps.push(t - last);
      last = t;
      rafId = requestAnimationFrame(tick);
    });

    setTimeout(() => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
      const sorted = [...frameGaps].sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
      resolve({
        longTaskCount: tasks.length,
        longTaskTotalMs: tasks.reduce((a, b) => a + b, 0),
        longTaskLongestMs: tasks.length ? Math.max(...tasks) : 0,
        frameCount: frameGaps.length,
        avgFrameMs: frameGaps.length ? frameGaps.reduce((a, b) => a + b, 0) / frameGaps.length : 0,
        p95FrameMs: p95,
        maxFrameMs: frameGaps.length ? Math.max(...frameGaps) : 0,
      });
    }, windowMs);
  }), LONGTASK_WINDOW_MS);

  await page.close();
  return result;
}

try {
  console.log(`Measuring against ${url} — ${LONGTASK_WINDOW_MS / 1000}s window, satellites + dense (Starlink) catalog enabled.\n`);

  const fmt = (r) => `  long tasks (>50ms): ${r.longTaskCount}, total ${r.longTaskTotalMs.toFixed(1)}ms, longest ${r.longTaskLongestMs.toFixed(1)}ms\n`
    + `  frames: ${r.frameCount}, avg ${r.avgFrameMs.toFixed(2)}ms, p95 ${r.p95FrameMs.toFixed(2)}ms, max ${r.maxFrameMs.toFixed(2)}ms`;

  console.log('BEFORE (window.Worker deleted — forces the main-thread fallback path):');
  const before = await runPass(true);
  console.log(`${fmt(before)}\n`);

  console.log('AFTER (unmodified — bulk propagation runs in satellitesPropagation.worker.js):');
  const after = await runPass(false);
  console.log(`${fmt(after)}\n`);

  console.log('SUMMARY');
  console.log(`  long-task count: ${before.longTaskCount} → ${after.longTaskCount}`);
  console.log(`  long-task total: ${before.longTaskTotalMs.toFixed(1)}ms → ${after.longTaskTotalMs.toFixed(1)}ms`);
  console.log(`  avg frame time:  ${before.avgFrameMs.toFixed(2)}ms → ${after.avgFrameMs.toFixed(2)}ms`);
  console.log(`  p95 frame time:  ${before.p95FrameMs.toFixed(2)}ms → ${after.p95FrameMs.toFixed(2)}ms`);
} finally {
  await browser.close();
}
