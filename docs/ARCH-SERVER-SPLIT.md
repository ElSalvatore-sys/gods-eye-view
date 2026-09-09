# Server split — extracting the `vite.config.js` API layer into `server/`

> Design document for `100.md` idea #7, with the hooks that #4 (SQLite cache),
> #21–25 (launchd + Tailscale + archive), and #27 (local LLM) need in place
> before they can be built independently.
>
> Status: **plan** — no runtime code changes ship with this document.
> Baseline it was written against: `main` @ `aa47445`, `vite.config.js` 7,798
> lines / 342 KB, `npm test` 2,706 pass / 0 fail.

---

## 1. What is actually in there

`vite.config.js` registers **26 `/api/*` mounts** across **20 plugin factories**
(plus `cesium()`), all as Connect middlewares on `server.middlewares`. The
client only ever fetches relative `/api/...` paths, so the mount prefix *is*
the public contract.

### 1a. Route inventory

Line ranges are `vite.config.js` @ `aa47445`. "Mount" is the prefix passed to
`middlewares.use()`; everything after it is re-parsed by the handler from the
**rewritten** `req.url` (see §2a — this is load-bearing).

| # | Mount → sub-routes | Plugin (lines) | Preview? | Upstream(s) | Env read | Shared state | Cache | Security notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `/api/radio` → `/stations`, `/click/:uuid` | `createRadioProxyMiddleware` 1051–1306, `radioBrowserProxy` 1307–1321 (mount 1310) | ✅ | `all.api.radio-browser.info`, `*.api.radio-browser.info` | — | closure: `mirrorCache`, `catalogCache`, `servedStationIds`, `catalogInstance` | mem 45 min catalog / 6 h mirrors, stale 7 d | **SSRF-hardened**: `radioProxyDestination` origin+path allowlist, `resolveRadioProxyAddresses` + `fetchPinnedRadioResponse` pin the resolved IP through a custom `https.request` `lookup`, `isPublicRadioAddress` rejects non-global v4/v6, `redirect:'manual'`. Click only accepts a UUID already served. |
| 2 | `/api/celestrak` → `/<group>` | `celestrakProxy` 1554–1653 (mount 1599) | ❌ | `celestrak.org/NORAD/elements/gp.php` | — | closure `mem`, `inflight` | mem+disk `.gev-cache/celestrak-<group>.json`, 6 h TTL, serve-stale | `^[a-z0-9-]+$` group allowlist → 400. Descriptive UA required by upstream. |
| 3 | `/api/launches` | `rocketLaunchesProxy` 1667–1774 (mount 1736) | ✅ | `ll.thespacedevs.com/2.3.0/launches/` | `LL2_API_TOKEN` (opt) | closure `cache`, `inFlight` | mem+disk `launch-library-2-v2.3.json`, 15 min, serve-stale | Token never reaches client. 12 MB response cap, 24 MB disk cap. |
| 4 | `/api/tomtom` → `/status`, `/flow/{z}/{x}/{y}.pbf` | `tomtomProxy` 1804–1899 (mount 1903) | ❌ | `api.tomtom.com/traffic/map/4/tile/flow` | `TOMTOM_API_KEY`, `TOMTOM_DAILY_TILE_BUDGET` | closure `mem` (256), `inflight`, `budget` | mem+disk `.gev-cache/tomtom/`, 120 s, serve-stale | Key never echoed; sanitized errors only. **Daily budget governor** persisted to `budget.json`. `isValidTomTomTile` → 400. |
| 5 | `/api/firms` → `/`, `/status` | `firmsProxy` 2031–2156 (mount 2160) | ❌ | `firms.modaps.eosdis.nasa.gov` (3 VIIRS sources + mapkey_status) | `FIRMS_MAP_KEY` | closure `mem`, `inflight`, `statusCache` | mem+disk `.gev-cache/firms.json`, 30 min, serve-stale | URL embeds MAP_KEY → **never logged**. Sequential source fetch (quota courtesy). Keyless → 503 `{error:'no_key'}` without touching upstream. |
| 6 | `/api/terrain/heights` | `terrainHeightsProxy` 2242–2337 (mount 2341) | ❌ | `terrain.reearth.land/heights.json` | — | closure `mem` (per 5dp point), `inflight` | mem+disk `terrain-heights.json` v2, 30 d, 15 s flush interval | `parseTerrainPoints` → 400; `MAX_POINTS` 2000 → 500. Chunked at 256/upstream call. |
| 7 | `/api/adsbdb` → `/route/:callsign`, `/type/:hex` | `adsbdbProxy` 2390–2471 (mount 2475) | ❌ | `api.adsbdb.com/v0/{callsign,aircraft}` | — | closure `cache{routes,aircraft}`, `inflight` | mem+disk `adsbdb.json`, 24 h, **negative-caches 404** | `^[A-Z0-9]{2,8}$` / `^[0-9a-f]{6}$` → 400. |
| 8 | `/api/overpass` | `overpassProxy` 2675–2900 (mount 2679) | ❌ | 4 Overpass mirrors (`OVERPASS_UPSTREAMS` 191–208) | — | **module**: `_overpassCache`, `_overpassInFlight`, `_overpassConcurrent`, `_overpassRateLimiter` | mem 24 h (120 entries) + disk `.gev-cache/overpass/`, 7 d (30 d boundary), serve-stale at any age | **The hardest surface.** `sanitizeOverpassBody` (624–714) + `stripOverpassNoise` lexer: exactly one `data` query, every selector spatially bounded *with set provenance*, area-bounded selectors denied, `poly:`/`foreach`/`convert`/… denied, radii ≤ 50 km, bbox ≤ 12°, `[timeout:]` clamped to 30 s. 24 KB body cap, 32 MB response cap, 6 concurrent, 90/min per client + 300/min global. |
| 9 | `/api/route` | `overpassProxy` (mount 2809) | ❌ | `routing.openstreetmap.de/routed-{foot,car,bike}` | — | **module**: `_routeCache` (200), `_routeRateLimiter` | mem 10 min | Profile allowlist, 2–12 coords, leg ≤ 600 km, total ≤ 2500 km, 8 MB cap, 60/min + 200/min. Errors flattened to `{ok:false}` @200. |
| 10 | `/api/opensky` | `openSkyProxy` 3013–3286 (mount 3017) | ❌ | `opensky-network.org/api/states/all`, `auth.opensky-network.org` (OAuth), `api.adsb.lol/v2/lat/../lon/..` (fallback) | `OPENSKY_AUTH_MODE`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `OPENSKY_USERNAME`, `OPENSKY_PASSWORD` | **module**: `_openskyToken/Expiry/Promise`, `_openskyCache{Body,Status,Time,Meta,SourceEpochMs}`, `_openskyTtlMs`, `_openskyCooldownUntil`, `_adsbLolPointCache/InFlight` | mem 9 s **adaptive** (`openskyAdaptiveTtlMs`), serve-stale, 429 cooldown 30 s–30 min | Credentials server-side only. Auth failure text is fixed strings, never upstream body. Credit governor honours `X-Rate-Limit-Retry-After-Seconds`. |
| 11 | `/api/gbfs` → `/<urlencoded upstream>` | `gbfsProxy` 3348–3462 (mount 3352) | ❌ | `GBFS_ALLOWED_HOSTS` + `*.publicbikesystem.net` | — | none | none (`max-age=300` for `station_information`) | **SSRF surface**: https-only, host allowlist, path must end `station_(information\|status).json`, 5 MB cap both declared and measured. Path segment is a **percent-encoded absolute URL** — see §2b. |
| 12 | `/api/cctv` → `/sources`, `/health`, `/stream/:id`, `/media/:id`, `/frame/:id` | `cctvProxy` 4518–4593 (mount 4597) | ❌ | Austin Socrata, Caltrans D1–12, TfL JamCam, per-camera frame hosts, Google Street View | `CCTV_SOURCES_FILE`, `CCTV_SOURCES_JSON`, `CCTV_AUSTIN_ROWS_URL`, `CCTV_AUSTIN_MAX_SOURCES`, `CCTV_CALTRANS_DISTRICTS`, `CCTV_CALTRANS_MAX_SOURCES`, `CCTV_TFL_ENABLED`, `CCTV_TFL_MAX_SOURCES`, `CCTV_MAX_SOURCES`, `CCTV_FORCE_AUSTIN`, `CCTV_PREFER_AUSTIN`, `TFL_APP_KEY`, `GOOGLE_MAPS_API_KEY` | **module**: `_cctvSourceCache`, `_cctvSourceCacheAt`, `_cctvSourceInflight`; closure `health` (1200) | mem 15 min catalog, serve-stale-on-empty; frames uncached | **Never accepts a client upstream URL** — server registry only. `/media` **pipes** an unbounded stream with `Range` pass-through (`proxyMediaResponse` 4423–4476). Declared-length cap 64 MB. |
| 13 | `/api/adsblol/mil` | `adsbLolProxy` 4811–4859 (mount 4821) | ❌ | `api.adsb.lol/v2/mil` | — | closure `_cache`, `_cacheAt` | mem 12 s, serve-stale | Sanitized errors. |
| 14 | `/api/ais-live` → `/`, `/track` | `aisLiveProxy` 4861–4945 (mount 4863) | ✅ | `wss://stream.aisstream.io/v0/stream` (persistent WS) | `AISSTREAM_API_KEY`, `AISSTREAM_URL`, `AISSTREAM_BOUNDING_BOXES`, `AISSTREAM_MESSAGE_TYPES`, `AISSTREAM_SILENCE_TIMEOUT_MS` | **module**: `_aisAdapter`, `_aisWatchdogPolicy`, `_aisStreamTickTimer`, `_aisNeedsRearm`, `_aisWebSocketImpl`, `_aisStreamVessels` (50k), `_aisStreamStatic`, `_aisStreamTracks`, `_aisStreamTrackPending` | in-process only, 30 min staleness prune | Key server-side only. **Owns a process singleton**: one socket, one interval, teardown on `httpServer 'close'` + `closeBundle`. `mmsi` `^\d{5,10}$` → 400. |
| 15 | `/api/opensky-track` | `trackBackfillProxies` 4956–5061 (mount 4999) | ✅ | `opensky-network.org/api/tracks/all` | shares OpenSky OAuth | closure `cache` (200) | mem 60 s | Shares `getOpenSkyToken()`; upstream error bodies replaced with `Track source HTTP <n>`. 5 MB cap. |
| 16 | `/api/adsblol/trace` | `trackBackfillProxies` (mount 5023) | ✅ | `adsb.lol/data/traces/…` | — | same `cache` | mem 60 s | `^[0-9a-f~]{6,7}$` → 400. ODbL attribution required in UI. |
| 17 | `/api/openai/hud-summary` | `openAiRealtimeProxy` 5063–5332 (mount 5065) | ✅ | `api.openai.com/v1/responses` | `OPENAI_API_KEY`, `OPENAI_HUD_SUMMARY_MODEL`, `GEV_RATELIMIT_OPENAI_PER_MIN` | **module**: `_openAiRateLimiter` (lazy) | none | **Cost-bearing.** Keyless → `keylessHudSummaryResponse` before the limiter. 64 KB body cap. Output clamped to 5 words. |
| 18 | `/api/realtime/debug-log` | `openAiRealtimeProxy` (mount 5127) | ✅ | — (writes `.gev-logs/realtime-conversations.jsonl`) | — | — | — | **Writes to disk from a request.** 8 MB body cap. Client redacts keys/secrets before POST. |
| 19 | `/api/realtime/token` | `openAiRealtimeProxy` (mount 5152) | ✅ | `api.openai.com/v1/realtime/client_secrets` | `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_MODEL_MINI`, `OPENAI_REALTIME_VOICE`, `OPENAI_REALTIME_REASONING_EFFORT`, `OPENAI_REALTIME_CONTEXT_TOKENS`, `OPENAI_REALTIME_CONTEXT_RETENTION`, `GEV_RATELIMIT_OPENAI_PER_MIN` | `_openAiRateLimiter` | none | **Mints a spendable credential.** `resolveVoiceModel` is total (hostile `?tier=` → `standard`). Carries the 28-entry `GEV_REALTIME_TOOLS` schema (5664–6302). See §7. |
| 20 | `/api/google/nearby-places` | `googlePlacesContextProxy` 5394–5642 (mount 5396) | ✅ | `places.googleapis.com/v1/places:searchNearby` | `GOOGLE_MAPS_API_KEY`, `GEV_RATELIMIT_GOOGLE_PER_MIN` | **module**: `_googleRateLimiter` (lazy) | none (`private, max-age=300`) | **Cost-bearing.** Key stays server-side. `radiusM` clamped 25–5000. Every error keeps the `places: []` contract. |
| 21 | `/api/google/text-search` | `googlePlacesContextProxy` (mount 5515) | ✅ | `places.googleapis.com/v1/places:searchText` | same | same | none | Same contract; `radiusM` clamped 50–50000. |
| 22 | `/api/military-installations` | `militaryInstallationsProxy` 6909–7038 (mount 6946) | ✅ | Overpass (via `fetchOverpassPayload`) | — | **module**: `_militaryInstallationCache` (80), `_militaryInstallationInFlight`, `_militaryInstallationsRateLimiter` | mem 5 min + disk `.gev-cache/military-installations/` 30 d (**atomic** temp+rename), stale 60 min then disk-at-any-age | Fixed QL template — arbitrary Overpass QL is never exposed. bbox ≤ 10°, no dateline → 400. Own limiter (90/min + 300/min) so it can't starve `/api/overpass`. `exact=1` keyed separately at 5dp. |
| 23 | `/api/regional-brief` | `regionalBriefProxy` 7243–7330 (mount 7274) | ✅ | `nominatim.openstreetmap.org`, `news.google.com/rss`, `api.gdeltproject.org`, `api.open-meteo.com` | — | **module**: `_regionalBriefCache` (120), `_regionalBriefInFlight`, `_regionalBriefRateLimiter`, `_nominatimQueue`, `_nominatimLastRequestAt` | mem 5 min, stale 60 min | **Nominatim 1.1 s serialized queue** (usage policy) — a global, not per-request, resource. 30/min + 90/min. 2 MB cap. Key rounded to 0.1°. |
| 24 | `/api/weather-effects` | `weatherEffectsProxy` 7332–7412 (mount 7348) | ✅ | `api.open-meteo.com` | — | **module**: `_weatherEffectsCache` (180), `_weatherEffectsInFlight`, `_weatherEffectsRateLimiter` | mem 5 min, stale 30 min | 45/min + 120/min. 512 KB cap. |
| 25 | `/api/setup/status` | `keySetupEndpoint` 7483–7729 (mount 7643) | ⛔ *deliberate* | — (reads `.env` / `pinokio/ENVIRONMENT`) | `GEV_LAUNCHER`, `GEV_KEY_SETUP_EXTERNAL_KEYS` | `LAUNCHER_AT_BOOT`, `PROVIDER_ENV_AT_BOOT`, `DEV_FRESH_EXTERNAL_KEYS_AT_BOOT` | none (`no-store`) | `admitKeySetupRequest` gate: loopback socket + Host/Origin + content-type + **proxy-header rejection**. `X-Frame-Options: DENY` + `frame-ancestors 'none'`. Never returns a value or suffix. |
| 26 | `/api/setup/keys` | `keySetupEndpoint` (mount 7649) | ⛔ *deliberate* | — (**writes** `.env` / `pinokio/ENVIRONMENT`) | same | same | none | Same gate. 8 KB body cap. Refuses to touch externally-managed keys (409). Symlink refusal, `O_EXCL` 0600 temp + `hardenCredentialFile` **before** the secret is written, `fsync`, atomic rename. Then `server.restart()`. |

