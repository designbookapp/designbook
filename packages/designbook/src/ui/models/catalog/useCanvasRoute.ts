import { useEffect, useState } from "react";
import { getFlowById, getFlowForScreen, getFlowScreen } from "@designbook-ui/models/catalog/flows";

type CanvasRoute = {
  branch: string | undefined;
  flowId: string | undefined;
  nodeIds: string[];
  /** App page route — the workbench-relative path shown in the
   * frame cell. Mutually exclusive with flowId/nodeIds; `undefined` for every
   * other route. */
  appPath?: string;
  /** Sandbox canvas route (docs/specs/sandbox.md) — the focused pin id.
   * Mutually exclusive with the other detail routes, like `appPath`. */
  sandboxPinId?: string;
};

/**
 * Resolves un-prefixed (legacy) segments to a canonical route: a flow id, a
 * flow screen, or a component entry.
 */
function parseLegacySegments(segments: string[]): Omit<CanvasRoute, "branch"> {
  if (segments.length === 1 && getFlowById(segments[0])) {
    return { flowId: segments[0], nodeIds: [] };
  }
  const detailId = segments[segments.length - 1];
  if (!detailId) {
    return { flowId: undefined, nodeIds: [] };
  }
  if (getFlowScreen(detailId)) {
    return { flowId: getFlowForScreen(detailId)?.id, nodeIds: [detailId] };
  }
  return { flowId: undefined, nodeIds: [detailId] };
}

function parseSegments(segments: string[]): Omit<CanvasRoute, "branch"> {
  if (segments[0] === "app") {
    // `segments` are already decodeURIComponent-ed once by parseHashString, so
    // no further decoding here (matches the "flow"/"component" branches below).
    return { flowId: undefined, nodeIds: [], appPath: segments[1] || "/" };
  }
  if (segments[0] === "sandbox" && segments[1]) {
    return { flowId: undefined, nodeIds: [], sandboxPinId: segments[1] };
  }
  if (segments[0] === "flow") {
    return {
      flowId: segments[1],
      nodeIds: segments[2] ? [segments[2]] : [],
    };
  }
  if (segments[0] === "component") {
    return {
      flowId: undefined,
      nodeIds: segments[1] ? [segments[1]] : [],
    };
  }
  return parseLegacySegments(segments);
}

