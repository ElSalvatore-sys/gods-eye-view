/**
 * Alert rules persistence — `localStorage['gev:alerts:v1']`, fail-open the
 * same way `firstRunExperience.js` treats storage: `globalThis.localStorage`
 * is a GETTER, and in Safari private mode (and some enterprise policies)
 * reading it THROWS. A default parameter evaluates that getter before the
 * function body runs, so the throw would escape every try/catch here — the
 * store is therefore resolved lazily, inside a try, at the moment it is used,
 * and an injected stub (tests, callers) short-circuits the global entirely.
 * @module alerts/alertStore
 */
import { DEFAULT_ALERT_RULES } from './alertRules.js';

/** localStorage key holding the saved rule list. */
export const ALERT_RULES_STORAGE_KEY = 'gev:alerts:v1';

/**
 * Resolve localStorage without letting a hostile getter escape.
 * @param {{getItem?: Function, setItem?: Function}|null|undefined} injected Explicit store; `undefined` means "use the global".
 * @returns {{getItem?: Function, setItem?: Function}|null}
 */
function resolveStore(injected) {
  if (injected !== undefined) return injected;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Read the raw rules blob, treating every failure as "nothing stored". */
function readRaw(injected) {
  try {
    return resolveStore(injected)?.getItem?.(ALERT_RULES_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the raw rules blob, best-effort.
 * @returns {boolean} true only if the value actually landed.
 */
function writeRaw(injected, value) {
  try {
    const store = resolveStore(injected);
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(ALERT_RULES_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/** True if `rule` has the minimum shape `evaluateRule` needs to run safely. */
function isRuleShaped(rule) {
  return !!rule && typeof rule === 'object'
    && typeof rule.id === 'string' && rule.id.length > 0
    && typeof rule.layer === 'string' && rule.layer.length > 0
    && Array.isArray(rule.where);
}

/** Fresh copies of the shipped example rules (never hand back shared frozen objects to a mutator). */
function seedDefaults() {
  return DEFAULT_ALERT_RULES.map((rule) => ({
    ...rule,
    where: rule.where.map((condition) => ({ ...condition })),
    ...(rule.geo ? { geo: { ...rule.geo } } : {}),
  }));
}

/**
 * Load rules. Fail-open: a missing key, a blocked/throwing storage area, or
 * a corrupted/foreign blob all fall back to the seeded example rules rather
 * than throwing or silently handing back zero rules.
 * @param {{getItem: Function}|null} [storage] Explicit store (tests); omit to use the global.
 * @returns {Array<object>}
 */
export function loadRules(storage) {
  const raw = readRaw(storage);
  if (raw === null) return seedDefaults();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return seedDefaults();
  }
  if (!Array.isArray(parsed)) return seedDefaults();
  const shaped = parsed.filter(isRuleShaped);
  return shaped.length ? shaped : seedDefaults();
}

/**
 * Persist rules, best-effort.
 * @param {Array<object>} rules
 * @param {{setItem: Function}|null} [storage] Explicit store (tests); omit to use the global.
 * @returns {boolean} true only if the value actually landed.
 */
export function saveRules(rules, storage) {
  try {
    return writeRaw(storage, JSON.stringify(Array.isArray(rules) ? rules : []));
  } catch {
    return false;
  }
}
