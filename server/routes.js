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
import { createLaunchesRoute } from './routes/launches.js';
import { createFirmsRoute } from './routes/firms.js';
import { createTomtomRoute } from './routes/tomtom.js';
import { createAdsbdbRoute } from './routes/adsbdb.js';
import { createTerrainRoute } from './routes/terrain.js';
import { createOverpassRoute, createOsrmRoutingRoute } from './routes/overpass.js';
import { createMilitaryInstallationsRoute } from './routes/military.js';
import { createGeocodeRoute } from './routes/geocode.js';
import { createRealtimeTokenRoute, createRealtimeDebugLogRoute } from './routes/realtime.js';

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
  { mount: '/api/launches', handler: createLaunchesRoute() },
  { mount: '/api/firms', handler: createFirmsRoute() },
  { mount: '/api/tomtom', handler: createTomtomRoute() },
  { mount: '/api/adsbdb', handler: createAdsbdbRoute() },
  { mount: '/api/terrain/heights', handler: createTerrainRoute() },
  { mount: '/api/overpass', handler: createOverpassRoute() },
  { mount: '/api/route', handler: createOsrmRoutingRoute() },
  { mount: '/api/military-installations', handler: createMilitaryInstallationsRoute() },
  { mount: '/api/geocode', handler: createGeocodeRoute() },
  // Voice. Previously dev-only inside vite.config.js, which left a deployed
  // build with no agent at all — see server/routes/realtime.js.
  { mount: '/api/realtime/token', handler: createRealtimeTokenRoute() },
  { mount: '/api/realtime/debug-log', handler: createRealtimeDebugLogRoute() },
];
