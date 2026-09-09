import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './mount.js';

/**
 * Differential test: pins `mount()` against the 8-row table measured in
 * docs/ARCH-SERVER-SPLIT.md §2a, where real Vite dev (Connect) and a
 * standalone router were run side-by-side and diffed. Any change to
 * `mount()`'s matching or URL-rewrite logic that breaks parity with Connect
 * must fail one of these cases.
 */

/** An echo handler matching the §2a probe: reports the rewritten `req.url`. */
function echo(req, res) {
  res.end(JSON.stringify({ seen: req.url }));
}

/** Wrap a mounted middleware and run it against a single fake request. */
function run(prefix, handler, url) {
  const req = { url };
  let body = null;
  let fellThrough = false;
  const res = { end: (b) => { body = b; } };
  const layer = mount(prefix, handler);
  layer(req, res, () => { fellThrough = true; });
  return { body, fellThrough };
}

test('§2a row 1: /api/celestrak/active', () => {
  const { body } = run('/api/celestrak', echo, '/api/celestrak/active');
  assert.equal(body, JSON.stringify({ seen: '/active' }));
});

test('§2a row 2: /api/celestrak/stations?x=1 preserves the query string', () => {
  const { body } = run('/api/celestrak', echo, '/api/celestrak/stations?x=1');
  assert.equal(body, JSON.stringify({ seen: '/stations?x=1' }));
});

test('§2a row 3: /api/celestrak (no sub-path) rewrites to /', () => {
  const { body } = run('/api/celestrak', echo, '/api/celestrak');
  assert.equal(body, JSON.stringify({ seen: '/' }));
});

test('§2a row 4: /api/celestrak/ (trailing slash) rewrites to /', () => {
  const { body } = run('/api/celestrak', echo, '/api/celestrak/');
  assert.equal(body, JSON.stringify({ seen: '/' }));
});

test('§2a row 5: /api/celestrakXYZ does not match — falls through to next()', () => {
  const { body, fellThrough } = run('/api/celestrak', echo, '/api/celestrakXYZ');
  assert.equal(body, null);
  assert.equal(fellThrough, true);
});

test('§2a row 6: percent-encoded GBFS target arrives raw and un-decoded', () => {
  const url = '/api/gbfs/https%3A%2F%2Fgbfs.lyft.com%2Fgbfs%2Fstation_status.json';
  const { body } = run('/api/gbfs', echo, url);
  assert.equal(body, JSON.stringify({ seen: '/https%3A%2F%2Fgbfs.lyft.com%2Fgbfs%2Fstation_status.json' }));
});

test('§2a row 7: /api/adsblol/mil (multi-segment prefix) rewrites to /', () => {
  const { body } = run('/api/adsblol/mil', echo, '/api/adsblol/mil');
  assert.equal(body, JSON.stringify({ seen: '/' }));
});

test('§2a row 8: /api/adsblol/mil?z=1 preserves the query string', () => {
  const { body } = run('/api/adsblol/mil', echo, '/api/adsblol/mil?z=1');
  assert.equal(body, JSON.stringify({ seen: '/?z=1' }));
});
