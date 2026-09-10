#!/usr/bin/env node
// @ts-nocheck
/**
 * qa-alerts — the alerts engine's contract, proved in the real app.
 *
 * The unit suite (src/alerts/*.test.mjs) pins evaluateRule/applyCooldown/
 * alertStore against fakes. This harness answers the question only a running
 * app can: wired into the real alerts-panel, does enabling the shipped
 * "Emergency squawk" example rule against an INJECTED fake flights record set
 * actually fire a `gev:alert` CustomEvent, and does the panel's live feed
 * show it.
 *
 * Usage: node scripts/qa-alerts.mjs [--url http://localhost:4203] [--headful]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(repoRoot, 'qa-shots', 'alerts');
const args = process.argv;
const getOpt = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const appUrl = (process.env.QA_BASE_URL || getOpt('--url', 'http://localhost:4173')).replace(/\/$/, '');
const headful = args.includes('--headful');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || (() => { try { return puppeteer.executablePath(); } catch { return null; } })();

if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable');
}
fs.mkdirSync(shotsDir, { recursive: true });

const failures = [];
const check = (name, passed, detail = '') => {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
};

// A civilian squawk (never matches) and an emergency squawk (matches
// ex-emergency-squawk's `squawk in [7500,7600,7700]`) — proves the rule
// discriminates, not just that anything with a `squawk` field fires.
const FAKE_FLIGHTS = [
  {
    id: 'RCH123', icao24: 'ae1234', callsign: 'RCH123', lat: 50.08, lon: 8.24, altitudeM: 3000, squawk: '7700',
  },
  {
    id: 'UAL45', icao24: 'a90001', callsign: 'UAL45', lat: 40.71, lon: -74.0, altitudeM: 9000, squawk: '1200',
  },
];

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--use-angle=metal',
    '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900',
  ],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  const source = message.location()?.url;
  // Filters mirror qa-firstrun.mjs's noise list, plus one specific to this
  // machine's mission setup: worktrees share node_modules (COMMON.md), so
  // this server's Vite dep-optimizer cache is the SAME directory the OWNER'S
  // separate dev server (port 4173, never touched by this script) also
  // writes to. A re-optimize on either server can 504 an in-flight request
  // on the other with "Outdated Optimize Dep" — confirmed present here via
  // `ps aux` showing both vite processes live. It is an artifact of the
  // shared-cache setup, not an alerts-engine defect, so it is filtered by
  // its specific message rather than by status code alone.
  if (/Failed to load resource.*(404|429|503)/i.test(text)) return;
  if (/504 \(Outdated Optimize Dep\)/i.test(text)) return;
  consoleErrors.push(source ? `${text} [${source}]` : text);
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  // welcome=0 skips the first-run launcher so it never covers the panel.
  await page.goto(`${appUrl}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${appUrl}/?welcome=0`, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(
    () => !!window.__godsEyeView?.styleManager?._alertRunner,
    { timeout: 45000 },
  );
  check('the app boots with the alerts engine wired (styleManager._alertRunner exists)', true);
  // Let the loading cover (z-index above every panel) actually clear before
  // interacting/screenshotting — the runner can exist a beat before it does.
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  ).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));

  const seeded = await page.evaluate(() => {
    const rules = window.__godsEyeView.styleManager._alertRules || [];
    return {
      count: rules.length,
      hasEmergency: rules.some((r) => r.id === 'ex-emergency-squawk'),
      emergencyEnabled: rules.find((r) => r.id === 'ex-emergency-squawk')?.enabled,
    };
  });
  check('3 example rules are seeded', seeded.count === 3, `count=${seeded.count}`);
  check('the emergency-squawk example is present and disabled by default',
    seeded.hasEmergency && seeded.emergencyEnabled === false, JSON.stringify(seeded));

  const formHiddenAtLoad = await page.evaluate(() => {
    const form = document.getElementById('alerts-rule-form');
    return { hiddenAttr: form?.hidden, display: getComputedStyle(form).display };
  });
  check('the rule-builder form stays hidden until "+ RULE" is clicked (the [hidden] attribute is honored)',
    formHiddenAtLoad.hiddenAttr === true && formHiddenAtLoad.display === 'none',
    JSON.stringify(formHiddenAtLoad));

  // Reveal the panel for the screenshot and to prove the DOM feed updates,
  // not just the runner's in-memory state.
  await page.evaluate(() => {
    window.__godsEyeView.styleManager.setPanelCollapsed('alerts-panel', false, { explicit: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const panelOpen = await page.evaluate(() => !document.getElementById('alerts-panel')?.classList.contains('collapsed'));
  check('the alerts-panel opens', panelOpen);

  // Set up the event capture BEFORE enabling the rule.
  await page.evaluate(() => {
    window.__gevAlertEvents = [];
    document.addEventListener('gev:alert', (event) => window.__gevAlertEvents.push(event.detail));
  });

  // Inject a fake flights record set — the alert runner reads records through
  // `styleManager._alertGetRecords(layerKey)`; overriding it is the seam the
  // real app uses to reach `dataManager.layers.get('flights').module
  // .getAnalystRecords()`, without needing a live OpenSky feed for this proof.
  await page.evaluate((fakeFlights) => {
    const sm = window.__godsEyeView.styleManager;
    sm._alertGetRecords = (layerKey) => (layerKey === 'flights' ? fakeFlights : []);
  }, FAKE_FLIGHTS);

  // Enable the emergency-squawk rule the way a visitor does: click its toggle.
  const toggled = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.alerts-rule-row')]
      .find((el) => el.dataset.ruleId === 'ex-emergency-squawk');
    const toggle = row?.querySelector('.alerts-rule-toggle');
    if (!toggle) return false;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  check('the emergency-squawk rule toggle is clicked', toggled);

  const ruleState = await page.evaluate(() => (
    window.__godsEyeView.styleManager._alertRules.find((r) => r.id === 'ex-emergency-squawk')?.enabled
  ));
  check('the rule is now enabled in state', ruleState === true, `enabled=${ruleState}`);

  // Force one evaluation pass instead of waiting up to 5 s for the throttle.
  await page.evaluate(() => window.__godsEyeView.styleManager._alertRunner.tick());
  await new Promise((resolve) => setTimeout(resolve, 200));

  const outcome = await page.evaluate(() => ({
    events: window.__gevAlertEvents,
    feedRows: [...document.querySelectorAll('#alerts-feed-list .alerts-feed-row')]
      .map((el) => el.querySelector('.alerts-feed-text')?.textContent || ''),
    toastText: document.getElementById('toast')?.textContent || '',
    toastVisible: document.getElementById('toast')?.classList.contains('visible'),
  }));

  check('exactly one gev:alert event fired (only the emergency squawk matches)',
    outcome.events.length === 1, `events=${outcome.events.length}`);
  check('the fired event carries the matching flight, not the civilian one',
    outcome.events[0]?.record?.icao24 === 'ae1234' && outcome.events[0]?.record?.squawk === '7700',
    JSON.stringify(outcome.events[0] || null));
  check('the fired event names the rule that fired',
    outcome.events[0]?.rule?.id === 'ex-emergency-squawk', JSON.stringify(outcome.events[0]?.rule || null));
  check('the alerts-panel feed shows the fired alert',
    outcome.feedRows.some((text) => text.includes('RCH123')), JSON.stringify(outcome.feedRows));
  check('a toast announced the alert',
    outcome.toastVisible && /Emergency squawk/i.test(outcome.toastText), `toast="${outcome.toastText}"`);

  // A second tick with the SAME fake records must not re-fire (cooldown).
  await page.evaluate(() => window.__godsEyeView.styleManager._alertRunner.tick());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterSecondTick = await page.evaluate(() => window.__gevAlertEvents.length);
  check('a second pass over the same records is withheld by cooldown/dedupe',
    afterSecondTick === 1, `events after second tick=${afterSecondTick}`);

  // Clip to the panel itself (plus a small margin) rather than the full
  // viewport — this is evidence of the ALERTS PANEL, not a globe screenshot,
  // and staying off the high-frequency satellite imagery keeps the PNG well
  // under the 400 KB evidence budget.
  const panelBox = await page.evaluate(() => {
    const rect = document.getElementById('alerts-panel')?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    };
  });
  const margin = 16;
  const clip = panelBox
    ? {
      x: Math.max(0, panelBox.x - margin),
      y: Math.max(0, panelBox.y - margin),
      width: panelBox.width + margin * 2,
      height: panelBox.height + margin * 2,
    }
    : undefined;
  await page.screenshot({ path: path.join(shotsDir, 'alerts-panel-fired.png'), clip });
  check('the alerts-panel bounding box was captured for the screenshot clip', !!panelBox);
  check('no console errors during the run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n  ${failures.length ? failures.length : 0} failing check(s) of the alerts QA run.`);
if (failures.length) {
  console.error(`\nAlerts QA failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nAlerts QA passed.');
}
