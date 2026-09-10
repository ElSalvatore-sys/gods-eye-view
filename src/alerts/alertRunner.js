/**
 * Alert runner — wires the pure rule engine (alertRules.js) to live layer
 * data and the DOM.
 *
 * It polls each enabled rule's layer through an injected `getRecords`
 * accessor — the SAME seam `analyst_query` uses (see
 * `analystProviders().getRecords` in `src/voice/gevActions.js`, which reads
 * `dataManager.layers.get(layerKey).module.getAnalystRecords()`) — throttled
 * to one evaluation pass every 5 s so a burst of layer refreshes only costs
 * one rule pass. Matches are deduped per (rule, entity id) with the rule's
 * cooldown (`alertRules.applyCooldown`) and each newly-fired match is both
 * kept in a capped "last 50" feed and dispatched as
 * `CustomEvent('gev:alert', {detail})` on `document`, for the alerts-panel UI
 * (and, later, a toast) to consume.
 * @module alerts/alertRunner
 */
import { evaluateRule, applyCooldown, defaultEntityId } from './alertRules.js';

/** Default evaluation cadence — one pass per this many ms. */
export const DEFAULT_THROTTLE_MS = 5000;
/** Cap on the in-memory "recent alerts" feed the panel reads. */
export const MAX_FEED = 50;

/**
 * @param {object} deps
 * @param {(layerKey: string) => Array<object>} deps.getRecords - layer accessor (analyst-record shape)
 * @param {() => Array<object>} deps.getRules - returns the live, already-loaded rule list
 * @param {Document|{dispatchEvent?: Function}|null} [deps.documentRef] - injectable for tests /
 *   non-DOM callers, so the structural `dispatchEvent` shape is the real contract, not `Document`
 * @param {() => number} [deps.now] - injectable clock
 * @param {Function} [deps.setIntervalFn]
 * @param {Function} [deps.clearIntervalFn]
 * @param {number} [deps.throttleMs]
 * @returns {{
 *   start: () => void, stop: () => void, tick: () => void,
 *   getFeed: () => Array<object>, resetCooldowns: () => void,
 * }}
 */
export function createAlertRunner({
  getRecords,
  getRules,
  documentRef = (typeof document !== 'undefined' ? document : null),
  now = () => Date.now(),
  setIntervalFn = (typeof setInterval !== 'undefined' ? setInterval : null),
  clearIntervalFn = (typeof clearInterval !== 'undefined' ? clearInterval : null),
  throttleMs = DEFAULT_THROTTLE_MS,
}) {
  let intervalHandle = null;
  /** `${ruleId}:${entityId}` -> epoch ms of last fire. */
  let lastFiredAt = new Map();
  /** Newest first, capped at MAX_FEED. */
  const recentAlerts = [];

  /** Run one evaluation pass over every enabled rule. Safe to call directly (tests, manual trigger). */
  function tick() {
    const rules = (typeof getRules === 'function' ? getRules() : []) || [];
    const nowMs = now();
    for (const rule of rules) {
      if (!rule?.enabled) continue;
      let records;
      try {
        records = (typeof getRecords === 'function' ? getRecords(rule.layer) : []) || [];
      } catch {
        records = []; // a layer accessor throwing must not take the whole pass down
      }
      let matches;
      try {
        matches = evaluateRule(rule, records);
      } catch {
        matches = []; // a malformed rule must not take the whole pass down either
      }
      if (!matches.length) continue;
      const cooled = applyCooldown(rule, matches, lastFiredAt, nowMs, defaultEntityId);
      lastFiredAt = cooled.lastFiredAt;
      for (const record of cooled.toFire) {
        const detail = {
          rule: {
            id: rule.id, name: rule.name, severity: rule.severity || 'info', layer: rule.layer,
          },
          record,
          entityId: defaultEntityId(record),
          firedAt: nowMs,
        };
        recentAlerts.unshift(detail);
        if (recentAlerts.length > MAX_FEED) recentAlerts.length = MAX_FEED;
        try {
          documentRef?.dispatchEvent?.(new CustomEvent('gev:alert', { detail }));
        } catch {
          // No CustomEvent/document (a bare Node unit test) — the feed above still recorded it.
        }
      }
    }
  }

  return {
    /** Start the throttled evaluation loop. Idempotent. */
    start() {
      if (intervalHandle !== null || typeof setIntervalFn !== 'function') return;
      intervalHandle = setIntervalFn(tick, throttleMs);
    },
    /** Stop the loop. Idempotent. */
    stop() {
      if (intervalHandle === null) return;
      clearIntervalFn?.(intervalHandle);
      intervalHandle = null;
    },
    /** Force one evaluation pass immediately. */
    tick,
    /** Last MAX_FEED fired alerts, newest first. */
    getFeed() { return recentAlerts.slice(); },
    /** Forget all cooldown state (e.g. after the rule set changes materially). */
    resetCooldowns() { lastFiredAt = new Map(); },
  };
}
