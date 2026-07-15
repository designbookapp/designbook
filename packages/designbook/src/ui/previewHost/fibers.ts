/**
 * React fiber utilities for the design workbench canvas.
 *
 * Dev-only tool that reads React 19 internals (`__reactFiber$*` expando,
 * `return`/`child`/`sibling` walking, `memoizedProps`). Pinned to React 19
 * expectations — revisit on major upgrades.
 */

import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";

/**
 * Cross-realm-safe replacement for `instanceof Element`. A fiber's
 * `stateNode` for an App-page frame cell is a DOM node created against the
 * IFRAME's own `Element` constructor, not the top document's — `instanceof`
 * compares against the CALLING realm's global, so `frameNode instanceof Element`
 * is always false for a frame node even though it's a perfectly normal element.
 * `nodeType` is a plain data property, unaffected by which realm's constructor
 * created the object, so it works identically same-document or cross-frame.
 */
function isElementNode(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Node).nodeType === 1
  );
}

type Fiber = {
  tag: number;
  type: unknown;
  stateNode: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: Record<string, unknown>;
  /**
   * Dev-only React 19 field: the fiber of the component whose render created
   * this element (its JSX owner). Because children are passed through
   * (`<Card>{children}</Card>`), the owner is often NOT the nearest ancestor
   * in the fiber tree — it's whoever wrote the JSX. Used for usage-line
   * attribution. Absent in production builds; Vite serves dev builds. Can
   * also be a non-fiber (server-component info) — walk defensively.
   */
  _debugOwner?: Fiber | null;
};

const HOST_PORTAL_TAG = 4;

function getFiberFromDom(el: Element): Fiber | undefined {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return undefined;
  return (el as unknown as Record<string, Fiber>)[key];
}

/**
 * Unwrap memo (`type.type`) and forwardRef (`type.render`) to reach the
 * innermost component function. Returns the unwrapped reference and a
 * best-effort display name.
 */
function unwrapType(type: unknown): { ref: unknown; name: string } {
  let current = type;
  const seen = new Set<unknown>();

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;

    if (typeof record.type === "function" || typeof record.type === "object") {
      current = record.type;
      continue;
    }
    if (
      typeof record.render === "function" ||
      typeof record.render === "object"
    ) {
      current = record.render;
      continue;
    }
    break;
  }

  const name =
    typeof current === "function"
      ? (current as { displayName?: string; name?: string }).displayName ||
        (current as { name?: string }).name ||
        ""
      : "";

  return { ref: current, name };
}

/**
 * The exact definition file stamped onto a component at transform time
 * (sourceStamp.ts): `fiber.type.__dbSource`. The stamp lands on the DECLARED
 * binding object, which React uses verbatim as `fiber.type` — so a direct read
 * is correct for a plain function, and for memo/forwardRef the stamp is on the
 * wrapper object (again `fiber.type`). The unwrapped inner function is checked
 * too as a belt-and-suspenders. Undefined for library components (no designbook
 * transform → no stamp; name-index resolution takes over) and prod builds.
 */
function sourceFromFiber(fiber: Fiber): string | undefined {
  const type = fiber.type;
  if (type == null || (typeof type !== "function" && typeof type !== "object")) {
    return undefined;
  }
  try {
    const direct = (type as { __dbSource?: unknown }).__dbSource;
    if (typeof direct === "string" && direct) return direct;
    const { ref } = unwrapType(type);
    const inner =
      ref && (typeof ref === "function" || typeof ref === "object")
        ? (ref as { __dbSource?: unknown }).__dbSource
        : undefined;
    return typeof inner === "string" && inner ? inner : undefined;
  } catch {
    return undefined;
  }
}

/** A registry entry with its `sourcePath` overridden by the fiber's exact
 * stamp when present — the definitive file for pins / code panel / capture,
 * bypassing the name→file ladder. Returns `entry` unchanged when unstamped. */
function withStampedSource(entry: RegistryEntry, fiber: Fiber): RegistryEntry {
  const stamped = sourceFromFiber(fiber);
  return stamped && stamped !== entry.sourcePath
    ? { ...entry, sourcePath: stamped }
    : entry;
}

/**
 * Synthesize an index-shaped entry for a STAMPED fiber that the name index
 * hasn't registered yet (lazy index growth: a just-transformed module's stamp
 * is on the fiber immediately, but its index entry only lands after the
 * debounced sidecar push + UI fetch). A fiber with a stamp is an app-component
 * boundary regardless — its exact file is already known. Undefined when the
 * fiber carries no stamp or no component name.
 */
