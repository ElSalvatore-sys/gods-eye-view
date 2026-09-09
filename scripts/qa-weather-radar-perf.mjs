#!/usr/bin/env node
/**
 * qa-weather-radar-perf — layer-rainviewer mission evidence.
 * Boots the app, enables ONLY weather-radar (left PAUSED, not autoplaying),
 * parks the camera, and counts scene.postRender fires over a settle window.
 * Expects ~0 renders/s (idle mode holds with the layer on but paused) —
 * complements the generic scripts/qa-perf.mjs governor regression gate with
 * a check specific to this layer.
 *
 * Usage: node scripts/qa-weather-radar-perf.mjs [--url http://localhost:4202]
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const APP_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4202';

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
      '--disable-dev-shm-usage', '--window-size=1440,860',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 860 });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 120000 });
    await new Promise((r) => setTimeout(r, 8000));

    const stats = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const v = gev.viewer;
      v.camera.cancelFlight();
      const ell = v.scene.globe.ellipsoid;
      v.camera.setView({
        destination: ell.cartographicToCartesian({
          longitude: 10 * Math.PI / 180, latitude: 48 * Math.PI / 180, height: 3_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      // Disable every OTHER layer first, then enable only weather-radar.
      for (const [id, entry] of gev.dataManager.layers) {
        if (entry.enabled && id !== 'weather-radar') {
          try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* best effort */ }
        }
      }
      await gev.dataManager.setEnabled('weather-radar', true, { origin: 'user' });
      const mod = gev.dataManager.layers.get('weather-radar').module;
      let s = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      return { stats: s, playing: s?.playing };
    });
    console.log('weather-radar stats after enable (paused):', JSON.stringify(stats));

    // Let tiles finish loading + any settling frames drain.
    await new Promise((r) => setTimeout(r, 10000));

    const counted = await page.evaluate((ms) => new Promise((resolve) => {
      const scene = window.__godsEyeView.viewer.scene;
      let renders = 0;
      const remove = scene.postRender.addEventListener(() => { renders += 1; });
      setTimeout(() => { remove(); resolve(renders); }, ms);
    }), 8000);

    const diag = await page.evaluate(() => window.__godsEyeView.getRenderGovernorDiagnostics?.());
    console.log('renders over 8s window (layer ON, paused):', counted);
    console.log('renders/s:', (counted / 8).toFixed(3));
    console.log('governor diagnostics:', JSON.stringify(diag));

    const ok = counted <= 2; // near-zero — a stray tile-load/camera settle frame is tolerated
    console.log(ok ? '[PASS] idle renders stay ~0 with weather-radar ON but paused' : '[FAIL] unexpected continuous rendering while paused');
    if (!ok) exitCode = 1;
  } catch (e) {
    console.error('harness error', e);
    exitCode = 3;
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
}

main();
