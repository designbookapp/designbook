/**
 * Pure resolution logic for Figma-style drill-in selection on the canvas.
 *
 * Operates on an *interleaved* "chain" (the render-tree levels under the
 * pointer, innermost → outermost: the pointer-target DOM element, then every
 * registered component and every plain host DOM element between it and the
 * outermost registered component) and a "drill path" (instanceIds of the
 * levels the user has entered, outermost first). No DOM/React here — see
 * fibers.ts and CanvasOverlay.tsx for how chains and instanceIds are produced.
 *
 * Both components and DOM elements are ordinary chain levels: a fresh click
 * selects the outermost level; each double-click descends exactly one level
 * (component OR DOM); single clicks re-select siblings at the current drilled
 * depth; Escape pops one level. `drillPath` may therefore contain DOM-level
 * instanceIds (e.g. `<div className="relative">` sitting between two
 * components) — the prefix-matching logic is agnostic to a level's kind.
 *
 * Owner-filtered traversal: drilling follows the AUTHORED JSX of the current
 * context, not the raw fiber tree. Each level may carry `ownerId` (the
 * component whose render created it, from `_debugOwner` — see fibers.ts) and
 * `componentId` (its own identity, component levels only). From a selection S
 * the next drill stop is the nearest deeper level owned by S's owner (S's
 * sibling-in-source JSX, e.g. ProductCard's `<Card>` → ProductCard's `<div
 * className="relative">`), else leaf. Only the OUTERMOST level — the page's
 * component, whose file IS the authored context — may instead descend into
 * levels owned by itself; that first step is what reveals its JSX at all.
 * Deeper components' implementations are never drill-reachable: their
 * internal DOM (the root `<div data-slot="card">` Card renders around
 * pass-through children, ProductBadges' own root div, …) is skipped or a
 * leaf, and the only way "into" a component is the context menu's "Go to
 * component". Levels without owner metadata degrade to plain adjacent
 * descent.
 */

type ChainLink = {
  instanceId: string;
  kind?: "component" | "dom";
  /** Registry id of the component whose JSX created this level. */
  ownerId?: string;
  /** Registry id of the level itself (component levels only). */
  componentId?: string;
};

/**
 * Next drillable level below `from`: the nearest deeper entry owned by
 * `chain[from]`'s owner (stay in the same authored JSX). Only the outermost
 * level — the page's component, whose source IS the authored context — may
 * instead descend into entries owned by itself; any deeper component with no
 * same-owner entry under the cursor is a leaf (its implementation is never
 * drill-reachable). An *adjacent* entry with no owner metadata can't be
 * skipped (there is no attribution to justify it), which also preserves
 * plain adjacent descent for owner-less chains (tests, prod builds without
 * `_debugOwner`).
 */
function nextDrillIndex(chain: ChainLink[], from: number): number | undefined {
  const current = chain[from];

  for (let i = from - 1; i >= 0; i--) {
    const candidate = chain[i];
    if (candidate.ownerId === undefined) {
      if (i === from - 1) return i;
      continue;
    }
    if (
      current.ownerId !== undefined &&
      candidate.ownerId === current.ownerId
    ) {
      return i;
    }
  }

  const isPageRoot = from === chain.length - 1;
  if (isPageRoot && current.componentId !== undefined) {
    for (let i = from - 1; i >= 0; i--) {
      if (chain[i].ownerId === current.componentId) return i;
    }
  }

  return undefined;
}

/**
 * The drillable subsequence of `chain`: indices (innermost-first, matching
 * chain order) of the levels reachable by repeated one-level descents from
 * the outermost entry. All resolution below operates on this subsequence,
 * so skipped levels (other components' implementation internals) are
 * invisible to click/double-click/deep-click selection alike.
 */
function drillableIndices(chain: ChainLink[]): number[] {
  if (chain.length === 0) return [];
  const indices: number[] = [chain.length - 1];
  let current = chain.length - 1;
  for (;;) {
    const next = nextDrillIndex(chain, current);
    if (next === undefined) break;
    indices.unshift(next);
    current = next;
  }
  return indices;
}

type ClickResolution = {
  /** Index into `chain` (innermost = 0) that should become selected. */
  index: number;
  /** Drill path after this click: truncated to the longest common prefix of
   * the previous path and the chain's drillable ancestry (unchanged on a
   * full match, [] when the click landed on an unrelated chain). */
  drillPath: string[];
};

