/**
 * Selection-context fiber walkers (PREVIEW — docs/specs/selection-context.md).
 *
 * Same-document fiber access for the Info panel's built-in contributors:
 *   - `collectRenderedText` — walk the selected fiber's host subtree
 *     collecting the text tool's invisible i18n markers → the keys rendered
 *     RIGHT NOW with their current-locale values, plus a count of rendered
 *     text nodes WITHOUT markers ("hardcoded strings");
 *   - `collectContextScope` — walk UP from the selected fiber over every
 *     ancestor context provider: context name, live provided value, whether
 *     the selected component actually consumes it (`fiber.dependencies`), and
 *     whether a nearer provider shadows it.
 *
 * Lives in the previewHost seam (NOT components/screens) exactly like
 * fibers.ts/fiberContext.ts — consumers reach these only via
 * `@designbook-ui/previewHost` so a future Model-A shell can reimplement them
 * over a message channel. Defensive by contract: React internals reads return
 * partial results rather than throwing.
 */

import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";
import {
  decodeMarker,
  getMarkerEntry,
  stripMarkers,
  type MarkerEntry,
} from "@designbook-ui/models/text/i18nMarkers";
import { isElementNode, matchFiber, unwrapType, type Fiber } from "./fibers";

const HOST_PORTAL_TAG = 4;

// ---------------------------------------------------------------------------
// Rendered text (runtime i18n enumeration).
// ---------------------------------------------------------------------------

type RenderedTextEntry = {
  namespace: string;
  key: string;
  resolvedKey: string;
  /** Current-locale rendered value (markers stripped). */
  value: string;
};

type RenderedTextResult = {
  /** Marker-attributed strings rendered right now (deduped by ns::key). */
  marked: RenderedTextEntry[];
  /** Rendered non-empty text nodes WITHOUT an i18n marker. */
  hardcodedCount: number;
};

/** First host elements of a fiber subtree (portals excluded). */
function collectHostElements(fiber: Fiber): Element[] {
  const out: Element[] = [];
  function walk(node: Fiber): void {
    if (node.tag === HOST_PORTAL_TAG) return;
    if (isElementNode(node.stateNode)) {
      out.push(node.stateNode);
      return; // the DOM subtree below is covered by the element walk
    }
    let child = node.child;
    while (child) {
      walk(child);
      child = child.sibling;
    }
  }
  walk(fiber);
  return out;
}