**Shared machinery that is not a route** (must move first, PR 2):
`makeRateLimiter` 453–478 · `makeOptInRateLimiter`/`enforceOptInRateLimit`/`clientKey` 495–547 ·
`readRequestBodyCapped` 716–735 · `readResponseTextCapped`/`readResponseJsonCapped` 736–780 ·
`coalesceProxyRequest` 781–796 · `readRequestBody` 5356–5377 · `haversineKm` 3863–3882 ·
`getOpenSkyToken` 1419–1492 · `fetchOverpassPayload` 2585–2673 · `buildOpenSkyHeaders` 1519–1553.

**Pure data**: `GEV_REALTIME_TOOLS` (5664–6302, 639 lines, 28 voice-tool schemas) — moves verbatim
to `server/routes/openai.tools.js`; it is the largest single block in the file and touches nothing.

### 1b. The preview-parity finding

`vite preview` is **not** a working baseline and must not be used as the parity
target. Only 9 of the 20 GEV plugins register `configurePreviewServer`; the
other 11 (celestrak, tomtom, firms, terrain, adsbdb, overpass+route, opensky,
gbfs, cctv, adsblol/mil, and the deliberately-dev-only key setup) are
`configureServer`-only. Measured on this branch after `npm run build`:

```
$ npx vite preview --port 4291 --host 127.0.0.1
ENDPOINT                           PREVIEW status / content-type
/api/celestrak/stations            200 text/html      ← SPA index, not TLE
/api/tomtom/status                 200 text/html
/api/firms/status                  200 text/html
/api/opensky                       200 text/html
/api/cctv/sources                  200 text/html
/api/terrain/heights               200 text/html
/api/setup/status                  200 text/html
/api/launches                      200 application/json
/api/weather-effects               400 application/json
/api/regional-brief                400 application/json
/api/ais-live                      503 application/json; charset=utf-8
```

