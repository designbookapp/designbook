/**
 * Pure helpers for the page-tools select layer.
 *
 * Page mode operates on the LIVE app DOM in viewport space (identity transform,
 * no canvas stage), so — unlike the canvas overlay — the geometry here is just a
 * union of viewport rects and the chip is positioned at those raw coordinates.
 * Everything in this module is DOM-free so it unit-tests in the node env; the
 * impure fiber/registry resolution lives in `resolvePageHit.ts`.
 */

import type { CanvasCodeTarget } from "@designbook-ui/types";

/** A viewport-space rectangle (client coords). */
type Box = { x: number; y: number; width: number; height: number };

type PageDom = { tag: string; id?: string; classes?: string[] };

/**
 * A resolved page selection/hover. A `component` hit maps to a registered
 * component (`entryId` set → "Go to component" enabled); a `dom` hit is a plain
 * element with no registered owner (chip shows `tag.class`, no go-to).
 */
type PageHit = {
  kind: "component" | "dom";
  /** Viewport-space bounds of the hit (already unioned). */
  rect: Box;
  /** Chip label: registry label for a component, else `tag#id`/`tag.class`/`tag`. */
  label: string;
  /** Registered component entry id — presence enables "Go to component". */
  entryId?: string;
  /** Registry label of the associated component (for the Pi prompt). */
  entryLabel?: string;
  /** Source path of the associated component. */
  sourcePath?: string;
  /** Usage-line attribution when the hit is a drilled (non-outermost) level. */
  codeTarget?: CanvasCodeTarget;
  /** Set for a plain DOM hit. */
  dom?: PageDom;
  /** Fiber-derived nearest component name for an unregistered DOM hit (a hint). */
  hint?: string;
};

/** css-ish label for a plain DOM element: `tag#id` / `tag.class` / `tag`. */
function domLabel(dom: PageDom): string {
  if (dom.id) return `${dom.tag}#${dom.id}`;
  if (dom.classes && dom.classes.length > 0) return `${dom.tag}.${dom.classes[0]}`;
  return dom.tag;
}

/** Chip label for a hit: the component's registry label, or the DOM css-ish label. */
function chipLabel(hit: {
  kind: "component" | "dom";
  entryLabel?: string;
  dom?: PageDom;
}): string {
  if (hit.kind === "component" && hit.entryLabel) return hit.entryLabel;
  if (hit.dom) return domLabel(hit.dom);
  return hit.entryLabel ?? "";
}

/**
 * Union a set of viewport rects into a single box, dropping zero-area rects.
 * Returns undefined when nothing measurable remains (mirrors `unionRects`, but
 * over plain boxes so it's testable without `DOMRect`).
 */
function unionBox(rects: readonly Box[]): Box | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    if (rect.width === 0 && rect.height === 0) continue;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (minX === Infinity) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Whether "Go to component" applies (a registered component hit). */
function canGoToComponent(hit: PageHit): boolean {
  return hit.kind === "component" && Boolean(hit.entryId);
}

/**
 * Prefill text for the Prompt Pi drawer: a compact context header the user
 * types their request under. Carries the file + usage line for a component hit
 * (like the canvas chat context), degrades to a DOM/hint description otherwise.
 */
function buildPagePromptPrefill(hit: PageHit): string {
  if (hit.kind === "component") {
    const header = `Re: ${hit.entryLabel ?? hit.label}`;
    if (hit.codeTarget) {
      const cls = hit.codeTarget.className
        ? ` className="${hit.codeTarget.className}"`
        : "";
      return `${header}\nUsed in ${hit.codeTarget.file} as <${hit.codeTarget.name}${cls}>\n\n`;
    }
    if (hit.sourcePath) return `${header} (${hit.sourcePath})\n\n`;
    return `${header}\n\n`;
  }
  const tag = hit.dom ? domLabel(hit.dom) : hit.label;
  const inside = hit.hint ? ` inside <${hit.hint}>` : "";
  return `Re: ${tag} element${inside} (not a registered component)\n\n`;
}

/** Strip tools: mutually-exclusive with each other and with the Pi drawer. */
type Tool = "select" | "text" | null;

/** Strip tool state: the active tool and the Pi drawer, which are exclusive-arm. */
type ToolState = { tool: Tool; chatOpen: boolean };

type ToolAction =
  | { type: "toggleSelect" }
  | { type: "toggleText" }
  | { type: "toggleChat" }
  | { type: "promptPi" }
  | { type: "escape"; chipOpen: boolean };

/**
 * Pure transitions for the strip's tool/drawer state. Arming a tool closes the
 * drawer (and any other tool) and vice-versa — one active affordance at a time;
 * Escape disarms the active tool only when no chip is open (the chip consumes
 * Escape first).
 */
function nextToolState(state: ToolState, action: ToolAction): ToolState {
  switch (action.type) {
    case "toggleSelect":
      return state.tool === "select"
        ? { tool: null, chatOpen: state.chatOpen }
        : { tool: "select", chatOpen: false };
    case "toggleText":
      return state.tool === "text"
        ? { tool: null, chatOpen: state.chatOpen }
        : { tool: "text", chatOpen: false };
    case "toggleChat":
      return state.chatOpen
        ? { ...state, chatOpen: false }
        : { tool: null, chatOpen: true };
    case "promptPi":
      return { tool: null, chatOpen: true };
    case "escape":
      // The chip (when open) consumes Escape first; only a bare armed tool
      // disarms here.
      if (action.chipOpen) return state;
      return state.tool ? { ...state, tool: null } : state;
    default:
      return state;
  }
}

export {
  buildPagePromptPrefill,
  canGoToComponent,
  chipLabel,
  domLabel,
  nextToolState,
  unionBox,
};
export type { Box, PageDom, PageHit, Tool, ToolAction, ToolState };
