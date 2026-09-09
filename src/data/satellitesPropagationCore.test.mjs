import assert from 'node:assert/strict';
import test from 'node:test';
import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';
import { propagateBatch } from './satellitesPropagationCore.js';

// Three real TLEs (ISS + two other stations), fixed rather than read from the
// runtime `.gev-cache/` fetch cache so this test has no network/cache
// dependency and stays deterministic.
const TLES = [
  {
    name: 'ISS (ZARYA)',
    line1: '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
    line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  },
  {
    name: 'TIANGONG',
    line1: '1 48274U 21035A   24001.50000000  .00012000  00000-0  15000-3 0  9991',
    line2: '2 48274  41.4700 100.0000 0005000  90.0000 270.0000 15.60000000100002',
  },
  {
    name: 'CSS (TIANHE)',
    line1: '1 48276U 21035C   24010.25000000  .00008000  00000-0  10000-3 0  9994',
    line2: '2 48276  41.4750 150.0000 0004500  80.0000 280.0000 15.61000000101003',
  },
];

/** Direct (non-batched) reference propagation, mirroring `propagatePosition` in satellites.js. */
function referenceLla(satrec, date) {
  const posVel = propagate(satrec, date);
  if (!posVel.position || typeof posVel.position === 'boolean') return [NaN, NaN, NaN];
  const gmst = gstime(date);
  const geo = eciToGeodetic(posVel.position, gmst);
  return [degreesLat(geo.latitude), degreesLong(geo.longitude), geo.height * 1000];
}

test('propagateBatch matches direct satellite.js propagation within 1e-6 for known TLEs', () => {
  const entries = TLES.map((t) => ({ id: t.name, satrec: twoline2satrec(t.line1, t.line2) }));
  for (const e of entries) assert.equal(e.satrec.error, 0, `${e.id} TLE must parse cleanly`);

  const dateMs = Date.UTC(2024, 0, 15, 12, 0, 0);
  const date = new Date(dateMs);
  const lla = propagateBatch(entries, dateMs);

  assert.equal(lla.length, entries.length * 3);

  entries.forEach((e, i) => {
    const [expLat, expLon, expAlt] = referenceLla(e.satrec, date);
    const offset = i * 3;
    assert.ok(Number.isFinite(lla[offset]), `${e.id} lat must be finite`);
    assert.ok(Math.abs(lla[offset] - expLat) < 1e-6, `${e.id} lat mismatch`);
    assert.ok(Math.abs(lla[offset + 1] - expLon) < 1e-6, `${e.id} lon mismatch`);
    assert.ok(Math.abs(lla[offset + 2] - expAlt) < 1e-6, `${e.id} alt mismatch`);
  });
});

test('propagateBatch yields NaN triples for a satrec that fails to propagate, without throwing', () => {
  const badSatrec = { error: 0 }; // missing SGP4 fields — satellite.js propagate() will throw internally
  const entries = [{ id: 'bad', satrec: badSatrec }];
  const lla = propagateBatch(entries, Date.now());
  assert.equal(lla.length, 3);
  assert.ok(Number.isNaN(lla[0]) && Number.isNaN(lla[1]) && Number.isNaN(lla[2]));
});

test('propagateBatch preserves input order across a mixed batch', () => {
  const entries = TLES.map((t) => ({ id: t.name, satrec: twoline2satrec(t.line1, t.line2) }));
  const dateMs = Date.UTC(2024, 0, 15, 12, 0, 0);
  const forward = propagateBatch(entries, dateMs);
  const reversed = propagateBatch([...entries].reverse(), dateMs);
  // Same epoch, so each satellite's triple must be identical regardless of
  // batch order — reversedTriple(i) should equal forwardTriple(N-1-i).
  const n = entries.length;
  for (let i = 0; i < n; i++) {
    const f = forward.slice(i * 3, i * 3 + 3);
    const r = reversed.slice((n - 1 - i) * 3, (n - 1 - i) * 3 + 3);
    assert.deepEqual(Array.from(f), Array.from(r));
  }
});
