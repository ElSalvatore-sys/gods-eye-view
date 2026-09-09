/**
 * Standalone production server: mounts the same route handlers Vite mounts
 * in dev (`server/routes.js`), then serves the built `dist/` directory with
 * `sirv`. No Vite in this file or its import graph — `node server/index.js`
 * runs with zero dev dependencies (docs/ARCH-SERVER-SPLIT.md §3).
 *
 * @module server/index
 */

import http from 'node:http';
import sirv from 'sirv';
import { ROUTES } from './routes.js';
import { mount } from './lib/mount.js';

const port = parseInt(process.env.PORT, 10) || 3000;
const host = process.env.HOST || 'localhost';

const serveStatic = sirv('dist', { single: true });
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
