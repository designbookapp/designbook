/**
 * Live binding for `captureSandboxContext` (docs/specs/sandbox.md, D2): turn
 * an app-frame CanvasHitResult into the pin payload by snapshotting the hit's
 * fiber props, its context scope (previewHost seam walk), and the adapter
 * runtime's dimension state — all at capture time, never subscribed.
 *
 * Kept apart from capture.ts so the capture core stays pure/testable: this
 * module is the only place that touches React internals and runtime globals.
 */

import {
  collectContextScope,
  getAnchorElement,
  getFiberFromDom,
  getFiberProps,
  unwrapType,
  type ContextScopeEntry,
  type Fiber,
} from "@designbook-ui/previewHost";
import {
  registryByName,
  registryByRef,
} from "@designbook-ui/models/catalog/componentRegistry";
import {
  isAdapterRuntimeReady,
  loadAdapterRuntime,
} from "@designbook-ui/adapterRuntime";
import { config, repoPathFromGlobKey } from "@designbook-ui/designbook";
import { buildElementLocator, captureSandboxContext } from "./capture";
import type {
  SandboxContextSnapshot,
  SandboxElementLocator,
  SandboxI18nInfo,
  SandboxTargetInput,
} from "./capture";

/** The slice of `CanvasHitResult` capture needs (DOM-free for typing ease). */
type CaptureHit = {
  kind: "component" | "dom";
  name: string;
  instanceId: string;
  entry: { id: string; label: string; sourcePath: string; key: string; exportName?: string };
  fiber?: unknown;
};

/**
 * Adapter dimension state at capture.
 *
 * ASYNC on purpose — the page-mode race root cause: the page-tools root
 * mounts as soon as its own (small) chunk loads, but `loadAdapterRuntime()`
 * only STARTS after the mount bootstrap has fetched + evaluated the much
 * larger WorkbenchRoot graph, and then awaits every adapter `setup()`
 * (network fetches: theme css model, variant overrides, i18next chunk). A
 * pin submitted inside that cold-load window used to call the SYNC
 * `getAdapterRuntime()`, catch its "before initialization" throw, and
 * silently capture `{}` — variants then rendered in DEFAULT
 * theme/locale/flags. The App page never hit this because its UI can't
 * render until the same bootstrap await completes. Awaiting the shared init
 * promise here makes capture correct on both surfaces regardless of timing.
 */
