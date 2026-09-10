import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertRunner } from './alertRunner.js';

/** A minimal document stub that records dispatched events. */
function fakeDocument() {
  const events = [];
  return { events, dispatchEvent(evt) { events.push(evt); return true; } };
}

test('alertRunner: tick() evaluates enabled rules, ignores disabled ones', () => {
  const documentRef = fakeDocument();
  const rules = [
    { id: 'on', enabled: true, layer: 'flights', where: [{ field: 'squawk', op: 'in', value: [7700] }], cooldownSec: 60 },
    { id: 'off', enabled: false, layer: 'flights', where: [{ field: 'squawk', op: 'in', value: [7700] }], cooldownSec: 60 },
  ];
  const records = [{ icao24: 'A1', squawk: '7700' }];
  const runner = createAlertRunner({
    getRecords: () => records,
    getRules: () => rules,
    documentRef,
    now: () => 1000,
  });
  runner.tick();
  assert.equal(documentRef.events.length, 1);
  assert.equal(documentRef.events[0].type, 'gev:alert');
  assert.equal(documentRef.events[0].detail.rule.id, 'on');
  assert.equal(documentRef.events[0].detail.entityId, 'A1');
  assert.deepEqual(runner.getFeed().map((a) => a.entityId), ['A1']);
});

test('alertRunner: respects cooldown across ticks, resetCooldowns clears it', () => {
  const documentRef = fakeDocument();
  let clock = 0;
  const rules = [{ id: 'r', enabled: true, layer: 'flights', where: [], cooldownSec: 100 }];
  const runner = createAlertRunner({
    getRecords: () => [{ id: 'X' }],
    getRules: () => rules,
    documentRef,
    now: () => clock,
  });
  runner.tick();
  clock = 5000; // well within the 100 s cooldown
  runner.tick();
  assert.equal(documentRef.events.length, 1, 'second tick withheld by cooldown');
  runner.resetCooldowns();
  runner.tick();
  assert.equal(documentRef.events.length, 2, 'cooldown state cleared, fires again');
});

test('alertRunner: a throwing getRecords/rule does not take the whole pass down', () => {
  const documentRef = fakeDocument();
  const rules = [
    { id: 'boom', enabled: true, layer: 'flights', where: [] },
    { id: 'fine', enabled: true, layer: 'military', where: [] },
  ];
  const runner = createAlertRunner({
    getRecords: (layer) => {
      if (layer === 'flights') throw new Error('layer offline');
      return [{ id: 'ok' }];
    },
    getRules: () => rules,
    documentRef,
    now: () => 0,
  });
  assert.doesNotThrow(() => runner.tick());
  assert.equal(documentRef.events.length, 1);
  assert.equal(documentRef.events[0].detail.rule.id, 'fine');
});

test('alertRunner: start/stop drive tick via the injected interval, and are idempotent', () => {
  // Annotated because the only assignment happens inside the injected
  // callback below, which TS does not use to widen an evolving `let`.
  /** @type {{fn: Function, ms: number}|null} */
  let scheduled = null;
  let cleared = 0;
  const runner = createAlertRunner({
    getRecords: () => [],
    getRules: () => [],
    documentRef: fakeDocument(),
    setIntervalFn: (fn, ms) => { scheduled = { fn, ms }; return 'handle-1'; },
    clearIntervalFn: () => { cleared += 1; },
  });
  runner.start();
  runner.start(); // idempotent — no second interval
  assert.equal(scheduled?.ms, 5000);
  runner.stop();
  runner.stop(); // idempotent — no double-clear
  assert.equal(cleared, 1);
});
