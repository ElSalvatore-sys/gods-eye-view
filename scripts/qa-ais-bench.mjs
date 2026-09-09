#!/usr/bin/env node
// @ts-nocheck
/**
 * qa-ais-bench.mjs — synthetic AIS render-throughput benchmark.
 *
 * Injects a fixed count of synthetic vessel rows through the AIS layer's own
 * dev-only ingest seam (the same `__focusEvidence.setVessels()` path
 * qa-vessel-cards.mjs uses for its synthetic mode), parks the camera at a
 * global-scale altitude, then manually drives `scene.render()` in a tight,
 * wall-clock-bounded loop (heading panning each call) for a fixed window.
 * Reports frames/elapsed as an "FPS" figure, average/max per-render cost,
 * and a count of renders over one 60fps frame budget (16.7ms).
 *
 * Deliberately NOT requestAnimationFrame-driven: on a contended shared host,
 * rAF/vsync scheduling can itself starve for tens of seconds (observed
 * directly while building this script), which would measure host scheduling
 * noise rather than the layer's own per-frame cost. Calling scene.render()
 * synchronously measures exactly the work this PR's LOD swap touches and
 * stays comparable across runs regardless of how busy the box is.
 *
 * This is a manual A/B tool, not a pass/fail gate: run it once against a dev
 * server on `main` and once against a dev server on the branch under test,
 * pointing `--url` at each, and compare the two printed JSON blocks.
 *
 * Usage:
 *   node scripts/qa-ais-bench.mjs --url http://localhost:4205
 *   node scripts/qa-ais-bench.mjs --url http://localhost:4206 --rows 12000 --duration 10000
 *   node scripts/qa-ais-bench.mjs --url http://localhost:4205 --alt 2000000
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const ROW_COUNT = Number(getOpt('--rows', '12000'));
const DURATION_MS = Number(getOpt('--duration', '10000'));
// Global-scale altitude (m) — well above POINT_LOD_ALTITUDE_M (350 km) so the
// branch's LOD swap is actually exercised; main has no LOD path so this
// altitude just puts the whole synthetic fleet on screen at once either way.
const ALTITUDE_M = Number(getOpt('--alt', '2000000'));
const OUT_JSON = getOpt('--out', '');

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Race a promise against a hard deadline so a single pathologically slow
 * in-page call (observed: a lone `scene.render()` blocking for tens of
 * seconds under heavy host contention) cannot hang this script forever.
 * The in-page work may still be running when this resolves — the caller's
 * `browser.close()` is what actually reclaims it.
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T|{timedOut: true, label: string}>}
 */
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, label }), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Deterministic global scatter of synthetic AIS rows (no clustering bias). */
function syntheticFleetRows(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    // Simple deterministic pseudo-random spread (LCG) — reproducible across runs.
    const a = Math.sin(i * 12.9898) * 43758.5453;
    const b = Math.sin(i * 78.233) * 12321.987;
    const lat = ((a - Math.floor(a)) * 170) - 85;
    const lon = ((b - Math.floor(b)) * 360) - 180;
    rows.push({
      mmsi: String(900000000 + i),
      name: `BENCH ${i}`,
      lat,
      lon,
      speed: 5 + (i % 20),
      course: (i * 37) % 360,
      heading: (i * 37) % 360,
      type: ['Cargo', 'Tanker', 'Tug', 'Container Ship', 'Fishing Vessel'][i % 5],
      destination: 'BENCH',
    });
  }
  return rows;
}

