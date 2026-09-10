/**
 * Standalone production server: mounts the same route handlers Vite mounts
 * in dev (`server/routes.js`), then serves the built `dist/` directory with
 * `sirv`. No Vite in this file or its import graph — `node server/index.js`
 * runs with zero dev dependencies (docs/ARCH-SERVER-SPLIT.md §3).
 *
 * @module server/index
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { ROUTES } from './routes.js';
import { mount } from './lib/mount.js';

/**
 * Load dotenv files before anything reads `process.env`.
 *
 * Vite calls `loadEnv()` for us in dev, so every key in `.env` was visible
 * under `npm run dev` and invisible under `node server/index.js`. That made
 * production quietly keyless: no voice token, no FIRMS, no AISStream, no
 * OpenSky — each one degrading to its "not configured" path with nothing in
 * the logs to explain why.
 *
 * `process.loadEnvFile` is a Node built-in (>=20.12), so this costs no
 * dependency — `server/index.js` still runs with zero dev dependencies
 * (docs/ARCH-SERVER-SPLIT.md §3). It does not overwrite variables already
 * present in the real environment, so a value exported by the shell or set by
 * the host platform still wins over the file — which is what a deployment
 * expects.
 *
 * Both files are optional: a container that injects real environment
 * variables and ships no `.env` is the normal production case, not an error.
 */
function loadDotenvFiles() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // `.env.local` last, so it wins over `.env` — matching Vite's precedence.
  for (const name of ['.env', '.env.local']) {
    try {
      process.loadEnvFile(path.join(root, name));
    } catch {
      // Absent or unreadable: expected, and not worth a warning.
    }
  }
}

loadDotenvFiles();

const port = parseInt(process.env.PORT, 10) || 3000;
const host = process.env.HOST || 'localhost';

/** A year, in seconds — the conventional ceiling for `max-age`. */
const ONE_YEAR_SECONDS = 31536000;

/**
 * Vite emits content-addressed filenames (`index-2pKbU9f6.js`), so those bytes
 * can never change under a given URL and are safe to cache forever. Cesium's
 * engine assets are copied verbatim by `vite-plugin-cesium` and are NOT hashed,
 * so they get revalidation instead — a 304 on a 5.7 MB file still costs one
 * round trip, but never a re-download.
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

const serveStatic = sirv('dist', {
  single: true,
  // Serve the `.br`/`.gz` siblings written by `scripts/precompress.mjs`. sirv
  // does not compress on the fly; without those siblings this is a no-op and
  // every asset goes out raw, which is what shipped before.
  brotli: true,
  gzip: true,
  etag: true,
  setHeaders(res, pathname) {
    // Set on `res` rather than via sirv's `maxAge` option, because `maxAge`
    // applies one policy to every file and `cesium/` is not content-addressed.
    // sirv's `send()` prefers headers already present on `res`.
    res.setHeader(
      'Cache-Control',
      HASHED_ASSET.test(pathname)
        ? `public,max-age=${ONE_YEAR_SECONDS},immutable`
        : 'no-cache',
    );
  },
});
const stack = [...ROUTES.map((r) => mount(r.mount, r.handler)), serveStatic];

/** Run `stack` in order, Connect-style: each layer's `next` advances to the following one. */
function handleRequest(req, res) {
  let index = 0;
  const next = (err) => {
    if (err) {
      console.error('[server]', err?.stack || err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }
    const layer = stack[index++];
    if (!layer) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
      return;
    }
    layer(req, res, next);
  };
  next();
}

const server = http.createServer(handleRequest);
server.listen(port, host, () => {
  console.log(`[server] listening on http://${host}:${port}`);
});
