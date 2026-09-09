/**
 * The shared cache-layer contract (docs/ARCH-SERVER-SPLIT.md §5), its
 * in-memory implementation, and the dispatcher that picks between it and the
 * `better-sqlite3` backend (./cacheSqlite.js, PR 9) so routes never see which
 * one is live.
 *
 * **The stale rule.** Fourteen routes serve stale data on upstream failure
 * — "last-good beats an empty layer". `get()` therefore returns an entry
 * whether or not it has expired; freshness is a property the *caller* reads
 * off `entry.expiresAt`, never a filter the cache applies. See §5.
 *
 * **Async by contract, sync inside.** Both backends could resolve
 * synchronously (a `Map`, or `better-sqlite3`'s synchronous API), but the
 * Promise-returning surface is the contract every backend must implement, so
 * callers never change when the backend swaps.
 *
 * **Single-flight stays out.** `coalesceProxyRequest` (./upstream.js) is
 * already extracted, tested, and orthogonal — this cache must not
 * deduplicate concurrent fetches itself.
 *
 * **Backend selection.** `GEV_CACHE_BACKEND=memory|sqlite` picks explicitly.
 * Left unset, the sqlite backend (./cacheSqlite.js) is tried first — it
 * persists across restarts, which is the point of PR 9 — and this module
 * falls back to the in-memory backend below, logging once, if the native
 * `better-sqlite3` module fails to load (e.g. no prebuild for the current
 * platform/Node ABI).
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

/** name -> { store: Map<string, CacheEntry>, opts } — shared across `memoryNamespace()` calls with the same name. */
const registry = new Map();

/**
 * The in-memory backend. Always available (no native module), used directly
 * under `GEV_CACHE_BACKEND=memory` and as the sqlite backend's fallback.
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
function memoryNamespace(name, opts) {
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

/**
 * Lazily, and only once per process, `import()` the sqlite backend
 * (./cacheSqlite.js). Memoized so a failed load (missing native module) logs
 * exactly one warning rather than one per cache call.
 * @returns {Promise<typeof import('./cacheSqlite.js') | null>} `null` if the backend failed to load.
 */
let sqliteBackendPromise = null;
let loggedSqliteFallback = false;
function loadSqliteBackend() {
  if (!sqliteBackendPromise) {
    sqliteBackendPromise = import('./cacheSqlite.js').catch((err) => {
      if (!loggedSqliteFallback) {
        loggedSqliteFallback = true;
        console.warn(`[cache] better-sqlite3 unavailable (${err?.message || err}) — falling back to the in-memory cache`);
      }
      return null;
    });
  }
  return sqliteBackendPromise;
}

/**
 * Resolve which backend a given `namespace()` call should use.
 * `GEV_CACHE_BACKEND=memory` opts out of sqlite entirely (no import attempt,
 * so it also works on platforms without a `better-sqlite3` prebuild).
 * Anything else (`sqlite`, or unset) tries sqlite and falls back to memory.
 * @returns {Promise<'memory'|'sqlite'>}
 */
function resolveBackendName() {
  if (process.env.GEV_CACHE_BACKEND === 'memory') return Promise.resolve('memory');
  return loadSqliteBackend().then((mod) => (mod ? 'sqlite' : 'memory'));
}

/**
 * @param {string} name  Namespace id (see the table below).
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
  /** Resolve the live backend for this call and hand back its namespace object. */
  const withBackend = async () => {
    const backendName = await resolveBackendName();
    if (backendName === 'sqlite') {
      const sqliteMod = await loadSqliteBackend();
      return sqliteMod.namespace(name, opts);
    }
    return memoryNamespace(name, opts);
  };
  return {
    async get(key) {
      return (await withBackend()).get(key);
    },
    async set(key, value, ttlMs) {
      return (await withBackend()).set(key, value, ttlMs);
    },
    async delete(key) {
      return (await withBackend()).delete(key);
    },
    async sweep() {
      return (await withBackend()).sweep();
    },
  };
}

/** Test-only: drop every backend's state so suites don't leak into each other. */
export async function _resetAllNamespaces() {
  registry.clear();
  const sqliteMod = await loadSqliteBackend();
  if (sqliteMod) sqliteMod._resetAllNamespaces();
}