async function main() {
  console.log(`\nAIS Primitive Render Benchmark`);
  console.log(`  App URL   : ${APP_URL}`);
  console.log(`  Rows      : ${ROW_COUNT}`);
  console.log(`  Duration  : ${DURATION_MS} ms`);
  console.log(`  Altitude  : ${ALTITUDE_M} m\n`);

  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }

  const chromeExecutable = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: 'new',
    // Generous — a synchronous scene.render() call can itself take seconds
    // on a contended shared host; the CDP round-trip must outlive it.
    protocolTimeout: 300_000,
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--window-size=1600,900',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    page.on('pageerror', (err) => console.error(`  [page-error] ${err.message}`));

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Generous timeout: on a loaded shared dev box, first-init competes with
    // every other process for CPU/GPU and can take much longer than usual.
    await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 180000, polling: 1000 });

    const injected = await page.evaluate(async ({ rows, alt }) => {
      const gev = window.__godsEyeView;
      const v = gev.viewer;
      v.camera.cancelFlight?.();
      v.scene.tweens?.removeAll?.();
      await gev.dataManager.setEnabled('ais-live-vessels', true);
      const seam = gev.dataManager.layers.get('ais-live-vessels')?.module?.__focusEvidence;
      if (!seam?.setVessels) throw new Error('Synthetic AIS evidence seam is unavailable (dev build required)');
      const result = seam.setVessels(rows);
      if (!result?.ok || result.count !== rows.length) {
        throw new Error(`Synthetic AIS injection failed (${result?.count || 0}/${rows.length})`);
      }
      // Park over the mid-Atlantic at a global-scale altitude, looking straight
      // down, so the synthetic fleet's horizon-visible fraction is large and
      // stable while the heading orbit below only changes screen projection.
      const carto = { longitude: 0, latitude: 20 * Math.PI / 180, height: alt };
      v.camera.setView({
        destination: v.scene.globe.ellipsoid.cartographicToCartesian(carto),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      v.scene.requestRender?.();
      return { count: result.count };
    }, { rows: syntheticFleetRows(ROW_COUNT), alt: ALTITUDE_M });
    console.log(`  [DATA] injected ${injected.count} synthetic vessels`);

    // Let the first visibility/LOD/declutter passes (800 ms cadence) settle
    // before measuring, so the benchmark window itself is steady-state.
    await new Promise((r) => setTimeout(r, 2500));

    // Manually driven render loop rather than requestAnimationFrame: on a
    // contended shared host, rAF/vsync scheduling itself can starve for
    // seconds at a time (observed directly in this environment — see the PR
    // body), which would measure host scheduling noise instead of the
    // layer's per-frame cost. Calling scene.render() synchronously in a
    // wall-clock-bounded loop measures exactly the work this PR touches
    // (occluder test, LOD sweep, rotation projection, draw submission) and
    // stays comparable across runs regardless of how busy the box is.
    const metrics = await withTimeout(
      page.evaluate(({ durationMs, headingRateRadS }) => {
        const gev = window.__godsEyeView;
        const v = gev.viewer;
        const scene = v.scene;
        v.useDefaultRenderLoop = false;

        const carto = { longitude: 0, latitude: 20 * Math.PI / 180, height: v.camera.positionCartographic.height };
        const ellipsoid = scene.globe.ellipsoid;
        const frameMs = [];
        const t0 = performance.now();
        while (performance.now() - t0 < durationMs) {
          const elapsedS = (performance.now() - t0) / 1000;
          v.camera.setView({
            destination: ellipsoid.cartographicToCartesian(carto),
            orientation: { heading: elapsedS * headingRateRadS, pitch: -Math.PI / 2, roll: 0 },
          });
          const f0 = performance.now();
          scene.render();
          frameMs.push(performance.now() - f0);
        }
        v.useDefaultRenderLoop = true;

        const elapsed = (performance.now() - t0) / 1000;
        const frameCount = frameMs.length;
        const totalFrameMs = frameMs.reduce((a, b) => a + b, 0);
        const avgFrameMs = frameCount ? totalFrameMs / frameCount : 0;
        const maxFrameMs = frameCount ? Math.max(...frameMs) : 0;
        // "Long task"-equivalent for a manually driven loop: a single render()
        // costing more than one 60fps frame budget (16.7ms).
        const longFrameCount = frameMs.filter((ms) => ms > 16.7).length;
        return {
          frameCount,
          elapsedS: elapsed,
          avgFps: elapsed > 0 ? frameCount / elapsed : 0,
          avgFrameMs: Number(avgFrameMs.toFixed(2)),
          maxFrameMs: Number(maxFrameMs.toFixed(2)),
          longFrameCount,
        };
      }, { durationMs: DURATION_MS, headingRateRadS: 10 * Math.PI / 180 }),
      // Generous margin over durationMs: a single scene.render() call can
      // itself block for many seconds under heavy host contention (observed
      // directly — see the PR body), and the synchronous in-page loop cannot
      // check its own deadline again until that one call returns.
      DURATION_MS + 60_000,
      'steady-state render loop',
    );
    if (metrics.timedOut) {
      console.warn(`  [WARN] ${metrics.label} did not return within its budget — host is severely contended; reporting no steady-state metrics.`);
    }

    // The steady-state loop above is dominated by cheap draw-only frames: the
    // per-vessel occluder/rotation/label-declutter pass this PR actually
    // changes is throttled to VISIBILITY_UPDATE_MS (800 ms) in production, so
    // it only runs a handful of times across a 10 s window and gets diluted
    // into the average. This second phase isolates exactly that pass: each
    // sample waits past the 800 ms throttle and changes heading (forcing the
    // rotation branch too) before timing one render() call.
    const HEAVY_ITERATIONS = Number(getOpt('--heavy-iterations', '6'));
    const heavyPass = await withTimeout(
      page.evaluate(async ({ iterations }) => {
        const gev = window.__godsEyeView;
        const v = gev.viewer;
        const scene = v.scene;
        v.useDefaultRenderLoop = false;
        const ellipsoid = scene.globe.ellipsoid;
        const carto = { longitude: 0, latitude: 20 * Math.PI / 180, height: v.camera.positionCartographic.height };
        const samples = [];
        for (let i = 0; i < iterations; i += 1) {
          v.camera.setView({
            destination: ellipsoid.cartographicToCartesian(carto),
            orientation: { heading: i * 0.05, pitch: -Math.PI / 2, roll: 0 },
          });
          await new Promise((r) => setTimeout(r, 850)); // clear the 800ms visibility-pass throttle
          const f0 = performance.now();
          scene.render();
          samples.push(Number((performance.now() - f0).toFixed(2)));
        }
        v.useDefaultRenderLoop = true;
        const sorted = [...samples].sort((a, b) => a - b);
        const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
        const medianMs = sorted[Math.floor(sorted.length / 2)];
        return { samples, avgMs: Number(avgMs.toFixed(2)), medianMs };
      }, { iterations: HEAVY_ITERATIONS }),
      // Each iteration budgets ~850ms wait + up to several seconds for a
      // contended scene.render() call; give the whole phase generous room.
      HEAVY_ITERATIONS * 8_000 + 10_000,
      'isolated visibility-pass loop',
    );
    if (heavyPass.timedOut) {
      console.warn(`  [WARN] ${heavyPass.label} did not return within its budget — host is severely contended; reporting no isolated-pass metrics.`);
    }

    const report = {
      url: APP_URL,
      rows: ROW_COUNT,
      durationMs: DURATION_MS,
      altitudeM: ALTITUDE_M,
      ...metrics,
      heavyPass,
    };
    console.log('\n  RESULT', JSON.stringify(report, null, 2));
    if (OUT_JSON) fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
    await page.close();
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
