/**
 * Deep-link navigation bus.
 *
 * The injected boot module (plugin.ts) drives the workbench to a component via
 * `WorkbenchHandle.navigateTo(entryId)` — used for the `/__designbook/component/
 * <entryId>` deep link — and to the App page via `WorkbenchHandle.navigateToApp
 * (path)`, used when a plain "expand" from the page-tools strip should land on
 * the App page showing the live page's route. It can't reach the workbench's
 * in-tree router directly, so this tiny module bridges the two:
 *
 *   - `requestNavigate(entryId)` / `requestNavigateApp(path)` record the target
 *     AND dispatch a window event, covering both timings — the request may
 *     arrive before the Workbench mounts (picked up via `takePendingNavigate` /
 *     `takePendingNavigateApp` in its mount effect) or after (delivered live via
 *     `onNavigate` / `onNavigateApp`).
 *
 * This is deliberately minimal plumbing; the full in-memory router lives in useCanvasRoute.ts.
 */

const EVENT = "designbook:navigate";
const APP_EVENT = "designbook:navigateApp";

let pending: string | undefined;
let pendingApp: string | undefined;

/** Ask the workbench to open a component entry (from the boot module). */
function requestNavigate(entryId: string): void {
  pending = entryId;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { entryId } }));
}

/** Consume a navigation requested before the workbench subscribed. */
function takePendingNavigate(): string | undefined {
  const value = pending;
  pending = undefined;
  return value;
}

/** Subscribe to live navigation requests; returns an unsubscribe. */
function onNavigate(handler: (entryId: string) => void): () => void {
  function listener(event: Event) {
    const detail = (event as CustomEvent<{ entryId?: string }>).detail;
    if (detail && typeof detail.entryId === "string" && detail.entryId) {
      handler(detail.entryId);
    }
  }
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** Ask the workbench to open the App page on `path` (from the boot module). */
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

export {
  onNavigate,
  onNavigateApp,
  requestNavigate,
  requestNavigateApp,
  takePendingNavigate,
  takePendingNavigateApp,
};