**11 of the 24 non-setup mounts are absent from preview**, and every one of the
six probed among them answers with the SPA index at **HTTP 200 `text/html`** —
worse than a 404, because the client parses it as data. (The remaining five fall
through the same unmatched-path handler.) The standalone server does not
"preserve preview behaviour"; it *fixes* it. This
also removes the only reason the brief offered for a spike branch: parity is
against **dev**, and dev's mounting is reproducible byte-for-byte (§2a).

---

## 2. Decision

> **Extract, don't migrate.** Keep the handlers as Connect-compatible
> `(req, res, next)` functions, mount them with a ~40-line prefix router that
> reproduces Connect's `use(prefix, fn)` semantics exactly, and serve `dist/`
> with `sirv`. Do **not** adopt Hono. Re-open the framework question later, and
> only for a layer that sits *in front of* these handlers.

Confidence **87%**. The council below reached it at Tier 3 with AoT branching,
and the framework advocate changed position mid-debate — the conditions they
attached survive as requirements in §3 and §4.

### 2a. Verified: a standalone mount router matches Vite/Connect exactly

This is the load-bearing claim, so it was measured rather than assumed. Eight
handlers re-parse the **rewritten** `req.url` (celestrak's group, tomtom's
`/status` vs `/flow/z/x/y.pbf`, firms' `/status`, cctv's five sub-routes,
radio's `/stations` and `/click/:uuid`, ais-live's `/track`, adsbdb's
`/route|/type` split, gbfs's encoded target). Two echo servers were run
side-by-side — real Vite dev (`server.middlewares.use`) on 4291, and a
40-line standalone mount router on 4292 — both mounting `/api/celestrak`,
`/api/gbfs`, `/api/adsblol/mil`:

```
PATH                                                       VITE_CONNECT           STANDALONE             MATCH
/api/celestrak/active                                      {"seen":"/active"}     {"seen":"/active"}     OK
/api/celestrak/stations?x=1                                {"seen":"/stations?x=1 {"seen":"/stations?x=1 OK
/api/celestrak                                             {"seen":"/"}           {"seen":"/"}           OK
/api/celestrak/                                            {"seen":"/"}           {"seen":"/"}           OK
/api/celestrakXYZ                                          404 (fell through)     404 (fell through)     OK
/api/gbfs/https%3A%2F%2Fgbfs.lyft.com%2Fgbfs%2Fstation_status.json
                                                           {"seen":"/https%3A%2F% {"seen":"/https%3A%2F% OK
/api/adsblol/mil                                           {"seen":"/"}           {"seen":"/"}           OK
/api/adsblol/mil?z=1                                       {"seen":"/?z=1"}       {"seen":"/?z=1"}       OK
```

8/8. Note the sixth row: the percent-encoded GBFS target arrives **raw and
un-decoded** in both, so the handler's single `decodeURIComponent` plus its
host/path allowlist keep their exact current meaning.

### 2b. Council record

**Tier 3** (architecture, security-adjacent, expensive to reverse mid-flight),
escalated with AoT branching and a private final round. Three generated experts
plus a neutral solver plus a validator pass.

**Experts.** *E1 — Principal engineer, edge/proxy infrastructure* (18 y; Node
HTTP internals, streaming backpressure; blocks anything that changes byte- or
stream-level semantics on a hardened path; blind spot: will keep an ugly file
forever if it works). *E2 — Staff platform architect* (12 y; Fastify/Hono,
observability, API contracts; designs for the 12-month shape and the second
engineer; blind spot: assumes greenfield ergonomics generalise). *E3 —
Application-security lead* (15 y; SSRF, path-normalisation bugs, credential
handling; blocks rewrites of validated controls without an equivalence proof;
blind spot: would freeze all refactoring if unopposed).

**Independent positions (before exposure).**

- **E1 → Extract, 88.** Handlers read a stripped `req.url`; Hono and Fastify
  hand you the full path, so a "mount swap" is really a sub-path rewrite in 26
  handlers. `/api/cctv/media` pipes unbounded MJPEG/HLS with `Range`
  pass-through; Hono's Web-standard `Response` goes through
  `@hono/node-server`'s stream adapter, adding a conversion layer and changing
  backpressure on a live video path. Fastify keeps `reply.raw`, so it survives
  that specific test. *Blocks Hono outright.*
- **E2 → Fastify, 68.** 7,000 lines with no logging, no error boundary and ~26
  hand-copied `res.writeHead(500, …)` blocks is not a codebase, it is a
  transcript. Fastify brings pino, schema validation, plugin encapsulation, and
  an ecosystem for the auth and MCP work coming in #22/#25 — and `request.raw`
  / `reply.raw` preserve socket and stream access. One-time cost, permanent
  structure. *Blocks a hand-rolled router that nobody will maintain.*
- **E3 → Extract, 92.** Four controls read the raw Node request: the rate
  limiter (`req.socket.remoteAddress`, with X-Forwarded-For explicitly
  distrusted), the key-setup admission gate (`socket.encrypted`, raw
  `req.headers` object, proxy-header detection), the radio SSRF pin
  (`https.request` custom `lookup`), and the GBFS allowlist (raw, un-decoded
  path segment). A framework that reshapes `req.headers` into a Web `Headers`
  forces a rewrite of a **credential-writing admission gate**, and a
  path-normalising router creates a double-decode window in front of the GBFS
  allowlist. *Blocks anything that reshapes `req.headers` or `req.socket`.*
- **Neutral → Extract, 85.** The 8 test files that import from `vite.config.js`
  drive plugins as `plugin().configureServer({ middlewares: { use(path, fn) } })`
  and then call `fn(req, res)` with a fake `{method, url, headers, socket:
  {remoteAddress}}`. The existing suite **already encodes the Connect contract**.
  Extraction changes an import path; migration rewrites 8 harnesses as well as
  26 handlers.

**Challenge round.** E2's strongest point (nobody maintains bespoke
infrastructure) was conceded by E1 and folded into a requirement rather than
dismissed. E1's and E3's strongest point against E2 was concrete rather than
stylistic: `use(prefix)` semantics are load-bearing in 8 handlers, the GBFS path
is a percent-encoded URL, and the test harnesses bake in the same contract.

