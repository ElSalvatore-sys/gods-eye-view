import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiProvider, OPENAI_BASE_URL, OPENAI_MODEL_DEFAULT } from './aiProvider.js';

/** Build a fetchImpl that returns a canned JSON response and records every call. */
function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('createAiProvider routes to OpenAI (Responses API) when AI_BASE_URL is unset', () => {
  const provider = createAiProvider({ OPENAI_API_KEY: 'sk-test' }, { fetchImpl: fakeFetch(() => jsonResponse(200, {})) });
  assert.equal(provider.kind, 'openai');
  assert.equal(provider.baseUrl, OPENAI_BASE_URL);
  assert.equal(provider.model, OPENAI_MODEL_DEFAULT);
  assert.equal(provider.configured, true);
});

test('createAiProvider routes to the local base URL when AI_BASE_URL is set', () => {
  const provider = createAiProvider({
    AI_BASE_URL: 'http://oasiss-mac-studio:4000/v1/',
    AI_MODEL: 'mlx-community/Qwen3-30B-A3B-4bit',
  }, { fetchImpl: fakeFetch(() => jsonResponse(200, {})) });
  assert.equal(provider.kind, 'local');
  // Trailing slash stripped so `${baseUrl}/chat/completions` never double-slashes.
  assert.equal(provider.baseUrl, 'http://oasiss-mac-studio:4000/v1');
  assert.equal(provider.baseUrlHost, 'oasiss-mac-studio:4000');
  assert.equal(provider.model, 'mlx-community/Qwen3-30B-A3B-4bit');
  // No AI_API_KEY given — a local provider is still considered configured.
  assert.equal(provider.configured, true);
});

test('OpenAI provider is unconfigured without an API key, and chat() short-circuits', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, {}));
  const provider = createAiProvider({}, { fetchImpl });
  assert.equal(provider.configured, false);
  const result = await provider.chat({ user: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.error, /not configured/i);
  assert.equal(fetchImpl.calls.length, 0); // never reaches the network
});

test('AI_MODEL overrides OPENAI_HUD_SUMMARY_MODEL, which overrides the hardcoded default', () => {
  assert.equal(createAiProvider({ OPENAI_API_KEY: 'k' }, {}).model, OPENAI_MODEL_DEFAULT);
  assert.equal(
    createAiProvider({ OPENAI_API_KEY: 'k', OPENAI_HUD_SUMMARY_MODEL: 'gpt-5-mini' }, {}).model,
    'gpt-5-mini'
  );
  assert.equal(
    createAiProvider({ OPENAI_API_KEY: 'k', OPENAI_HUD_SUMMARY_MODEL: 'gpt-5-mini', AI_MODEL: 'gpt-5-nano-2' }, {}).model,
    'gpt-5-nano-2'
  );
});

test('local chat() posts chat/completions and extracts choices[0].message.content', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(url, 'http://localhost:4000/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'qwen3');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'summarize this' },
    ]);
    assert.equal(body.max_tokens, 123);
    assert.equal(init.headers.Authorization, undefined); // no AI_API_KEY set
    return jsonResponse(200, { choices: [{ message: { content: '  five words exactly here now  ' } }] });
  });
  const provider = createAiProvider({ AI_BASE_URL: 'http://localhost:4000/v1' }, { fetchImpl });
  const result = await provider.chat({ system: 'be terse', user: 'summarize this', maxTokens: 123, model: 'qwen3' });
  assert.deepEqual(result, { ok: true, text: 'five words exactly here now', error: null, status: 200 });
});

test('local chat() sends an Authorization header when AI_API_KEY is set', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer secret-local-key');
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
  });
  const provider = createAiProvider(
    { AI_BASE_URL: 'http://localhost:4000/v1', AI_API_KEY: 'secret-local-key', AI_MODEL: 'm' },
    { fetchImpl }
  );
  await provider.chat({ user: 'hi' });
});

test('local chat() sets response_format json_object when json:true is requested', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return jsonResponse(200, { choices: [{ message: { content: '{}' } }] });
  });
  const provider = createAiProvider({ AI_BASE_URL: 'http://localhost:4000/v1', AI_MODEL: 'm' }, { fetchImpl });
  await provider.chat({ user: 'hi', json: true });
});

test('openai chat() posts the Responses API shape and extracts output_text', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(url, `${OPENAI_BASE_URL}/responses`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-5-nano');
    assert.equal(body.instructions, 'be terse');
    assert.equal(body.input, 'summarize this');
    assert.equal(body.max_output_tokens, 100);
    assert.equal(init.headers.Authorization, 'Bearer sk-test');
    return jsonResponse(200, { output_text: 'five words here right now' });
  });
  const provider = createAiProvider({ OPENAI_API_KEY: 'sk-test' }, { fetchImpl });
  const result = await provider.chat({ system: 'be terse', user: 'summarize this', maxTokens: 100 });
  assert.deepEqual(result, { ok: true, text: 'five words here right now', error: null, status: 200 });
});

test('openai chat() falls back to parsing data.output[].content[].text', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, {
    output: [{ content: [{ text: 'from' }, { text: 'output array' }] }],
  }));
  const provider = createAiProvider({ OPENAI_API_KEY: 'sk-test' }, { fetchImpl });
  const result = await provider.chat({ user: 'hi' });
  assert.equal(result.text, 'from output array');
});

test('chat() reports a non-2xx upstream response as a sanitized failure, never throwing', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(500, { error: { message: 'upstream on fire' } }));
  const provider = createAiProvider({ OPENAI_API_KEY: 'sk-test' }, { fetchImpl });
  const result = await provider.chat({ user: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, 'upstream on fire');
  assert.equal(result.text, null);
});

test('chat() sanitizes an Authorization bearer token that leaks into an error message', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(401, {
    error: { message: 'invalid credentials: Bearer sk-live-abcdef123456' },
  }));
  const provider = createAiProvider({ OPENAI_API_KEY: 'sk-test' }, { fetchImpl });
  const result = await provider.chat({ user: 'hi' });
  assert.equal(result.error, 'invalid credentials: Bearer [redacted]');
  assert.doesNotMatch(result.error, /sk-live-abcdef123456/);
});

test('chat() sanitizes a fetch-level throw (e.g. network error) into a generic message', async () => {
  const fetchImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4000 key=sk-live-oops'); };
  const provider = createAiProvider({ AI_BASE_URL: 'http://localhost:4000/v1', AI_MODEL: 'm' }, { fetchImpl });
  const result = await provider.chat({ user: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.error, /sk-live-oops/);
});

test('probe() returns true only on a 2xx GET /models, false on failure or when unconfigured', async () => {
  const ok = createAiProvider(
    { AI_BASE_URL: 'http://localhost:4000/v1' },
    { fetchImpl: fakeFetch((url) => { assert.equal(url, 'http://localhost:4000/v1/models'); return jsonResponse(200, {}); }) }
  );
  assert.equal(await ok.probe(), true);

  const down = createAiProvider(
    { AI_BASE_URL: 'http://localhost:4000/v1' },
    { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }
  );
  assert.equal(await down.probe(), false);

  const unconfigured = createAiProvider({}, { fetchImpl: fakeFetch(() => jsonResponse(200, {})) });
  assert.equal(await unconfigured.probe(), false);
});
