# Desktop shell (Tauri v2) — Phase A: thin client

`apps/desktop/` packages God's Eye View as a native macOS app. It is a THIN
CLIENT: the native window is chrome (menu bar, notifications, a settings
form) around a REMOTE web app — it never bundles `src/`, `index.html`, or
any of the game's own code. The window loads whatever server URL is
configured (default `http://localhost:4173`, editable from File → Settings…),
the same production build served by `npm run preview` today, or later the
owner's Mac Studio over Tailscale.

Phase B (a later mission, after server PRs 3–8 land) bundles
`node server/index.js` as a Tauri sidecar so the `.app` runs standalone
without a separately-running server. Nothing in Phase A blocks that: the
server-URL setting simply becomes "the sidecar's own local port" as the
default, unless the owner points it elsewhere.

## Gate 0 — WebGL parity (WKWebView vs. Chrome)

Before any packaging work, this mission measured whether WKWebView (the
native macOS webview Tauri uses) renders the Cesium scene acceptably
compared to Chrome — orbiting the camera for 10 s with Flights + Satellites
enabled (the two continuous-render layers, i.e. worst case for frame budget).
Both sides run the *identical* measurement JS (rAF-driven, `camera.rotateRight`
every frame): `apps/desktop/src-tauri/src/lib.rs`'s `GATE0_MEASURE_JS` for
WKWebView, `scripts/qa-gate0-fps.mjs` for headless Chrome. Both load
`http://localhost:4206/#lat=30.2672&lon=-97.7431&alt=3000000&heading=0&pitch=-50&v=2&l=f.s`
— `lat`/`lon` are mandatory for `src/sharelink.js` to recognize the hash as
share state at all (v2/l alone parses as no-share-link); `v=2&l=f.s` then
decodes to Flights + Satellites enabled per `src/data/layerState.js`'s token
registry. Both wait 20 s after the scene reports ready before starting the
10 s measurement window, so tile/data warm-up is excluded from the sample.

**Numbers (captured 2026-09-09, `PORT=4206 npm run dev`, MacBook, macOS 26.5):**

<!-- GATE0_RESULTS -->

**Verdict:** <!-- GATE0_VERDICT -->

Reproduce:
```bash
# terminal 1 — dev server
PORT=4206 npm run dev

# terminal 2 — Chrome side
node scripts/qa-gate0-fps.mjs --url http://localhost:4206

# terminal 3 — WKWebView side (prints GATE0_WKWEBVIEW_* then exits)
GEV_GATE0=1 GEV_SERVER_URL="http://localhost:4206/#lat=30.2672&lon=-97.7431&alt=3000000&heading=0&pitch=-50&v=2&l=f.s" \
  npm run desktop:dev
```

## Prerequisites

