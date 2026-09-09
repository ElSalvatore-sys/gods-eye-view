//! God's Eye View desktop shell — Phase A "thin client".
//!
//! The native window is just a chrome around a REMOTE web app. It never bundles
//! the web app's own code; it only stores/reads the server URL the window
//! should point at (via `tauri-plugin-store`), builds a native macOS menu bar,
//! and forwards `gev:alert` browser events to native notifications.
//!
//! Phase B (later mission) bundles `node server/index.js` as a sidecar so the
//! `.app` can run standalone; see `docs/TAURI.md`.

use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

/// Used when the store has never been written and no override env var is set.
/// Matches `npm run preview`'s default port — the owner's day-to-day server.
const DEFAULT_SERVER_URL: &str = "http://localhost:4173";

/// Name of the persisted key/value store file (relative to the app data dir).
const STORE_FILE: &str = "settings.json";

/// Key under which the configured server URL is persisted.
const SERVER_URL_KEY: &str = "serverUrl";

/// Resolve the server URL the main window should load, in priority order:
/// 1. `GEV_SERVER_URL` env var (dev/test override, never persisted) — lets
///    Gate 0 and other manual runs point at an arbitrary dev server without
///    touching the user's saved setting.
/// 2. The value persisted in the store from a previous "Settings…" save.
/// 3. `DEFAULT_SERVER_URL`.
fn resolve_server_url(app: &AppHandle) -> String {
  if let Ok(url) = std::env::var("GEV_SERVER_URL") {
    if !url.trim().is_empty() {
      return url;
    }
  }
  match app.store(STORE_FILE) {
    Ok(store) => store
      .get(SERVER_URL_KEY)
      .and_then(|v| v.as_str().map(str::to_string))
      .filter(|s| !s.trim().is_empty())
      .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string()),
    Err(err) => {
      log::warn!("could not open settings store, using default server URL: {err}");
      DEFAULT_SERVER_URL.to_string()
    }
  }
}

/// Point the main window at `url`, creating it if this is the first call.
fn apply_server_url(app: &AppHandle, url: &str) -> tauri::Result<()> {
  let parsed = url::Url::parse(url).map_err(|e| tauri::Error::InvalidUrl(e))?;
  if let Some(window) = app.get_webview_window("main") {
    window.navigate(parsed)?;
    window.set_focus()?;
  } else {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
      .title("God's Eye View")
      .inner_size(1400.0, 900.0)
      .min_inner_size(900.0, 600.0)
      .build()?;
  }
  Ok(())
}

/// Open (or focus) the native "Settings…" window — a tiny local HTML form,
/// never the remote page — that edits the persisted server URL.
fn open_settings_window(app: &AppHandle) -> tauri::Result<()> {
  if let Some(window) = app.get_webview_window("settings") {
    window.set_focus()?;
    return Ok(());
  }
  WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
    .title("God's Eye View — Settings")
    .inner_size(480.0, 220.0)
    .resizable(false)
    .build()?;
  Ok(())
}

/// Read the persisted server URL. Invoked by `web/settings.html`.
#[tauri::command]
fn get_server_url(app: AppHandle) -> Result<String, String> {
  Ok(resolve_server_url(&app))
}

/// Persist a new server URL and immediately navigate the main window to it.
/// Invoked by `web/settings.html`'s Save button.
#[tauri::command]
fn set_server_url(app: AppHandle, url: String) -> Result<(), String> {
  let trimmed = url.trim();
  let parsed = url::Url::parse(trimmed).map_err(|e| format!("invalid URL: {e}"))?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return Err("server URL must be http:// or https://".to_string());
  }
  let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
  store.set(SERVER_URL_KEY, serde_json::Value::String(trimmed.to_string()));
  store.save().map_err(|e| e.to_string())?;
  apply_server_url(&app, trimmed).map_err(|e| e.to_string())?;
  if let Some(settings) = app.get_webview_window("settings") {
    let _ = settings.close();
  }
  Ok(())
}

/// Forward a `gev:alert` browser CustomEvent (see `src/platform/desktopBridge.js`
/// in the main web app) to a native macOS notification. This is the ONLY
/// command the remote page may invoke — see `capabilities/remote.json`.
#[tauri::command]
fn notify_from_web(app: AppHandle, title: String, body: Option<String>) -> Result<(), String> {
  let mut builder = app.notification().builder().title(title);
  if let Some(body) = body {
    builder = builder.body(body);
  }
  builder.show().map_err(|e| e.to_string())
}

