// src/data/weatherRadar.test.mjs
// Pure-function tests for the RainViewer weather-radar layer: frame-list
// parsing, tile URL template building, and the 2-layer swap planner. No
// Cesium viewer/DOM needed — these three functions are the load-bearing
// logic and are exercised directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrameTileUrlTemplate,
  formatFrameTimestamp,
  parseRainviewerFrames,
  planFrameSwap,
  selectLatestPastFrameIndex,
} from './weatherRadar.js';

const SAMPLE_PAYLOAD = {
  version: '2.0',
  generated: 1_700_000_600,
  host: 'https://tilecache.rainviewer.com',
  radar: {
    past: [
      { time: 1_700_000_000, path: '/v2/radar/1700000000' },
      { time: 1_700_000_600, path: '/v2/radar/1700000600' },
    ],
    nowcast: [
      { time: 1_700_001_200, path: '/v2/radar/nowcast_1700001200' },
    ],
  },
  satellite: { infrared: [] },
};

// ── parseRainviewerFrames ────────────────────────────────────────────────

test('parseRainviewerFrames: extracts host and a sorted past+nowcast frame list', () => {
  const parsed = parseRainviewerFrames(SAMPLE_PAYLOAD);
  assert.ok(parsed);
  assert.equal(parsed.host, 'https://tilecache.rainviewer.com');
  assert.equal(parsed.frames.length, 3);
  assert.deepEqual(parsed.frames.map((f) => f.time), [1_700_000_000, 1_700_000_600, 1_700_001_200]);
  assert.deepEqual(parsed.frames.map((f) => f.kind), ['past', 'past', 'nowcast']);
  assert.equal(parsed.frames[2].path, '/v2/radar/nowcast_1700001200');
});

test('parseRainviewerFrames: sorts out-of-order frames and tolerates a missing nowcast', () => {
  const shuffled = {
    host: 'https://tilecache.rainviewer.com',
    radar: {
      past: [
        { time: 1_700_000_600, path: '/v2/radar/1700000600' },
        { time: 1_700_000_000, path: '/v2/radar/1700000000' },
      ],
    },
  };
  const parsed = parseRainviewerFrames(shuffled);
  assert.ok(parsed);
  assert.deepEqual(parsed.frames.map((f) => f.time), [1_700_000_000, 1_700_000_600]);
});

test('parseRainviewerFrames: rejects a malformed or empty payload', () => {
  assert.equal(parseRainviewerFrames(null), null);
  assert.equal(parseRainviewerFrames({}), null);
  assert.equal(parseRainviewerFrames({ host: 'https://tilecache.rainviewer.com' }), null);
  assert.equal(parseRainviewerFrames({ host: '', radar: { past: [] } }), null);
  assert.equal(
    parseRainviewerFrames({ host: 'https://tilecache.rainviewer.com', radar: { past: [] } }),
    null,
  );
});

test('parseRainviewerFrames: drops individual frames missing a usable time or path', () => {
  const dirty = {
    host: 'https://tilecache.rainviewer.com',
    radar: {
      past: [
        { time: 1_700_000_000, path: '/v2/radar/ok' },
        { time: 'not-a-number', path: '/v2/radar/bad-time' },
        { time: 1_700_000_100, path: 'relative-path-missing-leading-slash' },
        { time: 1_700_000_200 }, // no path at all
      ],
    },
  };
  const parsed = parseRainviewerFrames(dirty);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].path, '/v2/radar/ok');
});

// ── selectLatestPastFrameIndex ───────────────────────────────────────────

test('selectLatestPastFrameIndex: picks the last PAST frame, not a nowcast', () => {
  const { frames } = parseRainviewerFrames(SAMPLE_PAYLOAD);
  assert.equal(selectLatestPastFrameIndex(frames), 1);
});

test('selectLatestPastFrameIndex: falls back to the last frame when nothing is "past"', () => {
  assert.equal(selectLatestPastFrameIndex([{ kind: 'nowcast' }, { kind: 'nowcast' }]), 1);
});

test('selectLatestPastFrameIndex: -1 for an empty or invalid list', () => {
  assert.equal(selectLatestPastFrameIndex([]), -1);
  assert.equal(selectLatestPastFrameIndex(null), -1);
});

