import { createAiProvider } from '../lib/aiProvider.js';
import { sendJson } from '../lib/http.js';

/**
 * `/api/ai/status` — keyless, read-only status for the non-voice AI provider
 * (`server/lib/aiProvider.js`). Never returns a secret: `baseUrlHost` is a
 * hostname only (no path, query, or key), and no key material is echoed back
 * at all. Lets the POWER UP / Provider Settings panel (`src/keySetup.js`)
 * show what's actually active without guessing from saved env var presence.
 *
 * Mounted at `/api/ai/status` by both `vite.config.js` (dev + preview) and
 * `server/index.js` (prod) via the shared `server/routes.js` manifest,
 * matching `server/routes/celestrak.js`'s pattern.
 *
 * @param {object} [deps]
 * @param {ReturnType<typeof createAiProvider>} [deps.provider] override for the AI provider (tests)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void}
 */
export function createAiStatusRoute(deps = {}) {
  // Built LAZILY on first request, NOT at module load — same reason as
  // server/routes/hudSummary.js: `server/routes.js` constructs this route at
  // import time, before Vite's config factory calls loadEnv() to copy `.env`
  // into process.env.
  let _provider = deps.provider || null;
  function provider() {
    if (!_provider) _provider = createAiProvider();
    return _provider;
  }

  return async function aiStatusRoute(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const ai = provider();
    const healthy = await ai.probe();
    sendJson(res, 200, {
      provider: ai.configured ? ai.kind : 'none',
      // Null out the resolved defaults when nothing is actually configured —
      // otherwise an unconfigured status would still show "api.openai.com",
      // implying a request that never happens.
      model: ai.configured ? (ai.model || null) : null,
      baseUrlHost: ai.configured ? (ai.baseUrlHost || null) : null,
      healthy,
    }, { 'Cache-Control': 'no-store' });
  };
}
