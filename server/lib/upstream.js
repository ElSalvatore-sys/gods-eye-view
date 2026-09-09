/**
 * Small utilities shared by proxy routes that call an upstream API: request
 * coalescing (single-flight) and great-circle distance for bounding/ranking
 * checks. Moved verbatim out of `vite.config.js`
 * (docs/ARCH-SERVER-SPLIT.md §4 PR 2) — no behaviour changes, only the
 * import path.
 *
 * @module server/lib/upstream
 */

/**
 * Return the existing promise for a cache key, or create one and remove it
 * only when that exact promise settles.
 * @param {Map<string, Promise<*>>} inFlight
 * @param {string} key
 * @param {() => Promise<*>} create
 * @returns {{promise: Promise<*>, shared: boolean}}
 */
export function coalesceProxyRequest(inFlight, key, create) {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, shared: true };
  let promise;
  promise = Promise.resolve()
    .then(create)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { promise, shared: false };
}

/**
 * Haversine great-circle distance between two WGS-84 points.
 *
 * @param {number} lat1 - Latitude of point A (degrees).
 * @param {number} lon1 - Longitude of point A (degrees).
 * @param {number} lat2 - Latitude of point B (degrees).
 * @param {number} lon2 - Longitude of point B (degrees).
 * @returns {number} Distance in kilometers.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
