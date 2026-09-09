import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCondition, withinGeofence, evaluateRule, applyCooldown, defaultEntityId, DEFAULT_ALERT_RULES,
} from './alertRules.js';

// ── evaluateCondition: each operator ────────────────────────────────────────

test('evaluateCondition: lt/lte/gt/gte compare numerically', () => {
  const r = { altitudeM: 900 };
  assert.equal(evaluateCondition(r, { field: 'altitudeM', op: 'lt', value: 914 }), true);
  assert.equal(evaluateCondition(r, { field: 'altitudeM', op: 'lt', value: 900 }), false);
  assert.equal(evaluateCondition(r, { field: 'altitudeM', op: 'lte', value: 900 }), true);
  assert.equal(evaluateCondition(r, { field: 'altitudeM', op: 'gt', value: 899 }), true);
  assert.equal(evaluateCondition(r, { field: 'altitudeM', op: 'gte', value: 900 }), true);
});

test('evaluateCondition: eq/neq are case-insensitive text compares (and true bool compares)', () => {
  assert.equal(evaluateCondition({ navStatus: 'Aground' }, { field: 'navStatus', op: 'eq', value: 'aground' }), true);
  assert.equal(evaluateCondition({ navStatus: 'under way' }, { field: 'navStatus', op: 'neq', value: 'aground' }), true);
  assert.equal(evaluateCondition({ military: true }, { field: 'military', op: 'eq', value: true }), true);
  assert.equal(evaluateCondition({ military: false }, { field: 'military', op: 'eq', value: true }), false);
});

test('evaluateCondition: in matches any value in the list, string/number agnostic', () => {
  const cond = { field: 'squawk', op: 'in', value: [7500, 7600, 7700] };
  assert.equal(evaluateCondition({ squawk: '7700' }, cond), true);
  assert.equal(evaluateCondition({ squawk: 7700 }, cond), true);
  assert.equal(evaluateCondition({ squawk: '1200' }, cond), false);
});

test('evaluateCondition: contains is a case-insensitive substring test', () => {
  assert.equal(evaluateCondition({ callsign: 'RCH123' }, { field: 'callsign', op: 'contains', value: 'rch' }), true);
  assert.equal(evaluateCondition({ callsign: 'UAL45' }, { field: 'callsign', op: 'contains', value: 'rch' }), false);
});

test('evaluateCondition: a null/undefined field never matches', () => {
  assert.equal(evaluateCondition({ squawk: null }, { field: 'squawk', op: 'eq', value: '7500' }), false);
  assert.equal(evaluateCondition({}, { field: 'squawk', op: 'in', value: [7500] }), false);
});

// ── withinGeofence: radius and ring ─────────────────────────────────────────

test('withinGeofence: no geo always passes', () => {
  assert.equal(withinGeofence({ lat: 1, lon: 1 }, undefined), true);
  assert.equal(withinGeofence({}, null), true);
});

test('withinGeofence: radius — inside vs outside, and missing coords fail closed', () => {
  const geo = { lat: 50.0782, lon: 8.2398, radiusKm: 50 }; // Wiesbaden, 50 km
  assert.equal(withinGeofence({ lat: 50.11, lon: 8.68 }, geo), true, 'Frankfurt is ~30 km away');
  assert.equal(withinGeofence({ lat: 52.52, lon: 13.405 }, geo), false, 'Berlin is ~430 km away');
  assert.equal(withinGeofence({ lat: null, lon: null }, geo), false, 'no position cannot be inside a geofence');
});

test('withinGeofence: ring — pointInRing containment', () => {
  const square = { ring: [[-1, -1], [1, -1], [1, 1], [-1, 1]] };
  assert.equal(withinGeofence({ lat: 0, lon: 0 }, square), true);
  assert.equal(withinGeofence({ lat: 5, lon: 5 }, square), false);
});

// ── evaluateRule: conditions AND geofence together ──────────────────────────

