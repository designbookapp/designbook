/**
 * Pure geometry for the in-preview element-select layer (SandboxPreviewSelect):
 * viewport-space hit rects → layer-relative overlay boxes, and the anchored
 * prompt-box position clamped into the layer. DOM-free so it unit-tests in
 * the node env (the pageHit.ts discipline).
 */

import type { Box } from "@designbook-ui/screens/pageTools/pageHit";

/** Translate a viewport-space rect into the layer's local coordinates. */
function relativeToLayer(rect: Box, layerRect: Box): Box {
  return {
    x: rect.x - layerRect.x,
    y: rect.y - layerRect.y,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Anchor the compact prompt box under `rect` (both viewport space), clamped
 * so the box stays inside the layer: left within [0, layerW - boxW], top
 * preferring "just below the selection" but pulled up when that would push
 * the box past the layer's bottom edge. Small layers degrade gracefully
 * (top/left clamp to the margin).
 */
function anchoredPromptBoxPosition(params: {
  rect: Box;
  layerRect: Box;
  boxWidth: number;
  boxHeight: number;
  margin?: number;
}): { left: number; top: number } {
  const { rect, layerRect, boxWidth, boxHeight } = params;
  const margin = params.margin ?? 4;
  const local = relativeToLayer(rect, layerRect);
  const left = Math.max(
    margin,
    Math.min(local.x, layerRect.width - boxWidth - margin),
  );
  const below = local.y + local.height + 6;
  const top = Math.max(
    margin,
    Math.min(below, layerRect.height - boxHeight - margin),
  );
  return { left, top };
}

export { anchoredPromptBoxPosition, relativeToLayer };
