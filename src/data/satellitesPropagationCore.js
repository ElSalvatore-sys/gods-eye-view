import { propagate, gstime, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';

/**
 * Pure SGP4 batch propagation — shared by the main-thread fallback in
 * `satellites.js` and `satellitesPropagation.worker.js`.
 *
 * Deliberately has no Cesium dependency and no module-level state: both
 * callers can invoke it from a plain data array, on the main thread or
 * inside a Worker, and its output is a single transferable buffer.
 */

/**
 * Propagate a batch of satrecs to one shared epoch.
 * @param {Array<{id: number|string, satrec: object}>} entries satrec records,
 *   each carrying the id the caller wants echoed back alongside its position.
 * @param {number} dateMs epoch to propagate to, as `Date.now()`-style millis.
 * @returns {Float64Array} flat `[lat, lon, alt, lat, lon, alt, ...]` triples,
 *   one per entry in `entries` order (lat/lon in degrees, alt in meters).
 *   A satrec that fails to propagate (decayed, malformed, SGP4 error) yields
 *   `NaN` for all three of its fields — callers must skip non-finite triples
 *   rather than plot them.
 */
export function propagateBatch(entries, dateMs) {
  const date = new Date(dateMs);
  const gmst = gstime(date);
  const lla = new Float64Array(entries.length * 3);

  for (let i = 0; i < entries.length; i++) {
    const offset = i * 3;
    try {
      const posVel = propagate(entries[i].satrec, date);
      if (!posVel.position || typeof posVel.position === 'boolean') {
        lla[offset] = NaN;
        lla[offset + 1] = NaN;
        lla[offset + 2] = NaN;
        continue;
      }
      const geo = eciToGeodetic(posVel.position, gmst);
      lla[offset] = degreesLat(geo.latitude);
      lla[offset + 1] = degreesLong(geo.longitude);
      lla[offset + 2] = geo.height * 1000; // km → meters
    } catch {
      lla[offset] = NaN;
      lla[offset + 1] = NaN;
      lla[offset + 2] = NaN;
    }
  }

  return lla;
}
