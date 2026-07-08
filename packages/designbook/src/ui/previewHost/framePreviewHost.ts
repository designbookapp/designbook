/**
 * PreviewHost over a same-origin `<iframe>` — the App page frame
 * cell's binding of the seam described in `index.ts`.
 *
 * The fiber hit-testing / drill / code-target functions re-exported from this
 * package (`hitTest`, `hitTestChain`, `getFiberRects`, …) are already
 * document-agnostic — they walk `fiber.return`/`child` and read DOM expandos off
 * whatever `Element` they're given, never touching a global `document`/`window` —
 * so they work unmodified on elements from `iframe.contentDocument`. What's
 * actually frame-specific, and lives here, is everything ABOUT reaching that
 * document safely from the parent:
 *
 *   - `iframe.contentDocument`/`contentWindow` can throw (a cross-origin
 *     navigation inside the frame, e.g. an external auth provider) or simply be
 *     absent for a beat around a reload — every accessor here is a safe,
 *     try/catch'd read, never a throw.
 *   - Registry matching for elements that come from the frame ALWAYS falls back
 *     to `matchFiber`'s by-name path: the frame is a separate module
 *     instantiation (its own `<script type=module>` graph), so component
 *     function references there are never `===` the parent's — only the
 *     `registryByName` lookup (a plain string match) can succeed. This needs no
 *     code here; it's already how `matchFiber` in `fibers.ts` is written.
 *   - Coordinate translation between the frame's own internal viewport and the
 *     parent's screen space (`frameCoords.ts`, pure and unit-tested) — an
 *     iframe's internal layout is unaffected by an ancestor's CSS transform, so
 *     the canvas's pan/zoom has to be applied by hand.
 */

import {
  frameLocalBoxToScreenBox,
  frameScale,
  screenPointToFrameLocal,
  isWithinFrameBounds,
  type Box,
} from "./frameCoords";

/** `iframe.contentDocument`, or `undefined` if unreachable (cross-origin, or the
 * frame hasn't attached a document yet). Never throws. */
function safeFrameDocument(iframe: HTMLIFrameElement): Document | undefined {
  try {
    return iframe.contentDocument ?? undefined;
  } catch {
    return undefined;
  }
}

/** `iframe.contentWindow`, or `undefined` if unreachable. Never throws. */
function safeFrameWindow(iframe: HTMLIFrameElement): Window | undefined {
  try {
    return iframe.contentWindow ?? undefined;
  } catch {
    return undefined;
  }
}

function boxFromRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Box {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * The innermost element in the frame's own document under a PARENT-screen point
 * (e.g. a pointer event's `clientX`/`clientY`), or `undefined` when the frame's
 * document isn't reachable or the point falls outside its content box.
 */
function elementAtFramePoint(
  iframe: HTMLIFrameElement,
  screenX: number,
  screenY: number,
): Element | undefined {
  const frameDoc = safeFrameDocument(iframe);
  if (!frameDoc) return undefined;

  const frameScreenRect = boxFromRect(iframe.getBoundingClientRect());
  const scale = frameScale(frameScreenRect, iframe.clientWidth);
  const local = screenPointToFrameLocal(
    { x: screenX, y: screenY },
    frameScreenRect,
    scale,
  );
  if (!isWithinFrameBounds(local, iframe.clientWidth, iframe.clientHeight)) {
    return undefined;
  }

  try {
    return frameDoc.elementsFromPoint(local.x, local.y)[0] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A rect measured inside the frame's own document (e.g. `el.getBoundingClientRect()`
 * for an `el` that lives in `iframe.contentDocument`) → the equivalent rect in the
 * PARENT's screen space. Feed the result through the canvas's own
 * `screenRectToStageRect` for the final stage-space overlay position.
 */
function frameLocalRectToScreenRect(
  iframe: HTMLIFrameElement,
  rect: { x: number; y: number; width: number; height: number },
): Box {
  const frameScreenRect = boxFromRect(iframe.getBoundingClientRect());
  const scale = frameScale(frameScreenRect, iframe.clientWidth);
  return frameLocalBoxToScreenBox(boxFromRect(rect), frameScreenRect, scale);
}

export {
  elementAtFramePoint,
  frameLocalRectToScreenRect,
  safeFrameDocument,
  safeFrameWindow,
};