function stampSynthesizedEntry(fiber: Fiber): RegistryEntry | undefined {
  const sourcePath = sourceFromFiber(fiber);
  if (!sourcePath) return undefined;
  let name: string;
  try {
    name = unwrapType(fiber.type).name;
  } catch {
    return undefined;
  }
  if (!name) return undefined;
  return {
    id: `src:${sourcePath}#${name}`,
    name,
    label: name,
    sourcePath,
    component: undefined,
    setId: "src",
    key: name,
    exportName: name,
    origin: "index",
    sourceCandidates: [sourcePath],
  };
}

type HitTestResult = {
  entry: RegistryEntry;
  fiber: Fiber;
};

/**
 * One level of the interleaved hit-test chain: either a registered component
 * or a plain host DOM element. Both carry `ownerEntry` — the registered
 * component that *created* this element (via `_debugOwner`), used to attribute
 * the element's JSX usage site to the right source file. `ownerEntry` is
 * undefined when no registered owner is found; callers fall back to the
 * nearest registered ancestor in the chain.
 */
type ComponentFiberEntry = {
  kind: "component";
  entry: RegistryEntry;
  fiber: Fiber;
  /** Component's JSX name (e.g. "Card", "ProductBadges"). */
  name: string;
  className?: string;
  ownerEntry?: RegistryEntry;
};

type DomFiberEntry = {
  kind: "dom";
  element: Element;
  fiber: Fiber;
  tag: string;
  id?: string;
  classes?: string[];
  className?: string;
  ownerEntry?: RegistryEntry;
};

type FiberChainEntry = ComponentFiberEntry | DomFiberEntry;

function asClassName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Walks `fiber._debugOwner` to the nearest *registered* owner component — the
 * component whose JSX created this element. Returns undefined if none of the
 * owners are registered (or the field is absent in a production build).
 */
function findOwnerEntry(
  fiber: Fiber,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
): RegistryEntry | undefined {
  let owner: unknown = fiber._debugOwner;
  const seen = new Set<unknown>();
  while (owner && typeof owner === "object" && !seen.has(owner)) {
    seen.add(owner);
    const ownerFiber = owner as Fiber;
    // The owner's OWN stamp is the exact file its JSX lives in — prefer it over
    // the (possibly ambiguous) name-index sourcePath, and treat a stamped-but-
    // unindexed owner as a resolvable owner too.
    const entry =
      matchFiber(ownerFiber, byRef, byName) ?? stampSynthesizedEntry(ownerFiber);
    if (entry) return withStampedSource(entry, ownerFiber);
    owner = ownerFiber._debugOwner;
  }
  return undefined;
}

function matchFiber(
  fiber: Fiber,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
): RegistryEntry | undefined {
  if (fiber.type == null) return undefined;
  const { ref, name } = unwrapType(fiber.type);

  const byRefMatch = byRef.get(ref);
  if (byRefMatch) return byRefMatch;

  // forwardRef/memo fibers carry the WRAPPER as `fiber.type` (an object, not a
  // function) and the registry is keyed by that wrapper — the unwrapped `ref`
  // lookup above misses it, so try the direct type for objects too.
  if (typeof fiber.type === "function" || typeof fiber.type === "object") {
    const directMatch = byRef.get(fiber.type);
    if (directMatch) return directMatch;
  }

  if (name) {
    return byName.get(name);
  }

  return undefined;
}

/**
 * Trim the OUTERMOST tail of a chain: export-index entries that are page
 * SHELLS (App, route pages, layouts, pass-through providers) are not useful
 * fresh-click boundaries — with the auto export index EVERY in-repo component
 * is registered, so without this a fresh click would always select the app
 * root. Pops index-origin shell levels (and the DOM levels above the new
 * outermost) while at least one component level remains, so a genuinely
 * full-page component that is the only boundary under the pointer stays
 * selectable. Config-`sets` entries are never trimmed (registering a
 * full-page component explicitly is a choice). Trimmed shells stay reachable
 * through the raw-DOM source-owner fallback, exactly like unregistered page
 * shells before the index.
 */
function trimPageSizedTail(
  entries: FiberChainEntry[],
  isShell: (entry: ComponentFiberEntry) => boolean,
): FiberChainEntry[] {
  const out = [...entries];
  let componentCount = out.filter((entry) => entry.kind === "component").length;
  while (componentCount > 1) {
    const last = out[out.length - 1];
    if (!last || last.kind !== "component") break;
    if (last.entry.origin !== "index") break;
    if (!isShell(last)) break;
    out.pop();
    componentCount -= 1;
    // DOM levels above the new outermost component are scaffolding now.
    while (out.length > 0 && out[out.length - 1].kind === "dom") out.pop();
  }
  return out;
}

