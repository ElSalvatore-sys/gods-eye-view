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
    name: 'capture_view',
    description: 'Take a small picture of what the globe shows right now, to look at it (signs, places, what is in view).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
]);

export const JARVIS_EXTRA_NAMES = new Set(JARVIS_EXTRA_TOOLS.map((t) => t.name));

const CAPTURE_MAX_WIDTH = 768;

/** Grab the Cesium canvas right after a frame was drawn (the drawing buffer is only valid then), scaled down. */
function captureCanvas(viewer) {
  return new Promise((resolve) => {
    if (!viewer?.scene?.postRender || !viewer.canvas) {
      resolve(null);
      return;
    }
    const remove = viewer.scene.postRender.addEventListener(() => {
      remove();
      try {
        const src = viewer.canvas;
        const scale = Math.min(1, CAPTURE_MAX_WIDTH / Math.max(1, src.width));
        const out = document.createElement('canvas');
        out.width = Math.round(src.width * scale);
        out.height = Math.round(src.height * scale);
        out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
        resolve(out.toDataURL('image/jpeg', 0.7));
      } catch {
        resolve(null);
      }
    });
    viewer.scene.requestRender();
  });
}

/**
 * Run one Jarvis tool with the page's own action runner.
 * @param {string} name
 * @param {object} args
 * @param {{ runner: (name: string, args?: object) => Promise<object>, viewer?: object }} deps
 */
export async function runJarvisExtra(name, args = {}, { runner, viewer } = {}) {
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
  if (name === 'capture_view') {
    const image = await captureCanvas(viewer);
    return image ? { ok: true, image } : { ok: false, error: 'no_picture' };
  }
  return { ok: false, error: 'unknown_tool' };
}
