/**
 * The `catalog` model — the workbench's ROOT data model.
 *
 * `catalog` owns the compiled-config lifecycle: the component sets, the
 * flattened registry of entries, the flows, and the viewport presets. It is the
 * one place the rest of the UI reaches that config through, plus the `navigate`
 * action that drives canvas routing.
 *
 * ## Runtime-ready root (Michael 2026-07-07, decision 2)
 * The registry is built EAGERLY when `componentRegistry.ts` is imported (a
 * module singleton). `CatalogProvider` (live mode) reads that already-built
 * `registry` array — so by the time any catalog consumer mounts the config is
 * guaranteed ready. This is why the factory needs NO lazy-runtime thunk (unlike
 * the text model, whose adapter runtime initializes after its provider mounts):
 * catalog IS the thing that guarantees readiness, so downstream models/providers
 * can assume the config/registry is live when they mount.
 *
 * `createCatalogModel` is a pure factory (no React, no ambient globals): it
 * builds lookups over the `data` slices it is handed, identically for live use
 * (the provider passes the singletons) and fixture/cell/test use (the provider
 * passes `fixtures.ts`). The computed lookups reproduce the registry/flows
 * helper functions exactly (`find`/`filter` over the same arrays), so routing a
 * screen through the model is behavior-identical to calling the raw helper.
 */

import type { ComponentSet, Flow, FlowScreen, ViewportSize } from "@designbookapp/designbook/config";
import type { RegistryEntry } from "./componentRegistry";

/** The catalog navigation action. In live use the provider hosts
 * the route hook and supplies this itself; a no-op in fixture/cell mode. */
type CatalogNavigate = (nodeIds: string[], flowId?: string) => void;

/** The App-page navigation action. Live: the
 * provider's own route hook drives it; a no-op in fixture/cell mode. */
type CatalogNavigateApp = (path: string) => void;

/**
 * The canvas route the catalog OWNS. Live use fills these from
 * the provider-hosted `useCanvasRoute`; fixture/cell mode uses the empty route.
 * These are the read side of the same routing `navigate`/`navigateApp` drive.
 */
type CatalogRoute = {
  /** The effective branch (route branch, else the current worktree branch). */
  branch: string | undefined;
  /** The branch explicitly in the route/URL, if any (drives branch switching). */
  urlBranch: string | undefined;
  flowId: string | undefined;
  nodeIds: string[];
  /** App-page route; `undefined` for every non-app route. */
  appPath: string | undefined;
};

const EMPTY_ROUTE: CatalogRoute = {
  branch: undefined,
  urlBranch: undefined,
  flowId: undefined,
  nodeIds: [],
  appPath: undefined,
};

/**
 * The config-derived slices the model exposes. In live mode the provider fills
 * these from the eager singletons (`registry`, `flows`, `viewportSizes`,
 * `sets`); a fixture supplies its own canonical set (see `fixtures.ts`).
 */
type CatalogData = {
  sets: ComponentSet[];
  /** The flattened registry — every renderable component entry. */
  entries: RegistryEntry[];
  flows: Flow[];
  viewports: ViewportSize[];
};

/** The catalog model surface exposed on context and returned by the factory. */
type CatalogModel = CatalogData & CatalogRoute & {
  /** Registry entry by id (`set.key`), or undefined. Mirrors `getRegistryEntry`. */
  getEntry: (id: string) => RegistryEntry | undefined;
  /** Every entry in a set, in registry order. Mirrors `getSetEntries`. */
  getSetEntries: (setId: string) => RegistryEntry[];
  /** Flow by id. Mirrors `getFlowById`. */
  getFlow: (id: string) => Flow | undefined;
  /** The flow containing a given screen id. Mirrors `getFlowForScreen`. */
  getFlowForScreen: (screenId: string) => Flow | undefined;
  /** A flow screen by id, across all flows. Mirrors `getFlowScreen`. */
  getFlowScreen: (screenId: string) => FlowScreen | undefined;
  /** Synthesize a `FlowScreen` from a registry entry (a component's own page). */
  screenFor: (id: string) => FlowScreen | undefined;
  /** Canvas navigation. No-op in fixture/cell mode. */
  navigate: CatalogNavigate;
  /** App-page navigation. No-op in fixture/cell mode. */
  navigateApp: CatalogNavigateApp;
};

type CreateCatalogModelOptions = {
  /** The config slices (live singletons or fixtures) the lookups run over. */
  data: CatalogData;
  /** The current canvas route; omitted in fixture/cell mode (empty route). */
  route?: CatalogRoute;
  /** Live navigation action; omitted in fixture/cell mode (defaults to no-op). */
  navigate?: CatalogNavigate;
  /** Live App-page navigation; omitted in fixture/cell mode (no-op). */
  navigateApp?: CatalogNavigateApp;
};

const noopNavigate: CatalogNavigate = () => {};
const noopNavigateApp: CatalogNavigateApp = () => {};

/**
 * Build a catalog model. Pure — no React, no globals; all lookups run over the
 * supplied `data`. See the module doc for the live vs. fixture split.
 */
function createCatalogModel(options: CreateCatalogModelOptions): CatalogModel {
  const { sets, entries, flows, viewports } = options.data;
  const route = options.route ?? EMPTY_ROUTE;

  function getFlowScreen(screenId: string): FlowScreen | undefined {
    for (const flow of flows) {
      const screen = flow.screens.find((s) => s.id === screenId);
      if (screen) return screen;
    }
    return undefined;
  }

  function getEntry(id: string): RegistryEntry | undefined {
    return entries.find((entry) => entry.id === id);
  }

  return {
    sets,
    entries,
    flows,
    viewports,
    ...route,
    getEntry,
    getSetEntries: (setId) => entries.filter((entry) => entry.setId === setId),
    getFlow: (id) => flows.find((flow) => flow.id === id),
    getFlowForScreen: (screenId) =>
      flows.find((flow) => flow.screens.some((s) => s.id === screenId)),
    getFlowScreen,
    screenFor: (id) => {
      const entry = getEntry(id);
      if (!entry) return undefined;
      return {
        id: entry.id,
        label: entry.label,
        description: entry.sourcePath,
        registryId: entry.id,
      };
    },
    navigate: options.navigate ?? noopNavigate,
    navigateApp: options.navigateApp ?? noopNavigateApp,
  };
}

export { createCatalogModel, EMPTY_ROUTE };
export type {
  CatalogData,
  CatalogModel,
  CatalogNavigate,
  CatalogNavigateApp,
  CatalogRoute,
  CreateCatalogModelOptions,
};