- **Rust** (stable, via [rustup](https://rustup.rs) — NOT Homebrew's `rust`
  formula, which on this machine had an LLVM-version mismatch that broke
  `rustc` entirely; rustup installs its own matched toolchain into
  `~/.cargo/bin`). `export PATH="$HOME/.cargo/bin:$PATH"`.
- **Xcode Command Line Tools** (`xcode-select -p` should print a path;
  install with `xcode-select --install` if not). Tauri's macOS bundler
  shells out to `xcrun`/`actool`/`codesign`.
- Node 24 (repo standard — see `~/gods-eye-view-missions/COMMON.md`).
- `@tauri-apps/cli` is a root `devDependency`; `npx tauri --version` should
  print `tauri-cli 2.x` once `npm install` has run.

## Running

```bash
export PATH="$HOME/.cargo/bin:$PATH"

# Dev: opens a native window against a running dev server (localhost:4206,
# same as this repo's other PORT=42NN conventions — see tauri.conf.json's
# build.devUrl). Start `PORT=4206 npm run dev` first in another terminal.
npm run desktop:dev

# Release build: universal macOS .app + .dmg under
# apps/desktop/src-tauri/target/release/bundle/{macos,dmg}/
npm run desktop:build
```

The **actual runtime target** (what the shipped `.app` connects to day to
day) is independent of `devUrl` — it's the persisted "Server URL" setting
(`tauri-plugin-store`, key `serverUrl` in `settings.json` under the app's
data dir), defaulting to `http://localhost:4173`. Change it from the native
menu: **File → Settings…**. A `GEV_SERVER_URL` env var overrides both (dev
and release) for one run without touching the saved setting — handy for
Gate 0 and manual QA.

## What's wired

- **Menu bar**: File (Reload, Settings…, Quit), View (Toggle Fullscreen,
  Zoom In/Out/Reset, and — debug builds only — Toggle Developer Tools),
  Window (Minimize, Close). App name "God's Eye View", bundle id
  `de.thepuffer.godseyeview`, icon generated from `public/logo.svg` (which
  has a non-square viewBox, so it was rasterized onto a padded square canvas
  with `sharp` before `tauri icon` — see git history for the one-off script;
  the master PNG itself isn't committed, only the generated `icons/`).
- **Native notifications**: `src/platform/desktopBridge.js` (new file, one
  new import line in `src/main.js`) feature-detects `window.__TAURI__` and
  forwards the alerts-engine's `gev:alert` `CustomEvent` to
  `notify_from_web`, a Tauri command that shows a native notification via
  `tauri-plugin-notification`. The alerts-engine branch may or may not be
  merged — this only listens for the event, it doesn't depend on anything
  that dispatches it.
- **Remote IPC**: the main window loads a REMOTE origin (the configured
  server URL), which Tauri does not grant IPC access to by default. See
  `apps/desktop/src-tauri/capabilities/remote.json` — scoped to
  `notify_from_web` (an app-defined command; Tauri's own doc: "by default,
  all commands that you registered in your app are allowed to be used by all
  the windows and webviews of the app" once a capability's `remote.urls`
  matches). The pattern is intentionally `http(s)://*/*` because the server
  URL is user-configurable (localhost today, a Tailscale host later) — the
  only thing exposed to it is that one narrow command.
- **Microphone**: `apps/desktop/src-tauri/Info.plist` sets
  `NSMicrophoneUsageDescription` (auto-merged by Tauri — see "Info.plist or
  Info.macos.plist next to tauri.conf.json" in the Tauri v2 config docs).
  Verified `navigator.mediaDevices.getUserMedia({ audio: true })` resolves
  from inside the Tauri window and the macOS permission prompt appears (no
  `OPENAI_API_KEY` configured in this environment, so the Realtime voice
  button itself wasn't exercised end-to-end — see Known limitations).
- **Auto-update**: `tauri-plugin-updater` is registered and
  `plugins.updater` in `tauri.conf.json` has a placeholder `endpoints` entry
  and a `pubkey`. The pubkey is a **throwaway** keypair generated only to
  produce a schema-valid placeholder — its private half was never written
  into the repo or kept (generated to the session scratch dir, discarded).
  Before shipping real updates, the owner must:
  1. `npx tauri signer generate -w ~/.tauri/godseyeview.key` (keep the
     private key OFF this repo, e.g. in the Studio's secrets store).
  2. Replace `plugins.updater.pubkey` in `tauri.conf.json` with the new
     public key.
  3. Host update manifests at the `endpoints` URL (currently a placeholder
     `updates.thepuffer.internal` host) and sign release artifacts with
     `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set
     in the release environment (`tauri build` picks these up automatically).
  4. Set `bundle.createUpdaterArtifacts: true` once signing is live —
     deliberately left unset for this mission so an unsigned Phase A build
     doesn't fail validation.

## Phase B plan (sidecar, later mission)

Bundle `node server/index.js` as a Tauri
[sidecar](https://v2.tauri.app/develop/sidecar/) (`tauri.conf.json`'s
`bundle.externalBin`), spawn it from `setup()` on a loopback port chosen at
launch, and make that port the DEFAULT server URL instead of
`localhost:4173` — the user-editable setting stays, so pointing at the
Mac Studio remains a one-field change. Needs: bundling a Node runtime or
switching the server to a Bun/single-binary build (`server/index.js`'s own
dependency footprint decides which), graceful sidecar shutdown on app quit,
and a port-collision fallback.

## Known limitations (Phase A)

- No sidecar yet — the app is useless without a server already running
  somewhere reachable at the configured URL.
- The Realtime voice button was not exercised with a live `OPENAI_API_KEY`
  in this environment; only the underlying `getUserMedia` permission path
  was verified.
- Auto-update is wired but inert (`createUpdaterArtifacts` unset, no real
  signing key, placeholder endpoint host) — see above.
- Unsigned/un-notarized build. To notarize for distribution outside this
  machine: enroll in the Apple Developer Program, set
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
  password), and `APPLE_TEAM_ID` in the build environment, then
  `npm run desktop:build` — Tauri's bundler codesigns and notarizes
  automatically when those are present. Without them (this build), macOS
  Gatekeeper will warn on first launch; right-click → Open bypasses it.
- The "Zoom In/Out/Reset" menu items scale the whole page via CSS zoom
  (`document.documentElement.style.zoom`) rather than a native pinch-zoom —
  simplest thing that works for a thin client with no access to the remote
  page's own camera-zoom controls.
