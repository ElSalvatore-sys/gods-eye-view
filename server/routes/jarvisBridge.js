import crypto from 'node:crypto';
import { readRequestBody } from '../lib/http.js';
import { GEV_PLAYBOOK_LINES, GEV_REALTIME_TOOLS } from './realtime.js';
import { JARVIS_EXTRA_TOOLS } from '../../src/voice/jarvisTools.js';

/**
 * The Jarvis bridge: lets the owner's office assistant (Jarvis, on this Mac) drive God's Eye View with the app's own
 * tools instead of clicks.
 *
 * Jarvis side (header X-Jarvis-Token = GEV_JARVIS_TOKEN, constant-time compare; no token configured = 503):
 *   GET  /api/jarvis/tools  -> { tools: [31 voice tools + Jarvis tools], playbook: [lines] }
 *   POST /api/jarvis/call   { tool, args, timeoutMs } -> { ok, result } | { ok:false, error: tool_not_allowed|no_page|timeout }
 * Page side (same-origin only: Sec-Fetch-Site same-origin and an Origin/Referer of this host):
 *   GET  /api/jarvis/allow  -> { names }
 *   GET  /api/jarvis/next   -> long poll: { id, tool, args } or 204
 *   POST /api/jarvis/result { id, result } -> 204
 *
 * @module server/routes/jarvisBridge
 */

const ALL_TOOLS = [...GEV_REALTIME_TOOLS, ...JARVIS_EXTRA_TOOLS];
const ALLOWED = new Set(ALL_TOOLS.map((t) => t.name));
const MAX_BODY = 4 * 1024 * 1024; // a captured view is a few hundred KB

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function tokenOk(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The page side: same-origin AND served from this machine's loopback name. Comparing Origin with Host alone is not
 * enough: under DNS rebinding both carry the attacker's hostname.
 */
function samePage(req) {
  const h = req.headers || {};
  if (h['sec-fetch-site'] !== 'same-origin') return false;
  try {
    const host = new URL(`http://${h.host || ''}`);
    const from = new URL(h.origin || h.referer || '');
    return LOOPBACK.has(host.hostname) && LOOPBACK.has(from.hostname) && from.host === host.host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  try {
    const raw = await readRequestBody(req, MAX_BODY);
    return JSON.parse(String(raw || '{}'));
  } catch {
    return null;
  }
}

export function createJarvisBridgeRoute({ token = process.env.GEV_JARVIS_TOKEN || '', waitMs = 25000, noPageMs = waitMs + 5000 } = {}) {
  const queue = []; // jobs not yet taken by the page
  const pollers = []; // page polls waiting for a job: { res, timer }
  const inflight = new Map(); // id -> resolve
  let lastPollAt = 0;

  function deliver() {
    while (queue.length && pollers.length) {
      const job = queue.shift();
      const p = pollers.shift();
      clearTimeout(p.timer);
      send(p.res, 200, job);
    }
  }

  return async function jarvisBridgeRoute(req, res, next) {
    const path = (req.url || '/').split('?')[0];
    if (path === '/tools' || path === '/call') {
      if (!token) return send(res, 503, { error: 'bridge token not configured' });
      if (!tokenOk(req.headers?.['x-jarvis-token'], token)) return send(res, 401, { error: 'unauthorized' });
      if (path === '/tools' && req.method === 'GET') return send(res, 200, { tools: ALL_TOOLS, playbook: GEV_PLAYBOOK_LINES });
      if (path === '/call' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body.tool !== 'string') return send(res, 400, { ok: false, error: 'bad_request' });
        if (!ALLOWED.has(body.tool)) return send(res, 200, { ok: false, error: 'tool_not_allowed' });
        if (!pollers.length && Date.now() - lastPollAt > noPageMs) return send(res, 200, { ok: false, error: 'no_page' });
        const id = crypto.randomUUID();
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 20000, 10), 120000);
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => { inflight.delete(id); resolve(null); }, timeoutMs);
          inflight.set(id, (value) => { clearTimeout(timer); inflight.delete(id); resolve(value); });
          queue.push({ id, tool: body.tool, args: body.args && typeof body.args === 'object' ? body.args : {} });
          deliver();
        });
        if (result === null) {
          const i = queue.findIndex((j) => j.id === id);
          if (i >= 0) queue.splice(i, 1);
          return send(res, 200, { ok: false, error: 'timeout' });
        }
        return send(res, 200, { ok: true, result });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (path === '/allow' || path === '/next' || path === '/result') {
      if (!samePage(req)) return send(res, 403, { error: 'forbidden' });
      if (path === '/allow') return send(res, 200, { names: [...ALLOWED] });
      if (path === '/next' && req.method === 'GET') {
        lastPollAt = Date.now();
        if (queue.length) return send(res, 200, queue.shift());
        const p = { res, timer: null };
        p.timer = setTimeout(() => {
          const i = pollers.indexOf(p);
          if (i >= 0) pollers.splice(i, 1);
          lastPollAt = Date.now();
          send(res, 204);
        }, waitMs);
        pollers.push(p);
        return undefined;
      }
      if (path === '/result' && req.method === 'POST') {
        const body = await readJson(req);
        const done = body && inflight.get(String(body.id));
        if (done) done(body.result ?? null);
        return send(res, 204);
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    return next();
  };
}
