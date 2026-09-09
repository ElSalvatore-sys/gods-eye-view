/**
 * Pluggable OpenAI-compatible provider for every NON-voice model call (HUD
 * summaries today; any future text/analysis call). OpenAI Realtime voice
 * (`/api/realtime/token`) is untouched by this module and stays hardcoded to
 * OpenAI — this only covers plain request/response chat calls.
 *
 * Routing: `AI_BASE_URL` set → a local OpenAI-compatible `chat/completions`
 * server (LiteLLM in front of MLX, Ollama, vLLM, …); unset → OpenAI's
 * `responses` API, matching the owner's existing OpenAI usage elsewhere in
 * this repo. `AI_API_KEY` is optional for the local path (most local servers
 * are unauthenticated); `OPENAI_API_KEY` is required for the OpenAI path.
 *
 * @module server/lib/aiProvider
 */

/** Fallback base URL when `AI_BASE_URL` is unset. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Fallback OpenAI model when neither `AI_MODEL` nor `OPENAI_HUD_SUMMARY_MODEL` is set. */
export const OPENAI_MODEL_DEFAULT = 'gpt-5-nano';

/** Hard cap on a single chat call, generous for a short HUD-style completion. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Hard cap on a health probe — status pages should never hang on a dead endpoint. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * @typedef {object} AiChatParams
 * @property {string} [system] system/instructions text
 * @property {string} [user] user/input text — required at runtime; a missing/blank
 *   value fails fast with a 400 result rather than sending an empty prompt upstream
 * @property {number} [maxTokens] output token cap (default 400)
 * @property {boolean} [json] ask the backend for JSON-only output, where supported
 * @property {string} [model] override the provider's configured model for this one call
 *
 * @typedef {object} AiChatResult
 * @property {boolean} ok true only when the call succeeded and returned non-empty text
 * @property {string|null} text the completion text, or null on failure
 * @property {string|null} error a sanitized, client-safe error message, or null on success
 * @property {number} status a normalized HTTP-shaped status (200 on success)
 *
 * @typedef {object} AiProvider
 * @property {'openai'|'local'} kind which API shape this instance speaks
 * @property {boolean} configured whether a call would actually be attempted (vs. short-circuited)
 * @property {string} baseUrl the resolved API base URL
 * @property {string} baseUrlHost hostname only — safe to expose on a status page
 * @property {string} model the resolved default model
 * @property {(params: AiChatParams) => Promise<AiChatResult>} chat
 * @property {() => Promise<boolean>} probe GET `${baseUrl}/models`; resolves false on any failure
 */

/** Strip anything that could carry a credential (Bearer tokens, key= query strings) out of an upstream error string. */
function sanitizeErrorMessage(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:^|[?&\s])(?:key|api[_-]?key|token)=)\S+/gi, '$1[redacted]')
    .slice(0, 500);
}

/** Pull the plain text out of an OpenAI Responses API payload. */
function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

/** Pull the plain text out of a `chat/completions` payload. */
function extractChatCompletionText(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * Build an OpenAI-compatible chat provider from environment configuration.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] override for the upstream fetch (tests)
 * @returns {AiProvider}
 */
export function createAiProvider(env = process.env, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const rawBaseUrl = String(env.AI_BASE_URL || '').trim();
  const kind = rawBaseUrl ? 'local' : 'openai';
  const baseUrl = kind === 'local' ? rawBaseUrl.replace(/\/+$/, '') : OPENAI_BASE_URL;
  const apiKey = kind === 'local'
    ? String(env.AI_API_KEY || '').trim()
    : String(env.OPENAI_API_KEY || '').trim();
  const model = String(env.AI_MODEL || '').trim()
    || (kind === 'openai' ? (String(env.OPENAI_HUD_SUMMARY_MODEL || '').trim() || OPENAI_MODEL_DEFAULT) : '');
  // Local providers work unauthenticated (most self-hosted OpenAI-compatible
  // servers do); OpenAI always requires a key.
  const configured = kind === 'local' || Boolean(apiKey);

  let baseUrlHost = '';
  try {
    baseUrlHost = new URL(baseUrl).host;
  } catch {
    baseUrlHost = '';
  }

  /** @type {AiProvider['chat']} */
  async function chat({ system, user, maxTokens = 400, json = false, model: modelOverride } = {}) {
    if (!configured) {
      return { ok: false, text: null, error: 'AI provider not configured', status: 503 };
    }
    if (!String(user || '').trim()) {
      return { ok: false, text: null, error: 'AI provider chat() requires a user prompt', status: 400 };
    }
    const useModel = String(modelOverride || model || '').trim();
    if (!useModel) {
      return { ok: false, text: null, error: 'AI provider has no model configured', status: 503 };
    }

    try {
      const response = kind === 'local'
        ? await chatLocal({ fetchImpl, baseUrl, apiKey, model: useModel, system, user, maxTokens, json })
        : await chatOpenAi({ fetchImpl, baseUrl, apiKey, model: useModel, system, user, maxTokens, json });
      const text = kind === 'local'
        ? extractChatCompletionText(response.data)
        : extractOpenAiResponseText(response.data);
      const ok = response.res.ok && Boolean(text);
      return {
        ok,
        text: ok ? text : null,
        error: ok ? null : sanitizeErrorMessage(
          response.data?.error?.message || `AI provider request failed (${response.res.status})`
        ),
        status: ok ? 200 : (response.res.status || 502),
      };
    } catch (error) {
      return {
        ok: false,
        text: null,
        error: sanitizeErrorMessage(error?.message) || 'AI provider request failed',
        status: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502,
      };
    }
  }

  /** @type {AiProvider['probe']} */
  async function probe() {
    if (!configured) return false;
    try {
      const response = await fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  }

  return { kind, configured, baseUrl, baseUrlHost, model, chat, probe };
}

/** POST `${baseUrl}/chat/completions` — the shape every local OpenAI-compatible server speaks. */
async function chatLocal({ fetchImpl, baseUrl, apiKey, model, system, user, maxTokens, json }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const body = { model, messages, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/** POST `${baseUrl}/responses` — OpenAI's Responses API, matching this repo's existing OpenAI usage. */
async function chatOpenAi({ fetchImpl, baseUrl, apiKey, model, system, user, maxTokens, json }) {
  const body = {
    model,
    input: user,
    max_output_tokens: maxTokens,
    // Matches the prior hud-summary request exactly: reasoning-capable models
    // (the gpt-5 family, the default here) default to a much slower/costlier
    // effort otherwise.
    reasoning: { effort: 'minimal' },
  };
  if (system) body.instructions = system;
  if (json) body.text = { format: { type: 'json_object' } };
  const res = await fetchImpl(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}