function parseHashString(rawHash: string): CanvasRoute {
  const hash = rawHash.replace(/^#\/?/, "");
  const segments = hash
    ? hash.split("/").filter(Boolean).map(decodeURIComponent)
    : [];

  if (segments[0] === "b" && segments.length >= 2) {
    return { branch: segments[1], ...parseSegments(segments.slice(2)) };
  }

  return { branch: undefined, ...parseSegments(segments) };
}

function parseHash(): CanvasRoute {
  return parseHashString(window.location.hash);
}

function buildHash(
  branch: string | undefined,
  nodeIds: string[],
  flowId?: string,
  appPath?: string,
  sandboxPinId?: string,
) {
  const parts: string[] = [];

  if (sandboxPinId !== undefined) {
    parts.push("sandbox", encodeURIComponent(sandboxPinId));
  } else if (appPath !== undefined) {
    parts.push("app", encodeURIComponent(appPath));
  } else {
    const detailId = nodeIds[nodeIds.length - 1];

    if (detailId) {
      if (getFlowScreen(detailId)) {
        const owner = flowId ?? getFlowForScreen(detailId)?.id;
        parts.push("flow");
        if (owner) parts.push(encodeURIComponent(owner));
        parts.push(encodeURIComponent(detailId));
      } else {
        parts.push("component", encodeURIComponent(detailId));
      }
    } else if (flowId) {
      parts.push("flow", encodeURIComponent(flowId));
    }
  }

  const suffix = parts.join("/");

  if (!branch) {
    return suffix ? `/${suffix}` : "/";
  }
  const branchSegment = `/b/${encodeURIComponent(branch)}`;
  return suffix ? `${branchSegment}/${suffix}` : branchSegment;
}

/**
 * Canvas navigation state stored in the URL hash:
 *
 * - `#/b/<branch>` — default flow canvas
 * - `#/b/<branch>/flow/<flowId>` — a specific flow canvas
 * - `#/b/<branch>/flow/<flowId>/<screenId>` — a flow screen's detail view
 * - `#/b/<branch>/component/<entryId>` — a component's detail view (flat and
 *   flow-free: the same component has one URL regardless of how it was reached)
 * - `#/b/<branch>/app/<encodedPath>` — the App page (injected mode
 *   only), showing a live same-origin frame of `<encodedPath>`
 * - `#/b/<branch>/sandbox/<pinId>` — the sandbox canvas focused on one pin's
 *   entry (docs/specs/sandbox.md)
 *
 * The `flow`/`component`/`app` prefixes namespace their id spaces so a flow, a
 * component, and an app route with the same id can't clash. Legacy un-prefixed
 * URLs are parsed and rewritten to the canonical form via replaceState.
 *
 * ## Router modes
 * - "hash" (host mode, default): behavior above — the URL hash IS the route.
 * - "memory" (injected mode): route lives in React state, seeded from the
 *   persisted snapshot; `navigate` updates state + notifies `onRouteChange` and
 *   NEVER reads or writes `location.hash`/history. Canonicalization still runs
 *   (via `buildHash` → `parseHashString`) so legacy/flow inference is identical,
 *   just against an in-memory string instead of the URL.
 */
type UseCanvasRouteOptions = {
  mode?: "hash" | "memory";
  /** Seed route for memory mode (from the persist blob), if any. */
  initialRoute?: CanvasRoute;
  /** Called with the canonical route whenever it changes (memory mode). */
  onRouteChange?: (route: CanvasRoute) => void;
};

/**
 * Memory (injected) mode reconcile: the route restored from the reload-persist
 * blob may still carry the branch the workbench was on BEFORE a proxy branch
 * switch reloaded the page (the blob flushes on pagehide, pre-switch). The
 * server's active branch is the truth there — returns the corrected route when
 * the persisted branch is stale, undefined when nothing needs to change. Hash
 * mode never reconciles: its URL branch is an explicit deep link that instead
 * drives an auto-switch (shouldAutoSwitchBranch in useWorktrees).
 */
function reconcileRouteBranch(
  route: CanvasRoute,
  currentBranch: string | undefined,
  memory: boolean,
): CanvasRoute | undefined {
  if (!memory || !currentBranch) return undefined;
  if (!route.branch || route.branch === currentBranch) return undefined;
  return { ...route, branch: currentBranch };
}

function useCanvasRoute(
  currentBranch: string | undefined,
  options: UseCanvasRouteOptions = {},
) {
  const { mode = "hash", initialRoute, onRouteChange } = options;
  const memory = mode === "memory";

  const [route, setRoute] = useState<CanvasRoute>(() =>
    memory ? (initialRoute ?? EMPTY_ROUTE) : parseHash(),
  );

  // Memory mode: snap a stale persisted branch to the live one — and persist
  // the correction — so a post-switch reload can't resurrect (or re-switch to)
  // the pre-switch branch.
  useEffect(() => {
    const next = reconcileRouteBranch(route, currentBranch, memory);
    if (next) {
      setRoute(next);
      onRouteChange?.(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconcile when the branches involved change
  }, [route, currentBranch, memory]);

  useEffect(() => {
    if (memory) return; // memory mode never listens to the URL
    function handleHashChange() {
      setRoute(parseHash());
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [memory]);

  useEffect(() => {
    if (memory) return; // memory mode never writes the URL
    const branch = route.branch ?? currentBranch;
    if (!branch) return;
    const canonical = `#${buildHash(branch, route.nodeIds, route.flowId, route.appPath, route.sandboxPinId)}`;
    if (window.location.hash !== canonical) {
      window.history.replaceState(null, "", canonical);
    }
  }, [currentBranch, route, memory]);

  function navigate(nextIds: string[], flowId?: string) {
    const branch = route.branch ?? currentBranch;
    const hash = buildHash(branch, nextIds, flowId);
    if (memory) {
      // Canonicalize the same way a hash round-trip would, then keep it in
      // memory — the app's URL is never touched.
      const next = parseHashString(hash);
      setRoute(next);
      onRouteChange?.(next);
      return;
    }
    window.location.hash = hash;
  }

  /** Navigate to the App page showing `path`. */
  function navigateApp(path: string) {
    const branch = route.branch ?? currentBranch;
    const hash = buildHash(branch, [], undefined, path);
    if (memory) {
      const next = parseHashString(hash);
      setRoute(next);
      onRouteChange?.(next);
      return;
    }
    window.location.hash = hash;
  }

  /** Navigate to the sandbox canvas focused on `pinId` (docs/specs/sandbox.md). */
  function navigateSandbox(pinId: string) {
    const branch = route.branch ?? currentBranch;
    const hash = buildHash(branch, [], undefined, undefined, pinId);
    if (memory) {
      const next = parseHashString(hash);
      setRoute(next);
      onRouteChange?.(next);
      return;
    }
    window.location.hash = hash;
  }

  return {
    branch: route.branch ?? currentBranch,
    urlBranch: route.branch,
    flowId: route.flowId,
    nodeIds: route.nodeIds,
    appPath: route.appPath,
    sandboxPinId: route.sandboxPinId,
    navigate,
    navigateApp,
    navigateSandbox,
  };
}

const EMPTY_ROUTE: CanvasRoute = {
  branch: undefined,
  flowId: undefined,
  nodeIds: [],
};

export { buildHash, parseHashString, reconcileRouteBranch, useCanvasRoute };
export type { CanvasRoute, UseCanvasRouteOptions };
