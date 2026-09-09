import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, saveRules, ALERT_RULES_STORAGE_KEY } from './alertStore.js';
import { DEFAULT_ALERT_RULES } from './alertRules.js';

/** A working in-memory localStorage-shaped stub. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    _data: data,
  };
}

test('loadRules: no stored key seeds the three shipped examples', () => {
  const rules = loadRules(fakeStorage());
  assert.equal(rules.length, DEFAULT_ALERT_RULES.length);
  assert.deepEqual(rules.map((r) => r.id).sort(), DEFAULT_ALERT_RULES.map((r) => r.id).sort());
});

test('saveRules then loadRules round-trips real data', () => {
  const storage = fakeStorage();
  const mine = [{ id: 'mine', name: 'Mine', enabled: true, layer: 'flights', where: [{ field: 'altitudeM', op: 'lt', value: 900 }], cooldownSec: 60, severity: 'info' }];
  assert.equal(saveRules(mine, storage), true);
  assert.equal(storage.getItem(ALERT_RULES_STORAGE_KEY), JSON.stringify(mine));
  const loaded = loadRules(storage);
  assert.deepEqual(loaded, mine);
});

test('loadRules: fail-open on a storage area whose getItem throws (Safari private-mode style)', () => {
  const hostile = { getItem() { throw new Error('SecurityError'); } };
  const rules = loadRules(hostile);
  assert.equal(rules.length, DEFAULT_ALERT_RULES.length, 'falls back to the seeded defaults, does not throw');
});

test('loadRules: fail-open when the resolved store itself throws on access (global getter case)', () => {
  // `undefined` (not passing storage) means "read globalThis.localStorage" —
  // simulate that getter throwing the way Safari private mode does.
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: hostile getter'); },
  });
  try {
    assert.doesNotThrow(() => loadRules());
    const rules = loadRules();
    assert.equal(rules.length, DEFAULT_ALERT_RULES.length);
  } finally {
    if (realDescriptor) Object.defineProperty(globalThis, 'localStorage', realDescriptor);
    else delete globalThis.localStorage;
  }
});

test('loadRules: fail-open on corrupted JSON', () => {
  const rules = loadRules(fakeStorage({ [ALERT_RULES_STORAGE_KEY]: '{not json' }));
  assert.equal(rules.length, DEFAULT_ALERT_RULES.length);
});

test('loadRules: fail-open on a well-formed but foreign/wrong-shaped blob', () => {
  const rules = loadRules(fakeStorage({ [ALERT_RULES_STORAGE_KEY]: JSON.stringify({ some: 'other app wrote this' }) }));
  assert.equal(rules.length, DEFAULT_ALERT_RULES.length);
});

test('loadRules: an array of foreign objects (no id/layer/where) also falls back', () => {
  const rules = loadRules(fakeStorage({ [ALERT_RULES_STORAGE_KEY]: JSON.stringify([{ foo: 'bar' }, 42, null]) }));
  assert.equal(rules.length, DEFAULT_ALERT_RULES.length);
});

test('loadRules: a mixed array keeps only the rule-shaped entries', () => {
  const good = { id: 'ok', layer: 'flights', where: [], enabled: true };
  const rules = loadRules(fakeStorage({ [ALERT_RULES_STORAGE_KEY]: JSON.stringify([good, { foo: 'bar' }]) }));
  assert.deepEqual(rules, [good]);
});

test('saveRules: fail-open (never throws) when setItem is missing or throws', () => {
  assert.equal(saveRules([{ id: 'x' }], {}), false, 'no setItem at all');
  assert.equal(saveRules([{ id: 'x' }], { setItem() { throw new Error('QuotaExceededError'); } }), false);
});

test('saveRules: non-array input is coerced to an empty saved list, never throws', () => {
  const storage = fakeStorage();
  assert.equal(saveRules(undefined, storage), true);
  assert.equal(storage.getItem(ALERT_RULES_STORAGE_KEY), '[]');
});
