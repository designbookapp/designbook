/**
 * Page-space hit resolution over the LIVE app DOM.
 *
 * The canvas overlay resolves an interleaved drill chain in stage space; page
 * mode is deliberately simpler — a single click selects the innermost
 * *registered* component under the pointer (chip shows its registry label +
 * "Go to component"), or, when the pointer isn't inside any registered
 * component, the plain element itself (chip shows `tag.class`, Prompt Pi only).
 * No drill stack: the full Figma-style drill lives in the canvas, and a page
 * selection can't carry into a freshly-mounted canvas instance anyway (see the
 * M1 notes), so entry-level navigation is all "Go to component" needs.
 *
 * All geometry is viewport space (identity transform), so a hit's `rect` is the
 * raw union of the fiber's client rects and the chip/overlay sit at those
 * coordinates under `position: fixed`.
 */

import {
  getFiberFromDom,
  getFiberRects,
  hitTestChain,
  resolveCodeTargets,
  unwrapType,
  type AttributableLink,
  type Fiber,
} from "@designbook-ui/previewHost";
import {
  registryByName,
  registryByRef,
} from "@designbook-ui/models/catalog/componentRegistry";
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

/** A plain-DOM hit for an element outside any registered component. */
function rawDomHit(el: Element): PageHit {
  const dom = {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.classList.length ? Array.from(el.classList) : undefined,
  };
  return {
    kind: "dom",
    rect: boxFromDomRect(el.getBoundingClientRect()),
    label: chipLabel({ kind: "dom", dom }),
    dom,
    hint: nearestComponentName(el),
  };
}

/**
 * Resolve the page hit at a live element: the innermost registered component in
 * its hit-test chain, or a raw DOM hit when the chain is empty (no registered
 * ancestor). Returns undefined only when the component has no measurable rect.
 */
function resolvePageHit(el: Element): PageHit | undefined {
  const chain = hitTestChain(el, registryByRef, registryByName);
  if (chain.length === 0) return rawDomHit(el);

  // Innermost registered component (chain is innermost → outermost).
  const index = chain.findIndex((entry) => entry.kind === "component");
  if (index === -1) return rawDomHit(el);

  const links: AttributableLink[] = chain.map((entry) => ({
    kind: entry.kind,
    entry: entry.kind === "component" ? entry.entry : undefined,
    ownerEntry: entry.ownerEntry,
    name: entry.kind === "component" ? entry.name : entry.tag,
    className: entry.className,
  }));
  const codeTargets = resolveCodeTargets(links);

  const item = chain[index];
  if (item.kind !== "component") return rawDomHit(el);
  const rect = unionBox(getFiberRects(item.fiber).map(boxFromDomRect));
  if (!rect) return undefined;

  return {
    kind: "component",
    rect,
    label: item.entry.label,
    entryId: item.entry.id,
    entryLabel: item.entry.label,
    sourcePath: item.entry.sourcePath,
    codeTarget: codeTargets[index],
  };
}

export { resolvePageHit };
