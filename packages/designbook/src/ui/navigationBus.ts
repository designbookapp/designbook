/**
 * Deep-link navigation bus.
 *
 * The injected boot module (plugin.ts) points the full view's center frame at
 * the live page's route via `WorkbenchHandle.navigateToApp(path)` on expand,
 * and can open the fullscreen sandbox canvas via `navigateToSandbox(pinId)`.
 * It can't reach the view's in-tree router directly, so this tiny module
 * bridges the two:
 *
 *   - `requestNavigateApp(path)` / `requestNavigateSandbox(pinId)` record the
 *     target AND dispatch a window event, covering both timings — the request
 *     may arrive before the full view mounts (picked up via
 *     `takePendingNavigateApp` / `takePendingNavigateSandbox` in its mount
 *     effect) or after (delivered live via `onNavigateApp` /
 *     `onNavigateSandbox`).
 *
 * This is deliberately minimal plumbing; the full in-memory router lives in useCanvasRoute.ts.
 */

const APP_EVENT = "designbook:navigateApp";

let pendingApp: string | undefined;

/** Point the full view's frame at `path` (from the boot module). */
function requestNavigateApp(path: string): void {
  pendingApp = path;
  window.dispatchEvent(new CustomEvent(APP_EVENT, { detail: { path } }));
}

/** Consume an app-page navigation requested before the workbench subscribed. */
function takePendingNavigateApp(): string | undefined {
  const value = pendingApp;
  pendingApp = undefined;
  return value;
}

/** Subscribe to live app-page navigation requests; returns an unsubscribe. */
function onNavigateApp(handler: (path: string) => void): () => void {
  function listener(event: Event) {
    const detail = (event as CustomEvent<{ path?: string }>).detail;
    if (detail && typeof detail.path === "string" && detail.path) {
      handler(detail.path);
    }
  }
  window.addEventListener(APP_EVENT, listener);
  return () => window.removeEventListener(APP_EVENT, listener);
}

// --- Sandbox canvas (docs/specs/sandbox.md): the same bus mirror
// (pending + live event) for opening the fullscreen canvas on a pin.

const SANDBOX_EVENT = "designbook:navigateSandbox";

let pendingSandbox: string | undefined;

/** Ask the workbench to open the sandbox canvas on `pinId`. */
function requestNavigateSandbox(pinId: string): void {
  pendingSandbox = pinId;
  window.dispatchEvent(new CustomEvent(SANDBOX_EVENT, { detail: { pinId } }));
}

/** Consume a sandbox navigation requested before the workbench subscribed. */
function takePendingNavigateSandbox(): string | undefined {
  const value = pendingSandbox;
  pendingSandbox = undefined;
  return value;
}

/** Subscribe to live sandbox navigation requests; returns an unsubscribe. */
function onNavigateSandbox(handler: (pinId: string) => void): () => void {
  function listener(event: Event) {
    const detail = (event as CustomEvent<{ pinId?: string }>).detail;
    if (detail && typeof detail.pinId === "string" && detail.pinId) {
      handler(detail.pinId);
    }
  }
  window.addEventListener(SANDBOX_EVENT, listener);
  return () => window.removeEventListener(SANDBOX_EVENT, listener);
}

export {
  onNavigateApp,
  onNavigateSandbox,
  requestNavigateApp,
  requestNavigateSandbox,
  takePendingNavigateApp,
  takePendingNavigateSandbox,
};
