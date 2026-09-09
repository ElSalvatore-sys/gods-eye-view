import * as Cesium from 'cesium';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * RainViewer precipitation radar — the last ~2h of frames plus the short
 * nowcast, draped as a Cesium imagery layer with a time scrubber.
 *
 * Keyless public API (https://www.rainviewer.com/api.html): the frame list
 * comes from `/api/rainviewer` (server proxy of
 * `https://api.rainviewer.com/public/weather-maps.json`, cached 5 min —
 * server/routes/rainviewer.js), and the returned `host` + each frame's
 * `path` build a tile URL directly fetched by the browser (RainViewer's
 * tile CDN is CORS-enabled for this exact public use — no server proxy for
 * tile bytes). Terms ask only for a courtesy attribution link, registered
 * in src/data/dataCredits.js.
 *
 * At most 2 Cesium `ImageryLayer`s are ever alive at once — the visible
 * frame and one pre-staged neighbour — so scrubbing/advancing swaps alpha
 * between them instead of removing then re-adding a layer, which would
 * paint one black frame. `planFrameSwap` below is the pure decision logic;
 * everything Cesium-shaped lives in the runtime methods that call it.
 */

const PROXY_URL = '/api/rainviewer';
const TILE_SIZE = 256;
/** RainViewer color scheme 2 = "Universal Blue", the scheme this layer ships with. */
const COLOR_SCHEME = 2;
const SMOOTH = 1;
const SNOW = 1;
const DEFAULT_ALPHA = 0.65;
const MAX_TILE_ZOOM = 12;
const AUTOPLAY_INTERVAL_MS = 800;
/** Defensive cap — RainViewer's own payload is already ~12 past + ~4 nowcast. */
const MAX_FRAMES = 40;

/**
 * Parse the RainViewer `weather-maps.json` payload into a flat, sorted,
 * JSON-safe frame list. Pure — no Cesium, no DOM.
 * @param {unknown} json Parsed response body.
 * @returns {{ host: string, frames: Array<{ time: number, path: string, kind: 'past'|'nowcast' }> } | null}
 *   `null` when the payload is missing the fields this layer needs.
 */
export function parseRainviewerFrames(json) {
  if (!json || typeof json !== 'object') return null;
  const host = typeof json.host === 'string' && json.host ? json.host : null;
  if (!host) return null;
  const radar = json.radar && typeof json.radar === 'object' ? json.radar : null;
  if (!radar) return null;

  const normalize = (list, kind) => (Array.isArray(list) ? list : [])
    .map((entry) => ({
      time: Number(entry?.time),
      path: typeof entry?.path === 'string' ? entry.path : '',
      kind,
    }))
    .filter((frame) => Number.isFinite(frame.time) && frame.path.startsWith('/'));

  const frames = [...normalize(radar.past, 'past'), ...normalize(radar.nowcast, 'nowcast')]
    .sort((a, b) => a.time - b.time)
    .slice(0, MAX_FRAMES);

  if (frames.length === 0) return null;
  return { host, frames };
}

/**
 * Index of the most recent PAST frame in a sorted frame list — the sane
 * default to show the moment data first loads (the newest observed radar
 * sweep, not a nowcast projection). Pure.
 * @param {Array<{ kind: string }>} frames Sorted ascending by time.
 * @returns {number} `-1` for an empty list.
 */
export function selectLatestPastFrameIndex(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return -1;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if (frames[i]?.kind === 'past') return i;
  }
  return frames.length - 1;
}

/**
 * Build the Cesium `UrlTemplateImageryProvider` URL TEMPLATE for one frame —
 * `{z}`/`{x}`/`{y}` are left as literal placeholders for Cesium to fill in
 * per tile, per the RainViewer pattern
 * `{host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png`. Pure.
 * @param {{ host: string, path: string }} frame
 * @param {{ size?: number, color?: number, smooth?: 0|1, snow?: 0|1 }} [options]
 * @returns {string|null} `null` on an invalid host/path.
 */
export function buildFrameTileUrlTemplate(frame, options = {}) {
  const host = typeof frame?.host === 'string' ? frame.host : '';
  const path = typeof frame?.path === 'string' ? frame.path : '';
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(host) || !path.startsWith('/')) return null;
  const size = Number.isInteger(options.size) && options.size > 0 ? options.size : TILE_SIZE;
  const color = Number.isInteger(options.color) ? options.color : COLOR_SCHEME;
  const smooth = options.smooth === 0 ? 0 : SMOOTH;
  const snow = options.snow === 0 ? 0 : SNOW;
  return `${host}${path}/${size}/{z}/{x}/{y}/${color}/${smooth}_${snow}.png`;
}