/** Pass-through wrappers: never content, shells at ANY size (a provider
 * wrapping one card is exactly as un-selectable as one wrapping the app). */
const PASS_THROUGH_NAME_PATTERN = /(Provider|Providers|Router|Routes)$/;

/** Names that read as page scaffolding: the app root and the
 * Page/Layout/Shell/Screen naming conventions. Geometry alone cannot identify
 * these — a centered `max-width` page container covers only ~half the body
 * width — so the convention carries a mild geometric sanity check (most of
 * the page's height) instead of the strict whole-body one. */
const PAGE_NAME_PATTERN = /(^App$)|(^Root$)|(Page|Layout|Shell|Screen)$/;

/**
 * Whether a component chain level is a page shell: a pass-through wrapper by
 * name; or a page-named component spanning ≥60% of the OWNING document's
 * body height (iframe-correct — rects and body share a document); or — any
 * name — a box covering ~the entire body (≥97% both dimensions).
 */
function isPageShellFiber(entry: ComponentFiberEntry): boolean {
  try {
    const name = entry.name || entry.entry.name;
    if (PASS_THROUGH_NAME_PATTERN.test(name)) return true;
    const anchor = getAnchorElement(entry.fiber);
    const doc = anchor?.ownerDocument;
    const body = doc?.body ?? doc?.documentElement;
    if (!body) return false;
    const bodyRect = body.getBoundingClientRect();
    if (bodyRect.width === 0 || bodyRect.height === 0) return false;
    const union = unionRects(getFiberRects(entry.fiber));
    if (!union) return false;
    if (PAGE_NAME_PATTERN.test(name) && union.height >= bodyRect.height * 0.6) {
      return true;
    }
    return (
      union.width >= bodyRect.width * 0.97 &&
      union.height >= bodyRect.height * 0.97
    );
  } catch {
    return false;
  }
}

/**
 * Interleaved hit-test chain under `el`, innermost → outermost. Walks
 * `fiber.return` from the pointer target up to the *outermost* registered
 * component, collecting BOTH registered components and the plain host DOM
 * elements between them — so each render-tree level a designer can see becomes
 * one drillable step (see drillSelection.ts). Fibers that are invisible to
 * designers (unregistered function components, providers, fragments, text) are
 * skipped. Host elements ABOVE the outermost registered component (canvas
 * scaffolding) are excluded, as are page-shell-sized export-index components
 * (see trimPageSizedTail).
 *
 * Consecutive matches against the same registry entry (a memo/forwardRef
 * wrapper whose unwrapped type matches the fiber right below it) are deduped
 * to their innermost occurrence.
 */
function hitTestChain(
  el: Element,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
): FiberChainEntry[] {
  const start = getFiberFromDom(el);
  if (!start) return [];

  // Innermost → outermost fiber path.
  const path: Fiber[] = [];
  for (let f: Fiber | null = start; f; f = f.return) path.push(f);

  // A fiber is an app-component BOUNDARY if it matches the registry/name index
  // (fallback) OR carries an exact `__dbSource` stamp (definitive, even before
  // its index entry has synced). `matched` is the registry entry that drives
  // wrapper-dedup identity; the DISPLAY entry additionally gets its file from
  // the stamp.
  function boundaryOf(
    fiber: Fiber,
  ): { matched: RegistryEntry | undefined; entry: RegistryEntry } | undefined {
    const matched = matchFiber(fiber, byRef, byName);
    if (matched) return { matched, entry: withStampedSource(matched, fiber) };
    const synth = stampSynthesizedEntry(fiber);
    return synth ? { matched: undefined, entry: synth } : undefined;
  }

  // Everything above the outermost boundary component is scaffolding.
  let outermostRegistered = -1;
  for (let i = 0; i < path.length; i++) {
    if (boundaryOf(path[i])) outermostRegistered = i;
  }
  if (outermostRegistered === -1) return [];

  const entries: FiberChainEntry[] = [];
  // Wrapper-dedup keys on the UNWRAPPED REF, not the registry entry: a
  // memo/forwardRef wrapper and its inner fiber share one unwrapped ref (dedup
  // them), while two genuinely-distinct components that happen to SHARE A NAME
  // resolve to the same by-name entry but DIFFERENT refs — and must stay
  // separate levels (the whole point of exact-source stamping).
  let lastDedupeKey: unknown;
  let lastComponentPushed: ComponentFiberEntry | undefined;
  for (let i = 0; i <= outermostRegistered; i++) {
    const fiber = path[i];
    const boundary = boundaryOf(fiber);
    if (boundary) {
      const { name, ref } = unwrapType(fiber.type);
      const dedupeKey =
        ref && (typeof ref === "function" || typeof ref === "object")
          ? ref
          : boundary.entry.id;
      if (dedupeKey === lastDedupeKey) {
        // memo/forwardRef wrapper of the just-pushed inner: the stamp lands on
        // the WRAPPER binding (React's `fiber.type`), not the inner fn — carry
        // its exact file down to the kept inner entry so the pair still
        // resolves to its own definition file.
        const stamp = sourceFromFiber(fiber);
        if (stamp && lastComponentPushed) {
          lastComponentPushed.entry = {
            ...lastComponentPushed.entry,
            sourcePath: stamp,
          };
        }
        continue;
      }
      lastDedupeKey = dedupeKey;
      const pushed: ComponentFiberEntry = {
        kind: "component",
        entry: boundary.entry,
        fiber,
        name: name || boundary.entry.name,
        className: asClassName(getFiberProps(fiber).className),
        ownerEntry: findOwnerEntry(fiber, byRef, byName),
      };
      entries.push(pushed);
      lastComponentPushed = pushed;
      continue;
    }

    if (isElementNode(fiber.stateNode)) {
      lastDedupeKey = undefined;
      lastComponentPushed = undefined;
      const element = fiber.stateNode;
      entries.push({
        kind: "dom",
        element,
        fiber,
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        classes: element.classList.length
          ? Array.from(element.classList)
          : undefined,
        className: asClassName(getFiberProps(fiber).className),
        ownerEntry: findOwnerEntry(fiber, byRef, byName),
      });
    }
    // else: unregistered component / provider / fragment / text — skip.
  }

  return trimPageSizedTail(entries, isPageShellFiber);
}

