/**
 * Source-owner fallback resolution for sandbox element pins
 * (docs/specs/sandbox.md v2): DOM outside any REGISTERED component subtree
 * (page shells like the demo's HomePage) still has an authoring component
 * with a source file in the repo — the prompt box must work there too.
 *
 * Reuses the existing machinery end to end, nothing new is invented:
 *   - the `_debugOwner` walk is the same owner-attribution relation
 *     `findOwnerEntry` (fibers.ts) and `ownerAttribution` (selectionInspect)
 *     use, minus the registry match — here ANY named function/class component
 *     is a candidate, because the owner is unregistered by definition;
 *   - the component-ref → repo-path inference mirrors the registry's
 *     `buildSourcePathMap` over the config's `sourceModules` glob — when the
 *     app's glob covers the owner file, the sourcePath resolves client-side;
 *   - when it doesn't (the demo's pages aren't in `sourceModules`), the pin
 *     route resolves the file NODE-side from the owner-name chain via the
 *     wrapper generator's export scan (`makeExportResolver` in
 *     node/api/sandbox.ts) — same scan, same bounds.
 *
 * Pure core (`sourceOwnerFromFiber`, injected path lookup) + live binding
 * (`resolveSourceOwner`), the capture.ts/captureLive.ts split.
 */

import {
  getFiberFromDom,
  unwrapType,
  type Fiber,
} from "@designbook-ui/previewHost";
import { repoPathFromGlobKey, sourceModules } from "@designbook-ui/designbook";

/** Bound for the owner-name chain sent to the server-side export scan. */
const MAX_OWNER_NAMES = 8;

/** A synthesized owner identity for a DOM element with no registered entry. */
type SourceOwner = {
  /** The authoring component's display name (chip hint + pin label). */
  name: string;
  /** Export the pin targets — the owner's name (glob-entry convention). */
  exportName: string;
  /** Repo-relative source path when client-resolvable via `sourceModules`;
   * "" when only the node-side export scan can resolve it. */
  sourcePath: string;
  /** Named-component chain, nearest owner first (server resolution ladder:
   * a node_modules component like react-router's Link scans to nothing and
   * the next name up — the page shell — resolves instead). */
  ownerNames: string[];
};

/** A named function/class component candidate on the owner chain. */
type OwnerCandidate = { name: string; ref: unknown };

function candidateOf(fiber: Fiber): OwnerCandidate | undefined {
  if (typeof fiber.type !== "function" && typeof fiber.type !== "object") {
    return undefined; // host element / text — never an authoring component
  }
  try {
    const { ref, name } = unwrapType(fiber.type);
    // Providers/fragments/anonymous wrappers unwrap to no name — skip, the
    // same visibility rule the hit-test chain applies.
    return name ? { name, ref } : undefined;
  } catch {
    return undefined;
  }
}

/** Named components along a linked fiber chain (`_debugOwner` or `return`). */
function collectCandidates(
  start: Fiber | null | undefined,
  next: (fiber: Fiber) => Fiber | null | undefined,
): OwnerCandidate[] {
  const out: OwnerCandidate[] = [];
  const seen = new Set<Fiber>();
  let node = start;
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const candidate = candidateOf(node);
    if (candidate && !out.some((c) => c.name === candidate.name)) {
      out.push(candidate);
      if (out.length >= MAX_OWNER_NAMES) break;
    }
    node = next(node);
  }
  return out;
}

/**
 * Resolve the source owner for an element's fiber: the nearest named
 * component on the JSX-owner chain (`_debugOwner` — who WROTE the element),
 * falling back to the render-tree parent chain when owner info is absent.
 * Prefers the nearest candidate whose source file resolves client-side;
 * otherwise the nearest named one (the server scan finishes the job).
 * Undefined when no named component is found at all.
 */
