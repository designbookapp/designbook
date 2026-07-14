/**
 * Page-space hit resolution over the LIVE app DOM.
 *
 * Page mode mirrors the canvas overlay's Figma-style drill semantics, driven
 * by the same pure resolution logic (drillSelection.ts) over the same
 * interleaved hit-test chain (fibers.ts):
 *
 *   - a fresh click selects the OUTERMOST registered component under the
 *     pointer (composites win over their atoms — lazy glob entries resolve via
 *     the registry's eager name registration);
 *   - double-click (or Enter, handled by PageTools) descends exactly ONE
 *     drillable level (component or host DOM element, innermost-ward);
 *   - Cmd/Ctrl+click drills straight to the DEEPEST registered component;
 *   - clicks at the drilled depth re-select siblings, exactly like the canvas.
 *
 * When the pointer isn't inside any registered component, the plain element
 * itself is the hit (chip shows `tag.class`, Prompt Pi only).
 *
 * All geometry is viewport space (identity transform), so a hit's `rect` is
 * the raw union of the fiber's client rects and the chip/overlay sit at those
 * coordinates under `position: fixed`.
 */

import {
  getAnchorElement,
  getDomInstanceId,
  getFiberFromDom,
  getFiberRects,
  getInstanceId,
  hitTestChain,
  resolveClickSelection,
  resolveCodeTargets,
  resolveDeepClick,
  resolveDoubleClick,
  resolveLevelOwner,
  unwrapType,
  type AttributableLink,
  type Fiber,
  type FiberChainEntry,
} from "@designbook-ui/previewHost";
import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";
import {
  registryByName,
  registryByRef,
} from "@designbook-ui/models/catalog/componentRegistry";
import type { CanvasCodeTarget } from "@designbook-ui/types";
import { resolveSourceOwner } from "@designbook-ui/models/sandbox/sourceOwner";
import { chipLabel, unionBox, type Box, type PageHit } from "./pageHit";

