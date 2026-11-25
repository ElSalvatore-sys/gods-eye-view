/**
 * Tools that exist only for Jarvis (the owner's office voice assistant), next to the 31 voice tools in
 * server/routes/realtime.js. Shared by the server (their schemas, served at /api/jarvis/tools) and the page
 * (runJarvisExtra runs them with the normal action runner). Pure data and plain JavaScript: no Node or DOM imports.
 *
 * @module voice/jarvisTools
 */

export const JARVIS_EXTRA_TOOLS = Object.freeze([
  {
    type: 'function',
    name: 'first_person_nearest_aircraft',
    description: 'Put the owner in first person (the cockpit view) inside the nearest airborne aircraft near a place: '
      + 'turns on Flights, flies there, selects the closest airborne plane, then enters Cockpit. Use for "first person", '
      + '"inside the plane", "fly in the closest plane near X".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place: { type: 'string', maxLength: 160, description: 'City, airport or region, e.g. "Frankfurt".' },
        layerId: { type: 'string', enum: ['flights', 'military'], description: 'military only when asked for military aircraft.' },
      },
      required: ['place'],
    },
  },
  {
    type: 'function',
    name: 'leave_cockpit',
    description: 'Leave the first-person cockpit view and give the camera back.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    type: 'function',
    name: 'frame_and_circle',
    description: 'Show what you drew: fly from above and a little to the side so the whole drawing is in view (the height '
      + 'follows its size), wait until the camera arrives, then circle it slowly at -45 degrees. Use right after '
      + 'annotate_map, with the drawing\'s points (or its centre and size). circle=false only frames it. A drawing wider '
      + 'than 1,500 km (places on different coasts) is framed from higher and not circled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        points: {
          type: 'array', minItems: 1, maxItems: 50, description: 'The drawing\'s points, in any order.',
          items: {
            type: 'object', additionalProperties: false, required: ['lat', 'lon'],
            properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 } },
          },
        },
        latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Centre, when no points are given.' },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        sizeKm: { type: 'number', minimum: 0.2, maximum: 4000, description: 'How wide the drawing is, with a centre.' },
        circle: { type: 'boolean', description: 'false: frame only, no circling. Default true.' },
      },
    },
  },
  {
    type: 'function',
    name: 'visit_stop',
    description: 'One stop of a tour or a documentary: fly to a place at city size (30 km) unless he asked to go closer, '
      + 'wait until the camera arrives, then hold a few seconds so the map can draw. Visit stops one at a time and talk '
      + 'about each between visits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place: { type: 'string', maxLength: 160, description: 'A place name, or give latitude and longitude.' },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        rangeKm: { type: 'number', minimum: 0.5, maximum: 3000, description: 'Camera distance. 30 = city size (default); '
          + 'about 5-10 to look at one damaged place; smaller only when he asks.' },
        holdS: { type: 'number', minimum: 0, maximum: 15, description: 'Seconds to stay before the next stop. Default 3.' },
      },
    },
  },
  {
    type: 'function',
    name: 'zoom_step',
    description: 'Zoom in or out the way he expects: from far away (a country, the globe) zoom in goes to city size first, '
      + 'then each zoom in is a small step closer; zoom out is a normal step back. Use for "zoom in", "zoom out", "closer".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { direction: { type: 'string', enum: ['in', 'out'] } },
      required: ['direction'],
    },
  },
  {
    type: 'function',
    name: 'capture_view',
    description: 'Take a small picture of what the globe shows right now, to look at it (signs, places, what is in view).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
]);

export const JARVIS_EXTRA_NAMES = new Set(JARVIS_EXTRA_TOOLS.map((t) => t.name));

