/**
 * Small response helpers shared by every route handler. Kept deliberately
 * thin — each function does exactly what its name says, so a handler's
 * control flow (cache hit/miss, error branch) stays visible at the call
 * site instead of hiding inside a generic responder.
 *
 * @module server/lib/http
 */

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
