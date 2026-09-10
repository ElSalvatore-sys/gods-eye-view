#!/usr/bin/env node
// @ts-nocheck
/**
 * zoom-probe — Track A0. Tests the diagnosis that free-fly wheel zoom misbehaves
 * because Cesium derives its zoom step from a canvas-CENTRE pickPosition that
 * silently degrades to raw height-above-ellipsoid whenever the pick misses.
 *
 * The claim is falsifiable two ways, and this probe measures both:
 *   1. pickPosition at the canvas centre MISSES intermittently (globe.show=false
 *      means globe.pickWorldCoordinates can never supply the fallback).
 *   2. When it hits, the true distance-to-surface diverges sharply from the
 *      ellipsoid height Cesium falls back to — so the zoom step is scaled by a
 *      number unrelated to what the user is looking at.
 *
 * Usage: node zoom-probe.mjs --url http://localhost:4173
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const getOpt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL = getOpt('--url', 'http://localhost:4173');

// Places chosen to separate the two candidate explanations: high terrain,
// dense verticals at low elevation, and a flat sea-level control.
const SCENES = [
  { name: 'Manhattan (dense verticals, ~10m ground)', lon: -73.9857, lat: 40.7484, height: 900 },
  { name: 'Denver (high terrain ~1600m)', lon: -104.9903, lat: 39.7392, height: 2600 },
  { name: 'Open ocean (flat, sea level control)', lon: -40.0, lat: 30.0, height: 900 },
];

// Args match scripts/qa-perf.mjs, which is the known-good launch profile for
// this app — overriding the GL backend here stops Cesium booting at all.
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

console.log(`zoom-probe -> ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 120_000 });
console.log('app ready\n');

const results = [];
for (const scene of SCENES) {
  const out = await page.evaluate(async (s) => {
    const Cesium = window.Cesium;
    const viewer = window.__godsEyeView.viewer;
    const scn = viewer.scene;

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
    });

    // Let the photoreal tileset stream in before probing.
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) { scn.render(); await settle(100); }

    const canvas = scn.canvas;
    const centre = new Cesium.Cartesian2(
      Math.round(canvas.clientWidth / 2),
      Math.round(canvas.clientHeight / 2),
    );

    // Sample repeatedly, nudging the camera slightly, to expose intermittency.
    const samples = [];
    for (let i = 0; i < 25; i++) {
      viewer.camera.rotateRight(0.0006);
      scn.render();
      await settle(40);

      let picked = null;
      try { picked = scn.pickPosition(centre); } catch { picked = null; }

      const camPos = viewer.camera.positionWC;
      const ellipsoidHeight = viewer.camera.positionCartographic.height;
      const trueDistance = picked
        ? Cesium.Cartesian3.distance(camPos, picked)
        : null;

      samples.push({ hit: !!picked, ellipsoidHeight, trueDistance });
    }

    return {
      globeShown: scn.globe.show,
      // The fallback Cesium uses when the depth pick misses.
      tilesRenderedThisFrame: scn.globe?._surface?._tilesRenderedThisFrame?.length ?? null,
      samples,
    };
  }, scene);

  const hits = out.samples.filter((x) => x.hit);
  const missRate = (1 - hits.length / out.samples.length) * 100;
  const ratios = hits
    .filter((x) => x.trueDistance > 0)
    .map((x) => x.ellipsoidHeight / x.trueDistance);
  const mean = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : NaN;
  const min = ratios.length ? Math.min(...ratios) : NaN;
  const max = ratios.length ? Math.max(...ratios) : NaN;

  results.push({ scene: scene.name, missRate, mean, min, max, out });

  console.log(scene.name);
  console.log(`  globe.show = ${out.globeShown}   globe tiles rendered this frame = ${out.tilesRenderedThisFrame}`);
  console.log(`  centre pick MISS rate: ${missRate.toFixed(0)}%  (${out.samples.length - hits.length}/${out.samples.length})`);
  if (ratios.length) {
    console.log(`  ellipsoidHeight / trueDistanceToSurface: mean ${mean.toFixed(2)}x  range ${min.toFixed(2)}x - ${max.toFixed(2)}x`);
    console.log(`     (1.00x would mean Cesium's fallback matches reality; anything else scales the zoom step wrongly)`);
  } else {
    console.log('  no successful picks - every zoom step here uses the ellipsoid fallback');
  }
  console.log();
}

console.log('--- verdict ---');
for (const r of results) {
  const bad = r.missRate > 5 || (Number.isFinite(r.mean) && Math.abs(r.mean - 1) > 0.15);
  console.log(`${bad ? 'CONFIRMS' : 'clean   '}  ${r.scene}`);
}

await browser.close();