/// JS injected into the main window by the `GEV_GATE0=1` harness (see
/// `run()` below). Deliberately mirrors `scripts/qa-gate0-fps.mjs`'s Chrome
/// measurement almost line-for-line — same 10 s window, same
/// `camera.rotateRight` orbit step per frame — so the two FPS numbers in
/// `docs/TAURI.md` are an apples-to-apples WKWebView-vs-Chrome comparison.
const GATE0_MEASURE_JS: &str = r#"(function () {
  var gev = window.__godsEyeView;
  if (!gev || !gev.viewer) {
    window.__TAURI__.core.invoke('gate0_report', { frames: 0, elapsedMs: 0 });
    return;
  }
  var v = gev.viewer;
  v.camera.cancelFlight();
  var frames = 0;
  var t0 = performance.now();
  function tick(now) {
    frames++;
    v.camera.rotateRight(0.0026);
    if (now - t0 < 10000) {
      requestAnimationFrame(tick);
    } else {
      window.__TAURI__.core.invoke('gate0_report', { frames: frames, elapsedMs: now - t0 });
    }
  }
  requestAnimationFrame(tick);
})();"#;

/// Reports the result of `GATE0_MEASURE_JS` back from the webview. Prints a
/// `GATE0_WKWEBVIEW_FPS=` line for `scripts/run-gate0.sh` to capture, then
/// exits the app — this harness exists to produce ONE number and stop.
#[tauri::command]
fn gate0_report(app: AppHandle, frames: u32, elapsed_ms: f64) -> Result<(), String> {
  let fps = if elapsed_ms > 0.0 { f64::from(frames) / (elapsed_ms / 1000.0) } else { 0.0 };
  println!("GATE0_WKWEBVIEW_FRAMES={frames}");
  println!("GATE0_WKWEBVIEW_ELAPSED_MS={elapsed_ms:.1}");
  println!("GATE0_WKWEBVIEW_FPS={fps:.2}");
  app.exit(0);
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_notification::init())
    .invoke_handler(tauri::generate_handler![
      get_server_url,
      set_server_url,
      notify_from_web,
      gate0_report
    ])
    .setup(|app| {
      let handle = app.handle().clone();

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      #[cfg(desktop)]
      app
        .handle()
        .plugin(tauri_plugin_updater::Builder::new().build())?;

      let initial_url = resolve_server_url(&handle);
      apply_server_url(&handle, &initial_url)?;

      // Gate 0 (docs/TAURI.md): `GEV_GATE0=1 GEV_SERVER_URL=... npm run desktop:dev`
      // waits for the scene to settle, then measures 10 s of WKWebView FPS.
      if std::env::var("GEV_GATE0").as_deref() == Ok("1") {
        if let Some(window) = handle.get_webview_window("main") {
          std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let _ = window.eval(GATE0_MEASURE_JS);
          });
        }
      }

      // ---- Native menu bar ----------------------------------------------
      let file_menu = SubmenuBuilder::new(app, "File")
        .text("reload", "Reload")
        .text("settings", "Settings…")
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit God's Eye View"))?)
        .build()?;

      let mut view_menu_builder = SubmenuBuilder::new(app, "View")
        .text("toggle-fullscreen", "Toggle Fullscreen")
        .separator()
        .text("zoom-in", "Zoom In")
        .text("zoom-out", "Zoom Out")
        .text("zoom-reset", "Actual Size");
      if cfg!(debug_assertions) {
        view_menu_builder = view_menu_builder.separator().text("toggle-devtools", "Toggle Developer Tools");
      }
      let view_menu = view_menu_builder.build()?;

      let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, Some("Close"))?)
        .build()?;

      let menu = MenuBuilder::new(app)
        .items(&[&file_menu, &view_menu, &window_menu])
        .build()?;
      app.set_menu(menu)?;

      app.on_menu_event(move |app_handle, event| {
        let Some(window) = app_handle.get_webview_window("main") else { return };
        match event.id().0.as_str() {
          "reload" => {
            let url = resolve_server_url(app_handle);
            let _ = apply_server_url(app_handle, &url);
          }
          "settings" => {
            let _ = open_settings_window(app_handle);
          }
          "toggle-fullscreen" => {
            let is_full = window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(!is_full);
          }
          "zoom-in" => {
            let _ = window.eval(
              "window.__gevZoom = Math.min(3, (window.__gevZoom || 1) + 0.1); document.documentElement.style.zoom = window.__gevZoom;",
            );
          }
          "zoom-out" => {
            let _ = window.eval(
              "window.__gevZoom = Math.max(0.3, (window.__gevZoom || 1) - 0.1); document.documentElement.style.zoom = window.__gevZoom;",
            );
          }
          "zoom-reset" => {
            let _ = window.eval("window.__gevZoom = 1; document.documentElement.style.zoom = 1;");
          }
          #[cfg(debug_assertions)]
          "toggle-devtools" => {
            if window.is_devtools_open() {
              window.close_devtools();
            } else {
              window.open_devtools();
            }
          }
          _ => {}
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
