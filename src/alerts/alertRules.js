/**
 * Alert rule engine — pure evaluation over records ALREADY sitting
 * client-side in the layers (idea #16). No fetches, no Cesium, no DOM: the
 * seam alertRunner.js drives with live records and the alerts-panel UI reads
 * results from.
 *
 * The rule schema is intentionally the same shape a future server-side
 * evaluator (ntfy/server delivery — a LATER mission) could run against a
 * snapshot of the same layers, so it is plain JSON, not a closure:
 *
 *   {
 *     id: string, name: string, enabled: boolean,
 *     layer: 'flights'|'military'|'ais-live-vessels'|'earthquakes'|'local-firms'|'satellites',
 *     where: [{ field: string, op: 'lt'|'lte'|'gt'|'gte'|'eq'|'neq'|'in'|'contains', value }],
 *     geo?: { lat: number, lon: number, radiusKm: number } | { ring: Array<[number, number]> },
 *     cooldownSec: number, severity: 'info'|'warning'|'critical',
 *   }
 *
 * Geo math is NOT duplicated here: radius uses `haversineKm` from
 * analystEngine.js (the same great-circle math the analyst query and Contacts
 * radius scope use) and ring containment uses `pointInRing` from
 * naturalEarthRegions.js (the Natural Earth polygon test).
 * @module alerts/alertRules
 */
import { haversineKm } from '../data/analystEngine.js';
import { pointInRing } from '../data/naturalEarthRegions.js';

/** Operators a `where` condition may use. */
export const ALERT_OPS = Object.freeze(['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'in', 'contains']);

/**
 * Evaluate one `where` condition against one record.
 * A missing/null field never matches — a rule should never fire off an
 * absent value comparing "equal" to itself by coincidence of both being
 * null/undefined.
 * @param {object} record
 * @param {{field: string, op: string, value: *}} condition
 * @returns {boolean}
 */
export function evaluateCondition(record, condition) {
  const { field, op, value } = condition || {};
  if (!field || !op) return true; // a condition missing shape constrains nothing
  const got = record?.[field];
  if (got === null || got === undefined) return false;
  switch (op) {
    case 'lt': return Number(got) < Number(value);
    case 'lte': return Number(got) <= Number(value);
    case 'gt': return Number(got) > Number(value);
    case 'gte': return Number(got) >= Number(value);
    case 'eq': {
      if (typeof got === 'boolean' || typeof value === 'boolean') return Boolean(got) === Boolean(value);
      return String(got).toLowerCase() === String(value).toLowerCase();
    }
    case 'neq': {
      if (typeof got === 'boolean' || typeof value === 'boolean') return Boolean(got) !== Boolean(value);
      return String(got).toLowerCase() !== String(value).toLowerCase();
    }
    case 'in': {
      const list = Array.isArray(value) ? value : [value];
      return list.some((v) => String(v).toLowerCase() === String(got).toLowerCase());
    }
    case 'contains': return String(got).toLowerCase().includes(String(value).toLowerCase());
    default: return false;
  }
}

/**
 * True if a record satisfies the rule's geofence. No geofence always passes;
 * a geofenced rule requires the record to actually carry lat/lon.
 * @param {object} record
 * @param {{lat: number, lon: number, radiusKm: number}|{ring: Array<[number, number]>}|null|undefined} geo
 * @returns {boolean}
 */
export function withinGeofence(record, geo) {
  if (!geo) return true;
  if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon)) return false;
  if (Array.isArray(geo.ring)) return pointInRing(geo.ring, record.lat, record.lon);
  if (Number.isFinite(geo.lat) && Number.isFinite(geo.lon) && Number.isFinite(geo.radiusKm)) {
    return haversineKm(geo.lat, geo.lon, record.lat, record.lon) <= geo.radiusKm;
  }
  return true;
}

/**
 * Evaluate one rule against a records snapshot for its layer.
 * @param {object} rule
 * @param {Array<object>} records
 * @returns {Array<object>} matching records, unfiltered by cooldown (see `applyCooldown`)
 */
export function evaluateRule(rule, records) {
  if (!rule || !Array.isArray(records)) return [];
  const conditions = Array.isArray(rule.where) ? rule.where : [];
  return records.filter((record) => (
    conditions.every((condition) => evaluateCondition(record, condition))
    && withinGeofence(record, rule.geo)
  ));
}

/**
 * Default per-record identity for dedupe: prefer stable transponder/vessel
 * ids, fall back to whatever `id` the layer's analyst record carries.
 * @param {object} record
 * @returns {string}
 */
export function defaultEntityId(record) {
  return record?.icao24 || record?.mmsi || record?.id || JSON.stringify(record ?? {});
}

/**
 * Filter already-matched records against per-(rule, entity) cooldown state.
 * Pure — the caller supplies `nowMs` and gets back the updated state to keep
 * (or persist), rather than this module reading the clock itself.
 * @param {object} rule
 * @param {Array<object>} matches - records already matched by `evaluateRule`
 * @param {Map<string, number>} lastFiredAt - `${ruleId}:${entityId}` -> epoch ms of last fire
 * @param {number} nowMs
 * @param {(record: object) => string} [getEntityId]
 * @returns {{toFire: Array<object>, lastFiredAt: Map<string, number>}}
 */
export function applyCooldown(rule, matches, lastFiredAt, nowMs, getEntityId = defaultEntityId) {
  const cooldownMs = Math.max(0, Number(rule?.cooldownSec) || 0) * 1000;
  const next = new Map(lastFiredAt);
  const toFire = [];
  for (const record of matches) {
    const entityId = getEntityId(record);
    const key = `${rule?.id}:${entityId}`;
    const last = next.get(key);
    if (last !== undefined && nowMs - last < cooldownMs) continue;
    next.set(key, nowMs);
    toFire.push(record);
  }
  return { toFire, lastFiredAt: next };
}

/**
 * Three example rules, SHIPPED DISABLED — Ali reviews and enables what's
 * useful rather than being opted into notifications on first load.
 * Wiesbaden is the reference point for the geofenced example, matching the
 * "50 km of Wiesbaden" example in the mission brief.
 * @type {Array<object>}
 */
export const DEFAULT_ALERT_RULES = Object.freeze([
  Object.freeze({
    id: 'ex-emergency-squawk',
    name: 'Emergency squawk (7500 / 7600 / 7700)',
    enabled: false,
    layer: 'flights',
    where: Object.freeze([Object.freeze({ field: 'squawk', op: 'in', value: Object.freeze([7500, 7600, 7700]) })]),
    cooldownSec: 300,
    severity: 'critical',
  }),
  Object.freeze({
    id: 'ex-vessel-aground',
    name: 'Vessel aground',
    enabled: false,
    layer: 'ais-live-vessels',
    where: Object.freeze([Object.freeze({ field: 'navStatus', op: 'eq', value: 'aground' })]),
    cooldownSec: 600,
    severity: 'warning',
  }),
  Object.freeze({
    id: 'ex-quake-500km-wiesbaden',
    name: 'Quake ≥ 5.0 within 500 km of Wiesbaden',
    enabled: false,
    layer: 'earthquakes',
    where: Object.freeze([Object.freeze({ field: 'magnitude', op: 'gte', value: 5 })]),
    geo: Object.freeze({ lat: 50.0782, lon: 8.2398, radiusKm: 500 }),
    cooldownSec: 1800,
    severity: 'warning',
  }),
]);
