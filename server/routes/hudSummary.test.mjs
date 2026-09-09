import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHudSummaryRoute } from './hudSummary.js';
import { HUD_SUMMARY_UNCONFIGURED_CODE } from '../../src/hudSummaryResponse.js';

/** Minimal http.ServerResponse double matching server/lib/http.js's sendJson contract. */
function fakeRes() {
  const headers = new Map();
  return {
    statusCode: null,
    headersSent: false,
    body: null,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    writeHead(status, headerMap = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headerMap)) headers.set(String(name).toLowerCase(), String(value));
    },
    end(body) { this.body = body ? JSON.parse(String(body)) : null; },
    get headersMap() { return Object.fromEntries(headers); },
  };
}

function fakeReq({ method = 'POST', body = '{}' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    // readRequestBody (server/lib/http.js) consumes the request as an EventEmitter.
    on(event, handler) {
      if (event === 'data') for (const chunk of chunks) handler(chunk);
      if (event === 'end') handler();
      return this;
    },
  };
}

test('non-POST is rejected with 405, never touching the provider', async () => {
  let called = false;
  const route = createHudSummaryRoute({ provider: { configured: true, chat: async () => { called = true; } } });
  const res = fakeRes();
  await route(fakeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(called, false);
});

test('an unconfigured provider returns the keyless capability response, never calling chat()', async () => {
  let called = false;
  const route = createHudSummaryRoute({
    provider: { configured: false, chat: async () => { called = true; } },
  });
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    configured: false,
    code: HUD_SUMMARY_UNCONFIGURED_CODE,
    error: null,
    summary: null,
  });
  assert.equal(res.headersMap['cache-control'], 'no-store');
  assert.equal(called, false);
});

test('a configured provider gets called with the HUD instructions and the request body as context', async () => {
  let seen = null;
  const route = createHudSummaryRoute({
    provider: {
      configured: true,
      chat: async (params) => {
        seen = params;
        return { ok: true, text: 'downtown austin flights airport nearby traffic', error: null, status: 200 };
      },
    },
  });
  const res = fakeRes();
  await route(fakeReq({ body: JSON.stringify({ place: 'Austin' }) }), res);
  assert.equal(res.statusCode, 200);
  // Clamped to exactly five words.
  assert.deepEqual(res.body, { summary: 'downtown austin flights airport nearby', error: null });
  assert.match(seen.system, /five words/);
  assert.equal(seen.user, JSON.stringify({ place: 'Austin' }));
});

test('a failed provider call surfaces its status and error, with a null summary', async () => {
  const route = createHudSummaryRoute({
    provider: {
      configured: true,
      chat: async () => ({ ok: false, text: null, error: 'AI provider request failed', status: 502 }),
    },
  });
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { summary: null, error: 'AI provider request failed' });
});

test('a malformed JSON body is reported as a 502 rather than throwing out of the route', async () => {
  const route = createHudSummaryRoute({ provider: { configured: true, chat: async () => ({ ok: true, text: 'x', status: 200 }) } });
  const res = fakeRes();
  await route(fakeReq({ body: '{not json' }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(typeof res.body.error, 'string');
});