/**
 * Innermost registered COMPONENT under `el`, skipping DOM levels. Used by the
 * text tool, which cares only about which component owns a text node.
 */
function hitTest(
  el: Element,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
): HitTestResult | undefined {
  const chain = hitTestChain(el, byRef, byName);
  const component = chain.find((entry) => entry.kind === "component");
  return component ? { entry: component.entry, fiber: component.fiber } : undefined;
}

const instanceAnchorIds = new WeakMap<Element, number>();
let nextInstanceAnchorId = 0;

/**
 * Finds the first host DOM node (document order) inside a fiber's subtree,
 * excluding portaled content. Used as a stable per-instance anchor: the same
 * component instance re-renders with the same leading host node, even though
 * fiber objects themselves are swapped between the current/work-in-progress
 * trees on every commit.
 */
function getAnchorElement(fiber: Fiber): Element | undefined {
  if (fiber.tag === HOST_PORTAL_TAG) return undefined;
  if (isElementNode(fiber.stateNode)) return fiber.stateNode;

  let child = fiber.child;
  while (child) {
    const found = getAnchorElement(child);
    if (found) return found;
    child = child.sibling;
  }

  return undefined;
}

/**
 * Derives a stable id for one specific component instance on the canvas
 * (as opposed to `entry.id`, which identifies the component's *type* and is
 * shared by every instance). Ids are assigned lazily per DOM anchor node via
 * a `WeakMap`, so they survive re-renders but not remounts.
 */
function getInstanceId(result: HitTestResult): string {
  const anchor = getAnchorElement(result.fiber);
  if (!anchor) return result.entry.id;

  let anchorId = instanceAnchorIds.get(anchor);
  if (anchorId === undefined) {
    anchorId = nextInstanceAnchorId++;
    instanceAnchorIds.set(anchor, anchorId);
  }

  return `${result.entry.id}::${anchorId}`;
}

const domAnchorIds = new WeakMap<Element, number>();
let nextDomAnchorId = 0;

/**
 * Derives a stable id for one specific plain DOM node reached by drilling
 * through a component (the "DOM level" one step deeper than any registered
 * component — see drillSelection.ts). Namespaced under the owning
 * component's instance id so ids read as `<ownerInstanceId>::dom:<n>`. Like
 * `getInstanceId`, this is best-effort: it survives re-renders that reuse
 * the same DOM node but not ones that replace it.
 */
function getDomInstanceId(el: Element, ownerInstanceId: string): string {
  let anchorId = domAnchorIds.get(el);
  if (anchorId === undefined) {
    anchorId = nextDomAnchorId++;
    domAnchorIds.set(el, anchorId);
  }
  return `${ownerInstanceId}::dom:${anchorId}`;
}

/**
 * Walk child fibers to host nodes (`stateNode instanceof Element`) and collect
 * bounding rects. Excludes portaled subtrees (HostPortal tag = 4).
 */
