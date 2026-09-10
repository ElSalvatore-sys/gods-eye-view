#!/usr/bin/env node
// @ts-nocheck
/**
 * qa-zoom-probe — the free-fly wheel zoom contract, proved in the real app.
 *
 * Two things are measured, because the original defect had two halves.
 *
 * 1. STEP SANITY. Cesium scales its zoom step from a canvas-CENTRE pick that
 *    always misses here (`globe.show = false` means
 *    `globe.pickWorldCoordinates` iterates an always-empty
 *    `_tilesRenderedThisFrame`), then falls back to raw height above the
 *    hidden WGS84 ellipsoid. Over terrain that fallback was measured at
 *    1.47x-3.21x the true distance to the visible surface, which is why zoom
 *    crawled in one place and lunged in another. So: each notch must close a
 *    bounded, roughly constant FRACTION of the true distance to the surface —
 *    never a multiple of it, and never nothing.
 *
 * 2. CURSOR ANCHORING. Cesium zooms toward the screen centre. The world point
 *    under the pointer must stay under the pointer, within a pixel tolerance.
 *    This is the assertion that would have caught the bug: it fails loudly for
 *    a centre-anchored zoom whenever the cursor is not already at the centre.
 *
 * The probe drives REAL wheel events through the canvas, so it exercises the
 * installed listener rather than calling internals.
 *
 * Usage:
 *   node scripts/qa-zoom-probe.mjs --url http://localhost:4173
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const getOpt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL = getOpt('--url', 'http://localhost:4173');

/** High terrain is where the ellipsoid fallback diverged worst, so it leads. */
const SCENES = [
  { name: 'Denver (terrain ~1600m)', lon: -104.9903, lat: 39.7392, height: 2600 },
  { name: 'Manhattan (dense verticals)', lon: -73.9857, lat: 40.7484, height: 900 },
  { name: 'Open ocean (sea-level control)', lon: -40.0, lat: 30.0, height: 900 },
];

/** Cursor deliberately OFF-CENTRE — a centre-anchored zoom cannot pass here. */
const CURSOR = { xFraction: 0.32, yFraction: 0.63 };

/** One notch should close roughly STEP_FRACTION of the distance; allow spread. */
const MIN_RATIO = 0.02;
const MAX_RATIO = 0.60;
/** Cursor drift budget, in CSS pixels. */
const MAX_DRIFT_PX = 24;

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
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

