import { sendText } from '../lib/http.js';
import { namespace } from '../lib/cache.js';

/**
 * Keyless forward geocoding (place name -> coordinates) via OpenStreetMap's
 * Nominatim.
 *
 * Why this exists: `src/locations.js` searched exclusively through the Google
 * Geocoding API and threw "No Google Maps API key available for geocoding"
 * without one — so on a keyless install, which is the documented default
 * startup path, the LOCATION box and every voice "fly me to X" simply failed.
 * Nominatim was already trusted in this codebase for REVERSE geocoding in the
 * cockpit regional briefing; this is the forward half of the same source.
 *
 * Google stays the preferred path when a key is present: it carries richer
 * place types and viewport bounds, and Places recovery has no Nominatim
 * equivalent. This is the fallback, not a replacement.
 *
 * Nominatim's usage policy is strict and unmetered access depends on honouring
 * it: at most one request per second, a genuine identifying User-Agent, and
 * aggressive caching. All three are enforced here rather than trusted to
 * callers — `_queue` serialises upstream calls with a >=1.1s spacing, and
 * results are cached for 30 days because a place's coordinates do not move.
 *
 * @module server/routes/geocode
 */

/** Coordinates of a named place are effectively static; cache them hard. */
const TTL_MS = 30 * 24 * 60 * 60_000;

/** Nominatim asks for <=1 request/second. 1.1s leaves headroom for clock skew. */
const MIN_REQUEST_SPACING_MS = 1100;

const UPSTREAM_HOST = 'nominatim.openstreetmap.org';

const USER_AGENT = 'gods-eye-view-geocode-proxy/1.0 (+https://github.com/ElSalvatore-sys/gods-eye-view)';

/**
 * Nominatim describes a place with `class`/`type`/`addresstype`; the client's
 * `geocodeNavigationMode()` (src/locations.js) reasons in Google place types.
 * Translate so a keyless search frames a country as a region, a city as a city
 * and a street as a corridor, exactly as the Google path would.
 * @param {{class?: string, type?: string, addresstype?: string}} hit
 * @returns {string[]} Google-style place types, most specific first.
 */
export function nominatimTypesToGoogle(hit) {
  const addressType = String(hit?.addresstype || '').toLowerCase();
  const klass = String(hit?.class || '').toLowerCase();
  const type = String(hit?.type || '').toLowerCase();
  const out = [];

  const push = (...values) => { for (const v of values) if (v && !out.includes(v)) out.push(v); };

  switch (addressType) {
    case 'country': push('country'); break;
    case 'state': case 'province': case 'region': push('administrative_area_level_1'); break;
    case 'county': case 'state_district': push('administrative_area_level_2'); break;
    case 'city': case 'town': case 'municipality': push('locality'); break;
    case 'village': case 'hamlet': push('locality'); break;
    case 'suburb': case 'borough': case 'city_district': case 'district':
      push('sublocality', 'sublocality_level_1'); break;
    case 'neighbourhood': case 'quarter': push('neighborhood'); break;
    case 'postcode': push('postal_code'); break;
    case 'road': case 'street': push('route'); break;
    case 'house': case 'building': case 'house_number': push('premise'); break;
    default: break;
  }

  // `class`/`type` carry the landmark character the address type flattens away
  // — these are what push a result into close landmark framing.
  if (klass === 'leisure' && (type === 'park' || type === 'garden')) push('park');
  if (klass === 'natural') push('natural_feature');
  if (klass === 'waterway' || type === 'water' || type === 'bay' || type === 'strait') push('natural_feature');
  if (type === 'university' || type === 'college') push('university', 'campus');
  if (type === 'aerodrome' || klass === 'aeroway') push('airport');
  if (type === 'stadium') push('stadium');
  if (type === 'zoo') push('zoo');
  if (type === 'theme_park') push('amusement_park');
  if (type === 'cemetery' || type === 'grave_yard') push('cemetery');
  if (type === 'mall') push('shopping_mall');
  if (klass === 'peak' || type === 'peak' || type === 'volcano') push('natural_feature');

  if (!out.length) push('establishment');
  return out;
}

/**
 * Nominatim returns `boundingbox` as `[south, north, west, east]` strings.
 * Reshape into the `{northeast, southwest}` bounds the client's
 * `flyToViewportBounds` already consumes from Google.
 * @param {string[]|undefined} boundingbox
 * @returns {{northeast: {lat: number, lng: number}, southwest: {lat: number, lng: number}}|null}
 */
