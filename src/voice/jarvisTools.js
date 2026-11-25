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
      + 'annotate_map, with the drawing\'s points (or its centre and size). circle=false only frames it.',
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
    name: 'capture_view',
    description: 'Take a small picture of what the globe shows right now, to look at it (signs, places, what is in view).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
]);

export const JARVIS_EXTRA_NAMES = new Set(JARVIS_EXTRA_TOOLS.map((t) => t.name));

const FRAME_RANGE_FACTOR = 1.4; // camera range per km of drawing: the whole drawing in view, a margin round it
const FRAME_MIN_M = 1500;
const FRAME_MAX_M = 6000000;
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
 * @param {{ runner: (name: string, args?: object) => Promise<object>, capture?: () => Promise<string|null> }} deps
 */
export async function runJarvisExtra(name, args = {}, { runner, capture } = {}) {
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
    const rangeM = Math.round(Math.min(Math.max(frame.sizeKm * 1000 * FRAME_RANGE_FACTOR, FRAME_MIN_M), FRAME_MAX_M));
    const flown = await runner('fly_to_location', { latitude: frame.latitude, longitude: frame.longitude, rangeM, waitForArrival: true });
    if (!flown || flown.ok === false) return { ok: false, step: 'fly_to_location', flown };
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
