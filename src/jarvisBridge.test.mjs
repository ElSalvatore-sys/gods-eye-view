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

test('every Jarvis tool has a name, a description and an object schema', () => {
  for (const t of JARVIS_EXTRA_TOOLS) {
    assert.equal(t.type, 'function');
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.description.length > 20);
    assert.equal(t.parameters.type, 'object');
  }
});