// ── buildFrameTileUrlTemplate ────────────────────────────────────────────

test('buildFrameTileUrlTemplate: builds the RainViewer {z}/{x}/{y} template with defaults', () => {
  const url = buildFrameTileUrlTemplate({
    host: 'https://tilecache.rainviewer.com',
    path: '/v2/radar/1700000600',
  });
  assert.equal(
    url,
    'https://tilecache.rainviewer.com/v2/radar/1700000600/256/{z}/{x}/{y}/2/1_1.png',
  );
});

test('buildFrameTileUrlTemplate: honors size/color/smooth/snow overrides', () => {
  const url = buildFrameTileUrlTemplate(
    { host: 'https://tilecache.rainviewer.com', path: '/v2/radar/1700000600' },
    { size: 512, color: 4, smooth: 0, snow: 0 },
  );
  assert.equal(
    url,
    'https://tilecache.rainviewer.com/v2/radar/1700000600/512/{z}/{x}/{y}/4/0_0.png',
  );
});

test('buildFrameTileUrlTemplate: rejects a non-https host or a path missing its leading slash', () => {
  assert.equal(buildFrameTileUrlTemplate({ host: 'http://tilecache.rainviewer.com', path: '/x' }), null);
  assert.equal(buildFrameTileUrlTemplate({ host: 'https://tilecache.rainviewer.com', path: 'x' }), null);
  assert.equal(buildFrameTileUrlTemplate({ host: '', path: '/x' }), null);
  assert.equal(buildFrameTileUrlTemplate(null), null);
});

// ── planFrameSwap (2-layer swap logic) ───────────────────────────────────

test('planFrameSwap: an unloaded target frame loads into the OTHER (stale) slot', () => {
  const state = { activeSlot: 'A', slotFrameIndex: { A: 3, B: null } };
  const plan = planFrameSwap(state, 5);
  assert.deepEqual(plan, { targetSlot: 'B', needsLoad: true, staleSlot: 'A' });
});

test('planFrameSwap: a target already pre-staged in the other slot swaps with no load', () => {
  // Frame 4 was pre-staged into B while A (frame 3) was visible — the
  // common autoplay-forward-one-frame case.
  const state = { activeSlot: 'A', slotFrameIndex: { A: 3, B: 4 } };
  const plan = planFrameSwap(state, 4);
  assert.deepEqual(plan, { targetSlot: 'B', needsLoad: false, staleSlot: 'A' });
});

test('planFrameSwap: re-selecting the already-active frame is a no-op swap', () => {
  const state = { activeSlot: 'B', slotFrameIndex: { A: 4, B: 3 } };
  const plan = planFrameSwap(state, 3);
  assert.deepEqual(plan, { targetSlot: 'B', needsLoad: false, staleSlot: 'A' });
});

test('planFrameSwap: never plans a target outside {A, B} and never grows past 2 slots', () => {
  const state = { activeSlot: 'A', slotFrameIndex: { A: 0, B: 1 } };
  for (const target of [0, 1, 2, 7]) {
    const plan = planFrameSwap(state, target);
    assert.ok(['A', 'B'].includes(plan.targetSlot));
    assert.ok(['A', 'B'].includes(plan.staleSlot));
    assert.notEqual(plan.targetSlot, plan.staleSlot);
  }
});

test('planFrameSwap: defaults a missing/invalid activeSlot to A', () => {
  const plan = planFrameSwap({ slotFrameIndex: {} }, 0);
  assert.equal(plan.targetSlot, 'B');
  assert.equal(plan.staleSlot, 'A');
});

// ── formatFrameTimestamp ──────────────────────────────────────────────────

test('formatFrameTimestamp: renders a UTC HH:MM label and a non-empty local label', () => {
  const { utc, local } = formatFrameTimestamp(1_700_000_600);
  assert.match(utc, /^\d{2}:\d{2} UTC$/);
  assert.ok(local.length > 0);
});

test('formatFrameTimestamp: falls back to em-dashes for a non-finite input', () => {
  assert.deepEqual(formatFrameTimestamp(NaN), { utc: '—', local: '—' });
  assert.deepEqual(formatFrameTimestamp(undefined), { utc: '—', local: '—' });
});
