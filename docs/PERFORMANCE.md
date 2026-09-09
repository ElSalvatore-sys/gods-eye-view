# Performance baseline

This page records one hardware-rendered Apple M5 comparison captured on 22
August 2026 in Chrome 150 at 1440 x 900. It is not a minimum hardware
specification and should not be used to predict performance on untested systems.
The original capture artifacts are not included here, so this page records
results rather than defining a runnable benchmark.

## Test context

The baseline was captured on 22 August 2026 with these conditions:

| Setting | Value |
| --- | --- |
| Renderer | Apple M5 Metal through the hardware ANGLE path |
| Browser | Chrome 150 in a fresh isolated profile |
| Viewport | 1440 x 900 at device pixel ratio 1 |
| Focus | Page foregrounded for controlled scenes |
| Scene sample | 5 seconds of scripted motion, then 5 seconds at rest |
| Startup | Browser cache disabled; three samples |

The capture covered three startup samples, 16 cold layer scenarios with 14
measurements, 23 controlled option and stress scenes, and five
hardware-rendered overlay scenes.

## Startup

| Sample | App ready | Initial settle | Load event | Motion / rest | Used JS heap |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 784.980 ms | 2,035.082 ms | 439.5 ms | 60 / 60 FPS | 102.9 MiB |
| 2 | 604.849 ms | 1,855.836 ms | 442.4 ms | 60 / 60 FPS | 111.6 MiB |
| 3 | 558.527 ms | 1,809.592 ms | 438.8 ms | 60 / 60 FPS | 105.1 MiB |
| Median | 604.849 ms | 1,855.836 ms | 439.5 ms | 60 / 60 FPS | 105.1 MiB |

The initial-settle measurement is the more useful launch reference because it
includes the first visual and data settling window. All three samples reached
the display ceiling during both motion and rest.

## Cold layer activation

Cold activation was measured separately from warm option switching. Live object
counts are included so that future runs can compare source populations before
attributing a difference to the client.

| Layer | Activation | Source count | Motion / rest | Used JS heap |
| --- | ---: | ---: | ---: | ---: |
| CCTV city | 19,608.240 ms | 48 | 60 / 60 FPS | 192.7 MiB |
| Space Missions (report label: Rocket missions) | 3,581.066 ms | 26 | 60 / 60 FPS | 131.3 MiB |
| Radio | 3,458.709 ms | 750 | 60 / 60 FPS | 124.8 MiB |
| Bikeshare | 2,069.498 ms | 633 | 60 / 60 FPS | 157.4 MiB |
| Datacenters | 817.693 ms | 4,362 | 59.6 / 60 FPS | 328.2 MiB |
| Flights | 667.671 ms | 247 | 60 / 60 FPS | 118.4 MiB |
| Submarine cables | 614.727 ms | 2,629 | 60 / 60 FPS | 412.0 MiB |
| Military Flights | 557.113 ms | 68 | 60 / 60 FPS | 118.4 MiB |

CCTV had the largest cold activation cost in this capture. Submarine cables
used the most heap, followed by datacenters. Completed single-layer samples
generally reached 60 FPS, so activation time and heap separate these cases more
clearly than steady-state frame rate.

## Aircraft, detection, and Cockpit

| Scene | Motion / rest |
| --- | ---: |
| Idle globe | 60 / 60 FPS |
| Flights, 2D | 60 / 60 FPS |
| Flights, 3D proximity | 60 / 60 FPS |
| Flights, all 3D models | 60 / 60 FPS |
| Military Flights, all 3D models | 60 / 60 FPS |
| Detection at 25% | 39.3 / 41.1 FPS |
| Detection at 50% | 37.4 / 39.8 FPS |
| Detection at 100% | 34.4 / 35.5 FPS |
| Cockpit | 49.6 / 49.2 FPS |

The clean detection scenes processed 8,169 to 8,170 observations. Selected
labels rose from 14 at 25% density to 28 at 50% and 56 at 100%. The aircraft
rows came from an earlier loaded, foreground-controlled pass because the clean
rerun received no live aircraft rows.

## Visual styles and combined stress

| Scene | Motion / rest |
| --- | ---: |
| Normal | 60 / 60 FPS |
| CRT (report label: Retro) | 60 / 60 FPS |
| NVG (report label: Surveillance) | 60 / 60 FPS |
| FLIR (report label: Thermal) | 49 / 60 FPS |
| Anime | 60 / 59.8 FPS |
| Noir | 47 / 56.6 FPS |
| Snow | 42.3 / 45.8 FPS |
| Combined static | 57.6 / 60 FPS |
| Combined operational | 39.9 / 43.1 FPS |

The combined static scene rendered 11,575 objects, used 872.2 MiB of JavaScript
heap, and issued 48,665 text draws during motion and 54,106 at rest. The combined
operational sample contained 3,909 observations and two selected labels, but its
live aircraft and traffic rows were empty, so it remains a limited stress case.

Snow, Noir, dense detection, and text-heavy combined layers are the clearest
controlled comparison points for later optimization work.

## Keyed live sources

NASA FIRMS, AISStream, and TomTom were captured in a separate hardware-rendered
pass. The page was visible but was not the focused window, so these frame rates
must not be compared directly with the foreground-controlled scenes above.