> **[POSITION CHANGE — E2: Fastify → Extract, with conditions | Trigger: the 8
> test harnesses + the GBFS encoded path + `req.url` rewriting in 8 handlers
> showed this is a 26-handler rewrite, not a mount swap.]**
> Conditions carried forward: (i) extraction must land `server/lib/` so the next
> route is 30 lines and not 300 — a pure file-move is a failure; (ii) a single
> `ROUTES` manifest, imported by *both* `vite.config.js` and `server/index.js`,
> so the two mount sites cannot drift; (iii) if a framework is later wanted, it
> mounts *in front* (identity, quota, MCP HTTP), never underneath these handlers.

E3 raised a supply-chain objection to adding `connect` as a dependency in a
credential-adjacent process. Checked: `connect` is not resolvable in this repo —
Vite bundles it into `vite/dist/node` and does not re-export it — so option A
means either adding the package or vendoring the ~40 lines we actually depend
on. §2a measures the vendored version at 8/8 parity, so **the plan vendors it**
(`server/lib/mount.js`) and takes no new production dependency beyond `sirv`.

**Validator pass.** E1's stated methodology ("accepts ugly code that is
correct") would argue for *no* extraction at all; E1 must justify any change.
Resolved: doing nothing is not on the ballot — `vite.config.js` imports
`defineConfig`/`loadEnv` from `vite` and `vite-plugin-cesium`, so a production
`node server/index.js` cannot import it. The extraction direction is *forced*;
only the destination shape is in question. Confidence scores are calibrated:
E3's 92 is highest and attaches to the narrowest claim (Hono is disqualified);
E2's posterior 74 is lowest because its concern is mitigated by a condition
rather than resolved. No position moved without a named evidential trigger.

**AoT branching** (scored on correctness / reversibility / team fit / cost;
prune below 2):

| Branch | 3 months | 12 months | Worst case | Score |
|---|---|---|---|---|
| **Extract** | 10 PRs; dev and prod run identical handlers; `server/lib/http.js` collapses 26 copies of `sendJson`. Pain: two mount sites — mitigated by the `ROUTES` manifest. | SQLite cache, DuckDB archive, Tailscale identity and SSE fan-out all attach as ordinary middleware. A framework for a *new* surface mounts alongside. | Vendored mount router has a bug the 8/8 probe missed → bounded, it is 40 lines with a differential test. | **4/4** |
| Fastify | 26 sub-path rewrites + 8 harness rewrites + GBFS routing hazard + re-derivation of the key-setup gate. | Genuinely nicer to extend; pino and schemas earn their keep. | A half-migrated security gate is not revertible. | 2/4 |
| Hono | Same rewrites, plus a stream-adapter regression on `/api/cctv/media` and loss of raw `req.headers`/`req.socket` for the admission gate. Portability to edge runtimes is worth zero on a launchd Mac. | — | — | **1/4 — pruned** |

**Private final round** (no group context): E1 Extract 90 · E2 Extract-with-conditions 78
(*"on a greenfield rewrite of these same 26 routes I would still pick Fastify; this is not greenfield"*)
· E3 Extract 92 · Neutral Extract 87. Confidence-weighted: **87%**.

```
CONSENSUS   Handlers stay Connect-shaped; Hono is disqualified on streaming +
            raw-request access; the extraction itself is forced by the prod
            requirement.
CONTESTED   Whether a pure extraction leaves the code maintainable. E2 holds
            that it does NOT unless server/lib/ and the ROUTES manifest land —
            recorded as blocking conditions on PR 1 and PR 2, not as a footnote.
DISSENT     E2: for a greenfield build of the same 26 routes, Fastify wins. Keep
            that door open at the identity/MCP edge (§7), not beneath the proxies.
OPEN RISK   Tailscale terminates at 127.0.0.1, which collapses every remote user
            onto one rate-limit bucket and makes every tailnet peer look local to
            the key-setup gate. See §7 — this is the plan's sharpest edge.
```

*Note on process: the skill's approval gate is written for interactive use. The
standing mission instruction was to execute end-to-end, so the council result is
recorded here and the plan continues rather than blocking. No code ships from
this document.*

---

## 3. Target layout

```
server/
  index.js                 # standalone entry: env → mount(ROUTES) → sirv(dist/) → listen
  routes.js                # the ROUTES manifest — the ONLY list of mounts (see below)
  routes/
    celestrak.js           # export function createCelestrakRoute(deps) -> (req,res,next)
    opensky.js             #   + adsb.lol regional fallback, OAuth token
    overpass.js            #   + /api/route
    military.js
    cctv.js                # + sources loaders (austin/caltrans/tfl)
    gbfs.js
    radio.js               # createRadioProxyMiddleware moves here unchanged
    ais.js                 # + the AISStream singleton lifecycle
    tomtom.js
    firms.js
    terrain.js
    adsbdb.js
    launches.js
    tracks.js              # /api/opensky-track + /api/adsblol/trace
    openai.js              # hud-summary, realtime/token, realtime/debug-log
    openai.tools.js        # GEV_REALTIME_TOOLS verbatim (639 lines of data)
    google.js              # nearby-places + text-search
    regional.js            # regional-brief + weather-effects
    setup.js               # /api/setup/* — mounted ONLY on the admin listener
  lib/
    mount.js               # vendored Connect `use(prefix, fn)` semantics (§2a)
    http.js                # sendJson / sendText / readBodyCapped / readResponseTextCapped
    ratelimit.js           # makeRateLimiter, makeOptInRateLimiter, clientKey
    cache.js               # the §5 contract; memory+disk today, SQLite later
    env.js                 # one typed read of every env var in §1a, defaults in one place
    upstream.js            # fetchWithTimeout, coalesceProxyRequest, size caps
    identity.js            # Tailscale header → principal; the §7 boundary
  archive/
    index.js               # archive.record(layer, payload, ts, meta) — no-op today
vite.config.js             # ~250 lines: loadEnv, defines, server opts, and:
                           #   plugins: [cesium(), gevApiPlugin()]
```

`vite.config.js` shrinks to a single plugin that iterates the same manifest:

```js
// vite.config.js — the dev half
import { ROUTES, ADMIN_ROUTES } from './server/routes.js';

function gevApiPlugin() {
  const install = (server) => {
    for (const { mount, handler } of ROUTES) server.middlewares.use(mount, handler);
  };
  return {
    name: 'gev-api',
    configureServer(server) {
      install(server);
      // Dev keeps the key-setup panel; prod does not (§7).
      for (const { mount, handler } of ADMIN_ROUTES) server.middlewares.use(mount, handler);
    },
    configurePreviewServer: install,   // fixes the §1b gap for free
  };
}
```

```js
// server/index.js — the prod half, same ROUTES
import { ROUTES, ADMIN_ROUTES } from './routes.js';
import { mount } from './lib/mount.js';

const stack = [...ROUTES.map(r => mount(r.mount, r.handler)), sirv('dist', { single: true })];
```

**Dev and prod therefore run the identical handler objects**, and adding a route
means one manifest entry, not two mount calls. This is E2's condition (ii).

**Import direction is one-way**: `server/**` never imports `vite`, and
`vite.config.js` imports `server/routes.js`. That is what makes
`node server/index.js` possible without Vite in the production dependency tree.

**Test compatibility.** The 8 test files keep importing the same factory
functions; only the specifier changes (`'../vite.config.js'` →
`'../server/routes/google.js'`). Their harness —
`plugin().configureServer({ middlewares: { use } })` — is preserved by exporting
a thin `configureServer`-shaped adapter from each route module during the
transition, or (cleaner, and what PR 1 does for celestrak) by exporting the bare
`create*Route()` factory the harness can call directly. Either way the fake
`req`/`res` objects and every assertion stay as they are.