function sourceOwnerFromFiber(
  fiber: Fiber | null | undefined,
  sourcePathOf: (ref: unknown) => string | undefined,
): SourceOwner | undefined {
  if (!fiber) return undefined;
  let candidates = collectCandidates(fiber._debugOwner, (f) => f._debugOwner);
  if (candidates.length === 0) {
    // Prod-ish build without owner info — the render-tree walk is the same
    // fallback `nearestComponentName` (resolvePageHit.ts) already uses.
    candidates = collectCandidates(fiber.return, (f) => f.return);
  }
  if (candidates.length === 0) return undefined;
  const resolved = candidates
    .map((candidate) => ({
      ...candidate,
      sourcePath: sourcePathOf(candidate.ref) ?? "",
    }))
    .find((candidate) => candidate.sourcePath);
  const owner = resolved ?? { ...candidates[0], sourcePath: "" };
  return {
    name: owner.name,
    exportName: owner.name,
    sourcePath: owner.sourcePath,
    ownerNames: candidates.map((candidate) => candidate.name),
  };
}

// ---------------------------------------------------------------------------
// Live binding.
// ---------------------------------------------------------------------------

/** Lazy mirror of the registry's `buildSourcePathMap` (componentRegistry.ts):
 * exported component ref → repo-relative path, from the config's
 * `sourceModules` glob. Built on first use — `initConfigStore` has run long
 * before any hit resolution can happen. */
let sourcePathMap: Map<unknown, string> | undefined;

function sourcePathByRef(ref: unknown): string | undefined {
  if (!sourcePathMap) {
    sourcePathMap = new Map();
    for (const [globKey, mod] of Object.entries(sourceModules)) {
      const repoPath = repoPathFromGlobKey(globKey);
      for (const exported of Object.values(
        (mod ?? {}) as Record<string, unknown>,
      )) {
        if (typeof exported === "function" && !sourcePathMap.has(exported)) {
          sourcePathMap.set(exported, repoPath);
        }
      }
    }
  }
  return sourcePathMap.get(ref);
}

/** Source owner for a live DOM element (undefined outside any React tree or
 * when no named authoring component exists). */
function resolveSourceOwner(el: Element): SourceOwner | undefined {
  let fiber: Fiber | undefined;
  try {
    fiber = getFiberFromDom(el);
  } catch {
    return undefined;
  }
  return sourceOwnerFromFiber(fiber, sourcePathByRef);
}

// ---------------------------------------------------------------------------
// Component-hit usage descriptor (props panel — docs/specs/props-panel.md).
// ---------------------------------------------------------------------------

/** Usage-site descriptor for the props panel's write payload — see
 * `CanvasUsageTarget` (ui/types.ts) for field semantics. */
type ComponentUsage = {
  ownerNames: string[];
  name: string;
  className?: string;
};

/**
 * Derive a COMPONENT hit's usage descriptor from its OWN fiber: the same
 * `_debugOwner`/`return` ladder `sourceOwnerFromFiber` walks (here started
 * from the SELECTED component's fiber, not an owned DOM leaf, so the walk
 * begins at whoever's JSX instantiated it) paired with the component's own
 * JSX name and — when cheaply available — the className the usage site
 * passed it (`fiber.memoizedProps.className`). Undefined when no named
 * owner exists on the chain (nothing for the server ladder to try).
 */
function componentUsageFromFiber(
  fiber: Fiber,
  name: string,
): ComponentUsage | undefined {
  const owner = sourceOwnerFromFiber(fiber, () => undefined);
  if (!owner || owner.ownerNames.length === 0) return undefined;
  const className =
    typeof fiber.memoizedProps?.className === "string"
      ? fiber.memoizedProps.className
      : undefined;
  return {
    ownerNames: owner.ownerNames,
    name,
    ...(className ? { className } : {}),
  };
}

export { componentUsageFromFiber, resolveSourceOwner, sourceOwnerFromFiber };
export type { ComponentUsage, SourceOwner };
