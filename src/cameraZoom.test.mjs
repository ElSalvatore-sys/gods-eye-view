import assert from 'node:assert/strict';
import test from 'node:test';
import { computeZoomStep, wheelNotches } from './cameraZoom.js';

/**
 * The defect this module exists to fix, restated as arithmetic:
 *
 * Cesium scaled its zoom step from the camera's height above the HIDDEN
 * ellipsoid whenever its canvas-centre depth pick missed — which, with
 * `globe.show = false` and no terrain provider, it always does.
 * `scripts/qa-zoom-probe.mjs` measured that fallback at 1.47x-3.21x the true
 * distance to the visible surface over Denver. A step scaled off the wrong
 * number is what "crawls here, lunges there" actually is.
 *
 * The browser probe cannot cover this on a machine where the photoreal tileset
 * does not render (headless returns an empty depth buffer), so the arithmetic
 * is pinned here instead, where it runs in CI on every push.
 */

test('a zoom step is always a bounded FRACTION of the distance — never a multiple', () => {
  // The original bug produced steps larger than the distance to the surface.
  for (const distance of [50, 500, 5_000, 250_000, 4_000_000]) {
    const step = computeZoomStep({ distance, notches: -1, onSurface: true });
    assert.ok(step > 0, `zooming in must move (distance ${distance})`);
    assert.ok(
      step < distance,
      `a single notch must never cover the whole distance (${step} vs ${distance})`,
    );
    assert.ok(
      step <= distance * 0.5,
      `a notch covered ${(step / distance * 100).toFixed(0)}% of the distance — that is a lunge`,
    );
  }
});

test('the step scales with distance, so zoom feels the same high up and low down', () => {
  // This is the property the ellipsoid-height fallback destroyed: at Denver the
  // "distance" it used was ~2.7x reality, so the same gesture moved ~2.7x too far.
  const near = computeZoomStep({ distance: 1_000, notches: -1, onSurface: true });
  const far = computeZoomStep({ distance: 100_000, notches: -1, onSurface: true });
  assert.ok(far > near, 'a step from further away must be larger in absolute terms');
  const nearFraction = near / 1_000;
  const farFraction = far / 100_000;
  assert.ok(
    Math.abs(nearFraction - farFraction) < 1e-9,
    `the FRACTION must be constant: ${nearFraction} vs ${farFraction}`,
  );
});

test('zooming in never crosses the surface', () => {
  // A violent scroll close to a rooftop must park above it, not inside it.
  const distance = 3;
  const step = computeZoomStep({ distance, notches: -3, onSurface: true });
  assert.ok(step < distance, 'the step must stop short of the picked surface');
  assert.ok(step >= 0, 'and must never invert into a reverse move');
});

test('an off-surface pick is not clamped to a surface that was never found', () => {
  // With no real geometry the ellipsoid ray is a direction, not a floor, so the
  // surface-margin clamp must not pretend otherwise. The caller applies its own
  // absolute height backstop instead.
  const distance = 10;
  const clamped = computeZoomStep({ distance, notches: -3, onSurface: true });
  const unclamped = computeZoomStep({ distance, notches: -3, onSurface: false });
  assert.ok(unclamped >= clamped, 'the off-surface step is not surface-clamped');
});

test('zooming out is the mirror of zooming in, so a gesture retraces itself', () => {
  const inStep = computeZoomStep({ distance: 8_000, notches: -1, onSurface: true });
  const outStep = computeZoomStep({ distance: 8_000, notches: 1, onSurface: true });
  assert.equal(outStep, -inStep, 'in and out must be equal and opposite at equal distance');
});

test('degenerate input is refused rather than moving the camera somewhere absurd', () => {
  assert.equal(computeZoomStep({ distance: 0, notches: -1, onSurface: true }), 0);
  assert.equal(computeZoomStep({ distance: -5, notches: -1, onSurface: true }), 0);
  assert.equal(computeZoomStep({ distance: NaN, notches: -1, onSurface: true }), 0);
  assert.equal(computeZoomStep({ distance: 1_000, notches: 0, onSurface: true }), 0);
  assert.equal(computeZoomStep({ distance: 1_000, notches: NaN, onSurface: true }), 0);
});

test('a huge distance is capped, so one flick cannot cross the planet', () => {
  const step = computeZoomStep({ distance: 40_000_000, notches: -3, onSurface: false });
  assert.ok(step <= 2_000_000, `a single event moved ${step} m`);
});

test('a tiny distance still moves, so the wheel never feels dead', () => {
  const step = computeZoomStep({ distance: 0.4, notches: -1, onSurface: false });
  assert.ok(step > 0, 'a very close camera must still respond to the wheel');
});

// ── wheel normalisation ─────────────────────────────────────────────────────

test('trackpad pixels and mouse lines produce comparable notches', () => {
  // A mouse sends deltaMode 0 with ~100px; a line-mode device sends ~1-3 lines.
  const mouse = wheelNotches({ deltaY: -100, deltaMode: 0 });
  const lines = wheelNotches({ deltaY: -16, deltaMode: 1 });
  assert.equal(mouse, -1);
  assert.equal(lines, -1, 'one line-mode notch must equal one pixel-mode notch');
});

test('a violent flick is clamped instead of teleporting the camera', () => {
  assert.equal(wheelNotches({ deltaY: -100_000, deltaMode: 0 }), -3);
  assert.equal(wheelNotches({ deltaY: 100_000, deltaMode: 0 }), 3);
});

test('a fine trackpad nudge survives as a small fractional notch', () => {
  const nudge = wheelNotches({ deltaY: -4, deltaMode: 0 });
  assert.ok(nudge < 0 && nudge > -0.1, `expected a small negative notch, got ${nudge}`);
});