console.log(`qa-zoom-probe -> ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 150_000 });
await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 150_000 });
console.log('app ready\n');

const failures = [];
let measured = 0;

for (const scene of SCENES) {
  const result = await page.evaluate(async (s, cursor) => {
    // dev serves Cesium as an ES module with no browser-resolvable specifier,
    // so take it from the app's own handle; the production build also sets a
    // global. Accept either.
    const Cesium = window.__godsEyeView.Cesium || window.Cesium;
    const viewer = window.__godsEyeView.viewer;
    const scn = viewer.scene;
    const canvas = scn.canvas;
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
    });
    // Photoreal tiles stream lazily; give them a generous window before
    // concluding there is no surface here.
    for (let i = 0; i < 70; i++) { scn.render(); await settle(90); }

    const rect = canvas.getBoundingClientRect();
    const px = Math.round(rect.width * cursor.xFraction);
    const py = Math.round(rect.height * cursor.yFraction);
    const win = new Cesium.Cartesian2(px, py);

    // Must match src/cameraZoom.js's plausibility rule. pickPosition does NOT
    // return undefined over an empty depth buffer — it reconstructs a point
    // deep inside the planet (measured at -13,625 m over Denver in headless,
    // where the photoreal tileset never streams). A probe that accepts that
    // asserts cursor-anchoring against a surface that does not exist.
    const surfaceAt = () => {
      const p = scn.pickPositionSupported ? scn.pickPosition(win) : undefined;
      if (p && Cesium.Cartesian3.magnitude(p) > 1) {
        const carto = Cesium.Cartographic.fromCartesian(p);
        if (carto && Number.isFinite(carto.height) && carto.height >= -1000) return p;
      }
      // Mirror src/cameraZoom.js's fallback exactly. Where no geometry is
      // rendered the module anchors to the ellipsoid ray, and that path must be
      // cursor-anchored too — it is what a keyless/streaming session actually
      // uses, and it is deterministic enough to assert on.
      const onEllipsoid = scn.camera.pickEllipsoid(win, scn.globe?.ellipsoid);
      return onEllipsoid || null;
    };
    const distanceToSurface = () => {
      const p = surfaceAt();
      return p ? Cesium.Cartesian3.distance(viewer.camera.positionWC, p) : null;
    };

    const anchor = surfaceAt();
    if (!anchor) return { skipped: 'no rendered surface under cursor (tileset not streamed here)' };
    const anchorCopy = Cesium.Cartesian3.clone(anchor);

    const steps = [];
    for (let i = 0; i < 6; i++) {
      const before = distanceToSurface();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100, deltaMode: 0,
        clientX: rect.left + px, clientY: rect.top + py,
        bubbles: true, cancelable: true,
      }));
      scn.render();
      await settle(140);
      scn.render();
      const after = distanceToSurface();

      // Where does the ORIGINAL anchor point sit on screen now?
      const projected = Cesium.SceneTransforms.worldToWindowCoordinates(scn, anchorCopy);
      const drift = projected
        ? Math.hypot(projected.x - px, projected.y - py)
        : null;

      steps.push({
        before, after,
        ratio: (before && after) ? (before - after) / before : null,
        drift,
      });
    }
    return { steps };
  }, scene, CURSOR);

  console.log(scene.name);
  if (result.skipped) {
    console.log(`  SKIPPED — ${result.skipped}\n`);
    continue;
  }

  measured += 1;
  const ratios = result.steps.map((x) => x.ratio).filter((r) => Number.isFinite(r));
  const drifts = result.steps.map((x) => x.drift).filter((d) => Number.isFinite(d));
  const worstDrift = drifts.length ? Math.max(...drifts) : NaN;
  const minRatio = ratios.length ? Math.min(...ratios) : NaN;
  const maxRatio = ratios.length ? Math.max(...ratios) : NaN;

  console.log(`  step closes ${(minRatio * 100).toFixed(1)}%-${(maxRatio * 100).toFixed(1)}% of the distance per notch`);
  console.log(`  cursor drift worst: ${worstDrift.toFixed(1)} px (budget ${MAX_DRIFT_PX})`);

  if (!(minRatio >= MIN_RATIO)) failures.push(`${scene.name}: a notch barely moved (${(minRatio * 100).toFixed(1)}%) — zoom stalls`);
  if (!(maxRatio <= MAX_RATIO)) failures.push(`${scene.name}: a notch overshot (${(maxRatio * 100).toFixed(1)}%) — zoom lunges`);
  if (!(worstDrift <= MAX_DRIFT_PX)) failures.push(`${scene.name}: cursor drifted ${worstDrift.toFixed(1)}px — zoom is not cursor-anchored`);
  console.log();
}

console.log('--- result ---');
if (!measured) {
  // An all-skipped run must NOT read as success: it validated nothing. The
  // photoreal tileset does not render under headless SwiftShader, so this probe
  // needs a real GPU browser. The arithmetic itself is covered in CI by
  // src/cameraZoom.test.mjs, which does not need a renderer.
  console.log('INCONCLUSIVE — no scene had a rendered surface to anchor to.');
  console.log('               Run this on a machine with GPU rendering; the step');
  console.log('               math is unit-tested in src/cameraZoom.test.mjs.');
  await browser.close();
  process.exit(2);
}
if (failures.length) {
  for (const f of failures) console.log('FAIL', f);
} else {
  console.log('PASS — every notch closes a bounded fraction of the true surface distance,');
  console.log('       and the point under the cursor stays under the cursor.');
}
await browser.close();
process.exit(failures.length ? 1 : 0);
