import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRateLimiter,
  makeOptInRateLimiter,
  enforceOptInRateLimit,
  clientKey,
} from './ratelimit.js';

test('makeRateLimiter allows up to max hits per key within the window, then blocks', () => {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 2, globalMax: 100 });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false); // 3rd hit in the same window is over the per-key cap
  assert.equal(allow('b'), true); // a different key has its own quota
});

test('makeRateLimiter enforces a global backstop across all keys', () => {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 10, globalMax: 2 });
  assert.equal(allow('a'), true);
  assert.equal(allow('b'), true);
  assert.equal(allow('c'), false); // under its own per-key cap, but the global backstop is exhausted
});

test('makeOptInRateLimiter is unlimited (null) for unset, zero, or non-numeric env values', () => {
  assert.equal(makeOptInRateLimiter(undefined), null);
  assert.equal(makeOptInRateLimiter('0'), null);
  assert.equal(makeOptInRateLimiter('not-a-number'), null);
  assert.equal(makeOptInRateLimiter('-5'), null);
});

test('makeOptInRateLimiter builds an active limiter for a positive integer env value', () => {
  const limiter = makeOptInRateLimiter('2');
  assert.equal(typeof limiter, 'function');
  assert.equal(limiter('x'), true);
  assert.equal(limiter('x'), true);
  assert.equal(limiter('x'), false);
});

test('enforceOptInRateLimit is a no-op passthrough when the limiter is null (default, unlimited)', () => {
  const res = { statusCode: null, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  assert.equal(enforceOptInRateLimit(null, { socket: {} }, res), true);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, null);
});

test('enforceOptInRateLimit writes a 429 with Retry-After when the limiter denies', () => {
  const limiter = () => false;
  const res = { statusCode: null, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  const req = { socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(enforceOptInRateLimit(limiter, req, res), false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '5');
  assert.deepEqual(JSON.parse(res.body), { error: 'Rate limit exceeded' });
});

test('clientKey reads the socket peer address, defaulting to "local"', () => {
  assert.equal(clientKey({ socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  assert.equal(clientKey({ socket: {} }), 'local');
  assert.equal(clientKey({}), 'local');
});
