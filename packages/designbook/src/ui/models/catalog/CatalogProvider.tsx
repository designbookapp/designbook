/**
 * React binding for the `catalog` model.
 *
 * `CatalogProvider` builds a `CatalogModel` (see catalogModel.ts) and puts it on
 * context so the workbench screens read the config slices + route + `navigate`
 * action declaratively. Two modes:
 *
 *   - LIVE (no `data`): the provider HOSTS the canvas route hook
 *     (`useCanvasRoute`) — so the catalog OWNS the route state and the
 *     `navigate`/`navigateApp` actions, rather
 *     than having them injected from `Workbench`'s composition root. It reads
 *     the eager config singletons (`registry`, `flows`, `viewportSizes`, `sets`)
 *     and takes only the route hook's *inputs* (current branch, router mode,
 *     seed route, persist callback) — the coupling that genuinely crosses the
 *     branch/persist boundary.
 *   - DATA (fixtures / canvas cells / tests): pass `data` (fixture slices);
 *     `navigate`/`navigateApp` are optional injected spies, route is empty. No
 *     route hook runs, so a cell never touches `location.hash`.
 *
 * Importing this module transitively imports `componentRegistry`, which builds
 * the registry EAGERLY — so the "catalog is the runtime-ready root" guarantee
 * (decision 2) holds by construction: any consumer under this provider sees a
 * fully-built config with no lazy thunk.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { sets } from "@designbook-ui/designbook";
import { registry } from "./componentRegistry";
import { flows } from "./flows";
import { viewportSizes } from "./viewports";
import {
  createCatalogModel,
  type CatalogData,
  type CatalogModel,
  type CatalogNavigate,
  type CatalogNavigateApp,
} from "./catalogModel";
import { useCanvasRoute, type CanvasRoute } from "./useCanvasRoute";

const CatalogModelContext = createContext<CatalogModel | null>(null);

type CatalogProviderProps = {
  /** Fixture slices for tests/cells; when set, the live singletons + route hook
   * are NOT used (DATA mode). */
  data?: CatalogData;
  /** Injected navigation spy for DATA mode (cells/tests); ignored when live. */
  navigate?: CatalogNavigate;
  /** Injected App-page navigation spy for DATA mode; ignored when live. */
  navigateApp?: CatalogNavigateApp;
  // ---- LIVE-mode route inputs (ignored in DATA mode) ---------------------
  /** The current worktree branch — the route hook's fallback branch. */
  currentBranch?: string;
  /** Router mode: "hash" (host) drives `location.hash`; "memory" (injected). */
  routeMode?: "hash" | "memory";
  /** Seed route for memory mode (from the persist blob), if any. */
  initialRoute?: CanvasRoute;
  /** Called with the canonical route whenever it changes (memory mode persist). */
  onRouteChange?: (route: CanvasRoute) => void;
  children: ReactNode;
};

/** The live config slices, collected from the eager singletons (decision 2). */
function liveCatalogData(): CatalogData {
  return { sets, entries: registry, flows, viewports: viewportSizes };
}

/** DATA mode: fixtures/cells/tests. Static slices + optional injected actions;
 * empty route, no route hook (so cells never touch the URL). */
function CatalogDataProvider({
  data,
  navigate,
  navigateApp,
  children,
}: {
  data: CatalogData;
  navigate?: CatalogNavigate;
  navigateApp?: CatalogNavigateApp;
  children: ReactNode;
}) {
  const model = useMemo(
    () => createCatalogModel({ data, navigate, navigateApp }),
    [data, navigate, navigateApp],
  );
  return (
    <CatalogModelContext.Provider value={model}>
      {children}
    </CatalogModelContext.Provider>
  );
}

/** LIVE mode: the catalog OWNS the canvas route. Hosts
 * `useCanvasRoute`, exposing its route reads + `navigate`/`navigateApp` on the
 * model, so no navigation action is injected from `Workbench`. */
function CatalogLiveProvider({
  currentBranch,
  routeMode = "hash",
  initialRoute,
  onRouteChange,
  children,
}: Omit<CatalogProviderProps, "data" | "navigate" | "navigateApp">) {
  const {
    branch,
    urlBranch,
    flowId,
    nodeIds,
    appPath,
    sandboxPinId,
    navigate,
    navigateApp,
    navigateSandbox,
  } = useCanvasRoute(currentBranch, {
    mode: routeMode,
    initialRoute,
    onRouteChange,
  });
  const model = useMemo(
    () =>
      createCatalogModel({
        data: liveCatalogData(),
        route: { branch, urlBranch, flowId, nodeIds, appPath, sandboxPinId },
        navigate,
        navigateApp,
        navigateSandbox,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- route scalars + actions
    [
      branch,
      urlBranch,
      flowId,
      nodeIds,
      appPath,
      sandboxPinId,
      navigate,
      navigateApp,
      navigateSandbox,
    ],
  );
  return (
    <CatalogModelContext.Provider value={model}>
      {children}
    </CatalogModelContext.Provider>
  );
}

function CatalogProvider(props: CatalogProviderProps) {
  // `data` presence is stable per usage (cells always pass it, the workbench
  // never does), so switching component identity on it is safe.
  if (props.data) {
    return (
      <CatalogDataProvider
        data={props.data}
        navigate={props.navigate}
        navigateApp={props.navigateApp}
      >
        {props.children}
      </CatalogDataProvider>
    );
  }
  return (
    <CatalogLiveProvider
      currentBranch={props.currentBranch}
      routeMode={props.routeMode}
      initialRoute={props.initialRoute}
      onRouteChange={props.onRouteChange}
    >
      {props.children}
    </CatalogLiveProvider>
  );
}

/** Read the catalog model from context; throws if used outside a provider. */
function useCatalogModel(): CatalogModel {
  const model = useContext(CatalogModelContext);
  if (!model) {
    throw new Error("useCatalogModel must be used within a <CatalogProvider>.");
  }
  return model;
}

export { CatalogProvider, useCatalogModel, CatalogModelContext };
export type { CatalogProviderProps };
