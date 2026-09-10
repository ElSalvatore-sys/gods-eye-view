// @ts-nocheck
/**
 * Desktop Bridge — Tauri native-notification adapter
 *
 * When this page runs inside the God's Eye View desktop shell (Tauri, see
 * `apps/desktop/`), `window.__TAURI__` is present. This module forwards the
 * alerts-engine's `gev:alert` CustomEvent to a native macOS notification via
 * the shell's `notify_from_web` command. In a plain browser tab
 * `window.__TAURI__` is undefined, so `initDesktopBridge()` is a no-op —
 * there is no alerts-engine dependency here, only a feature-detected event
 * listener, so this works whether or not that branch is merged.
 */

/**
 * Wire the `gev:alert` → native-notification bridge if running inside Tauri.
 * Safe to call unconditionally on every page load.
 * @returns {boolean} true if the bridge was installed
 */
export function initDesktopBridge() {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return false;

  document.addEventListener('gev:alert', (event) => {
    const detail = event?.detail || {};
    const title = String(detail.title || "God's Eye View");
    const body = detail.body != null ? String(detail.body) : undefined;
    tauri.core.invoke('notify_from_web', { title, body }).catch((err) => {
      console.warn('[desktopBridge] native notification failed:', err);
    });
  });

  return true;
}
