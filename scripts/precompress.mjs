#!/usr/bin/env node
/**
 * precompress — emit `.br` and `.gz` siblings for every compressible file in
 * `dist/`, so the production server can serve them directly.
 *
 * `sirv` (server/index.js) does NOT compress on the fly: with `{ brotli: true,
 * gzip: true }` it looks for a `<file>.br` / `<file>.gz` sibling and serves it
 * with the right `Content-Encoding` when the request's `Accept-Encoding`
 * allows. No sibling means the raw file goes out uncompressed — which is what
 * shipped until now, including `cesium/Cesium.js` at 5.7 MB.
 *
 * Deliberately dependency-free: `node:zlib` only. `server/index.js` and its
 * import graph run with zero dev dependencies (docs/ARCH-SERVER-SPLIT.md §3),
 * and a build step that exists to feed that server should not be the thing
 * that drags a compression plugin into the tree.
 *
 * Usage: node scripts/precompress.mjs [dir]   (default: dist)
 *
 * @module scripts/precompress
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/**
 * Extensions worth compressing. Binary media (png/jpg/webp/glb/ktx2) is already
 * compressed — a second pass costs build time and yields nothing, so it is
 * skipped rather than listed here. `.wasm` IS included: it is uncompressed
 * bytecode and compresses well (basis_transcoder.wasm is ~500 KB).
 */
const COMPRESSIBLE = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.json', '.geojson', '.geojsonl',
  '.svg', '.txt', '.xml', '.wasm', '.glsl', '.map',
]);

/**
 * Below this size the encoding headers and the extra request bookkeeping cost
 * more than the bytes saved, and many servers/CDNs decline to compress at all.
 */
const MIN_BYTES = 1024;

/**
 * Only keep a compressed sibling if it is meaningfully smaller than the source.
 * Some already-entropy-dense files (rare here) round-trip to ~100%.
 */
const MAX_RATIO = 0.95;

/** @returns {Promise<string[]>} every file under `dir`, recursively, absolute. */
async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = await Promise.all(entries.map(async (entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(abs);
    return [abs];
  }));
  return out.flat();
}

/**
 * Compress one file to `.br` and `.gz`, skipping either when it is already
 * newer than the source (so a rebuild of one chunk doesn't recompress Cesium).
 * @returns {Promise<{original: number, br: number, gz: number}|null>}
 */
async function compressOne(abs) {
  const stat = await fs.stat(abs);
  if (stat.size < MIN_BYTES) return null;

  const source = await fs.readFile(abs);

  const write = async (ext, compress) => {
    const target = `${abs}${ext}`;
    const existing = await fs.stat(target).catch(() => null);
    if (existing && existing.mtimeMs >= stat.mtimeMs) return existing.size;

    const encoded = await compress(source);
    if (encoded.length > source.length * MAX_RATIO) {
      // Not worth serving. Remove a stale sibling from an earlier build so the
      // server never prefers a compressed file that is bigger than the original.
      if (existing) await fs.rm(target, { force: true });
      return 0;
    }
    await fs.writeFile(target, encoded);
    return encoded.length;
  };

  const [br, gz] = await Promise.all([
    write('.br', (buf) => brotli(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    })),
    write('.gz', (buf) => gzip(buf, { level: zlib.constants.Z_BEST_COMPRESSION })),
  ]);

  return { original: stat.size, br, gz };
}

/** Run `task` over `items` with bounded concurrency (zlib async uses libuv's pool). */
async function mapWithConcurrency(items, limit, task) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

async function main() {
  const dir = path.resolve(process.argv[2] || 'dist');
  const exists = await fs.stat(dir).catch(() => null);
  if (!exists) {
    console.error(`[precompress] ${dir} does not exist — run \`vite build\` first.`);
    process.exit(1);
  }

  const started = Date.now();
  const candidates = (await walk(dir)).filter((abs) => {
    const ext = path.extname(abs);
    if (ext === '.br' || ext === '.gz') return false; // never compress a sibling
    return COMPRESSIBLE.has(ext);
  });

  const results = await mapWithConcurrency(
    candidates,
    Math.max(2, os.cpus().length),
    compressOne,
  );

  let original = 0;
  let br = 0;
  let gz = 0;
  let count = 0;
  for (const result of results) {
    if (!result) continue;
    count += 1;
    original += result.original;
    br += result.br || result.original;
    gz += result.gz || result.original;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const percent = original ? ((1 - br / original) * 100).toFixed(1) : '0.0';
  console.log(
    `[precompress] ${count} files in ${seconds}s — `
    + `${kib(original)} raw, ${kib(br)} brotli (-${percent}%), ${kib(gz)} gzip`,
  );
}

main().catch((err) => {
  console.error('[precompress]', err?.stack || err);
  process.exit(1);
});
