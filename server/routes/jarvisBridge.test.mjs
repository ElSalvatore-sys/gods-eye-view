import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { GEV_PLAYBOOK_LINES, GEV_REALTIME_TOOLS } from './realtime.js';
import { createJarvisBridgeRoute } from './jarvisBridge.js';
import { JARVIS_EXTRA_TOOLS } from '../../src/voice/jarvisTools.js';

const TOKEN = 'test-token-0123456789';
const PAGE = { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:4173', host: 'localhost:4173' };

function req(method, url, { headers = {}, body } = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(r, { method, url, headers: { host: 'localhost:4173', ...headers } });
}

function res() {
  let finish;
  const out = {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    done: new Promise((r) => { finish = r; }),
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(s, h = {}) { this.statusCode = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; },
    end(b) { this.ended = true; this.body = b ? JSON.parse(String(b)) : undefined; finish(); },
  };
  return out;
}

/** Resolves when the response ends (a long poll ends later than the handler returns). */
async function hit(route, r) {
  const out = res();
  await route(r, out, () => { out.statusCode = 404; out.end(); });
  await out.done;
  return out;
}

test('the playbook moved unchanged (53 lines, same text)', () => {
  const hash = crypto.createHash('sha256').update(GEV_PLAYBOOK_LINES.join('\n')).digest('hex');
  assert.equal(GEV_PLAYBOOK_LINES.length, 53);
  assert.equal(hash, '691e4fcfd30156d9dd2f46f1af1b33b5b5d7d19a072168690c9a41e84f20bec2');
  assert.equal(GEV_REALTIME_TOOLS.length, 31);
});

test('no token configured: every Jarvis call is 503', async () => {
  const route = createJarvisBridgeRoute({ token: '' });
  const out = await hit(route, req('GET', '/tools', { headers: { 'x-jarvis-token': 'x' } }));
  assert.equal(out.statusCode, 503);
});

test('tools need the right token and list the 31 tools plus the Jarvis tools and the playbook', async () => {
  const route = createJarvisBridgeRoute({ token: TOKEN });
  assert.equal((await hit(route, req('GET', '/tools'))).statusCode, 401);
  assert.equal((await hit(route, req('GET', '/tools', { headers: { 'x-jarvis-token': 'wrong-token-0123456' } }))).statusCode, 401);
  const ok = await hit(route, req('GET', '/tools', { headers: { 'x-jarvis-token': TOKEN } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.tools.length, 31 + JARVIS_EXTRA_TOOLS.length);
  assert.ok(ok.body.tools.some((t) => t.name === 'first_person_nearest_aircraft'));
  assert.equal(ok.body.playbook.length, 53);
});

test('page endpoints refuse anything that is not same-origin', async () => {
  const route = createJarvisBridgeRoute({ token: TOKEN, waitMs: 20 });
  assert.equal((await hit(route, req('GET', '/next'))).statusCode, 403);
  const cross = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };
  assert.equal((await hit(route, req('POST', '/result', { headers: cross, body: { id: 'x', result: {} } }))).statusCode, 403);
  assert.equal((await hit(route, req('GET', '/allow', { headers: PAGE }))).statusCode, 200);
});

test('the page side is accepted only from localhost:4173 itself (DNS rebinding sends a foreign Host)', async () => {
  const route = createJarvisBridgeRoute({ token: TOKEN });
  const rebound = { 'sec-fetch-site': 'same-origin', origin: 'http://evil.example:4173', host: 'evil.example:4173' };
  assert.equal((await hit(route, req('GET', '/allow', { headers: rebound }))).statusCode, 403);
  const loopback = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173' };
  assert.equal((await hit(route, req('GET', '/allow', { headers: loopback }))).statusCode, 200);
  const mixed = { 'sec-fetch-site': 'same-origin', origin: 'http://evil.example:4173', host: 'localhost:4173' };
  assert.equal((await hit(route, req('GET', '/allow', { headers: mixed }))).statusCode, 403);
});

test('a call waits for the page and returns its result', async () => {
  const route = createJarvisBridgeRoute({ token: TOKEN, waitMs: 500, noPageMs: 60000 });
  // the page is polling
  const nextOut = hit(route, req('GET', '/next', { headers: PAGE }));
  const callOut = hit(route, req('POST', '/call', { headers: { 'x-jarvis-token': TOKEN },
    body: { tool: 'fly_to_location', args: { query: 'Frankfurt' }, timeoutMs: 2000 } }));
  const job = (await nextOut).body;
  assert.equal(job.tool, 'fly_to_location');
  assert.deepEqual(job.args, { query: 'Frankfurt' });
  const posted = await hit(route, req('POST', '/result', { headers: PAGE, body: { id: job.id, result: { ok: true, arrived: true } } }));
  assert.equal(posted.statusCode, 204);
  const done = await callOut;
  assert.deepEqual(done.body, { ok: true, result: { ok: true, arrived: true } });
});

test('a tool that is not on the list is refused before it reaches the page', async () => {
  const route = createJarvisBridgeRoute({ token: TOKEN });
  const out = await hit(route, req('POST', '/call', { headers: { 'x-jarvis-token': TOKEN }, body: { tool: 'eval_js', args: {} } }));
  assert.deepEqual(out.body, { ok: false, error: 'tool_not_allowed' });
});

test('no page connected answers no_page', async () => {
  const route = createJarvisBridgeRoute({ token: TOKEN });
  const out = await hit(route, req('POST', '/call', { headers: { 'x-jarvis-token': TOKEN }, body: { tool: 'zoom_to_globe', args: {} } }));
  assert.deepEqual(out.body, { ok: false, error: 'no_page' });
});

test('a page that never answers gives timeout', async () => {
  const route = createJarvisBridgeRoute({ token: TOKEN, waitMs: 1000, noPageMs: 60000 });
  hit(route, req('GET', '/next', { headers: PAGE }));
  const out = await hit(route, req('POST', '/call', { headers: { 'x-jarvis-token': TOKEN },
    body: { tool: 'zoom_to_globe', args: {}, timeoutMs: 50 } }));
  assert.deepEqual(out.body, { ok: false, error: 'timeout' });
});