function boxFromDomRect(rect: DOMRect): Box {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Nearest ancestor function-component display name for `el` (a cheap hint for
 * an unregistered DOM element). Walks `fiber.return` until a named component. */
function nearestComponentName(el: Element): string | undefined {
  let fiber: Fiber | null | undefined = getFiberFromDom(el);
  const seen = new Set<Fiber>();
  while (fiber && !seen.has(fiber)) {
    seen.add(fiber);
    if (typeof fiber.type === "function" || typeof fiber.type === "object") {
      const { name } = unwrapType(fiber.type);
      if (name) return name;
    }
    fiber = fiber.return;
  }
  return undefined;
}

/**
 * A plain-DOM hit for an element outside any registered component.
 *
 * Owner fallback (docs/specs/sandbox.md v2): the element's UNREGISTERED
 * authoring component (fiber owner walk, sourceOwner.ts) is synthesized onto
 * the hit — sourcePath/exportName/instanceId/anchor, marked
 * `ownerKind: "source"` — so the sandbox prompt box works on page shells like
 * HomePage exactly as it does inside registered subtrees. `sourcePath` may be
 * "" (the pin route resolves the file from `ownerNames` node-side).
 */
function rawDomHit(el: Element): PageHit {
  const dom = {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.classList.length ? Array.from(el.classList) : undefined,
  };
  const owner = resolveSourceOwner(el);
  return {
    kind: "dom",
    rect: boxFromDomRect(el.getBoundingClientRect()),
    label: chipLabel({ kind: "dom", dom }),
    dom,
    hint: owner?.name ?? nearestComponentName(el),
    ...(owner
      ? {
          ownerKind: "source" as const,
          ownerNames: owner.ownerNames,
          entryLabel: owner.name,
          sourcePath: owner.sourcePath,
          exportName: owner.exportName,
          entryKey: owner.exportName,
          instanceId: getDomInstanceId(el, `src:${owner.exportName}`),
          anchor: el,
        }
      : {}),
  };
}

/** One drillable level of the page chain (the CanvasOverlay ChainItem shape,
 * minus stage-space concerns). Innermost first, like `hitTestChain`. */
type PageChainItem = {
  kind: "component" | "dom";
  instanceId: string;
  /** Associated component: itself for a component level, its owner for DOM.
   * Undefined only for a DOM level of a boundary-trimmed chain whose owner
   * fell outside the boundary (sandbox preview subtrees). */
  entry?: RegistryEntry;
  /** Registry id of the component whose JSX created this level. */
  ownerId?: string;
  /** The level's own registry id (component levels only). */
  componentId?: string;
  codeTarget?: CanvasCodeTarget;
  fiber?: Fiber;
  name?: string;
  element?: Element;
  tag?: string;
  domId?: string;
  classes?: string[];
};

/**
 * Trim a hit-test chain to the levels whose DOM lives inside `boundary`
 * (sandbox canvas element selection: the chain must never leave one variant
 * preview's subtree). Out-of-boundary levels are strictly OUTER than
 * in-boundary ones (the chain follows `fiber.return` outward), so trimming is
 * a tail cut. Component levels are located by their anchor host element.
 */
function trimChainToBoundary(
  chain: FiberChainEntry[],
  boundary: Element,
): FiberChainEntry[] {
  const inside = (entry: FiberChainEntry): boolean => {
    const el =
      entry.kind === "dom" ? entry.element : getAnchorElement(entry.fiber);
    return el ? boundary.contains(el) : false;
  };
  let end = chain.length;
  while (end > 0 && !inside(chain[end - 1]!)) end--;
  return chain.slice(0, end);
}

/**
 * Interleaved chain under `el`, innermost first, with stable instanceIds and
 * owner-attributed code targets — the page-mode sibling of CanvasOverlay's
 * `resolveChain`. Empty when the pointer isn't inside a registered component.
 *
 * `within` (sandbox canvas element selection) SCOPES the chain to one variant
 * preview's subtree: levels outside the boundary element are cut, so drill
 * gestures can never escape the preview into canvas/drawer chrome. A trimmed
 * chain with no registered component left degrades to [] (raw-DOM hit).
 */
function resolvePageChain(el: Element, within?: Element): PageChainItem[] {
  let fiberChain = hitTestChain(el, registryByRef, registryByName);
  if (within) {
    fiberChain = trimChainToBoundary(fiberChain, within);
    // Component-less chains keep no drillable identity to anchor instance
    // ids/owners on — treat exactly like an unregistered subtree.
    if (!fiberChain.some((entry) => entry.kind === "component")) return [];
  }
  if (fiberChain.length === 0) return [];

  const componentIds = fiberChain.map((entry) =>
    entry.kind === "component"
      ? getInstanceId({ entry: entry.entry, fiber: entry.fiber })
      : undefined,
  );

  function ancestorInstanceId(index: number): string {
    for (let j = index + 1; j < fiberChain.length; j++) {
      const id = componentIds[j];
      if (id) return id;
    }
    return "";
  }

  const links: AttributableLink[] = fiberChain.map((entry) => ({
    kind: entry.kind,
    entry: entry.kind === "component" ? entry.entry : undefined,
    ownerEntry: entry.ownerEntry,
    name: entry.kind === "component" ? entry.name : entry.tag,
    className: entry.className,
  }));
  const codeTargets = resolveCodeTargets(links);

  return fiberChain.map((entry, index): PageChainItem => {
    if (entry.kind === "component") {
      return {
        kind: "component",
        instanceId: componentIds[index]!,
        entry: entry.entry,
        componentId: entry.entry.id,
        ownerId: entry.ownerEntry?.id,
        codeTarget: codeTargets[index],
        fiber: entry.fiber,
        name: entry.name,
      };
    }
    return {
      kind: "dom",
      instanceId: getDomInstanceId(entry.element, ancestorInstanceId(index)),
      // A DOM level's "component" is the one that created it (its owner),
      // falling back to the nearest registered chain ancestor — defined
      // whenever the outermost chain level is a component (always, except in
      // a boundary-trimmed chain whose owner fell outside the boundary).
      entry: resolveLevelOwner(links, index),
      ownerId: entry.ownerEntry?.id,
      codeTarget: codeTargets[index],
      element: entry.element,
      tag: entry.tag,
      domId: entry.id,
      classes: entry.classes,
    };
  });
}

/** Build the PageHit for one chain level. Undefined when unmeasurable. */
function pageHitForIndex(
  chain: PageChainItem[],
  index: number,
): PageHit | undefined {
  const item = chain[index];
  if (!item) return undefined;

  if (item.kind === "dom") {
    const element = item.element!;
    const dom = {
      tag: item.tag ?? element.tagName.toLowerCase(),
      id: item.domId,
      classes: item.classes,
    };
    return {
      kind: "dom",
      rect: boxFromDomRect(element.getBoundingClientRect()),
      label: chipLabel({ kind: "dom", dom }),
      dom,
      codeTarget: item.codeTarget,
      hint: item.entry?.label,
      instanceId: item.instanceId,
      // Sandbox element pins (docs/specs/sandbox.md v2): the OWNER component's
      // identity (a DOM level's `entry` IS its owner) + the live element as
      // the anchor, so the prompt box can create an element pin here too.
      // Ownerless levels (boundary-trimmed chains) carry the anchor only.
      ...(item.entry
        ? {
            ownerKind: "entry" as const,
            entryId: item.entry.id,
            entryLabel: item.entry.label,
            sourcePath: item.entry.sourcePath,
            entryKey: item.entry.key,
            exportName:
              item.codeTarget?.ownerExportName ?? item.entry.exportName,
          }
        : {}),
      anchor: element,
    };
  }

  if (!item.entry) return undefined; // component levels always carry entry
  const rect = unionBox(getFiberRects(item.fiber!).map(boxFromDomRect));
  if (!rect) return undefined;
  return {
    kind: "component",
    rect,
    label: item.entry.label,
    ownerKind: "entry",
    entryId: item.entry.id,
    entryLabel: item.entry.label,
    sourcePath: item.entry.sourcePath,
    codeTarget: item.codeTarget,
    // Sandbox capture extras (docs/specs/sandbox.md): the pin's code-target
    // identity plus the transient fiber/anchor handles for props capture and
    // bubble rect re-resolution.
    entryKey: item.entry.key,
    exportName: item.entry.exportName,
    instanceId: item.instanceId,
    fiber: item.fiber,
    anchor: getAnchorElement(item.fiber!),
  };
}

/** A resolved page gesture: the hit to select + the drill path after it. */
type PageGestureResult = {
  hit: PageHit | undefined;
  /** Drill path (instanceIds, outermost first) after this gesture. */
  drillPath: string[];
};

/**
 * Resolve a plain click (or hover preview) at a live element given the
 * current drill path: outermost registered component by default, one level
 * inside the drilled ancestry when the click lands on the drilled branch
 * (sibling re-selection at depth), the raw element when no registered
 * component is under the pointer.
 */
function resolvePageClick(
  el: Element,
  drillPath: string[],
  within?: Element,
): PageGestureResult {
  const chain = resolvePageChain(el, within);
  if (chain.length === 0) return { hit: rawDomHit(el), drillPath: [] };
  const resolved = resolveClickSelection(chain, drillPath);
  if (!resolved) return { hit: rawDomHit(el), drillPath: [] };
  return {
    hit: pageHitForIndex(chain, resolved.index),
    drillPath: resolved.drillPath,
  };
}

/**
 * Resolve a double-click (or Enter on the selection): descend exactly one
 * drillable level. Undefined = no-op (leaf reached, or nothing under the
 * pointer) — the caller keeps the current selection.
 */
function resolvePageDoubleClick(
  el: Element,
  drillPath: string[],
  within?: Element,
): PageGestureResult | undefined {
  const chain = resolvePageChain(el, within);
  if (chain.length === 0) return undefined;
  const resolved = resolveDoubleClick(chain, drillPath);
  if (!resolved || resolved.kind === "leaf") return undefined;
  return {
    hit: pageHitForIndex(chain, resolved.index),
    drillPath: resolved.drillPath,
  };
}

/**
 * Resolve a Cmd/Ctrl+click: drill straight to the DEEPEST registered
 * component under the pointer in one gesture (DOM levels below it are
 * skipped), with the drill path that would have led there step by step.
 * Falls back to the plain-click resolution when the chain has none.
 */
function resolvePageDeepClick(
  el: Element,
  within?: Element,
): PageGestureResult {
  const chain = resolvePageChain(el, within);
  if (chain.length === 0) return { hit: rawDomHit(el), drillPath: [] };
  const deep = resolveDeepClick(chain);
  if (!deep) return { hit: rawDomHit(el), drillPath: [] };
  return { hit: pageHitForIndex(chain, deep.index), drillPath: deep.drillPath };
}

/**
 * Hover preview: what a click at this point would select — the deep-click
 * target while Cmd/Ctrl is held, else the normal click resolution at the
 * current drill depth.
 */
function resolvePageHover(
  el: Element,
  drillPath: string[],
  deep: boolean,
  within?: Element,
): PageHit | undefined {
  return deep
    ? resolvePageDeepClick(el, within).hit
    : resolvePageClick(el, drillPath, within).hit;
}

export {
  resolvePageChain,
  resolvePageClick,
  resolvePageDeepClick,
  resolvePageDoubleClick,
  resolvePageHover,
};
export type { PageChainItem, PageGestureResult };
