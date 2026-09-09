/**
 * The single manifest of API route mounts, consumed by both `vite.config.js`
 * (dev + preview) and `server/index.js` (prod) — see
 * docs/ARCH-SERVER-SPLIT.md §3. Adding a route means adding one entry here;
 * no separate dev/prod mount calls to keep in sync.
 *
 * @module server/routes
 */

import { createCelestrakRoute } from './routes/celestrak.js';
import { createHudSummaryRoute } from './routes/hudSummary.js';
import { createAiStatusRoute } from './routes/aiStatus.js';
import { createRainviewerRoute } from './routes/rainviewer.js';

/**
 * @typedef {object} RouteEntry
 * @property {string} mount the URL prefix, e.g. `/api/celestrak`
 * @property {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void} handler
 */

/** @type {RouteEntry[]} */
export const ROUTES = [
  { mount: '/api/celestrak', handler: createCelestrakRoute() },
  { mount: '/api/openai/hud-summary', handler: createHudSummaryRoute() },
  { mount: '/api/ai/status', handler: createAiStatusRoute() },
  { mount: '/api/rainviewer', handler: createRainviewerRoute() },
];
