import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendText } from '../lib/http.js';

const CACHE_TTL_MS = 5 * 60_000;
const UPSTREAM_URL = 'https://api.rainviewer.com/public/weather-maps.json';
/**
 * RainViewer serves the frame-list JSON from `api.rainviewer.com` and the
 * radar tile images themselves from `tilecache.rainviewer.com` (the `host`
 * field this route returns points there). Only the JSON is fetched
 * server-side — tiles are CORS-enabled and load directly in the browser via
 * `UrlTemplateImageryProvider` (src/data/weatherRadar.js) — but both hosts
 * are allowlisted here so any future upstream URL this route builds (e.g. a
 * `host` value RainViewer returns) is verified against the same list rather
 * than trusted implicitly.
 */
const ALLOWED_HOSTS = new Set(['api.rainviewer.com', 'tilecache.rainviewer.com']);

/**
 * RainViewer weather-radar frame-list proxy with a memory + disk cache.
 * Upstream: https://api.rainviewer.com/public/weather-maps.json — a keyless,
 * public endpoint. RainViewer publishes a fresh frame roughly every 10 min,
 * so a 5 min TTL keeps clients comfortably inside that cadence without every
 * dev reload or open tab re-fetching. Pattern mirrors celestrakProxy's
 * memory+disk cache with serve-stale-on-failure (a stale frame list beats an
 * empty radar layer).
 *
 * Mounted at `/api/rainviewer` by both `vite.config.js` (dev + preview) and
 * `server/index.js` (prod) via the shared `server/routes.js` manifest. This
 * route takes no sub-path — `req.url` (rewritten by `server/lib/mount.js`)
 * is ignored beyond routing.
 *
 * @param {object} [deps]
 * @param {string} [deps.cacheDir] override for the on-disk cache directory (tests)
 * @param {typeof fetch} [deps.fetchImpl] override for the upstream fetch (tests)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void}
 */
export function createRainviewerRoute(deps = {}) {
  const cacheDir = deps.cacheDir || path.join(process.cwd(), '.gev-cache');
  const fetchImpl = deps.fetchImpl || fetch;
  let mem = null; // { at: epochMs, body: string } | null
  let inflight = null; // Promise<{at, body}|null> | null

  const diskPath = path.join(cacheDir, 'rainviewer.json');

  async function readDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath, 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at)) return parsed;
    } catch { /* no disk cache yet */ }
    return null;
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(diskPath, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[rainviewer-route] cache write failed:', err?.message || err);
    }
  }

  async function fetchUpstream() {
    const url = new URL(UPSTREAM_URL);
    if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error('upstream host not allowlisted');
    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'gods-eye-view-rainviewer-proxy/1.0 (+https://github.com/ElSalvatore-sys/gods-eye-view)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('malformed JSON from upstream');
    }
    // An upstream error page or maintenance response parses fine but carries
    // no radar block — treat as failure, keep serving cache.
    if (!parsed || typeof parsed !== 'object' || !parsed.radar) {
      throw new Error('no radar block in response');
    }
    return { at: Date.now(), body };
  }

  return async function rainviewerRoute(req, res) {
    const send = (status, body, cacheStatus) => sendText(res, status, body, {
      'Content-Type': 'application/json',
      'x-rainviewer-cache': cacheStatus,
    });
    try {
      const now = Date.now();
      let entry = mem;
      if (!entry) {
        entry = await readDisk();
        if (entry) mem = entry;
      }
      if (entry && now - entry.at < CACHE_TTL_MS) {
        send(200, entry.body, 'HIT');
        return;
      }
      // Stale or missing → refresh, single-flight.
      if (!inflight) {
        inflight = fetchUpstream()
          .then(async (fresh) => {
            mem = fresh;
            await writeDisk(fresh);
            return fresh;
          })
          .catch((err) => {
            console.warn(`[rainviewer-route] refresh failed (${err?.message || err}) — serving cache if any`);
            return null;
          })
          .finally(() => { inflight = null; });
      }
      const fresh = await inflight;
      if (fresh) {
        send(200, fresh.body, 'MISS');
      } else if (entry) {
        send(200, entry.body, 'STALE-ERROR'); // upstream down — stale beats empty
      } else {
        send(502, JSON.stringify({ error: 'rainviewer fetch failed and no cache available' }), 'NONE');
      }
    } catch (err) {
      send(500, JSON.stringify({ error: 'rainviewer proxy error' }), 'ERROR');
      console.warn('[rainviewer-route] unexpected error:', err?.message || err);
    }
  };
}
