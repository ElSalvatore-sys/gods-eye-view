import { createAiProvider } from '../lib/aiProvider.js';
import { readRequestBody, sendJson } from '../lib/http.js';
import { enforceOptInRateLimit, makeOptInRateLimiter } from '../lib/ratelimit.js';
import { keylessHudSummaryResponse } from '../../src/hudSummaryResponse.js';

/** Hard cap on the incoming HUD context body — it's a handful of short place/layer labels. */
const HUD_SUMMARY_BODY_MAX_BYTES = 64 * 1024;

const HUD_SUMMARY_INSTRUCTIONS = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'Do not infer from coordinates or invent a place.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

/** Clamp a provider completion down to the five bare words the HUD strip has room for. */
function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/**
 * `/api/openai/hud-summary` — a one-line intelligence-HUD summary from whatever
 * text provider is configured (`server/lib/aiProvider.js`): OpenAI by default,
 * or any OpenAI-compatible local endpoint when `AI_BASE_URL` is set. Moved out
 * of `vite.config.js`'s `openAiRealtimeProxy()` (docs/ARCH-SERVER-SPLIT.md §3
 * pattern) — OpenAI Realtime voice (`/api/realtime/token`) is untouched and
 * stays there.
 *
 * Mounted at `/api/openai/hud-summary` by both `vite.config.js` (dev +
 * preview) and `server/index.js` (prod) via the shared `server/routes.js`
 * manifest, matching `server/routes/celestrak.js`'s pattern.
 *
 * @param {object} [deps]
 * @param {ReturnType<typeof createAiProvider>} [deps.provider] override for the AI provider (tests)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void}
 */
export function createHudSummaryRoute(deps = {}) {
  // Built LAZILY on first request, NOT at module load: `server/routes.js`
  // constructs this route eagerly at import time — before Vite's config
  // factory calls loadEnv() to copy `.env` into process.env (same trap
  // vite.config.js documents for its own openAiRateLimiter()). Reading
  // AI_BASE_URL/AI_MODEL/OPENAI_API_KEY at module-load time would always see
  // them unset in `vite dev`/`vite preview`. `deps.provider` bypasses this
  // for tests, which construct it explicitly.
  let _provider = deps.provider || null;
  function provider() {
    if (!_provider) _provider = createAiProvider();
    return _provider;
  }

  // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN), built lazily once so
  // its per-IP window state persists across requests — same lazy-singleton
  // shape as vite.config.js's own openAiRateLimiter() for /api/realtime/token.
  // A separate instance: keyless HUD summaries (the common case) resolve
  // before either limiter is touched, and a self-hosted local provider has no
  // OpenAI cost to share a budget with.
  let _rateLimiter; // undefined = not built yet; null = unlimited; fn = active limiter
  function rateLimiter() {
    if (_rateLimiter === undefined) _rateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_OPENAI_PER_MIN);
    return _rateLimiter;
  }

  return async function hudSummaryRoute(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const ai = provider();

    // A local provider works unauthenticated, so "keyless" here means "no
    // provider configured at all" (ai.configured), not specifically a
    // missing OPENAI_API_KEY — keylessHudSummaryResponse only cares whether
    // its argument is a non-blank string either way.
    const keyless = keylessHudSummaryResponse(ai.configured ? 'configured' : '');
    if (keyless) {
      sendJson(res, keyless.statusCode, keyless.payload, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return;
    }

    // Opt-in per-IP throttle. Keyless HUD fallback above has no provider cost
    // and resolves before this can consume or exhaust quota.
    if (!enforceOptInRateLimit(rateLimiter(), req, res)) return;

    try {
      const body = await readRequestBody(req, HUD_SUMMARY_BODY_MAX_BYTES);
      const context = JSON.parse(body || '{}');
      const result = await ai.chat({
        system: HUD_SUMMARY_INSTRUCTIONS,
        user: JSON.stringify(context),
        maxTokens: 100,
      });
      const summary = result.ok ? toFiveWordHudSummary(result.text) : null;
      sendJson(res, result.ok && summary ? 200 : (result.status || 502), {
        summary: summary || null,
        error: result.ok ? null : (result.error || 'AI provider HUD summary request failed'),
      }, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } catch (error) {
      sendJson(res, 502, { error: error?.message || 'AI provider HUD summary request failed' });
    }
  };
}
