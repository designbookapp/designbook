/**
 * Public entry for the workbench as an embeddable library.
 *
 * `mountWorkbench` renders the full workbench (chrome + canvas) into a host
 * page using the host's React. It is called by:
 *   - the dev server bootstrap (src/ui/main.tsx), which feeds it the user
 *     config via `virtual:designbook-config`;
 *   - the C2.2 library consumer (`@designbookapp/designbook/ui`), which passes an inline
 *     config and its own container.
 *
 * The config flows in as a value (no `virtual:designbook-config` coupling): we
 * initialize the module-level config store first, THEN dynamically import the
 * App graph, so every module that reads config at evaluation time observes the
 * initialized values.
 *
 * ## Isolation
 * `isolation: "shadow"` mounts the chrome inside a shadow root so the host
 * page's css cannot restyle it and our css cannot leak out. Previewed user
 * components still render in the LIGHT DOM (via `LightDomSlot`) so the host
 * page's stylesheets reach them. The consumer supplies the chrome css through
 * `styles` (raw text of `@designbookapp/designbook/ui/style.css`, or a constructable
 * `CSSStyleSheet`) — it is injected ONLY into the shadow root, never the
 * document, so Tailwind preflight is contained.
 *
 * ## Overlay
 * `overlay: true` mounts into a fixed, full-viewport, top-layer host and
 * returns `expand()`/`collapse()`/`toggle()` on the handle (the injected toolbar drives
 * them). Collapsing hides the host without unmounting, so workbench React state
 * survives an expand/collapse cycle.
 */

import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesignbookConfig } from "@designbookapp/designbook/config";
import { initConfigStore } from "./designbook";
import { requestNavigate, requestNavigateApp } from "./navigationBus";
import { IsolationProvider, type IsolationAnchors } from "./isolationContext";
import "./index.css";

type IsolationMode = "none" | "shadow";

interface MountWorkbenchOptions {
  /** Element the workbench React tree renders into (or anchors, in overlay mode). */
  container: Element;
  /** The user's designbook config, as a value. */
  config: DesignbookConfig;
  /** Directory of the config file, relative to the project root. */
  configDir: string;
  /** Base URL of the designbook API server, when one is running. */
  serverUrl?: string;
  /**
   * Router mode. "hash" (default, host mode) drives `location.hash`
   * exactly as before. "memory" (injected mode) keeps route + UI state in
   * memory, mirrored to sessionStorage, and NEVER reads or writes the app's
   * URL — the plugin's boot module passes this so the workbench doesn't touch
   * the target app's routing.
   */
  routing?: "hash" | "memory";
  /**
   * DOM isolation for the chrome. "none" (default) renders directly into the
   * container as before. "shadow" seals the chrome in a shadow root and renders
   * previewed components into the light DOM.
   */
  isolation?: IsolationMode;
  /**
   * Mount into a fixed, full-viewport, top-layer host instead of laying out
   * inside the container. Starts collapsed-hidden only if `startCollapsed`.
   */
  overlay?: boolean;
  /** Start an overlay mount collapsed (hidden). Default false (expanded). */
  startCollapsed?: boolean;
  /**
   * Chrome css for shadow mode: the text of `@designbookapp/designbook/ui/style.css`, or a
   * ready `CSSStyleSheet`. Required for readable chrome under `isolation:
   * "shadow"`; ignored in "none" mode (the consumer links the stylesheet as
   * usual). Injected only into the shadow root.
   */
  styles?: string | CSSStyleSheet;
}