---

## 4. PR sequence

Ten PRs. 1–8 are strictly ordered; **9 and 10 are parallelisable** the moment
PR 2 lands. Every PR keeps `npm test` at 0 failures and touches no client code.

Standing gate for every PR (abbreviated `GATE` below):

```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm test                                    # expect: pass 2706+ / fail 0
npm run build                               # expect: exit 0
PORT=42xx npm run dev  &  <curl probes>     # dev parity
node server/index.js   &  <same probes>     # prod parity — identical bodies
```

### PR 1 — `server/` scaffolding + CelesTrak (the pattern proof)
**Files** `server/index.js`, `server/routes.js`, `server/lib/mount.js`,
`server/lib/http.js`, `server/routes/celestrak.js`, `server/lib/mount.test.mjs`,
`vite.config.js` (celestrak plugin → manifest entry), `package.json` (+`sirv`).
**Why first** CelesTrak is the lowest-risk route with a real sub-path parse, a
memory+disk cache, and a serve-stale path — it exercises the whole pattern
without touching a security control.
**Risk** *Low.* Only new failure mode is a mount-semantics mismatch, which
`mount.test.mjs` pins as a differential test against the §2a table.
**Gate**
```
node --test server/lib/mount.test.mjs      # 8 mount cases incl. the encoded-URL row
# dev  (PORT=4291 npm run dev):
curl -sD- http://127.0.0.1:4291/api/celestrak/stations | head -1
  → HTTP/1.1 200 OK   +  x-tle-cache: MISS  (then HIT on the second call)
  → body begins "ISS (ZARYA)" then a "1 25544U 98067A" TLE line
curl -s -o/dev/null -w '%{http_code}' .../api/celestrak/BAD%21GROUP   → 400
# prod (node server/index.js on 4292): byte-identical body, same x-tle-cache header
diff <(curl -s :4291/api/celestrak/stations) <(curl -s :4292/api/celestrak/stations)  → empty
# preview regression now fixed:
npm run build && npx vite preview --port 4291
curl -s -o/dev/null -w '%{content_type}' .../api/celestrak/stations  → text/plain (was text/html)
GATE
```

### PR 2 — shared `server/lib/` (no route moves)
**Files** `server/lib/{http,ratelimit,upstream,env}.js` + tests; `vite.config.js`
re-imports `makeRateLimiter`, `makeOptInRateLimiter`, `enforceOptInRateLimit`,
`clientKey`, `readRequestBodyCapped`, `readResponseTextCapped`,
`readResponseJsonCapped`, `coalesceProxyRequest`, `readRequestBody`,
`haversineKm` from there instead of defining them.
**Why second** E2's condition (i): every later PR must be able to delete
boilerplate rather than relocate it. Also unblocks PRs 9 and 10.
**Risk** *Low–medium.* These functions are shared by every route, so a
regression is broad but instantly visible. Move verbatim; no behaviour edits.
**Gate** `GATE` + `node --test src/data/overpassProxy.test.mjs src/data/radioProxy.test.mjs`
(both exercise the caps and coalescing helpers directly).

### PR 3 — keyless / simple GET proxies
**Routes** `/api/launches`, `/api/firms`(+`/status`), `/api/tomtom`(+`/status`),
`/api/adsbdb`, `/api/terrain/heights`.
**Files** `server/routes/{launches,firms,tomtom,adsbdb,terrain}.js`.
**Risk** *Low.* All are cache-and-forward with no request-shaped security
control. TomTom's persistent budget counter is the one piece of state that must
keep its `.gev-cache/tomtom/budget.json` path.
**Gate** `GATE` +
```
curl -s :PORT/api/tomtom/status  → {"hasKey":false,"dailyCount":0,"budget":40000,"date":"<UTC today>"}
curl -s :PORT/api/firms/status   → {"hasKey":false,"lastFetch":null,"count":null,"stale":false,"ttlMs":1800000,"transactions":null}
curl -s -o/dev/null -w '%{http_code}' ':PORT/api/tomtom/flow/99/0/0.pbf'      → 400
curl -s -o/dev/null -w '%{http_code}' ':PORT/api/adsbdb/route/!!'             → 400
curl -s -o/dev/null -w '%{http_code}' ':PORT/api/terrain/heights?points=x'    → 400
node scripts/qa-firms.mjs ; node scripts/qa-traffic.mjs ; node scripts/qa-height-datum.mjs
```

### PR 4 — Overpass family
**Routes** `/api/overpass`, `/api/route`, `/api/military-installations`.
**Files** `server/routes/{overpass,military}.js` (they share `fetchOverpassPayload`,
`sanitizeOverpassBody`, `stripOverpassNoise`, the disk cache and the two limiters).
**Risk** **High** — this carries the static QL validator. **Move the validator
and its regexes byte-for-byte; reject any diff that touches
`sanitizeOverpassBody`, `stripOverpassNoise`, `OVERPASS_*_RE` or the limiter
constants.** Review the PR with `git diff --word-diff` over those ranges.
**Gate** `GATE` +
```
node --test src/overpassProxy.test.mjs src/data/overpassProxy.test.mjs src/data/installationProxy.test.mjs
# validator still refuses an unbounded selector:
curl -s -XPOST --data 'data=[out:json];way["highway"];out;' :PORT/api/overpass
  → 400 {"error":"Overpass query has an unbounded selector"}
curl -s -XPOST --data 'data=[out:json];node(around:9999999,0,0);out;' :PORT/api/overpass
  → 400 {"error":"Overpass around radius too large"}
curl -s -XPOST --data 'data=[out:json];way(area.a);out;' :PORT/api/overpass
  → 400 {"error":"Overpass area-bounded element selector not allowed"}
curl -s :PORT/api/route?profile=foot'&'coords=-97.74,30.27';'-97.73,30.28  → {"ok":true,...}
curl -s ':PORT/api/military-installations?south=0&west=0&north=90&east=90' → 400
```

### PR 5 — flights & vessels
**Routes** `/api/opensky`, `/api/adsblol/mil`, `/api/opensky-track`,
`/api/adsblol/trace`, `/api/ais-live`(+`/track`).
**Files** `server/routes/{opensky,tracks,ais}.js`; `getOpenSkyToken` →
`server/lib/opensky-auth.js` (shared by opensky + opensky-track).
**Risk** **High — lifecycle, not logic.** `aisLiveProxy` owns a process
singleton (one websocket, one `setInterval`, teardown on `httpServer 'close'`
and `closeBundle`). Standalone has no Vite hooks, so `server/index.js` must call
`disposeAisStream()` on `SIGTERM`/`SIGINT` and on `server.close`. Under launchd
a missed teardown wedges AISStream's one-connection-per-key limit.
**Gate** `GATE` +
```
curl -sD- :PORT/api/ais-live | grep -i '^HTTP'     → 503 without a key, 200 with one
curl -s ':PORT/api/ais-live/track?mmsi=abc'        → 400 {"error":"mmsi query param required",...}
curl -sD- :PORT/api/opensky | grep -i 'x-opensky-' → X-OpenSky-Cache / -Auth / -Auth-Reason present
curl -s ':PORT/api/opensky-track?icao24=zz'        → 400
# lifecycle: start standalone with a key, SIGTERM, confirm one clean close and no
# reconnect chain in the log; a second start must connect (not be refused by upstream).
```

