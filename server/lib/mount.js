/**
 * Vendored, minimal reimplementation of Connect's `use(prefix, fn)` mount
 * semantics — the router Vite's dev server uses under the hood. Verified
 * byte-for-byte against real Vite/Connect dev mounting in
 * docs/ARCH-SERVER-SPLIT.md §2a (8/8 differential cases, including the
 * percent-encoded-URL row). This wraps exactly one `(prefix, handler)` pair
 * into a single Connect-style layer — it is not a general middleware stack;
 * `server/index.js` composes an array of these plus `sirv` and dispatches
 * them itself.
 *
 * Match rule: the request pathname must start with `prefix`, and the
 * character immediately following the prefix (if any) must be `/`, `.`, or
 * the end of the path — so `/api/celestrakXYZ` does not match
 * `/api/celestrak`. On match, `req.url` is rewritten to strip the prefix
 * (keeping a leading `/` and the original query string) before `handler`
 * runs, and is restored to its original value before `next` is called — so
 * later layers in the stack see the unrewritten URL.
 *
 * @module server/lib/mount
 */

/**
 * @typedef {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: (err?: unknown) => void) => void} Middleware
 */

/**
 * @param {string} prefix e.g. `/api/celestrak`
 * @param {Middleware} handler
 * @returns {Middleware} a single Connect-style layer mounted at `prefix`
 */
export function mount(prefix, handler) {
  // Strip a trailing slash, matching Connect's own route normalisation.
  const route = prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;

  return function mounted(req, res, next) {
    const originalUrl = req.url || '/';
    const qIndex = originalUrl.indexOf('?');
    const pathname = qIndex === -1 ? originalUrl : originalUrl.slice(0, qIndex);

    if (pathname.toLowerCase().slice(0, route.length) !== route.toLowerCase()) {
      next();
      return;
    }
    // The match must border a path segment, an extension, or the end of the
    // string — otherwise `/api/celestrakXYZ` would wrongly match `/api/celestrak`.
    const border = pathname.length > route.length ? pathname[route.length] : undefined;
    if (border && border !== '/' && border !== '.') {
      next();
      return;
    }

    let rewritten = originalUrl.slice(route.length);
    if (route.length !== 0 && rewritten[0] !== '/') {
      rewritten = '/' + rewritten;
    }
    req.url = rewritten;

    const restore = (err) => {
      req.url = originalUrl;
      next(err);
    };

    try {
      handler(req, res, restore);
    } catch (err) {
      restore(err);
    }
  };
}
