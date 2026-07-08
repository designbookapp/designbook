/**
 * React binding for the `frame` model.
 *
 * `FrameProvider` builds a `FrameModel` (see frameModel.ts) and puts it on
 * context so the App page + its tool overlays (`AppFrameOverlay`,
 * `AppFrameTextOverlay`) reach the live iframe handle + route ops declaratively.
 * It is provided once, above both `AppPage` and `CanvasStage`'s overlay slot, in
 * `Workbench` (they are siblings — the iframe element can't be threaded down as
 * a prop; see the module doc on frameModel.ts). Two modes:
 *
 *   - LIVE (no `data`): the provider OWNS the frame state — the iframe element,
 *     the generation counter, and the `ignoreNextNavigation` reload latch — and
 *     reads the catalog route's `navigateApp` for `open`. Nothing is injected
 *     from `Workbench` except `onFrameNavigated` (the tool/selection reset a
 *     real navigation triggers, which is Workbench-owned tool state — a genuine
 *     seam). The App page reports its `<iframe>` and `load` events by calling
 *     `setIframe`/`notifyNavigated` on this model.
 *   - DATA (fixtures / canvas cells / tests): pass `data` (+ optional injected
 *     `open`/`ignoreNextNavigation` spies); a static handle, no live state.
 *
 * Supersedes the former `AppFrameContext`.
 */

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CatalogModelContext } from "@designbook-ui/models/catalog/CatalogProvider";
import { DEFAULT_APP_PATH } from "./appFrame";
import {
  createFrameModel,
  type FrameData,
  type FrameModel,
  type FrameOpen,
} from "./frameModel";

/** Stable empty model for overlays that render before the App page provides one
 * (mirrors the old `AppFrameContext`'s default value — never throws). */
const EMPTY_MODEL = createFrameModel();

const FrameModelContext = createContext<FrameModel>(EMPTY_MODEL);

type FrameProviderProps = {
  /** Fixture data for cells/tests; when set, the provider is in DATA mode. */
  data?: FrameData;
  /** Injected navigate spy for DATA mode (cells/tests); ignored when live. */
  open?: FrameOpen;
  /** Injected reload-latch spy for DATA mode; ignored when live. */
  ignoreNextNavigation?: () => void;
  /** LIVE: tool/selection reset a real frame navigation triggers (Workbench's
   * tool state — a seam). Ignored in DATA mode. */
  onFrameNavigated?: () => void;
  children: ReactNode;
};

/** DATA mode: cells/tests. Static handle + optional injected spies. */
function FrameDataProvider({
  data,
  open,
  ignoreNextNavigation,
  children,
}: {
  data: FrameData;
  open?: FrameOpen;
  ignoreNextNavigation?: () => void;
  children: ReactNode;
}) {
  const model = useMemo(
    () => createFrameModel({ data, open, ignoreNextNavigation }),
    [data, open, ignoreNextNavigation],
  );
  return (
    <FrameModelContext.Provider value={model}>
      {children}
    </FrameModelContext.Provider>
  );
}

/** LIVE mode: the frame OWNS its handle state. Holds the iframe
 * element + generation + reload latch, and reads the catalog route for `open`
 * (the app path it shows, and `navigateApp`). */
function FrameLiveProvider({
  onFrameNavigated,
  children,
}: {
  onFrameNavigated?: () => void;
  children: ReactNode;
}) {
  // Read the catalog route directly (this provider lives under CatalogProvider
  // in the live tree). `useContext` — not `useCatalogModel` — so a stray render
  // outside a catalog degrades to defaults instead of throwing.
  const catalog = useContext(CatalogModelContext);
  const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);
  const [generation, setGeneration] = useState(0);
  // The reload latch: set by the text tool before its self-triggered reload so
  // `notifyNavigated` doesn't disarm the very tool the reload is FOR.
  const ignoreNextRef = useRef(false);

  const navigateApp = catalog?.navigateApp;
  const appPath = catalog?.appPath;

  const model = useMemo(
    () =>
      createFrameModel({
        data: { iframe, generation, path: appPath ?? DEFAULT_APP_PATH },
        open: navigateApp,
        ignoreNextNavigation: () => {
          ignoreNextRef.current = true;
        },
        setIframe,
        notifyNavigated: () => {
          setGeneration((g) => g + 1);
          if (ignoreNextRef.current) {
            ignoreNextRef.current = false;
            return;
          }
          onFrameNavigated?.();
        },
      }),
    [iframe, generation, appPath, navigateApp, onFrameNavigated],
  );
  return (
    <FrameModelContext.Provider value={model}>
      {children}
    </FrameModelContext.Provider>
  );
}

function FrameProvider(props: FrameProviderProps) {
  // `data` presence is stable per usage (cells always pass it, the workbench
  // never does), so switching component identity on it is safe.
  if (props.data) {
    return (
      <FrameDataProvider
        data={props.data}
        open={props.open}
        ignoreNextNavigation={props.ignoreNextNavigation}
      >
        {props.children}
      </FrameDataProvider>
    );
  }
  return (
    <FrameLiveProvider onFrameNavigated={props.onFrameNavigated}>
      {props.children}
    </FrameLiveProvider>
  );
}

/** Read the frame model from context; outside a provider this is the stable
 * empty (no-iframe) model, so an overlay that mounts before the App page
 * degrades to "no frame yet" rather than throwing (mirrors the old
 * `AppFrameContext`'s default value). */
function useFrameModel(): FrameModel {
  return useContext(FrameModelContext);
}

export { FrameProvider, useFrameModel, FrameModelContext };
export type { FrameProviderProps };
