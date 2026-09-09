/**
 * The shared cache-layer contract (docs/ARCH-SERVER-SPLIT.md §5) and its
 * in-memory implementation. PR 9 implements a SQLite-backed namespace
 * against this same interface — defined here, ahead of any route adopting
 * it, so route PRs 3–8 and the SQLite work (PR 9) and archive hook (PR 10)
 * can proceed in parallel once PR 2 lands.
 *
 * **The stale rule.** Fourteen routes serve stale data on upstream failure
 * — "last-good beats an empty layer". `get()` therefore returns an entry
 * whether or not it has expired; freshness is a property the *caller* reads
 * off `entry.expiresAt`, never a filter the cache applies. See §5.
 *
 * **Async by contract, sync inside.** This in-memory backend could resolve
 * synchronously, but the Promise-returning surface is the contract every
 * backend (this one, the on-disk one routes use today, and PR 9's
 * `better-sqlite3` backend) must implement, so callers never change when the
 * backend swaps.
 *
 * **Single-flight stays out.** `coalesceProxyRequest` (./upstream.js) is
 * already extracted, tested, and orthogonal — this cache must not
 * deduplicate concurrent fetches itself.
 *
 * @module server/lib/cache
 */

/**
 * One stored value plus the metadata a caller needs to decide freshness.
 * @typedef {object} CacheEntry
 * @property {Buffer|string|object} value  Payload. Buffer for tiles/images,
 *   string for pre-serialized JSON bodies, plain object for structured data.
 * @property {number} storedAt   Epoch ms when the value was written.
 * @property {number} expiresAt  Epoch ms; `Infinity` for never.
 * @property {number} bytes      Serialized size, for cap accounting.
 */

/**
 * A namespaced key/value store with TTLs and caps.
 * @typedef {object} CacheNamespace
 * @property {(key: string) => Promise<?CacheEntry>} get
 *   Returns the entry whether or not it has expired, or null if absent.
 *   Callers compare `entry.expiresAt` to now and choose fresh vs stale.
 * @property {(key: string, value: *, ttlMs: number) => Promise<void>} set
 *   Writes and stamps `expiresAt = now + ttlMs`. Enforces caps on write.
 * @property {(key: string) => Promise<void>} delete
 * @property {() => Promise<{removed: number, bytes: number}>} sweep
 *   Drops expired entries beyond the namespace's stale window and trims to caps.
 */

/** Serialized byte size of a cache value, for cap accounting. */
function byteSize(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value);
  return Buffer.byteLength(JSON.stringify(value));
}

/** Evict the oldest (first-inserted) entries until both caps are satisfied. */
function trimToCaps(store, opts) {
  let removed = 0;
  let bytes = 0;
  const overEntries = () => opts.maxEntries && store.size > opts.maxEntries;
  const totalBytes = () => {
    let sum = 0;
    for (const entry of store.values()) sum += entry.bytes;
    return sum;
  };
  let over = overEntries() || (opts.maxBytes && totalBytes() > opts.maxBytes);
  while (over && store.size > 0) {
    const oldestKey = store.keys().next().value;
    const oldest = store.get(oldestKey);
    store.delete(oldestKey);
    removed += 1;
    bytes += oldest.bytes;
    over = overEntries() || (opts.maxBytes && totalBytes() > opts.maxBytes);
  }
  return { removed, bytes };
}

/** name -> { store: Map<string, CacheEntry>, opts } — shared across `namespace()` calls with the same name. */
const registry = new Map();

/**
 * @param {string} name  Namespace id (see the table in §5).
 * @param {object} opts
 * @param {number} opts.defaultTtlMs
 * @param {number} opts.staleMs     How long past expiry an entry is retained
 *                                  for the serve-stale path. `Infinity` for
 *                                  overpass / military-installations.
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.maxBytes]
 * @returns {CacheNamespace}
 */
export function namespace(name, opts) {
  let entry = registry.get(name);
  if (!entry) {
    entry = { store: new Map(), opts };
    registry.set(name, entry);
  }
  const { store } = entry;
  const nsOpts = entry.opts;

  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, ttlMs) {
      const now = Date.now();
      const bytes = byteSize(value);
      store.delete(key); // re-insert at the end so eviction stays oldest-first
      store.set(key, { value, storedAt: now, expiresAt: now + ttlMs, bytes });
      trimToCaps(store, nsOpts);
    },
    async delete(key) {
      store.delete(key);
    },
    async sweep() {
      const now = Date.now();
      let removed = 0;
      let bytes = 0;
      if (Number.isFinite(nsOpts.staleMs)) {
        for (const [key, cacheEntry] of store) {
          if (now - cacheEntry.expiresAt > nsOpts.staleMs) {
            store.delete(key);
            removed += 1;
            bytes += cacheEntry.bytes;
          }
        }
      }
      const trimmed = trimToCaps(store, nsOpts);
      return { removed: removed + trimmed.removed, bytes: bytes + trimmed.bytes };
    },
  };
}

/** Test-only: drop every namespace's state so suites don't leak into each other. */
export function _resetAllNamespaces() {
  registry.clear();
}