| Source | Point-in-time population | Activation or coverage | Motion / rest |
| --- | ---: | --- | ---: |
| NASA FIRMS | 100,430 detections in 3,557 cells | 30.0 s activation | 32.1 / 55.2 FPS |
| AISStream | 12,000 vessels | 6.4 s activation | 22.1 / 29.8 FPS |
| TomTom Traffic | 4,222 road dots | 70% coverage, 2 decoded tiles | 45.0 / 51.7 FPS |

These populations change continuously. A future comparison must record the
live counts again and match the focus conditions.

## Controls for a future capture

Use the same controls before attributing a difference to the application:

1. Record the exact GPU renderer and reject software-rendered or unavailable GPU
   strings.
2. Use a 1440 x 900 viewport at device pixel ratio 1 and keep the page focused.
3. Measure cache-disabled startup separately from cold layer activation and warm
   option switching.
4. Repeat startup three times and compare medians.
5. Sample each option for 5 seconds in scripted motion and 5 seconds at rest.
6. Record live object counts before attributing a difference to the client.
7. Treat a live-source outage as missing coverage, not as evidence of low client
   rendering cost.

## Detection overlay: projection vs. draw calls (perf-detection-offscreen)

Idea #3 proposed moving the detection overlay's box/label drawing to an
OffscreenCanvas worker, leaving only the screen-space projection (which needs
Cesium's camera/view-projection matrix) on the main thread. Before building
that, `detection.js` was instrumented with a same-pattern diagnostic split
next to its existing `paintMs`/`solveMs` fields (see `getDetectionDiagnostics()`):

- `projectionMs` — the per-object loop (view-projection matrix multiply,
  ellipsoid occlusion cull, bracket-alpha/path-building, label-cohort
  bookkeeping) plus the label-arbiter solve and the render-entry bookkeeping
  that turns a solve into replayable callout rows.
- `drawMs` — the actual `CanvasRenderingContext2D` calls: the batched bracket
  `stroke()` calls, scanlines, the sparse-focus ring, and the mode banner.
- `calloutMs` — the callout lane's own canvas calls (plate, accent bar, id/
  metric text), timed separately because it paints in its own host lane after
  the sensor/bracket lane.

Measured with `node scripts/qa-overlay-baseline.mjs --scene
detection-25,detection-50,detection-100 --url http://localhost:4209`, both
under the default SwiftShader software renderer and with `--hardware-gpu`
(Apple M2 Pro, Metal), sampling `window.__godsEyeView.styleManager
.getDetectionDiagnostics()` at rest. At the ~8,000-8,170-observation
population this report's baseline used (OpenSky's live flight count varies
run to run — a `--hardware-gpu` capture on the same day saw as few as ~1,230
observations when the feed happened to be sparse):

| Density | observations | visible | selected | projectionMs | solveMs | drawMs | calloutMs | draw share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 25% (SwiftShader) | 8,057 | 4,053 | 14 | 2.6 | 0.0 | 0.3 | 0.1 | 13.3% |
| 50% (SwiftShader) | 8,057 | 4,067 | 28 | 2.6 | 0.1 | 0.2 | 0.3 | 15.6% |
| 100% (SwiftShader) | 8,058 | 4,068 | 56 | 2.6 | 0.2 | 0.2 | 0.3 | 15.2% |
| 100% (SwiftShader, repeat ×2) | 8,011 | 4,048–4,055 | 56 | 2.6 | 0.4 | 0.3 | 0.3–0.4 | ≈17.8% |
| 100% (`--hardware-gpu`) | 7,993 | 4,458 | 56 | 1.8 | 0.0 | 0.3 | 0.3 | 25.0% |

`draw share` = `(drawMs + calloutMs) / (projectionMs + solveMs + drawMs +
calloutMs)`. Every capture puts drawing well under half the mission's 30%
worth-building threshold, at all three densities, on both renderer backends.
`drawMs` and `calloutMs` barely move with density (they scale with the
*visible/labeled* count, ~4,000 brackets and 14-56 labels throughout) while
`projectionMs` scales with the *observation* count, which is the same
~8,000-object pool at every density stop — projection over the full candidate
pool, not drawing, is what detection at higher density actually costs more
of. (The one low-observation `--hardware-gpu` sample, ~1,230 objects, pushed
the draw share to ~30-40% — but that is the live feed happening to be sparse
that run, not the documented baseline population above.)

**VERDICT: NOT-WORTH-IT.** Drawing is not the dominant cost at the density
levels and object population this report's 39/37/34 FPS finding was measured
against, so per the mission brief no OffscreenCanvas worker was built — the
IPC/message-passing and Float32Array-transfer overhead of a worker split would
be spent moving a sub-millisecond `drawMs`/`calloutMs` off-thread while
leaving the actual bottleneck (per-object projection over ~8,000 candidates,
already necessarily on the main thread for its Cesium camera/matrix reads) in
place.

## What is not established yet

- This report does not establish Windows performance.
- The report does not record machine memory capacity, so it cannot support a
  minimum-memory recommendation.
- The report does not cover other GPU renderers or viewport configurations.
- Military Installations is outside this comparison because it requires close
  camera context.
- The keyed pass has no controlled rerun suitable for comparison with the
  option scenes.

Use this page as a regression baseline for one known hardware and browser
configuration, not as a compatibility guarantee.
