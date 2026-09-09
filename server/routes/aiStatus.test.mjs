import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiStatusRoute } from './aiStatus.js';

function fakeRes() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    writeHead(status, headerMap = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headerMap)) headers.set(String(name).toLowerCase(), String(value));
    },
    end(body) { this.body = body ? JSON.parse(String(body)) : null; },
    get headersMap() { return Object.fromEntries(headers); },
  };
}

const fakeReq = (method = 'GET') => ({ method, url: '/', socket: { remoteAddress: '127.0.0.1' } });

test('non-GET is rejected with 405', async () => {
  const route = createAiStatusRoute({ provider: { configured: true, kind: 'local', probe: async () => true } });
  const res = fakeRes();
  await route(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});

test('reports provider "none" and healthy:false when unconfigured, without leaking model/host', async () => {
  const route = createAiStatusRoute({
    provider: { configured: false, kind: 'openai', model: 'gpt-5-nano', baseUrlHost: 'api.openai.com', probe: async () => false },
  });
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'none');
  assert.equal(res.body.healthy, false);
  // Unconfigured means no request would ever be made — the resolved
  // OpenAI defaults are not echoed back as if they were active.
  assert.equal(res.body.model, null);
  assert.equal(res.body.baseUrlHost, null);
  assert.equal(res.headersMap['cache-control'], 'no-store');
});

test('reports the local provider, model, host, and healthy from probe()', async () => {
  const route = createAiStatusRoute({
    provider: {
      configured: true,
      kind: 'local',
      model: 'mlx-community/Qwen3-30B-A3B-4bit',
      baseUrlHost: 'oasiss-mac-studio:4000',
      probe: async () => true,
    },
  });
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.deepEqual(res.body, {
    provider: 'local',
    model: 'mlx-community/Qwen3-30B-A3B-4bit',
    baseUrlHost: 'oasiss-mac-studio:4000',
    healthy: true,
  });
});

test('reports openai as configured when an API key is present', async () => {
  const route = createAiStatusRoute({
    provider: { configured: true, kind: 'openai', model: 'gpt-5-nano', baseUrlHost: 'api.openai.com', probe: async () => true },
  });
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.equal(res.body.provider, 'openai');
  assert.equal(res.body.healthy, true);
});