function getFiberRects(fiber: Fiber): DOMRect[] {
  const rects: DOMRect[] = [];

  function walk(node: Fiber) {
    if (node.tag === HOST_PORTAL_TAG) return;

    if (isElementNode(node.stateNode)) {
      const rect = node.stateNode.getBoundingClientRect();
      // A boxless host (display:contents wrapper — e.g. a config's FlagScope)
      // measures 0×0; stopping there would make the whole component measure
      // empty and every hit on it silently unselectable. Descend into its
      // children instead.
      if (rect.width !== 0 || rect.height !== 0) {
        rects.push(rect);
        return;
      }
    }

    let child = node.child;
    while (child) {
      walk(child);
      child = child.sibling;
    }
  }

  walk(fiber);
  return rects;
}

function unionRects(rects: DOMRect[]): DOMRect | undefined {
  if (rects.length === 0) return undefined;

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

  return new DOMRect(minX, minY, maxX - minX, maxY - minY);
}

function getFiberProps(fiber: Fiber): Record<string, unknown> {
  return fiber.memoizedProps ?? {};
}

type SubtreeNode = {
  entry: RegistryEntry;
  fiber: Fiber;
  occurrenceIndex: number;
};

/**
 * Filtered walk of `fiber.child`/`sibling` producing the registry-matched
 * descendant tree. Run on demand (on selection / drill-in), not on every commit.
 */
function collectSubtree(
  fiber: Fiber,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
): SubtreeNode[] {
  const results: SubtreeNode[] = [];
  const counts = new Map<string, number>();

  function walk(node: Fiber, isRoot: boolean) {
    if (node.tag === HOST_PORTAL_TAG) return;

    if (!isRoot) {
      const entry = matchFiber(node, byRef, byName);
      if (entry) {
        const count = counts.get(entry.id) ?? 0;
        counts.set(entry.id, count + 1);
        results.push({ entry, fiber: node, occurrenceIndex: count });
        return;
      }
    }

    let child = node.child;
    while (child) {
      walk(child, false);
      child = child.sibling;
    }
  }

  walk(fiber, true);
  return results;
}

type BoundaryFiberNode = SubtreeNode & {
  /** True when the component receives parent-authored (slotted) content. */
  slot: boolean;
};

/**
 * Like `collectSubtree`, but slot-aware: registered descendants for which
 * `isSlotFiber` returns true (e.g. they receive parent-authored `children`)
 * are reported with `slot: true` and the walk CONTINUES into their subtree,
 * so registered components nested inside a slot are still found. Non-slot
 * matches terminate their branch exactly like `collectSubtree`.
 *
 * A memo/forwardRef wrapper and its inner fiber both match the same registry
 * entry; the wrapper chain is deduped by carrying the active slot entry down
 * until a host element is reached.
 */
function collectSlotAwareSubtree(
  fiber: Fiber,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
  isSlotFiber: (fiber: Fiber) => boolean,
): BoundaryFiberNode[] {
  const results: BoundaryFiberNode[] = [];
  const counts = new Map<string, number>();

  function walk(
    node: Fiber,
    isRoot: boolean,
    activeSlotEntry: RegistryEntry | undefined,
  ) {
    if (node.tag === HOST_PORTAL_TAG) return;

    let nextActive = isElementNode(node.stateNode)
      ? undefined
      : activeSlotEntry;

    if (!isRoot) {
      const entry = matchFiber(node, byRef, byName);
      if (entry && entry !== activeSlotEntry) {
        const count = counts.get(entry.id) ?? 0;
        counts.set(entry.id, count + 1);
        const slot = isSlotFiber(node);
        results.push({ entry, fiber: node, occurrenceIndex: count, slot });
        if (!slot) return;
        nextActive = entry;
      }
    }

    let child = node.child;
    while (child) {
      walk(child, false, nextActive);
      child = child.sibling;
    }
  }

  walk(fiber, true, undefined);
  return results;
}

export {
  collectSlotAwareSubtree,
  collectSubtree,
  getAnchorElement,
  getDomInstanceId,
  getFiberFromDom,
  getFiberProps,
  getFiberRects,
  getInstanceId,
  hitTest,
  hitTestChain,
  isElementNode,
  matchFiber,
  sourceFromFiber,
  stampSynthesizedEntry,
  trimPageSizedTail,
  unionRects,
  unwrapType,
  withStampedSource,
};
export type {
  BoundaryFiberNode,
  ComponentFiberEntry,
  DomFiberEntry,
  Fiber,
  FiberChainEntry,
  HitTestResult,
  SubtreeNode,
};
