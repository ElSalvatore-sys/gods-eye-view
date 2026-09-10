import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readResponseTextCapped } from '../lib/http.js';
import { coalesceProxyRequest } from '../lib/upstream.js';

/** @module server/routes/launches */

export const LL2_CACHE_TTL_MS = 15 * 60_000;

/** Build LL2 request headers without exposing its optional token client-side. */
export function launchLibraryRequestHeaders(token = process.env.LL2_API_TOKEN) {
  const normalized = String(token || '').trim();
  return {
    Accept: 'application/json',
    ...(normalized ? { Authorization: `Token ${normalized}` } : {}),
  };
}

/**
 * Proxy the public Launch Library 2 recent-launch feed server-side.
 *
 * Mounted at `/api/launches` by both `vite.config.js` (dev + preview) and
 * `server/index.js` (prod) via the shared `server/routes.js` manifest.
 * Moved verbatim from `vite.config.js` (docs/ARCH-SERVER-SPLIT.md §4 PR 3).
 *
 * @param {object} [deps]
 * @param {string} [deps.cacheDir] override for the on-disk cache directory (tests)
 * @param {typeof fetch} [deps.fetchImpl] override for the upstream fetch (tests)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void}
 */
export function createLaunchesRoute(deps = {}) {
  const cacheDir = deps.cacheDir || path.join(process.cwd(), '.gev-cache');
  const fetchImpl = deps.fetchImpl || fetch;
  const ttlMs = LL2_CACHE_TTL_MS;
  const maxResponseBytes = 12 * 1024 * 1024;
  const maxDiskCacheBytes = 24 * 1024 * 1024;
  const cachePath = path.join(cacheDir, 'launch-library-2-v2.3.json');
  let cache = null;
  let diskLoaded = false;
  const inFlight = new Map();

  async function loadDiskCache() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const stat = await fsp.stat(cachePath);
      if (stat.size > maxDiskCacheBytes) throw new Error('cache file too large');
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && typeof parsed?.body === 'string') {
        const body = JSON.parse(parsed.body);
        if (Array.isArray(body?.results)) cache = parsed;
      }
    } catch { /* first run or invalid cache */ }
  }

  async function saveDiskCache(entry) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.warn(`[launch-library-proxy] cache write failed: ${error?.message || error}`);
    }
  }

  function send(res, status, body, cacheState) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': status === 200 ? 'public, max-age=900' : 'no-store',
      'X-GEV-Cache': cacheState,
    });
    res.end(body);
  }

  async function refreshUpstream() {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.searchParams.set('net__gte', start.toISOString());
    url.searchParams.set('net__lte', end.toISOString());
    url.searchParams.set('limit', '100');
    url.searchParams.set('mode', 'detailed');
    const upstream = await fetchImpl(url, {
      signal: AbortSignal.timeout(20000),
      headers: launchLibraryRequestHeaders(),
    });
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    if (!upstream.ok) {
      /** @type {Error & {upstreamStatus?: number, upstreamBody?: string}} */
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      error.upstreamBody = body;
      throw error;
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results)) throw new Error('malformed upstream response');
    const fresh = { at: Date.now(), body };
    cache = fresh;
    void saveDiskCache(fresh);
    return fresh;
  }

  return async function launchesRoute(req, res) {
    if (req.method !== 'GET') {
      send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
      return;
    }
    await loadDiskCache();
    const now = Date.now();
    if (cache && now - cache.at < ttlMs) {
      send(res, 200, cache.body, 'HIT');
      return;
    }
    const stale = cache;
    const request = coalesceProxyRequest(inFlight, 'recent-launches', refreshUpstream);
    try {
      const fresh = await request.promise;
      send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
    } catch (error) {
      if (stale) {
        if (!request.shared) console.warn(`[launch-library-proxy] refresh failed (${error?.message || error}) — serving stale cache`);
        send(res, 200, stale.body, 'STALE-ERROR');
        return;
      }
      send(
        res,
        Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : 502,
        error?.upstreamBody || JSON.stringify({ error: 'Launch Library 2 unavailable' }),
        'NONE',
      );
    }
  };
}