export function boundingBoxToViewport(boundingbox) {
  if (!Array.isArray(boundingbox) || boundingbox.length < 4) return null;
  const [south, north, west, east] = boundingbox.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return {
    northeast: { lat: north, lng: east },
    southwest: { lat: south, lng: west },
  };
}

/**
 * Normalise one Nominatim hit into the shape `searchAndFlyTo` expects.
 * @param {object} hit
 * @returns {{lat: number, lon: number, label: string, types: string[], viewport: object|null}|null}
 */
export function normalizeHit(hit) {
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    label: String(hit?.display_name || '').trim() || null,
    types: nominatimTypesToGoogle(hit),
    viewport: boundingBoxToViewport(hit?.boundingbox),
  };
}

/**
 * Keyless forward-geocoding proxy. Mounted at `/api/geocode` by the shared
 * `server/routes.js` manifest, so dev (vite.config.js) and prod
 * (server/index.js) get it from one registration.
 *
 * Query: `q` (required, the search text), `viewbox` (optional
 * `west,north,east,south` bias forwarded verbatim to Nominatim).
 *
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] override for the upstream fetch (tests)
 * @param {() => number} [deps.now] injectable clock (tests)
 * @param {(ms: number) => Promise<void>} [deps.sleep] injectable delay (tests)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => Promise<void>}
 */
export function createGeocodeRoute(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cache = namespace('geocode', { defaultTtlMs: TTL_MS, staleMs: Infinity, maxEntries: 5000 });

  // Serialises every upstream call so concurrent browser requests can never
  // burst past Nominatim's one-per-second ceiling. Mirrors the reverse-geocode
  // queue already used for the cockpit regional briefing.
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  function enqueue(task) {
    const run = queue.then(async () => {
      const wait = Math.max(0, MIN_REQUEST_SPACING_MS - (now() - lastRequestAt));
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      return task();
    });
    // Keep the chain alive after a rejection, or one failure stalls every
    // subsequent lookup for the life of the process.
    queue = run.catch(() => null);
    return run;
  }

  async function fetchUpstream(query, viewbox) {
    const url = new URL(`https://${UPSTREAM_HOST}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('addressdetails', '1');
    if (viewbox) {
      url.searchParams.set('viewbox', viewbox);
      // Bias, never restrict: a bounded search for a place outside the current
      // view must still succeed ("fly me to Tokyo" from over Berlin).
      url.searchParams.set('bounded', '0');
    }
    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await res.json();
    if (!Array.isArray(parsed)) throw new Error('malformed response');
    return parsed.map(normalizeHit).filter(Boolean);
  }

  return async function geocodeRoute(req, res) {
    const send = (status, payload, cacheStatus) => sendText(res, status, JSON.stringify(payload), {
      'Content-Type': 'application/json; charset=utf-8',
      'x-geocode-cache': cacheStatus,
    });

    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      const query = (requestUrl.searchParams.get('q') || '').trim();
      const viewbox = (requestUrl.searchParams.get('viewbox') || '').trim();
      if (!query) {
        send(400, { error: 'missing q' }, 'NONE');
        return;
      }
      if (query.length > 200) {
        send(400, { error: 'q too long' }, 'NONE');
        return;
      }

      // Viewbox participates in the key: the same text biased to a different
      // view is a genuinely different question ("Sixth Street" over Austin vs
      // over Los Angeles).
      const key = `${query.toLowerCase()}|${viewbox}`;
      const cached = await cache.get(key);
      if (cached && cached.expiresAt > now()) {
        send(200, { results: cached.value }, 'HIT');
        return;
      }

      let results;
      try {
        results = await enqueue(() => fetchUpstream(query, viewbox));
      } catch (err) {
        // Stale beats empty: a cached answer from beyond its TTL is still the
        // right place on the map.
        if (cached) {
          send(200, { results: cached.value }, 'STALE-ERROR');
          return;
        }
        console.warn(`[geocode-route] lookup failed (${err?.message || err})`);
        send(502, { error: 'geocode lookup failed' }, 'NONE');
        return;
      }

      await cache.set(key, results, TTL_MS);
      send(200, { results }, 'MISS');
    } catch (err) {
      console.warn('[geocode-route] unexpected error:', err?.message || err);
      send(500, { error: 'geocode proxy error' }, 'ERROR');
    }
  };
}
