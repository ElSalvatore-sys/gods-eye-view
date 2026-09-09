import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendText } from '../lib/http.js';

const TLE_TTL_MS = 6 * 3600_000;

/**
 * CelesTrak GP/TLE proxy with a memory + disk cache and serve-stale-on-failure.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE
 * beats an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 *
 * Mounted at `/api/celestrak` by both `vite.config.js` (dev + preview) and
 * `server/index.js` (prod) via the shared `server/routes.js` manifest —
 * `req.url` here is already the sub-path (e.g. `/stations`), rewritten by
 * `server/lib/mount.js`.
 *
 * @param {object} [deps]
 * @param {string} [deps.cacheDir] override for the on-disk cache directory (tests)
 * @param {typeof fetch} [deps.fetchImpl] override for the upstream fetch (tests)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void}
 */
export function createCelestrakRoute(deps = {}) {
  const cacheDir = deps.cacheDir || path.join(process.cwd(), '.gev-cache');
  const fetchImpl = deps.fetchImpl || fetch;
  const mem = new Map(); // group -> { at: epochMs, body: string }
  const inflight = new Map(); // group -> Promise<{at, body}|null>

  const diskPath = (group) => path.join(cacheDir, `celestrak-${group}.json`);

  async function readDisk(group) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at)) return parsed;
    } catch { /* no disk cache yet */ }
    return null;
  }

  async function writeDisk(group, entry) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn(`[celestrak-route] cache write failed for ${group}:`, err?.message || err);
    }
  }

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
    return { at: Date.now(), body };
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
      let entry = mem.get(group);
      if (!entry) {
        entry = await readDisk(group);
        if (entry) mem.set(group, entry);
      }
      if (entry && now - entry.at < TLE_TTL_MS) {
        send(200, entry.body, 'HIT');
        return;
      }
      // Stale or missing → refresh, single-flight per group.
      if (!inflight.has(group)) {
        inflight.set(group, fetchUpstream(group)
          .then(async (fresh) => {
            mem.set(group, fresh);
            await writeDisk(group, fresh);
            return fresh;
          })
          .catch((err) => {
            console.warn(`[celestrak-route] ${group} refresh failed (${err?.message || err}) — serving cache if any`);
            return null;
          })
          .finally(() => inflight.delete(group)));
      }
      const fresh = await inflight.get(group);
      if (fresh) {
        send(200, fresh.body, 'MISS');
      } else if (entry) {
        send(200, entry.body, 'STALE-ERROR'); // upstream down — stale beats empty
      } else {
        send(502, 'celestrak fetch failed and no cache available', 'NONE');
      }
    } catch (err) {
      send(500, `celestrak proxy error: ${err?.message || err}`, 'ERROR');
    }
  };
}