/**
 * Resolves what a click (or hover preview) at `chain` should select given
 * the current `drillPath`. Computes the longest common prefix between
 * `drillPath` (outermost-first) and the chain's drillable subsequence, then
 * selects one drillable level inside that prefix — so siblings of ANY level
 * on the drilled path are selectable at their own depth (divergence level),
 * not only siblings of the deepest level. The drill path is truncated to the
 * common prefix, so a subsequent double-click enters the newly selected
 * branch and Escape pops to the common ancestor.
 *
 * Degenerate cases fall out naturally: a full prefix match keeps the path
 * and selects one level inside it (or the deepest matched level itself when
 * nothing deeper is under the cursor); zero common prefix (a different
 * top-level component) truncates to [] and selects the outermost entry.
 */
function resolveClickSelection(
  chain: ChainLink[],
  drillPath: string[],
): ClickResolution | undefined {
  if (chain.length === 0) return undefined;
  const drillable = drillableIndices(chain);

  let matchedDepth = 0;
  while (
    matchedDepth < drillPath.length &&
    matchedDepth < drillable.length &&
    chain[drillable[drillable.length - 1 - matchedDepth]].instanceId ===
      drillPath[matchedDepth]
  ) {
    matchedDepth++;
  }

  const commonPrefix =
    matchedDepth < drillPath.length
      ? drillPath.slice(0, matchedDepth)
      : drillPath;
  const innerPosition = Math.max(drillable.length - 1 - matchedDepth, 0);
  return { index: drillable[innerPosition], drillPath: commonPrefix };
}

type DoubleClickResolution =
  | {
      kind: "descend";
      index: number;
      drillPath: string[];
      /** The chain index entered (pushed onto the drill path). */
      entered: { chainIndex: number };
    }
  | {
      kind: "leaf";
      index: number;
      drillPath: string[];
    };

/**
 * Resolves a double-click: first resolves the click normally, then descends
 * one *drillable* level deeper (skipping other components' internals),
 * pushing the just-resolved entry onto the drill path (`kind: "descend"`).
 * Double-clicking a leaf — nothing drillable deeper — reports
 * `kind: "leaf"`, which the caller treats as a no-op.
 */
function resolveDoubleClick(
  chain: ChainLink[],
  drillPath: string[],
): DoubleClickResolution | undefined {
  const base = resolveClickSelection(chain, drillPath);
  if (!base) return undefined;

  const drillable = drillableIndices(chain);
  const basePosition = drillable.indexOf(base.index);
  if (basePosition <= 0) {
    return { kind: "leaf", index: base.index, drillPath: base.drillPath };
  }

  return {
    kind: "descend",
    index: drillable[basePosition - 1],
    drillPath: [...base.drillPath, chain[base.index].instanceId],
    entered: { chainIndex: base.index },
  };
}

type DeepClickResolution = {
  /** Chain index that becomes selected (the innermost registered component). */
  index: number;
  /** Drill path placing selection at `index` — its drillable ancestors,
   * outermost first — so subsequent single-clicks / Escape behave as if the
   * user had drilled there one level at a time. */
  drillPath: string[];
};

/**
 * Resolves a modifier+click "drill deep in one gesture": selects the
 * innermost registered COMPONENT on the drillable path (skipping the DOM
 * levels below it) and returns the drill path that would have led there step
 * by step. Returns undefined when the chain has no drillable component.
 */
function resolveDeepClick(chain: ChainLink[]): DeepClickResolution | undefined {
  const drillable = drillableIndices(chain);
  const position = drillable.findIndex(
    (index) => chain[index].kind === "component",
  );
  if (position === -1) return undefined;
  const drillPath = drillable
    .slice(position + 1)
    .map((index) => chain[index].instanceId)
    .reverse();
  return { index: drillable[position], drillPath };
}

type EscapeResolution<T> = {
  drillPath: T[];
  selected: T | undefined;
};

/**
 * Resolves Escape: pops the deepest drill level and selects it (the level
 * whose interior you just left, one drillable step shallower than before —
 * the exact reverse of the descent order, DOM levels included). An empty
 * drill path returns `selected: undefined` — the caller should clear the
 * selection entirely in that case.
 */
function resolveEscape<T>(drillPath: T[]): EscapeResolution<T> {
  if (drillPath.length === 0) return { drillPath: [], selected: undefined };
  return {
    drillPath: drillPath.slice(0, -1),
    selected: drillPath[drillPath.length - 1],
  };
}

export {
  drillableIndices,
  resolveClickSelection,
  resolveDeepClick,
  resolveDoubleClick,
  resolveEscape,
};
export type {
  ChainLink,
  ClickResolution,
  DeepClickResolution,
  DoubleClickResolution,
  EscapeResolution,
};
