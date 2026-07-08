/**
 * `virtual:designbook-mark` runtime — top-window fallback.
 *
 * The pageText transform wraps the app's `t()`/`i18n._()` call sites in
 * `__dbMark(value, key, ns)` (see `pageTextTransform.ts`), which normally
 * delegates to `window.__designbook.mark` — installed by `pageMark.ts` from the
 * injected top page. Inside an App-page frame cell, though, the boot module's
 * recursion guard (`frameGuard.ts`) bails BEFORE that install runs, so
 * `window.__designbook` never exists in the frame's own realm — `__dbMark` would
 * see no `.mark` hook and stay permanently passthrough, and the frame's marked
 * strings would never light up for the text tool.
 *
 * The fix: when the LOCAL hook is absent, fall back to `window.top.__designbook`
 * (same-origin reachable — the frame's `window.top` IS the injected top page that
 * hosts the App page cell showing it) and use ITS `.mark` hook + `textToolActive`
 * state instead. Two rules, both load-bearing:
 *   - Local wins when present — a page that legitimately booted designbook
 *     itself (the ordinary, non-framed case) must never look at `window.top`.
 *   - The frame must never WRITE to its own `window.__designbook` — only read
 *     the parent's. Marking a frame string calls the PARENT's `mark` closure,
 *     which registers the attribution into the parent's own marker table (the
 *     same one its canvas/page-tools decoder reads) — nothing is written
 *     frame-side, so a half-booted frame can't corrupt anything.
 *
 * This module holds the decision as a pure, unit-testable predicate, mirroring
 * `frameGuard.ts`'s pattern. The ACTUAL runtime lives in `MARK_MODULE_SOURCE`
 * (`pageTextTransform.ts`) — plain JS shipped to the browser — with the same
 * algorithm duplicated by hand; keep them in sync.
 */

interface MarkHostInputs {
  /** Whether `window.__designbook?.mark` exists in THIS window. */
  hasLocalMark: boolean;
  /** `window.top !== window.self` — false when this window IS the top window. */
  isFramed: boolean;
  /**
   * Whether `window.top.__designbook?.mark` was reachable and truthy.
   * `undefined` when reading it threw (cross-origin parent) — never treated as
   * a match.
   */
  topHasMark: boolean | undefined;
}

/** Which mark hook `__dbMark` should call: the local one, the top window's
 * (frame fallback), or none (stay passthrough). */
type MarkHostChoice = "local" | "top" | "none";

function resolveMarkHost({
  hasLocalMark,
  isFramed,
  topHasMark,
}: MarkHostInputs): MarkHostChoice {
  if (hasLocalMark) return "local";
  if (isFramed && topHasMark === true) return "top";
  return "none";
}

export { resolveMarkHost };
export type { MarkHostChoice, MarkHostInputs };
