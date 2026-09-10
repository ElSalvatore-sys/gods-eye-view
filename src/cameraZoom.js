// @ts-nocheck
import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';

/**
 * Cursor-anchored, surface-relative wheel zoom.
 *
 * WHY THIS EXISTS — the measured defect
 * -------------------------------------
 * Cesium's `ScreenSpaceCameraController` derives its per-notch zoom step from
 * `pickPosition` sampled at the CANVAS CENTRE, then falls back to the camera's
 * raw height above the WGS84 ellipsoid whenever that pick misses:
 *
 *     if (!defined(distance2)) distance2 = height;
 *
 * The fallback path is `globe.pickWorldCoordinates`, which iterates
 * `globe._surface._tilesRenderedThisFrame`. `src/main.js` sets
 * `globe.show = false` (Google Photorealistic 3D Tiles supply the surface), so
 * that list is ALWAYS empty and the fallback ALWAYS misses. Ellipsoid height
 * has no relationship to the visible photoreal surface: over a city at 1,600 m
 * elevation the two disagree by multiples.
 *
 * Measured with `scripts/qa-zoom-probe.mjs` — ratio of ellipsoid height to true
 * distance-to-surface, sampled 25× per scene:
 *
 *     Denver (terrain ~1,600 m)  mean 2.70x   range 1.47x - 3.21x
 *
 * A zoom step scaled by 1.5x-3.2x the correct distance is exactly the reported
 * symptom: it crawls in one place and lunges through the ground in another,
 * changing behaviour as you fly. (The Manhattan and open-ocean scenes in that
 * probe sit near 0.55x, which is just the -35 deg camera pitch making the centre
 * ray longer than the drop — geometry, not the bug. Terrain elevation is the
 * signal.)
 *
 * Cesium also zooms toward the screen centre rather than the pointer, so the
 * thing under the cursor drifts away as you approach it.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * Take WHEEL off Cesium's controller and drive zoom here:
 *   1. pick the world point under the CURSOR (depth buffer sees the tileset);
 *   2. step a fraction of the true distance to THAT point;
 *   3. move along the camera->point ray, so the point stays under the cursor.
 *
 * Every other gesture — drag to pan, right-drag/middle-drag to tilt, pinch —
 * stays with Cesium untouched.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 * -----------------------------------
 * Tracked flight (`src/data/trackedCamera.js` already sets `inertiaZoom = 0`
 * and raises `minimumZoomDistance`), Cockpit (`enableInputs = false`), and any
 * non-identity `camera.transform` (orbit / launch-pad framing, where Cesium
 * switches to a simpler, well-behaved ellipsoid-relative zoom). In those states
 * this module stands down and restores Cesium's own WHEEL handling, so the
 * modes that already work keep working.
 *
 * @module cameraZoom
 */

/** Fraction of the distance-to-surface covered by one wheel notch. */
const STEP_FRACTION = 0.18;

/** Never move less than this per notch, or zooming stalls at close range. */
const MIN_STEP_M = 0.5;

/** Never move more than this per notch, so one flick cannot cross a continent. */
const MAX_STEP_M = 2_000_000;

/** Stop this far short of the picked surface — the "do not fly through the roof" floor. */
const SURFACE_MARGIN_M = 2.0;

/** Ceiling, a little beyond geostationary, so zooming out cannot lose the globe. */
const MAX_CAMERA_HEIGHT_M = 45_000_000;

/**
 * Signed distance to move the camera along the camera->cursor ray for one wheel
 * event. Pure, and exported for `src/cameraZoom.test.mjs`: the browser probe
 * cannot cover this on a machine where the photoreal tileset does not render,
 * and this is the arithmetic that actually had the bug.
 *
 * The contract, in one line: the step is always a bounded FRACTION of the true
 * distance to the surface — never a multiple of it (Cesium's ellipsoid-height
 * fallback reached 3.2x), and never zero (which reads as a dead wheel).
 *
 * @param {object} input
 * @param {number} input.distance metres from camera to the picked point
 * @param {number} input.notches signed wheel notches; negative zooms in
 * @param {boolean} input.onSurface whether the pick landed on real geometry
 * @returns {number} signed metres to move; positive moves toward the point
 */