### PR 6 — media & allowlist proxies
**Routes** `/api/cctv`(5 sub-routes), `/api/gbfs`, `/api/radio`(2 sub-routes).
**Files** `server/routes/{cctv,gbfs,radio}.js` + `server/routes/cctv.sources.js`.
**Risk** **High** — three distinct SSRF-relevant surfaces plus the only streaming
path. Do not restructure `proxyMediaResponse`; keep `stream.pipe(res)`, the
`Range` pass-through and the 64 MB declared-length cap. Keep `radioProxyDestination`,
`resolveRadioProxyAddresses`, `fetchPinnedRadioResponse` and `isPublicRadioAddress`
byte-for-byte.
**Gate** `GATE` +
```
node --test src/data/cctvProxy.test.mjs src/data/radioProxy.test.mjs
node scripts/qa-cctv-v2.mjs ; node scripts/qa-radio.mjs
curl -s :PORT/api/cctv/sources | head -c 80        → {"sources":[{"id":...
curl -s :PORT/api/cctv/health                      → {"cameras":[...]}
curl -s -o/dev/null -w '%{http_code} %{content_type}' :PORT/api/cctv/frame/nope
                                                   → 200 image/svg+xml  (synthetic fallback)
curl -s -o/dev/null -w '%{http_code}' ':PORT/api/gbfs/http%3A%2F%2Fevil.example%2Fstation_status.json' → 400
curl -s -o/dev/null -w '%{http_code}' ':PORT/api/gbfs/https%3A%2F%2Fevil.example%2Fstation_status.json' → 403
curl -s -o/dev/null -w '%{http_code}' ':PORT/api/gbfs/https%3A%2F%2Fgbfs.lyft.com%2Fsecrets.json'       → 400
curl -s :PORT/api/radio/stations | head -c 60      → {"stations":[...
curl -s -XPOST -o/dev/null -w '%{http_code}' :PORT/api/radio/click/00000000-0000-0000-0000-000000000000 → 404
```

### PR 7 — cost-bearing & context routes
**Routes** `/api/openai/hud-summary`, `/api/realtime/token`,
`/api/realtime/debug-log`, `/api/google/nearby-places`, `/api/google/text-search`,
`/api/regional-brief`, `/api/weather-effects`.
**Files** `server/routes/{openai,openai.tools,google,regional}.js`.
**Risk** *Medium.* Mostly mechanical, but this is where `GEV_REALTIME_TOOLS`
(639 lines) moves — verify it is byte-identical, since the voice contract is
pinned against it. `_openAiRateLimiter` / `_googleRateLimiter` must stay lazily
built on first request (module-load reads see an unpopulated `process.env`).
**Gate** `GATE` +
```
node --test src/hudSummaryResponse.test.mjs src/googlePlacesKeyless.test.mjs \
            src/data/regionalProxy.test.mjs src/voice/voiceCost.test.mjs
git show HEAD~1:vite.config.js | sed -n '5664,6302p' > /tmp/tools.before
sed -n '/^export const GEV_REALTIME_TOOLS/,/^];/p' server/routes/openai.tools.js > /tmp/tools.after
diff <(grep -o "name: '[a-z_]*'" /tmp/tools.before) <(grep -o "name: '[a-z_]*'" /tmp/tools.after)  → empty (28 tools)
curl -s :PORT/api/google/nearby-places?lat=30'&'lon=-97 → {"configured":false,"error":null,"places":[]}  (keyless)
curl -s -XPOST :PORT/api/openai/hud-summary -d '{}'     → keyless HUD payload, not 502
curl -s ':PORT/api/weather-effects'                     → 400 {"error":"Valid latitude and longitude are required"}
node scripts/qa-voice-routing.mjs
```

### PR 8 — the setup boundary + `vite.config.js` reduction
**Files** `server/routes/setup.js`, `server/lib/identity.js`, `server/index.js`
(dual listener), `vite.config.js` (down to ~250 lines: `loadEnv`, `define`,
`server` options, `cesium()`, `gevApiPlugin()`).
**Content** Implements §7: a public listener and a loopback-only admin listener;
`/api/setup/*` mounts **only** on the latter and only when `GEV_ENABLE_SETUP=1`;
`clientKey` gains a trusted-proxy mode for Tailscale identity;
`/api/realtime/token` gains an identity requirement.
**Risk** **Highest** — this is the credential-writing surface, and §7's finding
is that the *existing* loopback check silently degrades behind a Tailscale
proxy. Treat as a security change, not a move.
**Gate** `GATE` +
```
node --test src/keySetupCore.test.mjs
# dev unchanged:
curl -s :4291/api/setup/status | head -c 40   → {"keys":[{"id":"google-maps",...
# prod default: setup is absent from the public listener
curl -s -o/dev/null -w '%{http_code}' http://127.0.0.1:$GEV_PORT/api/setup/status        → 404
curl -s -o/dev/null -w '%{http_code}' http://127.0.0.1:$GEV_ADMIN_PORT/api/setup/status  → 200
# the admin listener is not reachable off-loopback
curl -s -m3 -o/dev/null -w '%{http_code}' http://$(ipconfig getifaddr en0):$GEV_ADMIN_PORT/api/setup/status → 000
# proxy headers still rejected on the admin listener
curl -s -H 'X-Forwarded-For: 1.2.3.4' :$GEV_ADMIN_PORT/api/setup/status  → 403
```

### PR 9 — SQLite cache behind the §5 contract *(parallel with PR 3–8 after PR 2)*
**Files** `server/lib/cache.js` (backend dispatcher + in-memory backend,
unchanged public API), `server/lib/cacheSqlite.js` (new — the
`better-sqlite3` backend), `server/lib/cache.test.mjs` (parametrized —
every contract test now runs once per backend), `server/routes/celestrak.js`
(wired to `namespace('celestrak', …)` — PR 1/2 had left it on its own
memory+per-group-disk-JSON cache), `package.json`/`package-lock.json`
(+`better-sqlite3@13.0.3`).
**Risk** *Medium, contained.* `cache.js`'s `namespace()` return type didn't
change — it still hands back a `CacheNamespace` synchronously, whose async
methods resolve the live backend internally. `GEV_CACHE_BACKEND=memory|sqlite`
selects explicitly; unset defaults to `sqlite` and falls back to `memory`
(one `console.warn`, memoized so it logs once) if the native module fails to
load. Routes other than CelesTrak are untouched — they keep migrating to the
namespace API one at a time in their own PRs (PR 3–8), same as before.
**Implementation notes (deviate from the loose sketch in §5, matching the
concrete brief this PR shipped against):** DB file `.gev-cache/cache.sqlite`
(not `gev.sqlite`) so it sits next to every other route's `.gev-cache/`
state; table `entries(ns, key, value, kind, expires_at, created_at, size)`
— `kind` (`'buffer'|'string'|'json'`) is the one addition beyond the brief's
column list, needed to round-trip `CacheEntry.value`'s three possible shapes
through SQLite's `BLOB`/`TEXT` storage; `PRAGMA user_version` gates schema
creation; WAL mode + `synchronous=NORMAL` as specified. Per-namespace
`maxEntries`/`maxBytes` caps evict oldest-`created_at` rows first, mirroring
the in-memory backend's insertion-order eviction exactly (a `set()` on an
existing key rewrites its `created_at`, so it moves to the back of the
eviction order the same way the in-memory `Map` delete-then-reinsert does).
**`better-sqlite3` prebuild check:** `npm install better-sqlite3` on this
machine (Node 24.20.0, darwin/arm64) pulled a prebuilt binary — no
`node-gyp` rebuild triggered, confirmed by loading it immediately after
install with no `npm rebuild` step. If a future `npm ci` on a different
Node ABI needs a rebuild, `npm rebuild better-sqlite3` is the fix; the
`GEV_CACHE_BACKEND` fallback means a stale/missing binary degrades to the
in-memory backend (with the one warning line) rather than crashing the server.
**Gate** `GATE` +
```
node --test server/lib/cache.test.mjs
# 21 tests: the full §5 contract suite runs once against GEV_CACHE_BACKEND=memory
# and once against GEV_CACHE_BACKEND=sqlite (pointed at a temp DB file), plus one
# sqlite-only restart-parity test. All 21 pass.

# serve-stale contract (the one that must not regress):
#   get() on an EXPIRED entry returns the entry with expiresAt in the past — NOT null.
# — verified both as a unit test (above) and over real HTTP: 1s TTL, wait 2s,
#   upstream failing → 200 with the original body and x-tle-cache: STALE-ERROR.

# cold-restart parity, measured on CelesTrak (PORT=4298):
rm -rf .gev-cache && node server/index.js &            # start #1
curl -sD- :4298/api/celestrak/stations | grep x-tle-cache   # → MISS
curl -sD- :4298/api/celestrak/stations | grep x-tle-cache   # → HIT
kill %1 && node server/index.js &                       # cold restart, start #2
curl -sD- :4298/api/celestrak/stations | grep x-tle-cache   # → HIT (persisted — no re-fetch)
  # body is byte-identical to start #1's fetch; diff confirms it.
ls -la .gev-cache/cache.sqlite*   # → cache.sqlite, cache.sqlite-shm, cache.sqlite-wal (WAL mode)
```