async function adapterStateSnapshot(): Promise<Record<string, string>> {
  try {
    if (!isAdapterRuntimeReady()) {
      // Diagnostic breadcrumb for the race described above: rare, but when
      // it happens we want the capture path visible, not silent.
      console.warn(
        "[designbook] sandbox capture ran before the adapter runtime finished initializing — awaiting init so the pin records the live adapter state.",
      );
    }
    const runtime = await loadAdapterRuntime();
    const { context } = runtime.getSnapshot();
    const state: Record<string, string> = {};
    for (const dimension of runtime.dimensions) {
      const value = context[dimension.id] ?? dimension.defaultValue;
      if (value !== undefined) state[dimension.id] = String(value);
    }
    return state;
  } catch (error) {
    // Init itself failed — degrade to {} but say so (never silently).
    console.warn("[designbook] sandbox adapter capture failed:", error);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Subtree-aware context consumption.
//
// `collectContextScope` marks a context `consumed` only when the SELECTED
// fiber's own dependency chain reads it. That's right for the Info panel, but
// a sandbox pin on a COMPOSITE (page mode's default selection since the
// outermost-first drill semantics) captures the whole render subtree: the
// demo's ProductCard consumes nothing itself, while its atoms all read
// ProductContext — filtering on root-only consumption dropped the one context
// the generated wrapper must re-create, so every variant of a composite threw
// "useProduct must be used inside a ProductProvider". The walk below unions
// the dependency chains of the selection's entire fiber subtree (bounded,
// portals excluded) so `consumed` means "consumed anywhere inside the
// selection".
// ---------------------------------------------------------------------------

const HOST_PORTAL_TAG = 4;
/** Safety bound for the subtree walk (a selection is a page section, not the
 * whole app; 5k fibers is far beyond any reasonable component). */
const MAX_SUBTREE_FIBERS = 5000;

/** Add every context on a fiber's `dependencies.firstContext` chain. */
function addConsumedContexts(fiber: Fiber, into: Set<unknown>): void {
  const deps = (fiber as { dependencies?: { firstContext?: unknown } })
    .dependencies;
  let dep = deps?.firstContext as
    | { context?: unknown; next?: unknown }
    | null
    | undefined;
  let guard = 0;
  while (dep && typeof dep === "object" && guard < 100) {
    if (dep.context) into.add(dep.context);
    dep = dep.next as typeof dep;
    guard += 1;
  }
}

/** Union of contexts consumed anywhere in the selection's fiber subtree. */
function subtreeConsumedContexts(root: Fiber): Set<unknown> {
  const consumed = new Set<unknown>();
  let visited = 0;
  function walk(node: Fiber): void {
    if (visited >= MAX_SUBTREE_FIBERS || node.tag === HOST_PORTAL_TAG) return;
    visited += 1;
    addConsumedContexts(node, consumed);
    let child = node.child;
    while (child) {
      walk(child);
      child = child.sibling;
    }
  }
  walk(root);
  return consumed;
}

/** React 18/19 provider-fiber → its Context object (mirrors the previewHost
 * walker's read; local so the sandbox capture stays inside its own module). */
const REACT_PROVIDER = Symbol.for("react.provider");
const REACT_CONTEXT = Symbol.for("react.context");
function providerContextOf(fiber: Fiber): unknown {
  const type = fiber.type as
    | { $$typeof?: symbol; _context?: unknown }
    | null
    | undefined;
  if (!type || typeof type !== "object") return undefined;
  if (type.$$typeof === REACT_PROVIDER) return type._context ?? undefined;
  if (type.$$typeof === REACT_CONTEXT) return type._context ?? type;
  return undefined;
}

/** A scope entry plus the provider-component attribution the deterministic
 * wrapper generator needs (docs/specs/sandbox.md fix: wrapper in code). */
type PinContextEntry = ContextScopeEntry & {
  providerName?: string;
  providerFile?: string;
  providerProps?: Record<string, unknown>;
};

/**
 * The component that RENDERED a provider fiber (its `_debugOwner` chain's
 * first function/class component): name + live props. This is the "importable
 * provider" the generated wrapper re-instantiates (e.g. `ProductProvider`
 * with the captured `product`/`currency` props) instead of a literal
 * `<Ctx.Provider>` stub. Dev-only React internals — degrade to undefined.
 */
function providerComponentOf(providerFiber: Fiber): {
  providerName?: string;
  providerProps?: Record<string, unknown>;
} {
  try {
    let owner: unknown = providerFiber._debugOwner;
    const seen = new Set<unknown>();
    while (owner && typeof owner === "object" && !seen.has(owner)) {
      seen.add(owner);
      const ownerFiber = owner as Fiber;
      if (typeof ownerFiber.type === "function" || typeof ownerFiber.type === "object") {
        const { name } = unwrapType(ownerFiber.type);
        if (name) {
          return {
            providerName: name,
            providerProps: getFiberProps(ownerFiber),
          };
        }
      }
      owner = ownerFiber._debugOwner;
    }
  } catch {
    // React internals drifted — the generator falls back to literal stubs.
  }
  return {};
}

/**
 * Context scope for a pin: `collectContextScope`'s entries (names, values,
 * owner attribution, shadowing) with `consumed` widened to the selection's
 * SUBTREE, plus provider-component attribution (name + props) per entry. The
 * provider chain above the selection is re-walked in step with the scope
 * entries to recover each entry's context identity (the entries themselves
 * only carry display names).
 */
function pinContextScope(
  fiber: Fiber,
): PinContextEntry[] {
  const entries = collectContextScope(fiber, registryByRef, registryByName);
  try {
    const consumed = subtreeConsumedContexts(fiber);
    // Ancestor providers, nearest first — the exact order collectContextScope
    // emits its entries in, so index i's context identity belongs to entry i.
    const providers: Array<{ context: unknown; fiber: Fiber }> = [];
    const seen = new Set<Fiber>();
    let node: Fiber | null = fiber.return;
    while (node && !seen.has(node)) {
      seen.add(node);
      const context = providerContextOf(node);
      if (context !== undefined) providers.push({ context, fiber: node });
      node = node.return;
    }
    if (providers.length !== entries.length) return entries; // drifted — keep as-is
    return entries.map((entry, index) => {
      const attribution = providerComponentOf(providers[index].fiber);
      return {
        ...entry,
        consumed: entry.consumed || consumed.has(providers[index].context),
        ...attribution,
        // Only trust the registry-attributed file when it belongs to the SAME
        // component we extracted props from (the owner walk may have matched
        // a registered component deeper in the chain).
        ...(attribution.providerName &&
        entry.ownerFile &&
        entry.ownerName === attribution.providerName
          ? { providerFile: entry.ownerFile }
          : {}),
      };
    });
  } catch {
    return entries;
  }
}

/**
 * The app route at pin time (seeds the wrapper's `<MemoryRouter>`). Read from
 * the SELECTION's own document so both surfaces are correct with one source:
 * in page mode the selection lives in the top window (the live app's location);
 * on the App page the selection lives in the app IFRAME, whose
 * `location.pathname` IS the frame's route. Falls back to the top window, then
 * "/". Query/hash (incl. the `?__designbook_frame` plumbing) are dropped
 * downstream by `normalizeCapturedPath`.
 */
function capturedPathFrom(node: Element | null | undefined): string {
  try {
    const win = node?.ownerDocument?.defaultView ?? window;
    return win.location.pathname || "/";
  } catch {
    return "/";
  }
}

/**
 * App i18n info for the wrapper generator: the config's locale-file pattern
 * (repo-relative, `{locale}`/`{namespace}` slots kept) so the node-side
 * generator can import the app's own locale JSON into the wrapper's i18next
 * instance. Absent when the config has no `i18n`.
 */
function i18nInfoSnapshot(): SandboxI18nInfo | undefined {
  const i18n = config.i18n;
  if (!i18n) return undefined;
  const pattern = i18n.localePath ?? "./locales/{locale}/{namespace}.json";
  return {
    localePathPattern: repoPathFromGlobKey(pattern),
    ...(i18n.defaultNamespace ? { defaultNamespace: i18n.defaultNamespace } : {}),
    ...(i18n.defaultLocale ? { defaultLocale: i18n.defaultLocale } : {}),
  };
}

/**
 * Capture a pin payload from a live selection hit. Works for component hits
 * (fiber-backed) and degrades for DOM hits / restored selections (props and
 * context scope simply come back empty — the pin still has its code target).
 */
async function captureFromHit(hit: CaptureHit): Promise<{
  target: SandboxTargetInput;
  contextSnapshot: SandboxContextSnapshot;
}> {
  const fiber = hit.fiber as Fiber | undefined;
  let props: Record<string, unknown> | undefined;
  let contextScope;
  let anchor: Element | undefined;
  if (fiber) {
    try {
      props = getFiberProps(fiber);
    } catch {
      props = undefined;
    }
    contextScope = pinContextScope(fiber);
    // The selection's rendered anchor gives us its owning document → the app's
    // route (top window in page mode, the iframe on the App page).
    try {
      anchor = getAnchorElement(fiber) ?? undefined;
    } catch {
      anchor = undefined;
    }
  }
  return captureSandboxContext({
    target: {
      file: hit.entry.sourcePath,
      exportName: hit.entry.exportName ?? hit.entry.key,
      name: hit.entry.label,
      entryId: hit.entry.id,
      instancePath: hit.instanceId,
    },
    props,
    contextScope,
    adapterState: await adapterStateSnapshot(),
    i18n: i18nInfoSnapshot(),
    capturedPath: capturedPathFrom(anchor),
  });
}

// ---------------------------------------------------------------------------
// Element pins (docs/specs/sandbox.md v2): capture a DOM-element selection.
// ---------------------------------------------------------------------------

/** Climb the fiber return chain from the element to the OWNER component's
 * fiber (matched by its display/export name) — the root the locator's child
 * index path is relative to. Undefined when React internals drifted. */
function ownerFiberOf(
  fiber: Fiber | null | undefined,
  ownerName: string,
): Fiber | undefined {
  const seen = new Set<Fiber>();
  let node: Fiber | null | undefined = fiber;
  while (node && !seen.has(node)) {
    seen.add(node);
    if (typeof node.type === "function" || typeof node.type === "object") {
      try {
        if (unwrapType(node.type).name === ownerName) return node;
      } catch {
        return undefined;
      }
    }
    node = node.return;
  }
  return undefined;
}

/** Element-child index path from `root` down to `element` (indexes among
 * element children per level). Empty when `root` isn't an ancestor. */
function childIndexPathFrom(root: Element, element: Element): number[] {
  const path: number[] = [];
  let node: Element = element;
  while (node !== root) {
    const parent = node.parentElement;
    if (!parent) return [];
    const index = Array.prototype.indexOf.call(parent.children, node);
    if (index < 0) return [];
    path.unshift(index);
    node = parent;
    if (path.length > 64) return []; // way past any sane owner subtree
  }
  return path;
}

/**
 * Capture an ELEMENT pin payload from a drilled DOM selection: the OWNER
 * component's code target (the pin's durable identity) + the element locator
 * (tag/outerHTML/child path/text hash — the director's locate signals) + the
 * usual snapshot with the element subtree's resolved fiber props/text (the
 * controller's inlined-locals raw material). Context scope walks up from the
 * ELEMENT's fiber, so `consumed` reflects the element subtree exactly.
 */
async function captureElementFromHit(
  hit: CaptureHit,
  element: Element,
): Promise<{
  target: SandboxTargetInput;
  contextSnapshot: SandboxContextSnapshot;
  locator: SandboxElementLocator;
}> {
  const ownerExportName = hit.entry.exportName ?? hit.entry.key;
  let hostFiber: Fiber | null | undefined;
  try {
    hostFiber = getFiberFromDom(element);
  } catch {
    hostFiber = undefined;
  }

  // Locator: child index path relative to the owner's rendered root when the
  // owner fiber + anchor resolve; the outerHTML/text signals always land.
  let childIndexPath: number[] = [];
  try {
    const ownerFiber = ownerFiberOf(hostFiber, ownerExportName);
    const ownerRoot = ownerFiber ? getAnchorElement(ownerFiber) : undefined;
    if (ownerRoot) childIndexPath = childIndexPathFrom(ownerRoot, element);
  } catch {
    childIndexPath = [];
  }
  const locator = buildElementLocator({
    tag: element.tagName.toLowerCase(),
    outerHtml: element.outerHTML,
    textContent: element.textContent ?? "",
    className:
      typeof element.className === "string" ? element.className : undefined,
    childIndexPath,
  });

  let elementProps: Record<string, unknown> | undefined;
  let contextScope;
  if (hostFiber) {
    try {
      elementProps = getFiberProps(hostFiber);
    } catch {
      elementProps = undefined;
    }
    contextScope = pinContextScope(hostFiber);
  }

  const captured = captureSandboxContext({
    target: {
      file: hit.entry.sourcePath,
      exportName: ownerExportName,
      name: hit.name,
      entryId: hit.entry.id,
      instancePath: hit.instanceId,
    },
    // The pin's `props` snapshot stays the OWNER-level concept; element pins
    // carry their readings in the dedicated `element` section instead.
    contextScope,
    adapterState: await adapterStateSnapshot(),
    i18n: i18nInfoSnapshot(),
    element: {
      tag: element.tagName.toLowerCase(),
      text: element.textContent ?? "",
      props: elementProps,
    },
    // The selected element's own document → the app's route (iframe-aware).
    capturedPath: capturedPathFrom(element),
  });
  return { ...captured, locator };
}

export { captureElementFromHit, captureFromHit };
export type { CaptureHit };
