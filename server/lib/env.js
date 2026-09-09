/**
 * Small, typed reads of `process.env` values with a fallback, used by routes
 * that accept a JSON-or-CSV env override. Moved verbatim out of
 * `vite.config.js` (docs/ARCH-SERVER-SPLIT.md §4 PR 2) — no behaviour
 * changes, only the import path. This is the seed of the "one typed read of
 * every env var" module described in §3; later route PRs add to it as each
 * route's env reads move out of `vite.config.js`.
 *
 * @module server/lib/env
 */

/**
 * Read `process.env[key]` as JSON, falling back (and warning) on an unset or
 * invalid value.
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
export function parseJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    console.warn(`[AISStream] Invalid ${key}; using default.`);
    return fallback;
  }
}

/**
 * Read `process.env[key]` as a JSON array, or — when it does not parse as
 * one — as a comma-separated list. Falls back on an unset value.
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
export function parseCsvOrJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
}
