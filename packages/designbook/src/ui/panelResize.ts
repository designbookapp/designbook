/**
 * Pure math for the workbench side-panel resize handles (left Files/Changes
 * panel and right Chat/Props/Code panel). Kept free of DOM/React so the
 * clamp + drag arithmetic is unit-testable (`panelResize.test.ts`); the
 * pointer plumbing lives in `components/PanelResizeHandle.tsx`.
 */

/** Smallest usable panel width, px. */
const PANEL_MIN_WIDTH = 260;
/** Largest panel width, px — keeps the canvas visible on laptop screens. */
const PANEL_MAX_WIDTH = 640;
/** Default width for BOTH side panels (fresh sessions only — a persisted
 * user width always wins via `initialPanelWidth`). Also the double-click
 * reset target of each drag handle. */
const PANEL_DEFAULT_WIDTH = 280;

/** Which edge of its panel a drag handle sits on: the left panel's handle is
 * on its "right" (inner) edge, the right panel's on its "left". Determines
 * which pointer direction grows the panel. */
type PanelHandleEdge = "left" | "right";

/** Clamp a width into the resizable range (rounded to whole px). */
function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, Math.round(width)),
  );
}

/**
 * Width during a drag: the pointer's horizontal delta applied in the
 * direction that grows the panel (right edge → dragging right widens;
 * left edge → dragging left widens), clamped.
 */
function dragPanelWidth(
  startWidth: number,
  startClientX: number,
  clientX: number,
  edge: PanelHandleEdge,
): number {
  const delta = clientX - startClientX;
  return clampPanelWidth(
    edge === "right" ? startWidth + delta : startWidth - delta,
  );
}

/** Seed width from a persisted value: absent/garbage → default, else clamped
 * (so a blob written under different limits can't produce an unusable panel). */
function initialPanelWidth(persisted: number | null | undefined): number {
  return typeof persisted === "number" && Number.isFinite(persisted)
    ? clampPanelWidth(persisted)
    : PANEL_DEFAULT_WIDTH;
}

export {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  dragPanelWidth,
  initialPanelWidth,
};
export type { PanelHandleEdge };