### PR 10 — archive hook *(parallel with PR 3–8 after PR 2)*
**Files** `server/archive/index.js` (no-op `record`), one call site per polling
route, `server/archive/index.test.mjs`.
**Risk** *Low.* A no-op by construction; the value is that PR-by-PR route moves
land the call sites so #24 never has to touch a route again.
**Gate** `GATE` + `node --test server/archive/index.test.mjs` +
```
GEV_ARCHIVE=stderr node server/index.js &     # debug sink counts calls
curl -s :PORT/api/celestrak/active >/dev/null ; curl -s :PORT/api/celestrak/active >/dev/null
  → exactly ONE archive line (the second request is a cache HIT and must not record)
```

---

## 5. Cache layer contract (idea #4)

The interface exists so PR 9 can run in parallel with route extraction. It is
deliberately narrow, and one design point dominates it.

**The stale rule.** Fourteen routes serve stale data on upstream failure —
that is the codebase's most consistent behaviour ("last-good beats an empty
layer", stated in the Overpass, OpenSky, TomTom, CelesTrak, FIRMS and
installation comments). A cache that returns `null` for an expired entry would
silently delete every one of those fallbacks. Therefore:

> **`get()` returns expired entries.** Freshness is a property the *caller*
> reads off the entry, never a filter the cache applies.

```js
/**
 * One stored value plus the metadata a caller needs to decide freshness.
 * @typedef {object} CacheEntry
 * @property {Buffer|string|object} value  Payload. Buffer for tiles/images,
 *   string for pre-serialized JSON bodies, plain object for structured data.
 * @property {number} storedAt   Epoch ms when the value was written.
 * @property {number} expiresAt  Epoch ms; `Infinity` for never.
 * @property {number} bytes      Serialized size, for cap accounting.
 */

/**
 * A namespaced key/value store with TTLs and caps.
 * @typedef {object} CacheNamespace
 * @property {(key: string) => Promise<?CacheEntry>} get
 *   Returns the entry whether or not it has expired, or null if absent.
 *   Callers compare `entry.expiresAt` to now and choose fresh vs stale.
 * @property {(key: string, value: *, ttlMs: number) => Promise<void>} set
 *   Writes and stamps `expiresAt = now + ttlMs`. Enforces caps on write.
 * @property {(key: string) => Promise<void>} delete
 * @property {() => Promise<{removed: number, bytes: number}>} sweep
 *   Drops expired entries beyond the namespace's stale window and trims to caps.
 */

/**
 * @param {string} name  Namespace id (see the table below).
 * @param {object} opts
 * @param {number} opts.defaultTtlMs
 * @param {number} opts.staleMs     How long past expiry an entry is retained
 *                                  for the serve-stale path. `Infinity` for
 *                                  overpass / military-installations.
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.maxBytes]
 * @returns {CacheNamespace}
 */
export function namespace(name, opts) {}
```

Notes that the implementation must honour:

- **Async by contract, sync inside.** `better-sqlite3` is synchronous; the
  Promise-returning surface lets the SQLite backend resolve immediately while
  today's `fsp`-based disk backend stays async. No caller changes when the
  backend swaps.
- **Single-flight stays out.** `coalesceProxyRequest` is already extracted,
  tested and orthogonal. The cache must not deduplicate.
- **Namespaces are the migration unit**, one route family at a time:
  `celestrak` (6 h / ∞) · `overpass` (24 h / ∞) · `overpass:boundary` (30 d / ∞) ·
  `opensky` (adaptive / ∞) · `adsblol:point` (12 s / short) · `tomtom` (120 s / ∞) ·
  `firms` (30 min / ∞) · `terrain` (30 d / ∞) · `adsbdb` (24 h, negative entries) ·
  `launches` (15 min / ∞) · `route` (10 min) · `cctv:sources` (15 min / ∞) ·
  `military-installations` (5 min mem, 30 d disk / ∞) · `regional-brief` (5 min / 60 min) ·
  `weather-effects` (5 min / 30 min) · `radio:catalog` (45 min / 7 d) · `track` (60 s).
- **Schema, as shipped in PR 9** (`server/lib/cacheSqlite.js`):
  `entries(ns TEXT, key TEXT, value BLOB, kind TEXT, expires_at INTEGER,
  created_at INTEGER, size INTEGER, PRIMARY KEY (ns, key))` with
  `INDEX (ns, created_at)` for LRU eviction and sweep's stale scan. WAL mode,
  `synchronous=NORMAL`, one file at `.gev-cache/cache.sqlite`, `PRAGMA
  user_version` gating schema migrations. `kind` records which of
  `CacheEntry.value`'s three shapes (`Buffer`/`string`/plain object) a row
  holds, so `get()` can reverse the `BLOB`/`TEXT` storage back to the right
  JS type.
- **`.gev-cache/` paths are load-bearest during migration.** A route may read
  its legacy disk file on a cache miss for one release so a warm cache survives
  the upgrade — the pattern `migrateMilitaryInstallationEntry` already
  establishes for in-place schema evolution.

---

## 6. Archive hook (idea #24)

One function, one call site per polling route, so the DuckDB/Parquet writer can
be built without reopening a single route file.

```js
/**
 * Record one upstream observation for the long-term archive.
 *
 * MUST NOT throw and MUST NOT be awaited: archiving is never allowed to add
 * latency to, or fail, a request. The default implementation is a no-op; the
 * DuckDB writer (idea #24) replaces it behind this exact signature.
 *
 * @param {string} layer   Stable layer id: 'opensky' | 'adsblol-mil' | 'ais' |
 *   'firms' | 'celestrak' | 'launches' | 'overpass' | 'military-installations' |
 *   'terrain' | 'tomtom' | 'regional-brief' | 'weather-effects' | 'cctv-sources'.
 * @param {*} payload      The payload exactly as served downstream.
 * @param {number} ts      Epoch ms of the OBSERVATION (upstream's own timestamp
 *                         when it has one — e.g. OpenSky's `time` field — else now).
 * @param {object} [meta]  {source, cacheStatus, count, key} for partitioning.
 * @returns {void}
 */
export function record(layer, payload, ts, meta) {}
```

**Placement rule — one line, invariant:**

> Call `archive.record()` on the **upstream-success path only**, immediately
> after the payload is validated and **before** it is written to the cache.
> Never on a cache HIT, never on an INFLIGHT join, never on the stale path.

That is what makes the archive a record of *polls* rather than of *requests* —
without it, ten browsers hitting a 9-second OpenSky cache would write ten
identical rows per poll. Concretely:

