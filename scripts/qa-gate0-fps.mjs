#!/usr/bin/env node
// @ts-nocheck
/**
 * qa-gate0-fps — headless-Chrome half of the Tauri "Gate 0" WebGL parity
 * check (see `docs/TAURI.md` and `apps/desktop/src-tauri/src/lib.rs`'s
 * `GATE0_MEASURE_JS`, which this deliberately mirrors line-for-line so the
 * two FPS numbers are an apples-to-apples comparison).
 *
 * Loads the app with Flights + Satellites preloaded via a share-link hash
 * (`src/sharelink.js`: `lat`/`lon` are mandatory for the hash to be
 * recognized as share state at all — v2/l alone parses as "no share link";
 * `src/data/layerState.js` then decodes `l`'s tokens, 'f' = flights,
 * 's' = satellites), waits for the scene to settle the same 20 s the Tauri
 * side waits, then measures 10 s of `requestAnimationFrame` ticks while
 * continuously orbiting the camera — the same "10 s of orbiting" load the
 * WKWebView side runs.
 *
 * Deliberately NOT `headless: 'new'`: headless Chrome on macOS renders WebGL
 * through SwiftShader (software), not the real GPU — that's why
 * qa-perf.mjs's own header calls its numbers "SwiftShader-safe" and refuses
 * to report wall-clock FPS from them at all. Gate 0 asks whether WKWebView
 * (hardware Metal) is an acceptable fraction of Chrome's HARDWARE frame
 * rate, so this launches a real (visible) Chrome window — the same
 * hardware-ANGLE path `docs/PERFORMANCE.md`'s baseline used. A software-vs-
 * hardware comparison would make WKWebView look artificially great for the
 * wrong reason.
 *
 * Usage: node scripts/qa-gate0-fps.mjs [--url http://localhost:4206]
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const baseUrl = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4206';
// Austin, high enough to see both flights and the satellite shells orbit.
const GATE0_HASH = 'lat=30.2672&lon=-97.7431&alt=3000000&heading=0&pitch=-50&v=2&l=f.s';
const url = `${baseUrl}#${GATE0_HASH}`;

const browser = await puppeteer.launch({
  headless: false,
  protocolTimeout: 300_000,
  args: [
    '--window-size=1440,900',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // NOT page.waitForFunction(): Puppeteer polls that in an isolated JS world,
  // which gets its own global object per Chrome DevTools Protocol — the
  // page's own script sets `window.__godsEyeView` in the MAIN world, so an
  // isolated-world poll never sees it and always times out at 90 s even
  // though the app finished loading seconds in (confirmed via console logs).
  // page.evaluate() always runs in the main world, so poll with that instead.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const ready = await page.evaluate(() => !!window.__godsEyeView?.viewer);
    if (ready) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for window.__godsEyeView.viewer');
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('[gate0] viewer ready, settling 20s...');

  // Same 20 s settle the Tauri side waits before measuring (Gate 0 numbers
  // must reflect the same warm-up state in both environments).
  await new Promise((r) => setTimeout(r, 20_000));
  console.error('[gate0] settled, measuring 10s...');

  /** Mirrors GATE0_MEASURE_JS in apps/desktop/src-tauri/src/lib.rs. */
  const result = await page.evaluate(() => new Promise((resolve) => {
    const gev = window.__godsEyeView;
    if (!gev?.viewer) { resolve({ frames: 0, elapsedMs: 0 }); return; }
    const v = gev.viewer;
    v.camera.cancelFlight();
    let frames = 0;
    const t0 = performance.now();
    function tick(now) {
      frames++;
      v.camera.rotateRight(0.0026);
      if (now - t0 < 10_000) {
        requestAnimationFrame(tick);
      } else {
        resolve({ frames, elapsedMs: now - t0 });
      }
    }
    requestAnimationFrame(tick);
  }));

  const fps = result.elapsedMs > 0 ? result.frames / (result.elapsedMs / 1000) : 0;
  console.log(`GATE0_CHROME_FRAMES=${result.frames}`);
  console.log(`GATE0_CHROME_ELAPSED_MS=${result.elapsedMs.toFixed(1)}`);
  console.log(`GATE0_CHROME_FPS=${fps.toFixed(2)}`);
} finally {
  await browser.close();
}