export function computeZoomStep({ distance, notches, onSurface }) {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  if (!Number.isFinite(notches) || notches === 0) return 0;

  const magnitude = Math.min(
    MAX_STEP_M,
    Math.max(MIN_STEP_M, distance * STEP_FRACTION * Math.abs(notches)),
  );
  const zoomingIn = notches < 0;
  let step = zoomingIn ? magnitude : -magnitude;

  if (zoomingIn && onSurface) {
    // Stop short of the surface rather than through it. Without this a fast
    // scroll parks the camera inside the building it was approaching.
    step = Math.min(step, Math.max(0, distance - SURFACE_MARGIN_M));
  }
  return step;
}

/**
 * Trackpads emit many small deltas and mice emit few large ones. Normalising to
 * notches keeps the two feeling the same instead of making a trackpad crawl.
 * Exported for the same reason as `computeZoomStep`.
 */
export function wheelNotches(event) {
  const mode = event.deltaMode;
  // 0 = pixels, 1 = lines, 2 = pages.
  const perNotch = mode === 1 ? 16 : mode === 2 ? 400 : 100;
  const raw = event.deltaY / perNotch;
  // Clamp so a violent flick or a momentum burst cannot produce a huge jump.
  return Math.max(-3, Math.min(3, raw));
}

/**
 * Lowest elevation a RENDERED surface can plausibly sit at. The deepest ocean
 * trench is about -11 km, but nothing is drawn down there: with the globe
 * hidden, the only geometry is photoreal tiles, whose floor is sea level.
 */
const MIN_PLAUSIBLE_SURFACE_M = -1000;

/**
 * Reject a depth-buffer pick that is not a real surface.
 *
 * `scene.pickPosition` does NOT return undefined when the depth buffer is empty
 * at that pixel — it returns a point reconstructed from cleared depth, which
 * lands deep inside the planet. Measured over Denver before this guard existed:
 * the "surface" came back at -13,623 m and the camera duly dived to -976 km.
 *
 * That is the same failure shape as the Cesium bug this module replaces: a pick
 * that silently degrades instead of failing. So the pick is only trusted when
 * the point it returns could actually be ground.
 *
 * @returns {boolean}
 */
function isPlausibleSurfacePoint(point, camera) {
  if (!Cesium.defined(point) || Cesium.Cartesian3.magnitude(point) <= 1) return false;
  const carto = Cesium.Cartographic.fromCartesian(point);
  if (!carto || !Number.isFinite(carto.height)) return false;
  if (carto.height < MIN_PLAUSIBLE_SURFACE_M) return false;
  // Ground far ABOVE the camera is not what the user is zooming toward; allow
  // headroom for looking up at terrain, but not an arbitrary reconstruction.
  const cameraHeight = camera.positionCartographic?.height;
  if (Number.isFinite(cameraHeight) && carto.height > cameraHeight + 20_000) return false;
  return true;
}

/**
 * World point under the cursor.
 *
 * `scene.pickPosition` reads the depth buffer, which DOES see the photoreal
 * tileset even with the globe hidden. On a miss (sky, a still-streaming tile,
 * a gap) fall back to the ellipsoid ray — not to camera height, which is the
 * whole bug being fixed here.
 *
 * @returns {{point: Cesium.Cartesian3, onSurface: boolean}|null}
 */
function pickUnderCursor(scene, windowPosition, result) {
  if (scene.pickPositionSupported) {
    const picked = scene.pickPosition(windowPosition, result);
    if (isPlausibleSurfacePoint(picked, scene.camera)) {
      return { point: picked, onSurface: true };
    }
  }
  const ray = scene.camera.getPickRay(windowPosition);
  if (!ray) return null;
  const globePoint = scene.globe?.pick?.(ray, scene);
  if (Cesium.defined(globePoint)) return { point: globePoint, onSurface: true };
  const ellipsoidPoint = scene.camera.pickEllipsoid(windowPosition, scene.globe?.ellipsoid);
  if (Cesium.defined(ellipsoidPoint)) return { point: ellipsoidPoint, onSurface: false };
  return null;
}

