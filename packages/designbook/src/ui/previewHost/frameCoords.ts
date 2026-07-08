/**
 * Pure coordinate math for the App-page frame cell's tool overlays.
 *
 * An iframe's OWN internal viewport (what `elementsFromPoint`/`getBoundingClientRect`
 * report for nodes INSIDE it) is laid out at the iframe's own CSS box size and is
 * NOT affected by an ancestor's CSS `transform` — only the iframe's outer, on-screen
 * box (`iframe.getBoundingClientRect()` as seen from the parent) shrinks/grows with
 * the canvas's pan/zoom. So two conversions are needed, both pure given plain
 * boxes/points (no DOM access here — that lives in `framePreviewHost.ts`):
 *
 *   - `screenPointToFrameLocal`: a parent-screen pointer position → the
 *     frame-internal coordinates `frameDoc.elementsFromPoint` expects.
 *   - `frameLocalBoxToScreenBox`: a rect measured INSIDE the frame (e.g. a hit
 *     fiber's `getBoundingClientRect()`) → the equivalent parent-screen rect, which
 *     the existing `screenRectToStageRect` (CanvasOverlay/TextToolOverlay) then
 *     maps into stage space exactly like any same-document overlay rect.
 *
 * `frameScale` derives the effective scale from the iframe's rendered vs. logical
 * width rather than trusting the canvas's `transform.scale` directly — it stays
 * correct even if something other than the canvas stage (e.g. a future device-width
 * preset) resizes the iframe's on-screen box independently of canvas zoom.
 */

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** Effective on-screen scale of an iframe, given its rendered screen box and its
 * own logical (unscaled) layout width. Falls back to 1 when the layout width
 * isn't measurable yet (e.g. mid-mount) rather than dividing by zero. */
function frameScale(frameScreenRect: Box, layoutWidth: number): number {
  if (!layoutWidth) return 1;
  return frameScreenRect.width / layoutWidth;
}

/** A parent-screen point (e.g. a pointer event's `clientX`/`clientY`) → the
 * frame-internal coordinates its own document's `elementsFromPoint` expects. */
function screenPointToFrameLocal(
  point: Point,
  frameScreenRect: Box,
  scale: number,
): Point {
  const s = scale || 1;
  return {
    x: (point.x - frameScreenRect.x) / s,
    y: (point.y - frameScreenRect.y) / s,
  };
}

/** Whether a frame-local point falls inside the frame's own content box — guards
 * a hit resolved from a pointer position that's technically over the iframe
 * element (e.g. its border/scrollbar chrome) but outside its document viewport. */
function isWithinFrameBounds(
  point: Point,
  contentWidth: number,
  contentHeight: number,
): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= contentWidth &&
    point.y <= contentHeight
  );
}

/** A rect measured inside the frame's own document (frame-internal coordinates)
 * → the equivalent rect in the PARENT's screen space — feed the result through
 * `screenRectToStageRect` for the final stage-space overlay position. */
function frameLocalBoxToScreenBox(
  box: Box,
  frameScreenRect: Box,
  scale: number,
): Box {
  const s = scale || 1;
  return {
    x: frameScreenRect.x + box.x * s,
    y: frameScreenRect.y + box.y * s,
    width: box.width * s,
    height: box.height * s,
  };
}

/**
 * Whether a value captured against the frame's document at `capturedGeneration`
 * should be treated as stale because the frame has since navigated/reloaded
 * (the App page bumps a generation counter on every `load` event — see
 * `appFrameContext.ts`). Used to drop in-flight hover/edit state that was
 * resolved against a document that no longer exists, rather than letting a
 * rAF-deferred callback act on it.
 */
function isFrameDocumentStale(
  capturedGeneration: number,
  currentGeneration: number,
): boolean {
  return capturedGeneration !== currentGeneration;
}

export {
  frameLocalBoxToScreenBox,
  frameScale,
  isFrameDocumentStale,
  isWithinFrameBounds,
  screenPointToFrameLocal,
};
export type { Box, Point };