/**
 * Pure two-slot swap planner. Two Cesium `ImageryLayer` slots, `'A'` and
 * `'B'`, each hold at most one frame index. Given which slot is currently
 * visible and which frame the scrubber/autoplay wants next, decide the
 * target slot without ever needing more than those two slots alive:
 *
 *  - the target frame is already the OTHER (pre-staged) slot → swap to it,
 *    no load needed (the common case: autoplay stepping to the frame that
 *    was pre-staged one tick ago).
 *  - the target frame is already the ACTIVE slot → no-op swap (re-scrubbing
 *    to the same frame).
 *  - otherwise → the other slot must load the target frame before the swap.
 *
 * The caller shows the target slot at full alpha and the stale slot at 0
 * BEFORE removing/replacing anything, so a viewer never sees zero visible
 * radar layers between frames.
 * @param {{ activeSlot: 'A'|'B', slotFrameIndex: { A: number|null, B: number|null } }} state
 * @param {number} targetFrameIndex
 * @returns {{ targetSlot: 'A'|'B', needsLoad: boolean, staleSlot: 'A'|'B' }}
 */
export function planFrameSwap(state, targetFrameIndex) {
  const activeSlot = state?.activeSlot === 'B' ? 'B' : 'A';
  const other = activeSlot === 'A' ? 'B' : 'A';
  const slotFrameIndex = state?.slotFrameIndex || {};
  if (slotFrameIndex[other] === targetFrameIndex) {
    return { targetSlot: other, needsLoad: false, staleSlot: activeSlot };
  }
  if (slotFrameIndex[activeSlot] === targetFrameIndex) {
    return { targetSlot: activeSlot, needsLoad: false, staleSlot: other };
  }
  return { targetSlot: other, needsLoad: true, staleSlot: activeSlot };
}

/**
 * Format one frame's Unix-seconds timestamp for the scrubber label, in both
 * UTC (stable, shareable) and the viewer's local time (immediately
 * readable). Pure — takes no implicit `Date.now()` dependency.
 * @param {number} epochSeconds
 * @returns {{ utc: string, local: string }}
 */
export function formatFrameTimestamp(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return { utc: '—', local: '—' };
  const date = new Date(epochSeconds * 1000);
  const utc = `${date.toISOString().slice(11, 16)} UTC`;
  const local = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return { utc, local };
}

/**
 * Build the standalone scrubber panel markup. Kept as a template string
 * (rather than DOM calls) so it stays trivially readable and diffable — the
 * panel is self-contained (weatherRadar.js owns it end to end) and does not
 * hook into the left-panel-stack's per-panel layout CSS, so it is injected
 * as a small floating control rather than a stack member.
 * @returns {string}
 */
function panelMarkup() {
  return (
    '<div class="weather-radar-panel-header">'
    + '<span>WEATHER RADAR</span>'
    + '<span id="weather-radar-status">—</span>'
    + '</div>'
    + '<div class="weather-radar-panel-controls">'
    + '<button id="weather-radar-play-btn" type="button" aria-pressed="false" disabled>▶ PLAY</button>'
    + '<input id="weather-radar-scrubber" type="range" min="0" max="0" step="1" value="0" disabled '
    + 'aria-label="Weather radar frame scrubber" />'
    + '</div>'
    + '<div id="weather-radar-timestamp">—</div>'
  );
}

const PANEL_STYLE = 'position:fixed;left:16px;bottom:16px;z-index:500;min-width:260px;'
  + 'padding:10px 12px;border-radius:10px;background:rgba(10,14,20,0.82);'
  + 'border:1px solid rgba(255,255,255,0.12);color:#e6f1ff;font:12px/1.4 system-ui,sans-serif;'
  + 'backdrop-filter:blur(10px);box-shadow:0 8px 24px rgba(0,0,0,0.4);';

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {Document|null} [deps.documentImpl] Injectable for tests; defaults to the global `document`.
 * @returns {object} Layer object matching src/data/earthquakes.js's contract.
 */