| Route | Call site |
|---|---|
| `/api/opensky` | in the `if (upstream.ok)` cache-write block, `ts = sourceEpochMs ?? now` |
| `/api/adsblol/mil` | in the `if (upstream.ok)` block |
| adsb.lol regional fallback | inside `coalesceProxyRequest`'s creator, after `normalizeAdsbLolPointResponse` |
| `/api/ais-live` | **not in the route** — in `ingestAisStreamEnvelope`, where the data actually arrives, batched |
| `/api/firms` | in `refreshUpstream`'s return, `ts = now` |
| `/api/celestrak` | in `fetchUpstream`'s `.then(fresh => …)` |
| `/api/launches` | in `refreshUpstream` after the `results` array check |
| `/api/overpass` | in the `overpassPayloadIsData(payload)` branch, `meta.key = cacheKey` |
| `/api/military-installations` | in `refresh()` before `_militaryInstallationCache.set` |
| `/api/terrain/heights` | in `fetchUpstreamAll`, per chunk |
| `/api/tomtom` | in `fetchUpstream`'s `.then`, `meta.key = 'z/x/y'` |
| `/api/regional-brief`, `/api/weather-effects` | in each `refresh()` before the cache set |
| `/api/cctv` | in `refreshCctvSources` when `capped.length > 0` |

**Backpressure.** `record` enqueues onto a bounded in-memory ring (drop-oldest,
with a dropped counter exposed on a health route). A slow disk degrades the
archive, never the API.

---

## 7. Boundaries: `/api/setup/keys` and `/api/realtime/token`

### The finding

`/api/setup/*` is guarded by `admitKeySetupRequest`, which requires a **loopback
socket address** plus Host/Origin agreement plus the absence of proxy headers.
`clientKey()` likewise uses `req.socket.remoteAddress` and explicitly refuses
`X-Forwarded-For` ("this is a localhost dev proxy, so the socket address is the
real client").

Both statements stop being true the moment `tailscale serve` fronts the process.
Tailscale terminates TLS and proxies to `127.0.0.1`, so:

1. **Every tailnet peer presents as `127.0.0.1`** — the key-setup gate's central
   check passes for anyone on the tailnet, and a guest could read which keys
   exist and write Ali's `.env`.
2. **Every remote user shares one rate-limit bucket** — the per-IP OpenAI and
   Google limiters become a single global bucket, and one person's session can
   429 the whole team.

Neither is a regression the split introduces; both are latent today and become
live the first time idea #22 ships. The split is the right moment to fix them.

### The design

**Two listeners, not one gate.**

```js
// server/index.js
const publicSrv = http.createServer(publicStack);   // ROUTES + sirv('dist')
publicSrv.listen(Number(env.GEV_PORT ?? 4173), env.GEV_BIND ?? '127.0.0.1');

// Setup lives on its own socket. Nothing a header can say reaches it.
if (env.GEV_ENABLE_SETUP === '1') {
  const adminSrv = http.createServer(adminStack);   // ADMIN_ROUTES only
  adminSrv.listen(Number(env.GEV_ADMIN_PORT ?? 4174), '127.0.0.1');
}
```

- `/api/setup/status` and `/api/setup/keys` mount **only** on the admin
  listener, which binds `127.0.0.1` unconditionally — never `GEV_BIND`. A
  Tailscale-proxied request arrives on the *public* listener and therefore 404s
  on those paths regardless of what it claims about itself.
- `GEV_ENABLE_SETUP` defaults to **off in production**. This preserves today's
  semantics: `keySetupEndpoint` already carries
  `apply: (_c, {command, isPreview}) => command === 'serve' && !isPreview`, so
  the panel has never existed outside dev. Dev keeps it via `ADMIN_ROUTES` in
  `configureServer`.
- There is an independent reason it must stay off: `GOOGLE_MAPS_API_KEY` and
  `CESIUM_ION_TOKEN` reach the browser through Vite's `define:`, i.e. they are
  **baked into `dist/` at build time**. A production `/api/setup/keys` write
  could not take effect without a rebuild, so offering the panel there would be
  a lie as well as a hazard. Key rotation in production is
  `edit .env → npm run build → launchctl kickstart -k`.
- `admitKeySetupRequest` is kept **unchanged** and still runs on the admin
  listener. It becomes defence-in-depth behind the socket boundary rather than
  the only boundary.

**Identity for the public listener** (`server/lib/identity.js`):

```js
/**
 * Resolve the calling principal. `tailscale serve` injects Tailscale-User-Login
 * and Tailscale-User-Name on every proxied request; a direct loopback caller has
 * neither and is the local operator.
 *
 * Trust is opt-in and connection-scoped: the header is honoured ONLY when
 * GEV_TRUST_TAILSCALE=1 AND the socket peer is loopback (which is exactly where
 * `tailscale serve` connects from). X-Forwarded-For is never consulted — that
 * stance is inherited from clientKey() deliberately.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {{ id: string, kind: 'local'|'tailnet'|'anonymous' }}
 */
export function principal(req) {}
```

- `clientKey(req)` becomes `principal(req).id`, so per-user quotas (idea #23)
  are real rather than collapsed onto one loopback bucket. Behaviour is
  identical when `GEV_TRUST_TAILSCALE` is unset — no change for `npm run dev`.
- **`/api/realtime/token` gains a requirement.** It mints an OpenAI ephemeral
  client secret that spends Ali's budget, and today it is unauthenticated with
  the per-IP limiter defaulting to *unlimited*. On the public listener:
  - with `GEV_REQUIRE_IDENTITY=1`, a request whose `principal().kind` is
    `anonymous` gets **403** before any upstream call;
  - `GEV_RATELIMIT_OPENAI_PER_MIN` gets a non-zero **default in production**
    (dev keeps unlimited), keyed on the principal;
  - the existing `X-GEV-Voice-Tier` / `-Model` echo headers are unchanged.
- `/api/realtime/debug-log` writes attacker-influenced JSONL to disk. On the
  public listener it is gated the same way and keeps its 8 MB cap; consider
  `GEV_ENABLE_DEBUG_LOG=0` by default in production.
- The dev server's document-level `X-Frame-Options: DENY` +
  `frame-ancestors 'none'` (set in `server.headers`) must be reproduced by
  `sirv` in `server/index.js` — they protect the *app document*, which is what
  makes the clickjacked same-origin credential write impossible.

---

## 8. What this unblocks

| Idea | Depends on | Notes |
|---|---|---|
| #21 launchd service | PR 1 + PR 8 | `node server/index.js` with `GEV_BIND=127.0.0.1`; `KeepAlive`, logs to `~/Library/Logs/gev/`. |
| #22 Tailscale + identity | PR 8 | `server/lib/identity.js` is the whole surface. |
| #23 per-user quotas | PR 8 | `clientKey` → `principal().id`. |
| #4 SQLite cache | PR 2, PR 9 | Parallel track; §5 contract. |
| #24 DuckDB archive | PR 2, PR 10 | Call sites already placed; §6. |
| #25 server-side fan-out | PR 5 | One poll loop replaces N browser polls; SSE alongside `ROUTES`. |
| #26 warm world snapshot | PR 9 | Boot-time `set()` into the persistent cache. |
| #27 local LLM via LiteLLM | PR 7 | `openai.js` gets a base-URL indirection; Realtime stays on OpenAI. |
| MCP server (`gev-mcp`) | PR 8 | Mounts as its own listener/transport, reusing `server/routes/*` handlers directly. E2's condition (iii). |

---

## 9. Non-goals

- No behaviour changes to any route in PRs 1–7. A diff that changes a status
  code, header, or body shape is out of scope and should be rejected in review.
- No reformatting of moved code. Move byte-for-byte so `git log --follow` and
  `git diff -M` stay readable, and so the security-control review in PRs 4, 6
  and 8 is a **whitespace-clean** diff.
- No client changes. `src/` continues to fetch relative `/api/...`.
- No new production dependency beyond `sirv` (PR 1) and `better-sqlite3` (PR 9,
  opt-in behind `GEV_CACHE=sqlite`). `connect` is vendored as 40 lines rather
  than added, per the council's supply-chain condition.
