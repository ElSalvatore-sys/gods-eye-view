/**
 * The page half of the Jarvis bridge. The page long-polls /api/jarvis/next on its own server, runs the one tool it is
 * given with the normal action runner (or a Jarvis tool), and posts the result plus the current view state back.
 * The page never holds the Jarvis token and never runs code it is sent: a tool name maps to a function, nothing else.
 *
 * @module jarvisBridge
 */
import { JARVIS_EXTRA_NAMES, runJarvisExtra } from './voice/jarvisTools.js';

const RETRY_MS = 2000;
const JOB_TIMEOUT_MS = 90000;

/** Run one job. Never throws. */
export async function runJob(job, { runner, capture, allow }) {
  const tool = String(job?.tool || '');
  if (!allow?.has(tool)) return { ok: false, error: 'tool_not_allowed' };
  try {
    const args = job.args && typeof job.args === 'object' ? job.args : {};
    const result = JARVIS_EXTRA_NAMES.has(tool) ? await runJarvisExtra(tool, args, { runner, capture }) : await runner(tool, args);
    let view = null;
    try {
      view = await runner('get_current_view_state', {});
    } catch {
      view = null;
    }
    return { ok: result?.ok !== false, result, view };
  } catch (error) {
    return { ok: false, error: 'page_error', message: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * Start polling. Returns { stop }. Jobs run side by side: a job that hangs (a camera flight that never arrives) never
 * blocks the next poll, and is answered with page_timeout after `jobTimeoutMs`.
 */
export function startJarvisBridge({ runner, capture, fetchImpl = globalThis.fetch?.bind(globalThis), base = '',
  jobTimeoutMs = JOB_TIMEOUT_MS }) {
  let running = true;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const handle = async (job, allow) => {
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r({ ok: false, error: 'page_timeout' }), jobTimeoutMs); });
    const result = await Promise.race([runJob(job, { runner, capture, allow }), timeout]);
    clearTimeout(timer);
    try {
      await fetchImpl(`${base}/api/jarvis/result`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, result }),
      });
    } catch {
      // the server is gone; Jarvis's side times out on its own
    }
  };
  (async () => {
    let allow = null;
    while (running) {
      try {
        if (!allow) {
          const a = await fetchImpl(`${base}/api/jarvis/allow`, { cache: 'no-store' });
          if (!a.ok) { await delay(RETRY_MS * 5); continue; }
          allow = new Set((await a.json()).names || []);
        }
        const r = await fetchImpl(`${base}/api/jarvis/next`, { cache: 'no-store' });
        if (r.status === 204) continue;
        if (!r.ok) { await delay(RETRY_MS); continue; }
        const job = await r.json();
        handle(job, allow);
      } catch {
        await delay(RETRY_MS);
      }
    }
  })();
  return { stop() { running = false; } };
}
