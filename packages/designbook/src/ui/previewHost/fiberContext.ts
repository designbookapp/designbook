/**
 * Read the nearest React Context Provider value out of the HOST app's fiber
 * tree (C4.3). The tenant-wrapper case: the app wraps its UI in a context
 * provider and exposes no getter API, but because the workbench is
 * same-document we can walk the fibers and read the provided value directly.
 *
 * Two entry modes:
 *   - `fromElement` given → walk UP (`fiber.return`) from that element's fiber
 *     to the nearest enclosing Provider for `context` (normal context lookup).
 *   - no element → locate the app's React root container and search DOWN for the
 *     first Provider for `context`, returning the value it provides.
 *
 * Defensive by contract: reads dev/prod React internals across React 18 and 19
 * fiber shapes and returns `undefined` on anything unexpected — never throws.
 * Lives in the previewHost seam (not `components/**`) alongside `fibers`.
 */

import { getFiberFromDom, type Fiber } from "./fibers";

/** Minimal shape of a React Context object we can match a provider fiber to. */
type ReactContextLike = {
  Provider?: unknown;
  _currentValue?: unknown;
  $$typeof?: symbol;
};

const PROVIDER_TYPE = Symbol.for("react.provider");
const CONTEXT_TYPE = Symbol.for("react.context");

/**
 * Does this fiber render a Provider for `context`? Handles:
 *   - React 18: `<Ctx.Provider>` — `fiber.type.$$typeof === react.provider`,
 *     `fiber.type._context === context`.
 *   - React 19: `<Ctx>` used directly as a provider — `fiber.type === context`
 *     (a context object whose `$$typeof === react.context`).
 *   - Either matched loosely against `context.Provider`.
 */
function isProviderFor(fiber: Fiber, context: unknown): boolean {
  const type = fiber.type as
    | { $$typeof?: symbol; _context?: unknown }
    | null
    | undefined;
  if (!type || typeof type !== "object") return false;
  const ctx = context as ReactContextLike;
  if (type === context) return true;
  if (ctx && type === ctx.Provider) return true;
  if (type.$$typeof === PROVIDER_TYPE && type._context === context) return true;
  if (
    type.$$typeof === CONTEXT_TYPE &&
    (type === context || type._context === context)
  ) {
    return true;
  }
  return false;
}

/** The value a matched Provider fiber currently provides. */
function providerValue<T>(fiber: Fiber): T | undefined {
  const props = fiber.memoizedProps as { value?: T } | undefined;
  return props ? props.value : undefined;
}

/** Walk `fiber.return` upward to the nearest Provider for `context`. */
function findUp<T>(start: Fiber | undefined, context: unknown): T | undefined {
  let node: Fiber | null | undefined = start;
  const seen = new Set<Fiber>();
  while (node && !seen.has(node)) {
    seen.add(node);
    if (isProviderFor(node, context)) return providerValue<T>(node);
    node = node.return;
  }
  return undefined;
}

/** Depth-first search of a subtree for the first Provider for `context`. */
function findDown<T>(root: Fiber | undefined, context: unknown): T | undefined {
  if (!root) return undefined;
  const stack: Fiber[] = [root];
  const seen = new Set<Fiber>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (isProviderFor(node, context)) return providerValue<T>(node);
    if (node.child) stack.push(node.child);
    if (node.sibling) stack.push(node.sibling);
  }
  return undefined;
}

/**
 * Locate a React root fiber by scanning the document for a container element
 * carrying React's `__reactContainer$…` expando, which points at the root
 * (HostRoot) fiber. Returns the topmost app-level fiber to search from.
 */
function findRootFiber(): Fiber | undefined {
  if (typeof document === "undefined") return undefined;
  const nodes = document.querySelectorAll("*");
  for (const node of nodes) {
    const key = Object.keys(node).find((k) =>
      k.startsWith("__reactContainer$"),
    );
    if (!key) continue;
    const container = (node as unknown as Record<string, unknown>)[key];
    // The container expando is the HostRoot fiber; `.current` (FiberRoot) is
    // handled too. Descend to its child to skip the root node itself.
    const rootFiber = (container as { current?: Fiber } | undefined)?.current
      ? (container as { current: Fiber }).current
      : (container as Fiber);
    if (rootFiber && typeof rootFiber === "object") return rootFiber;
  }
  return undefined;
}

/**
 * Read the nearest Provider value for a React `context` in the host document's
 * fiber tree. Pass `fromElement` to walk up from a specific element (normal
 * enclosing-provider lookup); omit it to search the app root top-down. Returns
 * `undefined` when no provider is found or internals don't match — never throws.
 */
function readFiberContext<T = unknown>(
  context: unknown,
  fromElement?: Element,
): T | undefined {
  try {
    if (fromElement) {
      return findUp<T>(getFiberFromDom(fromElement), context);
    }
    return findDown<T>(findRootFiber(), context);
  } catch {
    return undefined;
  }
}

export { readFiberContext };
