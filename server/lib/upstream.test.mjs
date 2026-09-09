import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesceProxyRequest, haversineKm } from './upstream.js';

test('coalesceProxyRequest shares one in-flight promise for concurrent calls with the same key', async () => {
  const inFlight = new Map();
  let creates = 0;
  const create = () => { creates += 1; return Promise.resolve(`v${creates}`); };

  const first = coalesceProxyRequest(inFlight, 'k', create);
  const second = coalesceProxyRequest(inFlight, 'k', create);
  assert.equal(first.shared, false);
  assert.equal(second.shared, true);
  assert.equal(await first.promise, await second.promise);
  assert.equal(creates, 1); // `create` ran exactly once for both callers
});

test('coalesceProxyRequest removes the key once its promise settles, so the next call creates a fresh one', async () => {
  const inFlight = new Map();
  let creates = 0;
  const create = () => { creates += 1; return Promise.resolve(`v${creates}`); };

  await coalesceProxyRequest(inFlight, 'k', create).promise;
  assert.equal(inFlight.has('k'), false);
  const again = coalesceProxyRequest(inFlight, 'k', create);
  assert.equal(again.shared, false);
  assert.equal(await again.promise, 'v2');
});

test('coalesceProxyRequest cleans up on rejection too', async () => {
  const inFlight = new Map();
  const rejecting = coalesceProxyRequest(inFlight, 'k', () => Promise.reject(new Error('upstream down')));
  await assert.rejects(rejecting.promise, /upstream down/);
  assert.equal(inFlight.has('k'), false);
});

test('haversineKm returns 0 for identical points', () => {
  assert.equal(haversineKm(30.2672, -97.7431, 30.2672, -97.7431), 0);
});

test('haversineKm matches the known Austin -> Houston great-circle distance (~239 km)', () => {
  const km = haversineKm(30.2672, -97.7431, 29.7604, -95.3698);
  assert.ok(Math.abs(km - 239) < 5, `expected ~239 km, got ${km}`);
});
