/**
 * `better-sqlite3`-backed implementation of the cache contract
 * (docs/ARCH-SERVER-SPLIT.md §5, `./cache.js`). Same `CacheEntry` /
 * `CacheNamespace` shapes and the same serve-stale rule as the in-memory
 * backend in `./cache.js` — `get()` returns expired entries; freshness is a
 * property the *caller* reads off `entry.expiresAt`.
 *
 * One database file (`.gev-cache/cache.sqlite`, WAL mode,
 * `synchronous=NORMAL`) shared by every namespace, table `entries(ns, key,
 * value, kind, expires_at, created_at, size)` keyed on `(ns, key)`.
 * `better-sqlite3` is synchronous; every method here still returns a Promise
 * (resolved immediately) so callers never change when `./cache.js` swaps
 * backends — see `./cache.js`'s "Async by contract, sync inside" note.
 *
 * Selected by `./cache.js` via `GEV_CACHE_BACKEND=sqlite` (the default, when
 * the native module loads). This module is only ever reached through a
 * dynamic `import()` in `./cache.js`, which catches a failed native-module
 * load and falls back to the in-memory backend — importing this file
 * directly on a platform without a `better-sqlite3` prebuild throws.
 *
 * @module server/lib/cacheSqlite
 */

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

/** Bumped whenever the `entries` table shape changes; read/written via `PRAGMA user_version`. */
const SCHEMA_VERSION = 1;

/**
 * DB file path. `GEV_CACHE_SQLITE_PATH` is a test-only override (see
 * `cache.test.mjs`) — the production path is always `.gev-cache/cache.sqlite`
 * relative to the process cwd, matching the on-disk caches every other route
 * already uses (e.g. `server/routes/celestrak.js`'s legacy `.gev-cache/`).
 */
function resolveDbPath() {
  return process.env.GEV_CACHE_SQLITE_PATH || path.join(process.cwd(), '.gev-cache', 'cache.sqlite');
}

/** @type {import('better-sqlite3').Database | null} */
let db = null;
let dbPath = null;
let statements = null;

/** Open (or reopen, if the target path changed) the shared DB connection and prepare statements. */
function getDb() {
  const wanted = resolveDbPath();
  if (db && dbPath === wanted) return db;
  if (db) db.close();

  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  db = new Database(wanted);
  dbPath = wanted;
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const userVersion = db.pragma('user_version', { simple: true });
  if (userVersion < SCHEMA_VERSION) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value BLOB,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      );
      CREATE INDEX IF NOT EXISTS idx_entries_ns_created ON entries (ns, created_at);
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  statements = {
    get: db.prepare('SELECT value, kind, expires_at, created_at, size FROM entries WHERE ns = ? AND key = ?'),
    upsert: db.prepare(`
      INSERT INTO entries (ns, key, value, kind, expires_at, created_at, size)
      VALUES (@ns, @key, @value, @kind, @expiresAt, @createdAt, @size)
      ON CONFLICT (ns, key) DO UPDATE SET
        value = excluded.value, kind = excluded.kind, expires_at = excluded.expires_at,
        created_at = excluded.created_at, size = excluded.size
    `),
    delete: db.prepare('DELETE FROM entries WHERE ns = ? AND key = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE ns = ?'),
    totalBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM entries WHERE ns = ?'),
    oldest: db.prepare('SELECT key, size FROM entries WHERE ns = ? ORDER BY created_at ASC, rowid ASC LIMIT 1'),
    deleteStaleBeyond: db.prepare('SELECT key, size FROM entries WHERE ns = ? AND (? - expires_at) > ?'),
    clearNamespace: db.prepare('DELETE FROM entries WHERE ns = ?'),
    clearAll: db.prepare('DELETE FROM entries'),
  };
  return db;
}

/** Split a cache value into its storable form (`BLOB` for buffers, `TEXT` otherwise) and a `kind` tag to reverse it on read. */
function toRow(value) {
  if (Buffer.isBuffer(value)) return { kind: 'buffer', data: value, bytes: value.length };
  if (typeof value === 'string') return { kind: 'string', data: value, bytes: Buffer.byteLength(value) };
  const json = JSON.stringify(value);
  return { kind: 'json', data: json, bytes: Buffer.byteLength(json) };
}

/** Reverse `toRow`, turning a stored row back into the original value shape. */
function fromRow(kind, data) {
  if (kind === 'buffer') return Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (kind === 'string') return data;
  if (kind === 'json') return JSON.parse(data);
  throw new Error(`cacheSqlite: unknown stored value kind "${kind}"`);
}

/** name -> opts, so a second `namespace()` call with the same name reuses the first call's caps (mirrors `./cache.js`'s registry). */
const optsRegistry = new Map();

/** Evict oldest-`created_at` rows in `ns` until both caps are satisfied. Returns `{removed, bytes}`. */
function trimToCaps(ns, opts) {
  const stmts = statements;
  let removed = 0;
  let bytes = 0;
  const overEntries = () => opts.maxEntries && stmts.count.get(ns).n > opts.maxEntries;
  const overBytes = () => opts.maxBytes && stmts.totalBytes.get(ns).total > opts.maxBytes;
  let over = overEntries() || overBytes();
  while (over) {
    const oldest = stmts.oldest.get(ns);
    if (!oldest) break;
    stmts.delete.run(ns, oldest.key);
    removed += 1;
    bytes += oldest.size;
    over = overEntries() || overBytes();
  }
  return { removed, bytes };
}

/**
 * @param {string} name  Namespace id (see the table in §5).
 * @param {object} opts
 * @param {number} opts.defaultTtlMs
 * @param {number} opts.staleMs     `Infinity` for overpass / military-installations.
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.maxBytes]
 * @returns {import('./cache.js').CacheNamespace}
 */
export function namespace(name, opts) {
  if (!optsRegistry.has(name)) optsRegistry.set(name, opts);
  const nsOpts = optsRegistry.get(name);

  return {
    async get(key) {
      getDb();
      const row = statements.get.get(name, key);
      if (!row) return null;
      return {
        value: fromRow(row.kind, row.value),
        storedAt: row.created_at,
        expiresAt: row.expires_at,
        bytes: row.size,
      };
    },
    async set(key, value, ttlMs) {
      getDb();
      const now = Date.now();
      const { kind, data, bytes } = toRow(value);
      statements.upsert.run({
        ns: name, key, value: data, kind, expiresAt: now + ttlMs, createdAt: now, size: bytes,
      });
      trimToCaps(name, nsOpts);
    },
    async delete(key) {
      getDb();
      statements.delete.run(name, key);
    },
    async sweep() {
      getDb();
      let removed = 0;
      let bytes = 0;
      if (Number.isFinite(nsOpts.staleMs)) {
        const now = Date.now();
        for (const row of statements.deleteStaleBeyond.all(name, now, nsOpts.staleMs)) {
          statements.delete.run(name, row.key);
          removed += 1;
          bytes += row.size;
        }
      }
      const trimmed = trimToCaps(name, nsOpts);
      return { removed: removed + trimmed.removed, bytes: bytes + trimmed.bytes };
    },
  };
}

/** Test-only: drop every namespace's rows and cached opts so suites don't leak into each other. */
export function _resetAllNamespaces() {
  getDb();
  statements.clearAll.run();
  optsRegistry.clear();
}
