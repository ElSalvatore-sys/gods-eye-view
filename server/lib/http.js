/**
 * Small request/response helpers shared by every route handler: writing a
 * response (`sendText`/`sendJson`) and reading a request or upstream
 * response body under a hard byte cap. Kept deliberately thin — each
 * function does exactly what its name says, so a handler's control flow
 * (cache hit/miss, error branch) stays visible at the call site instead of
 * hiding inside a generic responder. The four `read*` helpers moved
 * verbatim out of `vite.config.js` in docs/ARCH-SERVER-SPLIT.md §4 PR 2.
 *
 * @module server/lib/http
 */

/** @typedef {Error & {code: string}} CappedError An over-cap Error tagged with a machine-readable `code`. */

/**
 * Write a `text/plain` response with optional extra headers. Guards against
 * a double-send (e.g. a throw that lands in a `catch` after a response
 * already went out) — `writeHead` after `headersSent` throws.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [headers]
 */
export function sendText(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
  res.end(body);
}

/**
 * Write an `application/json` response with optional extra headers. Same
 * double-send guard as {@link sendText}.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, data, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

/**
 * Read a request body with a hard byte cap; throws `{ code: 'BODY_TOO_LARGE' }`
 * past the cap. Moved verbatim from `vite.config.js`
 * (docs/ARCH-SERVER-SPLIT.md §4 PR 2).
 * @param {import('http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function readRequestBodyCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = /** @type {CappedError} */ (new Error('Request body too large'));
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Read a request body as a UTF-8 string with a hard byte cap, rejecting (and
 * destroying the socket) once the cap is exceeded. Moved verbatim from
 * `vite.config.js` (docs/ARCH-SERVER-SPLIT.md §4 PR 2) — kept alongside
 * {@link readRequestBodyCapped} rather than merged into it, matching the
 * source: callers that want a Buffer use one, callers that want a string and
 * mid-stream `req.destroy()` on overflow use the other.
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Read a fetch() Response body as text with a hard byte cap. Rejects early on an
 * oversized Content-Length, then streams with a running cap so a chunked or
 * length-omitted response cannot blow past the limit. Throws { code:'RESPONSE_TOO_LARGE' }.
 * Moved verbatim from `vite.config.js` (docs/ARCH-SERVER-SPLIT.md §4 PR 2).
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function readResponseTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = /** @type {CappedError} */ (new Error('Upstream response too large'));
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      const err = /** @type {CappedError} */ (new Error('Upstream response too large'));
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      const err = /** @type {CappedError} */ (new Error('Upstream response too large'));
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * Parse a fetch() JSON response only after enforcing a hard byte cap. Moved
 * verbatim from `vite.config.js` (docs/ARCH-SERVER-SPLIT.md §4 PR 2).
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<*>}
 */
export async function readResponseJsonCapped(response, maxBytes) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes));
}
