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
  // --- Sandbox capture extras (docs/specs/sandbox.md). Component hits carry
  // their own identity; DOM hits (v2 element pins) carry their OWNER's
  // identity here (entry = owner) with the element itself as `anchor`.
  /** Registry entry key (the component's set key). */
  entryKey?: string;
  /** Export name: the entry's own for a component hit; the OWNER's for a
   * drilled DOM hit (codeTarget.ownerExportName). */
  exportName?: string;
  /** Stable per-instance id (pin identity's instance path). */
  instanceId?: string;
  /** Live fiber — transient, never persisted (props/context capture). */
  fiber?: unknown;
  /** Live anchor element — transient (pin bubble rect re-resolution). */
  anchor?: Element;
  /**
   * How the owner identity was derived: "entry" = a registered component
   * (the original flow); "source" = an UNREGISTERED authoring component
   * resolved by the fiber owner walk (sourceOwner.ts) — page shells like
   * HomePage. Source owners have no entryId, and `sourcePath` may be ""
   * (the pin route resolves the file from `ownerNames` node-side).
   */
  ownerKind?: "entry" | "source";
  /** Named-component owner chain, nearest first (source owners only). */
  ownerNames?: string[];
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
 * Whether the sandbox prompt box applies to a hit (docs/specs/sandbox.md):
 * a registered component hit (component pin), a drilled DOM element inside a
 * registered owner (element pin), or a DOM element whose UNREGISTERED
 * authoring component resolved via the source-owner fallback — the pin route
 * finishes file resolution from `ownerNames` when `sourcePath` is "".
 */
function canPromptSandbox(hit: PageHit): boolean {
  if (!hit.instanceId) return false;
  if (hit.kind === "component") {
    return Boolean(hit.entryId && hit.sourcePath);
  }
  if (!hit.anchor) return false;
  if (hit.entryId && hit.sourcePath) return true; // registered-owner element
  return hit.ownerKind === "source" && Boolean(hit.exportName);
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

/** Strip tools: mutually-exclusive with EACH OTHER, but NOT with the drawer. */
type Tool = "select" | "text" | null;

/** Strip tool state: the active tool + the Pi drawer. The two COEXIST — a tool
 * can be armed while the drawer (thread or canvas) is open, so arming a tool
 * never closes the drawer and opening the drawer never disarms a tool. */
type ToolState = { tool: Tool; chatOpen: boolean };

type ToolAction =
  | { type: "toggleSelect" }
  | { type: "toggleText" }
  | { type: "toggleChat" }
  | { type: "promptPi" }
  | { type: "escape"; chipOpen: boolean };

/**
 * Pure transitions for the strip's tool/drawer state. Tools are exclusive with
 * EACH OTHER (arming one swaps out the other), but a tool and the Pi drawer
 * COEXIST: arming/disarming a tool preserves `chatOpen`, and opening/closing
 * the drawer preserves the armed `tool`. This lets the user keep the drawer
 * (and the independent canvas panel) open while selecting/text-editing on the
 * page. Escape disarms the active tool only when no chip is open (the chip
 * consumes Escape first); the drawer and then the canvas panel sit at the END
 * of the ladder (handled in the component).
 */
function nextToolState(state: ToolState, action: ToolAction): ToolState {
  switch (action.type) {
    case "toggleSelect":
      return state.tool === "select"
        ? { ...state, tool: null }
        : { ...state, tool: "select" };
    case "toggleText":
      return state.tool === "text"
        ? { ...state, tool: null }
        : { ...state, tool: "text" };
    case "toggleChat":
      return { ...state, chatOpen: !state.chatOpen };
    case "promptPi":
      return { ...state, chatOpen: true };
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
  canPromptSandbox,
  chipLabel,
  domLabel,
  nextToolState,
  unionBox,
};
export type { Box, PageDom, PageHit, Tool, ToolAction, ToolState };
