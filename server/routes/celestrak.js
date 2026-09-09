import { sendText } from '../lib/http.js';
import { namespace } from '../lib/cache.js';

const TLE_TTL_MS = 6 * 3600_000;

/**
 * CelesTrak GP/TLE proxy backed by the shared cache namespace (§5) and
 * serve-stale-on-failure. Upstream:
 * https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h, `staleMs: Infinity` — on upstream failure the freshest stale copy is
 * served (a stale TLE beats an empty satellites layer), matching the
 * `celestrak` row in §5's namespace table. Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 *
 * Mounted at `/api/celestrak` by both `vite.config.js` (dev + preview) and
 * `server/index.js` (prod) via the shared `server/routes.js` manifest —
 * `req.url` here is already the sub-path (e.g. `/stations`), rewritten by
 * `server/lib/mount.js`.
 *
 * @param {object} [deps]
 * @param {import('../lib/cache.js').CacheNamespace} [deps.cache] override cache namespace (tests)
 * @param {typeof fetch} [deps.fetchImpl] override for the upstream fetch (tests)
 * @param {number} [deps.ttlMs] override the 6 h TTL (tests / serve-stale evidence gathering)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void}
 */
export function createCelestrakRoute(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const ttlMs = deps.ttlMs || TLE_TTL_MS;
  const cache = deps.cache || namespace('celestrak', { defaultTtlMs: ttlMs, staleMs: Infinity });
  const inflight = new Map(); // group -> Promise<{at, body}|null>

  async function fetchUpstream(group) {
    const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
    url.searchParams.set('GROUP', group);
    url.searchParams.set('FORMAT', 'tle');
    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(20000),
      // CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
      // descriptive User-Agent with a contact point.
      headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    // An upstream error page parses to zero TLEs — treat as failure, keep cache.
    if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
    return body;
  }

  return async function celestrakRoute(req, res) {
    const group = String(req.url || '').replace(/^\//, '').split('?')[0];
    if (!/^[a-z0-9-]+$/i.test(group)) {
      sendText(res, 400, 'invalid group');
      return;
    }
    const send = (status, body, cacheStatus) => sendText(res, status, body, { 'x-tle-cache': cacheStatus });
    try {
      const now = Date.now();
      // §5 serve-stale contract: get() returns the entry whether or not it's
      // expired — freshness is read off expiresAt here, not filtered by the cache.
      const cached = await cache.get(group);
      if (cached && now < cached.expiresAt) {
        send(200, cached.value, 'HIT');
        return;
      }
      // Stale or missing → refresh, single-flight per group.
      if (!inflight.has(group)) {
        inflight.set(group, fetchUpstream(group)
          .then(async (body) => {
            await cache.set(group, body, ttlMs);
            return body;
          })
          .catch((err) => {
            console.warn(`[celestrak-route] ${group} refresh failed (${err?.message || err}) — serving cache if any`);
            return null;
          })
          .finally(() => inflight.delete(group)));
      }
      const fresh = await inflight.get(group);
      if (fresh) {
        send(200, fresh, 'MISS');
      } else if (cached) {
        send(200, cached.value, 'STALE-ERROR'); // upstream down — stale beats empty
      } else {
        send(502, 'celestrak fetch failed and no cache available', 'NONE');
      }
    } catch (err) {
      send(500, `celestrak proxy error: ${err?.message || err}`, 'ERROR');
    }
  };
}
