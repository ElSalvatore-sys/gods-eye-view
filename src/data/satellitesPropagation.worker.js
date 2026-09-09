import { twoline2satrec } from 'satellite.js';
import { propagateBatch } from './satellitesPropagationCore.js';

/**
 * Dedicated Web Worker: owns bulk SGP4 propagation off the main thread.
 *
 * Protocol (see `satellites.js` for the main-thread side):
 *  - main → worker `{ type: 'load', sats: [{ id, line1, line2 }] }` —
 *    replaces the whole working set. Sent once per catalog fetch/refresh,
 *    not per frame.
 *  - main → worker `{ type: 'setInterval', ms }` — retunes the tick cadence
 *    (satellites.js uses this for the existing 200ms-tracked / 1s-idle split).
 *  - worker → main `{ type: 'positions', epochMs, ids: Int32Array, lla: Float64Array }`
 *    posted on a timer, with both typed arrays transferred (zero-copy).
 *
 * satrecs never leave this thread: only TLE text goes in, only lat/lon/alt
 * triples come out, so the transfer stays small regardless of catalog size.
 */

let _entries = []; // { id, satrec }
let _timer = null;
let _intervalMs = 1000;

function _tick() {
  if (_entries.length === 0) return;
  const epochMs = Date.now();
  const lla = propagateBatch(_entries, epochMs);
  const ids = new Int32Array(_entries.length);
  for (let i = 0; i < _entries.length; i++) ids[i] = _entries[i].id;
  self.postMessage({ type: 'positions', epochMs, ids, lla }, [ids.buffer, lla.buffer]);
}

function _restartTimer() {
  if (_timer !== null) clearInterval(_timer);
  _timer = setInterval(_tick, _intervalMs);
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'load') {
    _entries = (msg.sats || [])
      .map((s) => ({ id: s.id, satrec: twoline2satrec(s.line1, s.line2) }))
      .filter((e) => e.satrec && e.satrec.error === 0);
    if (_timer === null) _restartTimer();
    _tick(); // first pass immediately so callers don't wait a full interval
    return;
  }

  if (msg.type === 'setInterval') {
    const ms = Number(msg.ms);
    if (Number.isFinite(ms) && ms > 0 && ms !== _intervalMs) {
      _intervalMs = ms;
      _restartTimer();
    }
    return;
  }

  if (msg.type === 'stop') {
    if (_timer !== null) {
      clearInterval(_timer);
      _timer = null;
    }
    _entries = [];
  }
};