const CITY_M = 30000; // a stop at city size: the owner, 2026-11-25: "keep it zoomed out on the city itself"
const ZOOM_IN_TO_CITY_M = 40000; // zoom in from farther than FAR_M lands here first
const FAR_M = 150000;
const HOLD_MS = 3000; // a stop stays this long so the map can draw ("a bit slower so it could render for me")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FRAME_RANGE_FACTOR = 1.4; // camera range per km of drawing: the whole drawing in view, a margin round it
const FRAME_MIN_M = 1500;
const FRAME_MAX_M = 6000000;
// Wider than this (points on different coasts or continents): frame from higher and do not circle. Live 2026-11-25:
// an orbit round a 5,000 km frame swung one pin to the horizon.
const WIDE_KM = 1500;
const WIDE_RANGE_FACTOR = 2.2;
const WIDE_MAX_M = 12000000;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQUATOR = 111.32;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** The centre and size (km, the box's diagonal) of a drawing, from its points or from a given centre and size. */
export function drawingFrame(args = {}) {
  const points = (Array.isArray(args.points) ? args.points : []).filter((p) => finite(p?.lat) && finite(p?.lon));
  if (points.length) {
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const [south, north, west, east] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    const latitude = (south + north) / 2;
    const dx = (east - west) * Math.cos((latitude * Math.PI) / 180) * KM_PER_DEG_LON_EQUATOR;
    const dy = (north - south) * KM_PER_DEG_LAT;
    return { latitude, longitude: (west + east) / 2, sizeKm: Math.max(Math.hypot(dx, dy), 0.5) };
  }
  if (finite(args.latitude) && finite(args.longitude)) {
    return { latitude: args.latitude, longitude: args.longitude, sizeKm: finite(args.sizeKm) ? args.sizeKm : 5 };
  }
  return null;
}

/** A fresh frame of the globe as a JPEG data URL, through the app's own capture (the renderer's ports, no Cesium). */
async function captureView(capture) {
  try {
    const take = capture ?? (await import('./realtimeViewport.js')).captureViewportImage;
    return (await take()) || null;
  } catch {
    return null;
  }
}

/**
 * Run one Jarvis tool with the page's own action runner.
 * @param {string} name
 * @param {object} args
 * @param {{ runner: (name: string, args?: object) => Promise<object>, capture?: () => Promise<string|null>,
 *   wait?: (ms: number) => Promise<void> }} deps
 */
export async function runJarvisExtra(name, args = {}, { runner, capture, wait = sleep } = {}) {
  if (name === 'visit_stop') {
    const where = finite(args.latitude) && finite(args.longitude)
      ? { latitude: args.latitude, longitude: args.longitude }
      : (String(args.place || '').trim() ? { query: String(args.place).trim().slice(0, 160) } : null);
    if (!where) return { ok: false, error: 'no_place' };
    const rangeM = finite(args.rangeKm) ? Math.round(Math.min(Math.max(args.rangeKm, 0.5), 3000) * 1000) : CITY_M;
    const flown = await runner('fly_to_location', { ...where, rangeM, waitForArrival: true });
    if (!flown || flown.ok === false) return { ok: false, step: 'fly_to_location', flown };
    const holdMs = finite(args.holdS) ? Math.min(Math.max(args.holdS, 0), 15) * 1000 : HOLD_MS;
    if (holdMs > 0) await wait(holdMs);
    return { ok: true, flown, rangeM };
  }
  if (name === 'zoom_step') {
    const direction = args.direction === 'out' ? 'out' : 'in';
    const view = await runner('get_current_view_state', {});
    const camera = view?.camera || {};
    if (direction === 'in' && finite(camera.heightM) && camera.heightM > FAR_M && finite(camera.latitude) && finite(camera.longitude)) {
      const flown = await runner('fly_to_location', { latitude: camera.latitude, longitude: camera.longitude,
        rangeM: ZOOM_IN_TO_CITY_M, waitForArrival: true });
      return { ok: flown?.ok !== false, flown, to: 'city' };
    }
    const zoom = await runner('adjust_camera_zoom', { direction, amount: direction === 'in' ? 'little' : 'medium' });
    return { ok: zoom?.ok !== false, zoom };
  }
  if (name === 'first_person_nearest_aircraft') {
    const layerId = args.layerId === 'military' ? 'military' : 'flights';
    const selected = await runner('select_nearest_aircraft', { layerId, locationQuery: String(args.place || '').slice(0, 160) });
    if (!selected || selected.ok === false) return { ok: false, step: 'select_nearest_aircraft', selected };
    const cockpit = await runner('control_cockpit', { action: 'enter' });
    return { ok: cockpit?.ok !== false, selected, cockpit };
  }
  if (name === 'leave_cockpit') {
    const cockpit = await runner('control_cockpit', { action: 'exit' });
    return { ok: cockpit?.ok !== false, cockpit };
  }
  if (name === 'frame_and_circle') {
    const frame = drawingFrame(args);
    if (!frame) return { ok: false, error: 'no_points' };
    const wide = frame.sizeKm > WIDE_KM;
    const rangeM = wide
      ? Math.round(Math.min(frame.sizeKm * 1000 * WIDE_RANGE_FACTOR, WIDE_MAX_M))
      : Math.round(Math.min(Math.max(frame.sizeKm * 1000 * FRAME_RANGE_FACTOR, FRAME_MIN_M), FRAME_MAX_M));
    const flown = await runner('fly_to_location', { latitude: frame.latitude, longitude: frame.longitude, rangeM, waitForArrival: true });
    if (!flown || flown.ok === false) return { ok: false, step: 'fly_to_location', flown };
    if (wide) return { ok: true, flown, rangeM, wide: true };
    if (args.circle === false) return { ok: true, flown, rangeM };
    const orbit = await runner('move_camera', { motion: 'orbit', speed: 'slow', mode: 'continuous', pitchDeg: -45 });
    return { ok: orbit?.ok !== false, flown, orbit, rangeM };
  }
  if (name === 'capture_view') {
    const image = await captureView(capture);
    return image ? { ok: true, image } : { ok: false, error: 'no_picture' };
  }
  return { ok: false, error: 'unknown_tool' };
}
