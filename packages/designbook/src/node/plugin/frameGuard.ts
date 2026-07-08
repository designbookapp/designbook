/**
 * Boot-module recursion guard.
 *
 * A live App-page frame cell loads the SAME dev server (same Vite +
 * `designbookPlugin()`), so without a guard the framed document would boot a
 * second toolbar, arm the reload-defer WebSocket patch, and read/write the
 * SAME per-origin `sessionStorage` persist keys as the top document — the
 * watch-out this guard exists for. It must run before any of
 * that.
 *
 * Two independent signals, either one is enough to bail:
 *   - `?__designbook_frame=1` on the framed document's own URL (belt-and-
 *     suspenders — set by {@link buildFrameSrc} in the UI package).
 *   - `window.top !== window.self` (this document is framed) AND
 *     `window.top.__designbook` is reachable and truthy (the parent is a
 *     designbook-injected page, same-origin). A cross-origin parent throws on
 *     read — treated as "no marker" (not our own frame cell), so `topHasMarker`
 *     is `undefined` in that case, not `false`.
 *
 * This module holds the decision as a pure, unit-testable predicate. The
 * ACTUAL runtime guard lives inline in `bootSource` / `RELOAD_GUARD_SOURCE`
 * (plugin.ts) — plain JS shipped to the browser, evaluated before `window`,
 * `document`, and the target app's own modules exist in any test environment.
 * The inline copies mirror this algorithm by hand; keep them in sync.
 */

/** Query param a frame cell's `src` carries (see `appFrame.ts` in the UI package). */
const FRAME_QUERY_PARAM = "__designbook_frame";

interface FrameGuardInputs {
  /** Raw `location.search` of the document being booted, e.g. `"?__designbook_frame=1"`. */
  search: string;
  /** `window.top !== window.self` — false when this window IS the top window. */
  isFramed: boolean;
  /**
   * Whether `window.top.__designbook` was reachable and truthy. `undefined`
   * when reading it threw (cross-origin parent) — never treated as a match.
   */
  topHasMarker: boolean | undefined;
}

/** True when the boot module should bail before any side effect. */
function shouldBailAsFrame({
  search,
  isFramed,
  topHasMarker,
}: FrameGuardInputs): boolean {
  const params = new URLSearchParams(search);
  if (params.get(FRAME_QUERY_PARAM) === "1") return true;
  return isFramed && topHasMarker === true;
}

export { FRAME_QUERY_PARAM, shouldBailAsFrame };
export type { FrameGuardInputs };