/**
 * Install cursor-anchored zoom on the viewer.
 * @param {Cesium.Viewer} viewer
 * @returns {() => void} disposer
 */
export function installCameraZoom(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const controller = scene.screenSpaceCameraController;
  if (!controller) return () => {};

  const defaultZoomEvents = controller.zoomEventTypes;
  // Cesium's default is [RIGHT_DRAG, WHEEL, PINCH]. Keep the other two.
  const withoutWheel = (Array.isArray(defaultZoomEvents) ? defaultZoomEvents : [defaultZoomEvents])
    .filter((type) => type !== Cesium.CameraEventType.WHEEL);

  const scratchWindow = new Cesium.Cartesian2();
  const scratchPick = new Cesium.Cartesian3();
  const scratchDirection = new Cesium.Cartesian3();
  const scratchOffset = new Cesium.Cartesian3();

  /**
   * True while another system owns the camera. Checked per event rather than
   * cached: tracking and Cockpit are entered and left constantly.
   */
  function delegatedToCesium() {
    if (!controller.enableInputs) return true;            // Cockpit, gizmo drags
    if (Cesium.defined(viewer.trackedEntity)) return true; // trackedCamera.js owns zoom
    // A non-identity transform means orbit / lookAtTransform framing, where
    // Cesium's own zoom is already the well-behaved path.
    return !Cesium.Matrix4.equals(scene.camera.transform, Cesium.Matrix4.IDENTITY);
  }

  function syncControllerZoomEvents() {
    const shouldOwnWheel = !delegatedToCesium();
    const desired = shouldOwnWheel ? withoutWheel : defaultZoomEvents;
    if (controller.zoomEventTypes !== desired) controller.zoomEventTypes = desired;
  }

  function onWheel(event) {
    syncControllerZoomEvents();
    if (delegatedToCesium()) return;

    const notches = wheelNotches(event);
    if (!notches) return;
    const zoomingIn = notches < 0;

    // Cesium's controller no longer handles WHEEL, so nothing else will act on
    // this event; preventing the default stops the page/gesture zoom instead.
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    scratchWindow.x = event.clientX - rect.left;
    scratchWindow.y = event.clientY - rect.top;

    const hit = pickUnderCursor(scene, scratchWindow, scratchPick);
    if (!hit) return;

    const camera = scene.camera;
    const distance = Cesium.Cartesian3.distance(camera.positionWC, hit.point);
    if (!Number.isFinite(distance) || distance <= 0) return;

    // THE FIX: the step is a fraction of the distance to the point the user is
    // actually looking at, never the camera's height over a hidden ellipsoid.
    const step = computeZoomStep({ distance, notches, onSurface: hit.onSurface });
    if (step === 0) return;

    // Toward the cursor point going in; straight back out along the same ray
    // going out, so in and out retrace one another.
    Cesium.Cartesian3.subtract(hit.point, camera.positionWC, scratchDirection);
    Cesium.Cartesian3.normalize(scratchDirection, scratchDirection);

    Cesium.Cartesian3.multiplyByScalar(scratchDirection, step, scratchOffset);
    const nextPosition = Cesium.Cartesian3.add(camera.positionWC, scratchOffset, new Cesium.Cartesian3());

    const nextCarto = Cesium.Cartographic.fromCartesian(nextPosition);
    if (!nextCarto || !Number.isFinite(nextCarto.height)) return;
    // Backstop, independent of the pick: never end a zoom underground, and
    // never lose the globe off the top. The surface-margin clamp above is the
    // precise guard; this one holds even if a pick slipped through.
    if (nextCarto.height < MIN_PLAUSIBLE_SURFACE_M) return;
    if (!zoomingIn && nextCarto.height > MAX_CAMERA_HEIGHT_M) return;

    camera.position = nextPosition;
    // The governor idles the render loop; a discrete mutation must ask for a
    // frame or the move is invisible until something else repaints.
    governorRequestRender('camera-zoom');
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  syncControllerZoomEvents();

  return function dispose() {
    canvas.removeEventListener('wheel', onWheel);
    controller.zoomEventTypes = defaultZoomEvents;
  };
}