interface WorkbenchHandle {
  /** Unmount the workbench, tear down the shadow/overlay host, release the root. */
  unmount(): void;
  /** Show the overlay (no-op when not in overlay mode). */
  expand(): void;
  /** Hide the overlay without unmounting; state is preserved (no-op otherwise). */
  collapse(): void;
  /** Flip expanded/collapsed (no-op when not in overlay mode). */
  toggle(): void;
  /**
   * Navigate the workbench to a component entry (registry id, e.g.
   * "primitives.Island"). Drives the same in-tree routing the files panel uses;
   * used by the `/__designbook/component/<entryId>` deep link. Safe to call
   * before the workbench React tree has finished mounting (queued).
   */
  navigateTo(entryId: string): void;
  /**
   * Navigate the workbench to the App page showing a same-origin
   * live frame of `path`. Used by the boot module when a plain "expand" from
   * the page-tools strip (no component entry) should land on the App page
   * carrying the live page's `location.pathname + location.search`. Safe to
   * call before the workbench React tree has finished mounting (queued).
   */
  navigateToApp(path: string): void;
  /**
   * Enter PAGE MODE (M spec, M1): mount the page-tools layer (strip + live-page
   * select + chip + Pi drawer) into its own shadow host WITHOUT expanding the
   * canvas overlay. Reuses this mount's single config store, so the canvas
   * `expand()` still works alongside. No-op when styles/overlay aren't available
   * (host mode never calls this). Idempotent.
   */
  openPageTools(callbacks: PageToolsCallbacks): void;
  /** Tear down the page-tools layer (leaves the canvas overlay untouched). */
  closePageTools(): void;
  /** Whether this mount is an overlay. */
  readonly isOverlay: boolean;
  /** The outermost host element created for this mount. */
  readonly host: HTMLElement | Element;
}

interface PageToolsCallbacks {
  /** Open the full canvas, navigating to a component entry first when given. */
  onExpandCanvas: (entryId?: string) => void;
  /** Restore the pill (page tools fully dismissed). */
  onClose: () => void;
}

const OVERLAY_Z = 2147483000;

/**
 * Build (or reuse) a constructable stylesheet from raw css text for shadow-root
 * injection. Bare `:root` selectors (where the shadcn theme declares its design
 * tokens) do NOT match inside a shadow root, so the tokens would resolve to
 * nothing and the chrome would render unstyled. We remap `:root` → `:host` so
 * the tokens land on the shadow host and inherit into the chrome. A consumer
 * that passes a ready `CSSStyleSheet` is assumed to have handled this already.
 */
function toStyleSheet(styles: string | CSSStyleSheet): CSSStyleSheet {
  if (styles instanceof CSSStyleSheet) return styles;
  const remapped = styles.replace(/:root\b/g, ":host");
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(remapped);

  // Slotted light-DOM cells inherit inherited properties — including CSS custom
  // properties — from their position in the SHADOW flattened tree, i.e. from our
  // chrome, not from the host page. So a previewed component that reads a token
  // the host app leaves undefined (e.g. excalidraw's `var(--font-family)`) would
  // silently pick up OUR chrome value. Reset every chrome token to `initial` on
  // slotted cells so they see the host page's cascade, not ours; the component's
  // own wrapper/host styles still set whatever it legitimately defines.
  const tokens = [...new Set(remapped.match(/--[\w-]+(?=\s*:)/g) ?? [])];
  if (tokens.length) {
    const reset = tokens.map((name) => `${name}:initial`).join(";");
    sheet.insertRule(
      `::slotted([slot^="db-cell-"]){${reset}}`,
      sheet.cssRules.length,
    );
  }
  return sheet;
}