test('evaluateRule: ANDs every where condition with the geofence', () => {
  const rule = {
    id: 'r1',
    layer: 'ais-live-vessels',
    where: [{ field: 'navStatus', op: 'eq', value: 'aground' }],
    geo: { lat: 0, lon: 0, radiusKm: 200 },
  };
  const records = [
    { id: 'A', lat: 0.1, lon: 0.1, navStatus: 'aground' }, // matches both
    { id: 'B', lat: 0.1, lon: 0.1, navStatus: 'under way' }, // fails condition
    { id: 'C', lat: 45, lon: 45, navStatus: 'aground' }, // fails geofence
  ];
  const matches = evaluateRule(rule, records);
  assert.deepEqual(matches.map((r) => r.id), ['A']);
});

test('evaluateRule: a rule/records of the wrong shape returns no matches, never throws', () => {
  assert.deepEqual(evaluateRule(null, [{ id: 'x' }]), []);
  assert.deepEqual(evaluateRule({ id: 'r', where: [] }, null), []);
});

test('evaluateRule: no `where` conditions matches every in-geofence record', () => {
  const rule = { id: 'r2', layer: 'earthquakes', where: [] };
  const records = [{ id: 'Q1' }, { id: 'Q2' }];
  assert.deepEqual(evaluateRule(rule, records).map((r) => r.id), ['Q1', 'Q2']);
});

// ── applyCooldown: dedupe per (rule, entity) ────────────────────────────────

test('applyCooldown: fires once per entity, then withholds until cooldown elapses', () => {
  const rule = { id: 'emergency', cooldownSec: 300 };
  const matches = [{ icao24: 'abc123', squawk: '7700' }];

  const first = applyCooldown(rule, matches, new Map(), 1_000_000);
  assert.equal(first.toFire.length, 1, 'first sighting fires');

  const secondSoon = applyCooldown(rule, matches, first.lastFiredAt, 1_000_000 + 10_000);
  assert.equal(secondSoon.toFire.length, 0, 'still within the 300 s cooldown');

  const thirdLater = applyCooldown(rule, matches, secondSoon.lastFiredAt, 1_000_000 + 300_001);
  assert.equal(thirdLater.toFire.length, 1, 'cooldown elapsed, fires again');
});

test('applyCooldown: dedupes per ENTITY, not per rule — two aircraft on the same rule both fire', () => {
  const rule = { id: 'emergency', cooldownSec: 300 };
  const matches = [{ icao24: 'AAA', squawk: '7500' }, { icao24: 'BBB', squawk: '7600' }];
  const result = applyCooldown(rule, matches, new Map(), 0);
  assert.equal(result.toFire.length, 2);
});

test('applyCooldown: cooldownSec 0 never withholds a repeat sighting', () => {
  const rule = { id: 'r', cooldownSec: 0 };
  const matches = [{ id: 'x' }];
  const first = applyCooldown(rule, matches, new Map(), 0);
  const second = applyCooldown(rule, matches, first.lastFiredAt, 1);
  assert.equal(first.toFire.length, 1);
  assert.equal(second.toFire.length, 1);
});

test('defaultEntityId: prefers icao24, then mmsi, then id', () => {
  assert.equal(defaultEntityId({ icao24: 'A1', mmsi: 'M1', id: 'I1' }), 'A1');
  assert.equal(defaultEntityId({ mmsi: 'M1', id: 'I1' }), 'M1');
  assert.equal(defaultEntityId({ id: 'I1' }), 'I1');
});

// ── shipped example rules ───────────────────────────────────────────────────

test('DEFAULT_ALERT_RULES: three examples, all disabled by default', () => {
  assert.equal(DEFAULT_ALERT_RULES.length, 3);
  assert.ok(DEFAULT_ALERT_RULES.every((rule) => rule.enabled === false));
  const ids = DEFAULT_ALERT_RULES.map((rule) => rule.id);
  assert.ok(ids.includes('ex-emergency-squawk'));
  assert.ok(ids.includes('ex-vessel-aground'));
  assert.ok(ids.some((id) => id.startsWith('ex-quake')));
});

test('DEFAULT_ALERT_RULES: the emergency-squawk example actually matches a 7700 record', () => {
  const rule = DEFAULT_ALERT_RULES.find((r) => r.id === 'ex-emergency-squawk');
  const matches = evaluateRule(rule, [{ icao24: 'X', squawk: '7700' }, { icao24: 'Y', squawk: '1200' }]);
  assert.deepEqual(matches.map((r) => r.icao24), ['X']);
});
