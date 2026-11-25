import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJob, startJarvisBridge } from './jarvisBridge.js';
import { runJarvisExtra, JARVIS_EXTRA_TOOLS } from './voice/jarvisTools.js';

function fakeRunner(results = {}) {
  const calls = [];
  const runner = async (name, args) => {
    calls.push([name, args]);
    return results[name] ?? { ok: true, name };
  };
  return { runner, calls };
}

test('a tool outside the allow list is refused by the page too', async () => {
  const { runner, calls } = fakeRunner();
  const out = await runJob({ id: '1', tool: 'eval_js', args: {} }, { runner, allow: new Set(['fly_to_location']) });
  assert.deepEqual(out, { ok: false, error: 'tool_not_allowed' });
  assert.equal(calls.length, 0);
});

test('a page tool runs and the view state comes back with it', async () => {
  const { runner, calls } = fakeRunner({ get_current_view_state: { latitude: 50.1, longitude: 8.68 } });
  const out = await runJob({ id: '2', tool: 'fly_to_location', args: { query: 'Frankfurt' } },
    { runner, allow: new Set(['fly_to_location']) });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0], ['fly_to_location', { query: 'Frankfurt' }]);
  assert.deepEqual(out.view, { latitude: 50.1, longitude: 8.68 });
});

test('a page tool that throws is a page_error, never a crash', async () => {
  const runner = async () => { throw new Error('boom'); };
  const out = await runJob({ id: '3', tool: 'fly_to_location', args: {} }, { runner, allow: new Set(['fly_to_location']) });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'page_error');
});

test('first person in the nearest plane: select it near the place, then enter the cockpit', async () => {
  const { runner, calls } = fakeRunner({ select_nearest_aircraft: { ok: true, selected: { callsign: 'DLH400' } } });
  const out = await runJarvisExtra('first_person_nearest_aircraft', { place: 'Frankfurt' }, { runner });
  assert.deepEqual(calls.map((c) => c[0]), ['select_nearest_aircraft', 'control_cockpit']);
  assert.deepEqual(calls[0][1], { layerId: 'flights', locationQuery: 'Frankfurt' });
  assert.deepEqual(calls[1][1], { action: 'enter' });
  assert.equal(out.ok, true);
});

test('no plane found: the cockpit is not entered', async () => {
  const { runner, calls } = fakeRunner({ select_nearest_aircraft: { ok: false, error: 'no aircraft' } });
  const out = await runJarvisExtra('first_person_nearest_aircraft', { place: 'Nowhere' }, { runner });
  assert.equal(out.ok, false);
  assert.deepEqual(calls.map((c) => c[0]), ['select_nearest_aircraft']);
});

test('leave the cockpit', async () => {
  const { runner, calls } = fakeRunner();
  await runJarvisExtra('leave_cockpit', {}, { runner });
  assert.deepEqual(calls, [['control_cockpit', { action: 'exit' }]]);
});

test('a job that hangs does not block the next one (found live: a camera flight in a hidden tab never arrived)', async () => {
  const jobs = [{ id: 'slow', tool: 'select_nearest_aircraft', args: {} }, { id: 'fast', tool: 'get_current_view_state', args: {} }];
  const posted = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/allow')) return { ok: true, status: 200, json: async () => ({ names: ['select_nearest_aircraft', 'get_current_view_state'] }) };
    if (url.endsWith('/next')) {
      const job = jobs.shift();
      if (!job) { await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 204 }; }
      return { ok: true, status: 200, json: async () => job };
    }
    posted.push(JSON.parse(opts.body).id);
    return { ok: true, status: 204 };
  };
  const runner = (name) => (name === 'select_nearest_aircraft' ? new Promise(() => {}) : Promise.resolve({ ok: true }));
  const bridge = startJarvisBridge({ runner, fetchImpl, jobTimeoutMs: 100 });
  await new Promise((r) => setTimeout(r, 300));
  bridge.stop();
  assert.ok(posted.includes('fast'));
  assert.ok(posted.includes('slow'), 'the hanging job is answered with a timeout');
});

test('frame and circle: fly to the middle of the drawing from its own size, wait, then orbit slowly at -45', async () => {
  // Live 2026-11-25: the brain drew the Nepal flood path but left the camera 3 km over one end of a 30 km line.
  const { runner, calls } = fakeRunner();
  const points = [{ lat: 28.30, lon: 85.30 }, { lat: 28.10, lon: 85.40 }, { lat: 28.00, lon: 85.36 }];
  const out = await runJarvisExtra('frame_and_circle', { points }, { runner });
  assert.equal(out.ok, true);
  const [fly, orbit] = calls;
  assert.equal(fly[0], 'fly_to_location');
  assert.ok(Math.abs(fly[1].latitude - 28.15) < 1e-9 && Math.abs(fly[1].longitude - 85.35) < 1e-9);
  assert.ok(fly[1].rangeM > 30000 && fly[1].rangeM < 80000, String(fly[1].rangeM));  // about 35 km across
  assert.equal(fly[1].waitForArrival, true);
  assert.deepEqual(orbit, ['move_camera', { motion: 'orbit', speed: 'slow', mode: 'continuous', pitchDeg: -45 }]);
});

test('frame and circle: a centre and a size work too, and circle=false only frames', async () => {
  const { runner, calls } = fakeRunner();
  await runJarvisExtra('frame_and_circle', { latitude: 50.03, longitude: 8.57, sizeKm: 4, circle: false }, { runner });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].rangeM, 5600);
});

test('frame and circle: no points and no centre is refused, nothing moves', async () => {
  const { runner, calls } = fakeRunner();
  const out = await runJarvisExtra('frame_and_circle', {}, { runner });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
});

test('frame and circle: a flight that fails is not followed by an orbit', async () => {
  const { runner, calls } = fakeRunner({ fly_to_location: { ok: false, error: 'cancelled' } });
  const out = await runJarvisExtra('frame_and_circle', { latitude: 1, longitude: 2, sizeKm: 10 }, { runner });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 1);
});

test('every Jarvis tool has a name, a description and an object schema', () => {
  for (const t of JARVIS_EXTRA_TOOLS) {
    assert.equal(t.type, 'function');
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.description.length > 20);
    assert.equal(t.parameters.type, 'object');
  }
});