function mountWorkbench(options: MountWorkbenchOptions): WorkbenchHandle {
  const {
    container,
    config,
    configDir,
    serverUrl,
    routing = "hash",
    isolation = "none",
    overlay = false,
    startCollapsed = false,
    styles,
  } = options;

  initConfigStore(config, configDir, serverUrl, routing);
  document.title = config.title ?? "Designbook";

  // ---- Host element (fixed overlay host, or the container itself) ---------
  let overlayHost: HTMLDivElement | null = null;
  if (overlay) {
    overlayHost = document.createElement("div");
    overlayHost.dataset.designbookOverlay = "";
    overlayHost.style.cssText = `position:fixed;inset:0;z-index:${OVERLAY_Z};display:${
      startCollapsed ? "none" : "block"
    };`;
    document.body.appendChild(overlayHost);
  }
  const host: HTMLElement = overlayHost ?? (container as HTMLElement);

  // ---- Isolation anchors + render target ----------------------------------
  let renderTarget: Element = host;
  const anchors: IsolationAnchors = { portalContainer: null, lightHost: null };

  if (isolation === "shadow") {
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    if (styles) {
      shadow.adoptedStyleSheets = [
        ...shadow.adoptedStyleSheets,
        toStyleSheet(styles),
      ];
    }
    // React chrome root inside the shadow root; fill the host.
    const mountEl = document.createElement("div");
    mountEl.style.cssText = "width:100%;height:100%;";
    shadow.appendChild(mountEl);
    // Radix portals (dropdowns/selects) target this element so their floating
    // layers stay inside the shadow root and keep the chrome css.
    const portalContainer = document.createElement("div");
    portalContainer.dataset.designbookPortalLayer = "";
    shadow.appendChild(portalContainer);

    renderTarget = mountEl;
    anchors.portalContainer = portalContainer;
    // Previewed components mount as slotted light-DOM children of the host.
    anchors.lightHost = host;
  }

  let root: Root | null = null;
  let disposed = false;

  void (async () => {
    // Dynamic imports: these module graphs read the config store at evaluation
    // time, so they must not evaluate until initConfigStore has run above.
    const [{ WorkbenchRoot }, { loadAdapterRuntime }] = await Promise.all([
      import("./WorkbenchRoot"),
      import("./adapterRuntime"),
    ]);
    if (disposed) return;

    const runtime = await loadAdapterRuntime();
    if (disposed) return;

    root = createRoot(renderTarget);
    root.render(
      <StrictMode>
        <IsolationProvider anchors={anchors}>
          <WorkbenchRoot runtime={runtime} />
        </IsolationProvider>
      </StrictMode>,
    );
  })();

  function setOverlayVisible(visible: boolean) {
    if (overlayHost) overlayHost.style.display = visible ? "block" : "none";
  }

  // ---- Page-tools layer: own shadow host, independent of overlay -----
  // Lives above the canvas overlay tier so it stays usable while the overlay is
  // collapsed. Its host is `pointer-events: none`; only its chrome (and the
  // armed select capture layer) opt back in, so the app stays interactive.
  let pageToolsHost: HTMLDivElement | null = null;
  let pageToolsRoot: Root | null = null;

  function openPageTools(callbacks: PageToolsCallbacks): void {
    if (pageToolsHost || disposed) return; // idempotent / post-unmount guard
    const ptHost = document.createElement("div");
    ptHost.dataset.designbookPageTools = "";
    ptHost.style.cssText = `position:fixed;inset:0;z-index:${OVERLAY_Z + 1};pointer-events:none;`;
    document.body.appendChild(ptHost);
    pageToolsHost = ptHost;

    const shadow = ptHost.attachShadow({ mode: "open" });
    if (styles) {
      shadow.adoptedStyleSheets = [
        ...shadow.adoptedStyleSheets,
        toStyleSheet(styles),
      ];
    }
    const mountEl = document.createElement("div");
    mountEl.style.cssText = "pointer-events:none;";
    shadow.appendChild(mountEl);
    const portalContainer = document.createElement("div");
    portalContainer.dataset.designbookPortalLayer = "";
    shadow.appendChild(portalContainer);
    const ptAnchors: IsolationAnchors = { portalContainer, lightHost: null };

    const ptRoot = createRoot(mountEl);
    pageToolsRoot = ptRoot;

    void import("./screens/pageTools/PageTools").then(({ PageTools }) => {
      if (pageToolsRoot !== ptRoot) return; // closed before load resolved
      ptRoot.render(
        <StrictMode>
          <IsolationProvider anchors={ptAnchors}>
            <PageTools
              hostEl={ptHost}
              onExpandCanvas={callbacks.onExpandCanvas}
              onClose={callbacks.onClose}
            />
          </IsolationProvider>
        </StrictMode>,
      );
    });
  }

  function closePageTools(): void {
    pageToolsRoot?.unmount();
    pageToolsRoot = null;
    pageToolsHost?.remove();
    pageToolsHost = null;
  }

  return {
    isOverlay: overlay,
    host,
    openPageTools,
    closePageTools,
    expand() {
      setOverlayVisible(true);
    },
    collapse() {
      setOverlayVisible(false);
    },
    toggle() {
      if (overlayHost) setOverlayVisible(overlayHost.style.display === "none");
    },
    navigateTo(entryId: string) {
      requestNavigate(entryId);
    },
    navigateToApp(path: string) {
      requestNavigateApp(path);
    },
    unmount() {
      disposed = true;
      closePageTools();
      root?.unmount();
      root = null;
      overlayHost?.remove();
    },
  };
}

export { mountWorkbench };
export type {
  MountWorkbenchOptions,
  PageToolsCallbacks,
  WorkbenchHandle,
  IsolationMode,
};
