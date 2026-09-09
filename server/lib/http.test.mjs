import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  readRequestBodyCapped,
  readRequestBody,
  readResponseTextCapped,
  readResponseJsonCapped,
} from './http.js';

test('readRequestBodyCapped concatenates chunks under the cap into a Buffer', async () => {
  const req = Readable.from([Buffer.from('hel'), Buffer.from('lo')]);
  const body = await readRequestBodyCapped(req, 10);
  assert.equal(body.toString('utf8'), 'hello');
});

test('readRequestBodyCapped throws BODY_TOO_LARGE once the cap is exceeded', async () => {
  const req = Readable.from([Buffer.from('123456')]);
  await assert.rejects(readRequestBodyCapped(req, 3), (err) => err.code === 'BODY_TOO_LARGE');
});

test('readRequestBody resolves the full body as a UTF-8 string under the cap', async () => {
  const req = Readable.from([Buffer.from('hel'), Buffer.from('lo')]);
  const body = await readRequestBody(req, 10);
  assert.equal(body, 'hello');
});

test('readRequestBody rejects and destroys the stream once the cap is exceeded', async () => {
  const req = Readable.from([Buffer.from('123456')]);
  let destroyed = false;
  const originalDestroy = req.destroy.bind(req);
  req.destroy = (...args) => { destroyed = true; return originalDestroy(...args); };
  await assert.rejects(readRequestBody(req, 3), /exceeds 3 bytes/);
  assert.equal(destroyed, true);
});

test('readResponseTextCapped rejects early on an oversized declared Content-Length', async () => {
  const response = new Response('hello world', { headers: { 'content-length': '11' } });
  await assert.rejects(
    readResponseTextCapped(response, 5),
    (err) => err.code === 'RESPONSE_TOO_LARGE',
  );
});

test('readResponseTextCapped streams a body under the cap when Content-Length is absent', async () => {
  const response = new Response('hello');
  const text = await readResponseTextCapped(response, 10);
  assert.equal(text, 'hello');
});

test('readResponseTextCapped rejects a chunked/length-omitted body that exceeds the cap while streaming', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('123456'));
      controller.close();
    },
  });
  const response = new Response(stream);
  await assert.rejects(
    readResponseTextCapped(response, 3),
    (err) => err.code === 'RESPONSE_TOO_LARGE',
  );
});

test('readResponseJsonCapped parses JSON only after the cap check passes', async () => {
  const response = new Response(JSON.stringify({ ok: true }));
  assert.deepEqual(await readResponseJsonCapped(response, 100), { ok: true });
});