function scanTextNodes(root: Element, result: RenderedTextResult, seen: Set<string>): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const visible = stripMarkers(text).trim();
    if (visible.length > 0) {
      const index = decodeMarker(text);
      const entry: MarkerEntry | undefined =
        index === undefined ? undefined : getMarkerEntry(index);
      if (entry) {
        const dedupeKey = `${entry.namespace}::${entry.resolvedKey}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          result.marked.push({ ...entry, value: visible });
        }
      } else {
        result.hardcodedCount += 1;
      }
    }
    node = walker.nextNode();
  }
}

/**
 * Runtime i18n enumeration for a selection: pass the live component fiber
 * when available, else a root element (DOM hit / restored selection).
 */
function collectRenderedText(
  target: { fiber?: unknown; element?: Element },
): RenderedTextResult {
  const result: RenderedTextResult = { marked: [], hardcodedCount: 0 };
  const seen = new Set<string>();
  try {
    const roots = target.fiber
      ? collectHostElements(target.fiber as Fiber)
      : target.element
        ? [target.element]
        : [];
    for (const root of roots) scanTextNodes(root, result, seen);
  } catch {
    // Partial results are fine.
  }
  return result;
}

// ---------------------------------------------------------------------------
// Context scope (ancestor providers).
// ---------------------------------------------------------------------------

type ContextScopeEntry = {
  /** `Context.displayName`, or "Context" when unnamed. */
  contextName: string;
  /** The provider's live `memoizedProps.value` — raw; callers sample it. */
  value: unknown;
  /** The selected fiber reads this context (its `dependencies` chain). */
  consumed: boolean;
  /** A nearer provider for the same context shadows this one. */
  shadowed: boolean;
  /** JSX owner component of the provider element, when attributable. */
  ownerName?: string;
  /** Owner's source file, when the owner is a registered component. */
  ownerFile?: string;
};

const REACT_PROVIDER = Symbol.for("react.provider");
const REACT_CONTEXT = Symbol.for("react.context");

/** The React Context object a provider fiber provides for, if any. */
function providerContextOf(fiber: Fiber): unknown {
  const type = fiber.type as
    | { $$typeof?: symbol; _context?: unknown }
    | null
    | undefined;
  if (!type || typeof type !== "object") return undefined;
  // React 18: <Ctx.Provider> — type.$$typeof is react.provider, context on
  // `_context`. React 19: <Ctx> directly — type IS the context object.
  if (type.$$typeof === REACT_PROVIDER) return type._context ?? undefined;
  if (type.$$typeof === REACT_CONTEXT) return type._context ?? type;
  return undefined;
}

/** Contexts the fiber reads, off its `dependencies.firstContext` chain. */
function consumedContexts(fiber: Fiber): Set<unknown> {
  const consumed = new Set<unknown>();
  const deps = (
    fiber as { dependencies?: { firstContext?: unknown } }
  ).dependencies;
  let dep = deps?.firstContext as
    | { context?: unknown; next?: unknown }
    | null
    | undefined;
  let guard = 0;
  while (dep && typeof dep === "object" && guard < 100) {
    if (dep.context) consumed.add(dep.context);
    dep = dep.next as typeof dep;
    guard += 1;
  }
  return consumed;
}

/** Nearest registered JSX owner of a fiber (walks `_debugOwner`). */
function ownerAttribution(
  fiber: Fiber,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
): { ownerName?: string; ownerFile?: string } {
  let owner: unknown = fiber._debugOwner;
  const seen = new Set<unknown>();
  let firstName: string | undefined;
  while (owner && typeof owner === "object" && !seen.has(owner)) {
    seen.add(owner);
    const ownerFiber = owner as Fiber;
    const { name } = unwrapType(ownerFiber.type);
    firstName ??= name || undefined;
    const entry = matchFiber(ownerFiber, byRef, byName);
    if (entry) {
      return { ownerName: name || entry.name, ownerFile: entry.sourcePath };
    }
    owner = ownerFiber._debugOwner;
  }
  return { ownerName: firstName };
}

/**
 * Every ancestor context provider above `fiber`, nearest first. `consumed`
 * reflects the selected fiber's own dependency chain; a farther provider for
 * an already-seen context is marked `shadowed`.
 */
function collectContextScope(
  fiber: unknown,
  byRef: Map<unknown, RegistryEntry>,
  byName: Map<string, RegistryEntry>,
): ContextScopeEntry[] {
  const entries: ContextScopeEntry[] = [];
  try {
    const start = fiber as Fiber;
    const consumed = consumedContexts(start);
    const seenContexts = new Set<unknown>();
    const seenFibers = new Set<Fiber>();
    let node: Fiber | null = start.return;
    while (node && !seenFibers.has(node)) {
      seenFibers.add(node);
      const context = providerContextOf(node);
      if (context !== undefined) {
        const contextName =
          (context as { displayName?: string }).displayName || "Context";
        const value = (node.memoizedProps as { value?: unknown } | null)
          ?.value;
        entries.push({
          contextName,
          value,
          consumed: consumed.has(context),
          shadowed: seenContexts.has(context),
          ...ownerAttribution(node, byRef, byName),
        });
        seenContexts.add(context);
      }
      node = node.return;
    }
  } catch {
    // Partial results are fine.
  }
  return entries;
}

export { collectContextScope, collectRenderedText };
export type { ContextScopeEntry, RenderedTextEntry, RenderedTextResult };
