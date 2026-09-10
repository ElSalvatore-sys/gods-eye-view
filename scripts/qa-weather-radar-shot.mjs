#!/usr/bin/env node
// @ts-nocheck
/**
 * qa-weather-radar-shot — layer-rainviewer mission evidence.
 * Boots the real app, enables weather-radar, teleports over Europe, waits
 * for frames to load, and saves a PNG proving the radar imagery and its
 * scrubber panel render (default output: docs/media/qa/weather-radar.png).
 *
 * Usage: node scripts/qa-weather-radar-shot.mjs [--url http://localhost:4202] [--out <path>]
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const APP_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4202';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'docs/media/qa/weather-radar.png';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 600000,
    ...(findChromeExecutable() ? { executablePath: findChromeExecutable() } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-dev-shm-usage', '--disable-web-security',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (msg) => console.log('[page]', msg.text()));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 480000 },
    );
    await sleep(1500);
    // Dismiss the first-run "Choose your first view" modal.
    try {
      await page.click('[data-first-run-choice="explore"]');
    } catch { /* already dismissed */ }
    await sleep(800);

    const stats = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const dm = gev.dataManager;
      await dm.setEnabled('weather-radar', true);
      const mod = dm.layers.get('weather-radar').module;
      let s = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      // Teleport over Europe.
      const ell = gev.viewer.scene.globe.ellipsoid;
      const d2r = Math.PI / 180;
      try { gev.viewer.camera.cancelFlight(); } catch { /* no flight */ }
      gev.viewer.camera.setView({
        destination: ell.cartographicToCartesian({ longitude: 10 * d2r, latitude: 48 * d2r, height: 3000000 }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
      return s;
    });
    console.log('weather-radar stats:', JSON.stringify(stats));
    if (!(stats.count > 0)) { exitCode = 1; }

    // Wait for tiles to actually paint a couple of frames.
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.__godsEyeView?.viewer?.scene?.requestRender?.());
      await sleep(500);
    }
    const panelVisible = await page.evaluate(() => {
      const panel = document.getElementById('weather-radar-panel');
      return panel ? !panel.hidden : false;
    });
    console.log('panel visible:', panelVisible);

    await page.screenshot({ path: OUT });
    console.log('saved screenshot to', OUT);
  } catch (e) {
    console.error('harness error', e);
    exitCode = 3;
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
}

main();
