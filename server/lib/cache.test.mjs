import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { namespace, _resetAllNamespaces } from './cache.js';

// PR 9: the sqlite backend defaults to `.gev-cache/cache.sqlite` (the real
// on-disk cache). Point it at a throwaway temp file for the whole run so the
// contract suite never touches — or gets polluted by — that file.
const sqliteTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cache-test-'));
process.env.GEV_CACHE_SQLITE_PATH = path.join(sqliteTestDir, 'cache.sqlite');
after(() => {
  delete process.env.GEV_CACHE_SQLITE_PATH;
  fs.rmSync(sqliteTestDir, { recursive: true, force: true });
});

/**
 * The cache contract (docs/ARCH-SERVER-SPLIT.md §5) run once per backend.
 * `envValue` forces `./cache.js`'s dispatcher via `GEV_CACHE_BACKEND` for the
 * duration of the block — top-level `node:test` tests in one file run
 * sequentially, so this mutation doesn't race across `describe` blocks.
 * @param {string} label
 * @param {'memory'|'sqlite'} envValue
 */
function describeContract(label, envValue) {
  describe(label, () => {
    test.beforeEach(() => {
      process.env.GEV_CACHE_BACKEND = envValue;
      return _resetAllNamespaces();
    });

    test('set then get round-trips the value, storedAt, expiresAt, and bytes', async () => {
      const ns = namespace('t-roundtrip', { defaultTtlMs: 1000, staleMs: 1000 });
      const before = Date.now();
      await ns.set('k', { hello: 'world' }, 1000);
      const entry = await ns.get('k');
      assert.deepEqual(entry.value, { hello: 'world' });
      assert.ok(entry.storedAt >= before);
      assert.equal(entry.expiresAt, entry.storedAt + 1000);
      assert.equal(entry.bytes, Buffer.byteLength(JSON.stringify({ hello: 'world' })));
    });

    test('get on a missing key returns null', async () => {
      const ns = namespace('t-missing', { defaultTtlMs: 1000, staleMs: 1000 });
      assert.equal(await ns.get('nope'), null);
    });

    test('§5 serve-stale contract: get() on an EXPIRED entry returns the entry with expiresAt in the past — NOT null', async () => {
      const ns = namespace('t-stale', { defaultTtlMs: 1000, staleMs: Infinity });
      await ns.set('k', 'v', -1000); // already expired the instant it's written
      const entry = await ns.get('k');
      assert.notEqual(entry, null);
      assert.equal(entry.value, 'v');
      assert.ok(entry.expiresAt < Date.now(), 'expiresAt must be in the past, not filtered away');
    });

    test('delete removes the key', async () => {
      const ns = namespace('t-delete', { defaultTtlMs: 1000, staleMs: 1000 });
      await ns.set('k', 'v', 1000);
      await ns.delete('k');
      assert.equal(await ns.get('k'), null);
    });

    test('two namespace() calls with the same name share the same underlying store', async () => {
      const a = namespace('t-shared', { defaultTtlMs: 1000, staleMs: 1000 });
      const b = namespace('t-shared', { defaultTtlMs: 1000, staleMs: 1000 });
      await a.set('k', 'v', 1000);
      assert.equal((await b.get('k')).value, 'v');
    });

    test('a different namespace name is an independent store', async () => {
      const a = namespace('t-iso-a', { defaultTtlMs: 1000, staleMs: 1000 });
      const b = namespace('t-iso-b', { defaultTtlMs: 1000, staleMs: 1000 });
      await a.set('k', 'v', 1000);
      assert.equal(await b.get('k'), null);
    });

    test('set enforces maxEntries by evicting the oldest entry first', async () => {
      const ns = namespace('t-cap-entries', { defaultTtlMs: 1000, staleMs: 1000, maxEntries: 2 });
      await ns.set('a', '1', 1000);
      await ns.set('b', '2', 1000);
      await ns.set('c', '3', 1000); // over the cap — 'a' (oldest) is evicted
      assert.equal(await ns.get('a'), null);
      assert.equal((await ns.get('b')).value, '2');
      assert.equal((await ns.get('c')).value, '3');
    });

    test('set enforces maxBytes by evicting oldest entries until back under the cap', async () => {
      const ns = namespace('t-cap-bytes', { defaultTtlMs: 1000, staleMs: 1000, maxBytes: 5 });
      await ns.set('a', 'xxx', 1000); // 3 bytes
      await ns.set('b', 'xxx', 1000); // 3 + 3 = 6 > 5 -> evict 'a'
      assert.equal(await ns.get('a'), null);
      assert.equal((await ns.get('b')).value, 'xxx');
    });

    test('sweep drops entries expired beyond staleMs and reports removed/bytes', async () => {
      const ns = namespace('t-sweep', { defaultTtlMs: 1000, staleMs: 100 });
      await ns.set('old', 'v', -200); // expired 200ms ago, past the 100ms stale window
      await ns.set('fresh', 'v', 10_000);
      const result = await ns.sweep();
      assert.equal(result.removed, 1);
      assert.ok(result.bytes > 0);
      assert.equal(await ns.get('old'), null);
      assert.equal((await ns.get('fresh')).value, 'v');
    });

    test('sweep never drops on staleness when staleMs is Infinity (overpass / military-installations)', async () => {
      const ns = namespace('t-sweep-infinite', { defaultTtlMs: 1000, staleMs: Infinity });
      await ns.set('ancient', 'v', -1_000_000);
      const result = await ns.sweep();
      assert.equal(result.removed, 0);
      assert.notEqual(await ns.get('ancient'), null);
    });

    if (envValue === 'sqlite') {
      test('persists across a fresh namespace() call after the module\'s connection is reused (restart parity)', async () => {
        // Simulates cold-restart parity: a brand-new `namespace()` call (as a
        // fresh process would make) against the same DB file sees prior writes.
        const first = namespace('t-persist', { defaultTtlMs: 60_000, staleMs: 60_000 });
        await first.set('k', { persisted: true }, 60_000);
        const second = namespace('t-persist', { defaultTtlMs: 60_000, staleMs: 60_000 });
        const entry = await second.get('k');
        assert.deepEqual(entry.value, { persisted: true });
      });
    }
  });
}

describeContract('memory backend (GEV_CACHE_BACKEND=memory)', 'memory');
describeContract('sqlite backend (GEV_CACHE_BACKEND=sqlite)', 'sqlite');