export function createWeatherRadarLayer({
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  documentImpl = (typeof document !== 'undefined' ? document : null),
} = {}) {
  let _frames = [];
  let _host = null;
  let _frameIndex = -1;
  let _playing = false;
  let _playTimer = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _viewer = null;
  const _slots = { A: null, B: null }; // { frameIndex, imageryLayer } | null
  let _activeSlot = 'A';
  let _panelEl = null;
  let _els = {};

  function ensurePanel() {
    if (_panelEl || !documentImpl) return;
    const panel = documentImpl.createElement('div');
    panel.id = 'weather-radar-panel';
    panel.setAttribute('style', PANEL_STYLE);
    panel.hidden = true;
    panel.innerHTML = panelMarkup();
    documentImpl.body.appendChild(panel);
    _panelEl = panel;
    _els = {
      status: panel.querySelector('#weather-radar-status'),
      playBtn: panel.querySelector('#weather-radar-play-btn'),
      scrubber: panel.querySelector('#weather-radar-scrubber'),
      timestamp: panel.querySelector('#weather-radar-timestamp'),
    };
    _els.playBtn?.addEventListener('click', () => (_playing ? pause() : play()));
    _els.scrubber?.addEventListener('input', (event) => {
      setFrameIndex(Number(event.target.value));
    });
  }

  function syncPanel() {
    if (!_panelEl) return;
    if (_els.status) {
      _els.status.textContent = _lastError
        ? `ERROR · ${_lastError}`
        : (_frames.length ? `${_frames.length} FRAMES` : 'LOADING…');
    }
    const hasFrames = _frames.length > 1;
    if (_els.scrubber) {
      _els.scrubber.min = '0';
      _els.scrubber.max = String(Math.max(0, _frames.length - 1));
      _els.scrubber.value = String(Math.max(0, _frameIndex));
      _els.scrubber.disabled = !hasFrames;
    }
    if (_els.playBtn) {
      _els.playBtn.disabled = !hasFrames;
      _els.playBtn.textContent = _playing ? '⏸ PAUSE' : '▶ PLAY';
      _els.playBtn.setAttribute('aria-pressed', String(_playing));
    }
    if (_els.timestamp) {
      const frame = _frames[_frameIndex];
      const { utc, local } = formatFrameTimestamp(frame?.time);
      const label = frame?.kind === 'nowcast' ? 'NOWCAST' : 'OBSERVED';
      _els.timestamp.textContent = frame ? `${label} · ${utc} · ${local}` : '—';
    }
  }

  function otherSlot(slot) {
    return slot === 'A' ? 'B' : 'A';
  }

  /** Load one frame's provider into a slot at the given alpha, replacing whatever it held. */
  function loadIntoSlot(slot, frameIndex, alpha) {
    const frame = _frames[frameIndex];
    if (!frame || !_viewer) return;
    if (_slots[slot]?.frameIndex === frameIndex) {
      _slots[slot].imageryLayer.alpha = alpha;
      return;
    }
    const template = buildFrameTileUrlTemplate({ host: _host, path: frame.path }, {
      size: TILE_SIZE,
      color: COLOR_SCHEME,
      smooth: SMOOTH,
      snow: SNOW,
    });
    if (!template) return;
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: template,
      minimumLevel: 0,
      maximumLevel: MAX_TILE_ZOOM,
      credit: 'RainViewer',
    });
    const newLayer = new Cesium.ImageryLayer(provider, { alpha, show: _enabled });
    // Add the new layer BEFORE removing the old one occupying this slot, so
    // there is never a frame with zero radar imagery layers attached.
    _viewer.imageryLayers.add(newLayer);
    const previous = _slots[slot];
    _slots[slot] = { frameIndex, imageryLayer: newLayer };
    if (previous?.imageryLayer) {
      _viewer.imageryLayers.remove(previous.imageryLayer, true);
    }
  }

  /** Swap the visible frame using the 2-slot planner, then pre-stage the next one. */
  function showFrame(index) {
    if (!_viewer || index < 0 || index >= _frames.length) return;
    const plan = planFrameSwap({
      activeSlot: _activeSlot,
      slotFrameIndex: {
        A: _slots.A?.frameIndex ?? null,
        B: _slots.B?.frameIndex ?? null,
      },
    }, index);

    if (plan.needsLoad) loadIntoSlot(plan.targetSlot, index, DEFAULT_ALPHA);
    else if (_slots[plan.targetSlot]) _slots[plan.targetSlot].imageryLayer.alpha = DEFAULT_ALPHA;
    if (_slots[plan.staleSlot]) _slots[plan.staleSlot].imageryLayer.alpha = 0;

    _activeSlot = plan.targetSlot;
    _frameIndex = index;

    // Opportunistically pre-stage the next frame (autoplay direction) into
    // the now-stale slot at alpha 0, so the common forward step never loads.
    const nextIndex = index + 1 < _frames.length ? index + 1 : 0;
    if (nextIndex !== index) loadIntoSlot(otherSlot(_activeSlot), nextIndex, 0);
  }

  /** @param {number} index */
  function setFrameIndex(index) {
    const clamped = Math.max(0, Math.min(_frames.length - 1, Math.round(index)));
    if (Number.isNaN(clamped) || _frames.length === 0) return;
    showFrame(clamped);
    syncPanel();
    governorRequestRender('weather-radar-frame');
  }

  function scheduleAutoplayTick() {
    _playTimer = setTimeout(() => {
      _playTimer = null;
      if (!_playing) return;
      const next = _frames.length > 0 ? (_frameIndex + 1) % _frames.length : 0;
      setFrameIndex(next);
      scheduleAutoplayTick();
    }, AUTOPLAY_INTERVAL_MS);
  }

  function play() {
    if (_playing || _frames.length < 2) return;
    _playing = true;
    holdContinuousRender('weather-radar');
    scheduleAutoplayTick();
    syncPanel();
  }

  function pause() {
    if (!_playing) return;
    _playing = false;
    if (_playTimer !== null) {
      clearTimeout(_playTimer);
      _playTimer = null;
    }
    releaseContinuousRender('weather-radar');
    syncPanel();
  }

  const layer = {
    id: 'weather-radar',
    name: 'Weather Radar',
    icon: '🌧️',
    source: 'RainViewer',
    updateInterval: 5 * 60_000,

    init(viewer) {
      _viewer = viewer;
      _frames = [];
      _host = null;
      _frameIndex = -1;
      _activeSlot = 'A';
      _slots.A = null;
      _slots.B = null;
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
      ensurePanel();
      syncPanel();
      console.log('[Data:WeatherRadar] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_panelEl) _panelEl.hidden = false;
      for (const slot of Object.values(_slots)) {
        if (slot?.imageryLayer) slot.imageryLayer.show = true;
      }
      if (_frames.length && _frameIndex < 0) {
        showFrame(selectLatestPastFrameIndex(_frames));
      }
      syncPanel();
      governorRequestRender('weather-radar-enable');
    },

    disable(viewer) {
      _enabled = false;
      pause();
      if (_panelEl) _panelEl.hidden = true;
      for (const slot of Object.values(_slots)) {
        if (slot?.imageryLayer) slot.imageryLayer.show = false;
      }
      governorRequestRender('weather-radar-disable');
    },

    async update(viewer) {
      if (!fetchImpl) {
        _lastError = 'fetch unavailable';
        return false;
      }
      try {
        const response = await fetchImpl(PROXY_URL);
        if (!response.ok) {
          _lastError = `RainViewer HTTP ${response.status}`;
          console.warn(`[Data:WeatherRadar] proxy returned ${response.status}`);
          syncPanel();
          return false;
        }
        const json = await response.json();
        const parsed = parseRainviewerFrames(json);
        if (!parsed) {
          _lastError = 'Malformed RainViewer response';
          syncPanel();
          return false;
        }
        _host = parsed.host;
        const wasAtLiveEdge = _frameIndex < 0 || _frameIndex === selectLatestPastFrameIndex(_frames);
        _frames = parsed.frames;
        _lastUpdate = Date.now();
        _lastError = null;
        if (_enabled) {
          const targetIndex = wasAtLiveEdge
            ? selectLatestPastFrameIndex(_frames)
            : Math.min(_frameIndex, _frames.length - 1);
          if (targetIndex >= 0) showFrame(targetIndex);
        }
        syncPanel();
        console.log(`[Data:WeatherRadar] Updated: ${_frames.length} frames`);
        return true;
      } catch (e) {
        console.warn('[Data:WeatherRadar] Fetch error:', e);
        _lastError = 'RainViewer network error';
        syncPanel();
        return false;
      }
    },

    destroy(viewer) {
      pause();
      _enabled = false;
      if (_viewer) {
        for (const slot of Object.values(_slots)) {
          if (slot?.imageryLayer) _viewer.imageryLayers.remove(slot.imageryLayer, true);
        }
      }
      _slots.A = null;
      _slots.B = null;
      _frames = [];
      _frameIndex = -1;
      _lastUpdate = null;
      _lastError = null;
      if (_panelEl?.parentNode) _panelEl.parentNode.removeChild(_panelEl);
      _panelEl = null;
      _els = {};
      _viewer = null;
    },

    getStats() {
      return {
        count: _frames.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        frameIndex: _frameIndex,
        playing: _playing,
      };
    },
  };
  return layer;
}

const weatherRadarLayer = createWeatherRadarLayer();

export default weatherRadarLayer;
