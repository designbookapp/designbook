import { useEffect, useRef, useState, type ReactNode } from "react";
import { CHAT_PROMPT_INPUT_ID, DesignChat } from "@designbook-ui/screens/DesignChat";
import {
  configDir,
  datasets as previewDatasets,
  providers,
  routing,
} from "@designbook-ui/designbook";
import {
  WorkbenchPersist,
  encodeSelection,
  type SelectionSnapshot,
} from "@designbook-ui/workbenchPersist";
import { cn } from "@designbook-ui/lib/utils";
import { BranchSelector } from "./BranchSelector";
import { useWorktrees } from "@designbook-ui/models/branch/useWorktrees";
import { BranchProvider } from "@designbook-ui/models/branch/BranchProvider";
import { useChanges } from "@designbook-ui/models/branch/useChanges";
import { ChangesProvider } from "@designbook-ui/models/branch/ChangesProvider";
import { CanvasToolbar, type CanvasTool } from "./CanvasToolbar";
import { CanvasSettingsBar, ViewportPicker } from "./CanvasSettings";
import { CANVAS_THEME_CLASS, themeOptions, useCanvasTheme } from "@designbook-ui/models/configState/themes";
import { ConfigStateProvider } from "@designbook-ui/models/configState/ConfigStateProvider";
import { getAdapterRuntime, useAdapterSnapshot } from "@designbook-ui/adapterRuntime";
import { viewportSizes, type ViewportSize } from "@designbook-ui/models/catalog/viewports";
import { DatasetContext } from "@designbook-ui/models/configState/datasetContext";
import { CanvasStage } from "./CanvasStage";
import {
  CanvasOverlay,
  canvasHitLabel,
  type CanvasHitResult,
} from "./CanvasOverlay";
import { TextToolOverlay } from "./TextToolOverlay";
import { FlowCanvas } from "./FlowCanvas";
import {
  NodeDetailHeader,
  NodeDetailView,
  type DetailLayout,
} from "./NodeDetailView";
import { AppPage } from "./AppPage";
import { DEFAULT_APP_PATH } from "@designbook-ui/models/frame/appFrame";
import { FrameProvider } from "@designbook-ui/models/frame/FrameProvider";
import { AppFrameOverlay } from "./AppFrameOverlay";
import { AppFrameTextOverlay } from "./AppFrameTextOverlay";
import { buildFramePromptPrefill } from "@designbook-ui/models/frame/appFrameHit";
import { SideRail, type PanelTab } from "@designbook-ui/components/SideRail";
import { RightPanel } from "@designbook-ui/components/RightPanel";
import { PanelResizeHandle } from "@designbook-ui/components/PanelResizeHandle";
import { initialPanelWidth } from "@designbook-ui/panelResize";
import {
  resolveInitialTabs,
  type RightPanelTab,
} from "@designbook-ui/workbenchTabs";
import { CodePanel } from "./panels";
import { ChangesPanel } from "./ChangesPanel";
import { AdapterPanel } from "./AdapterPanel";
import { FigmaPanel } from "./FigmaPanel";
import { FilesPanel } from "./FilesPanel";
import { PropsPanel } from "./PropsPanel";
import { flows, getFlowForScreen, getFlowScreen } from "@designbook-ui/models/catalog/flows";
import type { FlowScreen } from "@designbook-ui/models/catalog/flowSpec";
import { getRegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";
import { resolveEscape } from "@designbook-ui/previewHost";
import {
  onNavigate,
  onNavigateApp,
  takePendingNavigate,
  takePendingNavigateApp,
} from "@designbook-ui/navigationBus";
import { CatalogProvider, useCatalogModel } from "@designbook-ui/models/catalog/CatalogProvider";
import { SelectionProvider } from "@designbook-ui/models/selection/SelectionProvider";
import type { CanvasNodeSelection } from "@designbook-ui/types";

const copy = {
  retryButton: "Retry",
};

/** Wraps the canvas content in the context providers from the user's config. */
function CanvasProviders({ children }: { children: ReactNode }) {
  return providers.reduceRight<ReactNode>(
    (wrapped, Provider) => <Provider>{wrapped}</Provider>,
    children,
  );
}

function screenFromRegistry(id: string): FlowScreen | undefined {
  const entry = getRegistryEntry(id);
  if (!entry) return undefined;
  return {
    id: entry.id,
    label: entry.label,
    description: entry.sourcePath,
    registryId: entry.id,
  };
}

function resolveScreenPath(ids: string[]): FlowScreen[] | undefined {
  const path: FlowScreen[] = [];
  for (const id of ids) {
    const screen = getFlowScreen(id) ?? screenFromRegistry(id);
    if (!screen) return undefined;
    path.push(screen);
  }
  return path.length > 0 ? path : undefined;
}

/** Reload-rehydration store. Created once; disabled (inert) in host mode
 * so hash routing is byte-identical and nothing touches sessionStorage. */
function usePersist(): WorkbenchPersist {
  const ref = useRef<WorkbenchPersist>(undefined);
  if (!ref.current) {
    ref.current = new WorkbenchPersist(configDir, routing === "memory");
  }
  useEffect(() => {
    const controller = ref.current!;
    if (!controller.enabled) return;
    // Flush synchronously before the page goes away (reload / navigation), so
    // the boot module's deferred reload and a manual F5 both persist the latest
    // state. StrictMode re-runs this effect; that's fine — same controller.
    const flush = () => controller.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") controller.flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("visibilitychange", onVisibility);
      controller.flush();
    };
  }, []);
  return ref.current;
}

/**
 * The workbench COMPOSITION ROOT. It owns only the pieces that
 * genuinely cross a boundary the catalog can't: the reload-persist store and
 * the worktree/branch state (which the route depends on). It hands those to
 * `CatalogProvider` (live mode), which OWNS the canvas route + `navigate`/
 * `navigateApp` actions, and renders the rest of the workbench inside it.
 */
function Workbench() {
  const persist = usePersist();
  const worktrees = useWorktrees();
  const init = persist.initial;

  return (
    <CatalogProvider
      currentBranch={worktrees.currentBranch}
      routeMode={routing === "memory" ? "memory" : "hash"}
      initialRoute={
        init.route
          ? {
              branch: init.route.branch,
              flowId: init.route.flowId,
              nodeIds: init.route.nodeIds,
              appPath: init.route.appPath,
            }
          : undefined
      }
      onRouteChange={(route) =>
        persist.update({
          route: {
            branch: route.branch,
            flowId: route.flowId,
            nodeIds: route.nodeIds,
            appPath: route.appPath,
          },
        })
      }
    >
      <WorkbenchContent persist={persist} worktrees={worktrees} />
    </CatalogProvider>
  );
}

/** The workbench body — reads the route (+ `navigate`/`navigateApp`) from the
 * catalog model rather than hosting the route hook itself. */
function WorkbenchContent({
  persist,
  worktrees: worktreesState,
}: {
  persist: WorkbenchPersist;
  worktrees: ReturnType<typeof useWorktrees>;
}) {
  const init = persist.initial;
  const {
    currentBranch,
    error,
    loaded: worktreesLoaded,
    retry,
    switchBranch,
    switching,
    worktrees,
  } = worktreesState;

  // The catalog OWNS the route now: read it declaratively.
  const { urlBranch, flowId, nodeIds, appPath, navigate, navigateApp } =
    useCatalogModel();

  // Left/right tab split (+ migration of pre-split blobs) — workbenchTabs.ts.
  const initialTabs = resolveInitialTabs(init.activeTab, init.rightTab);
  const [activeTab, setActiveTab] = useState<PanelTab>(() => initialTabs.left);
  const [rightTab, setRightTab] = useState<RightPanelTab>(
    () => initialTabs.right,
  );
  const [rightCollapsed, setRightCollapsed] = useState(
    () => init.rightCollapsed ?? false,
  );
  // Side-panel widths (resize handles). Seeded from the persist blob and
  // clamped, so a stale value can't render an unusable panel. A collapsed
  // right panel keeps its stored width for the next expand.
  const [leftWidth, setLeftWidth] = useState(() =>
    initialPanelWidth(init.leftWidth),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    initialPanelWidth(init.rightWidth),
  );
  // While a handle drag is live, the canvas (which hosts iframes that would
  // swallow pointermove) is pointer-events-disabled and text selection is off.
  const [panelResizing, setPanelResizing] = useState(false);
  const [tool, setTool] = useState<CanvasTool>(
    () => (init.tool as CanvasTool | null) ?? "preview",
  );

  /** Reveals a right-panel tab (a collapsed panel would swallow the switch). */
  function openRightTab(tab: RightPanelTab) {
    setRightTab(tab);
    setRightCollapsed(false);
  }

  // Changes tab (Changes tab MVP): live changed-files state at the composition
  // root (same altitude as useWorktrees), plus the Code-tab diff override —
  // a Changes row / canvas change badge opens THIS file's diff, which wins
  // over the canvas selection until the user selects something new.
  const changesState = useChanges({ active: activeTab === "changes" });
  const [diffFile, setDiffFile] = useState<string>();

  /** Open a changed file's diff in the RHS Code tab. */
  function openDiff(path: string) {
    setDiffFile(path);
    openRightTab("code");
  }

  /** Drafts a prompt into the chat tab's input WITHOUT sending it (Figma pull
   * handoff) — the user's send click is the confirm gate. Reveals the chat
   * tab and focuses the textarea once it has rendered. */
  function draftPromptToChat(promptText: string) {
    setChatDraft(promptText);
    openRightTab("chat");
    // The discrete click flushes the tab switch synchronously, so by the next
    // frame the chat input exists even if the tab was collapsed or inactive.
    requestAnimationFrame(() => {
      document.getElementById(CHAT_PROMPT_INPUT_ID)?.focus();
    });
  }

  // App page is injected-mode only — host mode never resolves an
  // app route even if one is somehow in the (hash) URL.
  const showAppPage = routing === "memory" && appPath !== undefined;

  // Write-through of the simple scalar UI state. Each effect also fires on
  // mount, harmlessly re-writing the value it was seeded with (StrictMode's
  // double-mount is therefore idempotent — no transient state is persisted).
  useEffect(() => {
    persist.update({ activeTab });
  }, [persist, activeTab]);
  useEffect(() => {
    persist.update({ rightTab });
  }, [persist, rightTab]);
  useEffect(() => {
    persist.update({ rightCollapsed });
  }, [persist, rightCollapsed]);
  useEffect(() => {
    persist.update({ leftWidth });
  }, [persist, leftWidth]);
  useEffect(() => {
    persist.update({ rightWidth });
  }, [persist, rightWidth]);
  useEffect(() => {
    persist.update({ tool });
  }, [persist, tool]);

  const activeFlow =
    flows.find((f) => f.id === flowId) ??
    (nodeIds.length > 0 ? getFlowForScreen(nodeIds[0]) : undefined) ??
    flows[0];

  useEffect(() => {
    if (urlBranch && currentBranch && urlBranch !== currentBranch) {
      void switchBranch(urlBranch, nodeIds, flowId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when the branches involved change
  }, [urlBranch, currentBranch]);

  const [nodeLayouts, setNodeLayouts] = useState<Record<string, DetailLayout>>(
    {},
  );
  const adapterRuntime = getAdapterRuntime();
  const { context: contextState, follow } = useAdapterSnapshot();
  // Host-context follow (C4.3): re-read app sources when this view mounts (so a
  // re-expand reflects an external change) and, for sources without a
  // `subscribe`, poll while open.
  useEffect(() => {
    adapterRuntime.refreshHostContext();
    if (!adapterRuntime.needsFollowPolling) return;
    const timer = window.setInterval(
      () => adapterRuntime.refreshHostContext(),
      2000,
    );
    return () => window.clearInterval(timer);
  }, [adapterRuntime]);
  const activeAdapterTab = adapterRuntime.tabs.find(
    (tab) => tab.id === activeTab,
  );
  const [themeId, setThemeId] = useState(
    () => init.themeId ?? themeOptions[0]?.id ?? "",
  );
  useCanvasTheme(themeId);
  useEffect(() => {
    persist.update({ themeId });
  }, [persist, themeId]);
  // A theme adapter's `mode` dimension is the source of truth for light/dark
  // when present; otherwise fall back to a standalone local toggle.
  const modeDimension = adapterRuntime.dimensions.find((dimension) =>
    dimension.id.endsWith(":mode"),
  );
  // A theme adapter's `variant` dimension (the "Theme" selector) replaces the
  // standalone `themes` preset Select when present.
  const variantDimension = adapterRuntime.dimensions.find((dimension) =>
    dimension.id.endsWith(":variant"),
  );
  const [localDarkMode, setLocalDarkMode] = useState(() => init.darkMode ?? false);
  useEffect(() => {
    persist.update({ darkMode: localDarkMode });
  }, [persist, localDarkMode]);
  const darkMode = modeDimension
    ? (contextState[modeDimension.id] ?? modeDimension.defaultValue) === "dark"
    : localDarkMode;
  function toggleDarkMode() {
    if (modeDimension) {
      adapterRuntime.setContext(modeDimension.id, darkMode ? "light" : "dark");
    } else {
      setLocalDarkMode((current) => !current);
    }
  }
  const previewThemeClass = cn(CANVAS_THEME_CLASS, darkMode && "dark");
  const [viewport, setViewport] = useState<ViewportSize>(viewportSizes[0]);
  const [datasetId, setDatasetId] = useState(
    () =>
      (init.datasetId &&
        previewDatasets.some((candidate) => candidate.id === init.datasetId) &&
        init.datasetId) ||
      previewDatasets[0].id,
  );
  useEffect(() => {
    persist.update({ datasetId });
  }, [persist, datasetId]);
  const dataset =
    previewDatasets.find((candidate) => candidate.id === datasetId) ??
    previewDatasets[0];

  // Chat prompt draft — controlled so it survives a reload.
  const [chatDraft, setChatDraft] = useState(() => init.chatDraft);
  useEffect(() => {
    persist.update({ chatDraft });
  }, [persist, chatDraft]);

  const [selectedHit, setSelectedHit] = useState<CanvasHitResult | undefined>();
  const [drillStack, setDrillStack] = useState<CanvasHitResult[]>([]);

  // The App page's live iframe handle (element + generation + reload latch) is
  // owned by `FrameProvider` now. All that remains here is the
  // TOOL/SELECTION reset a real frame navigation triggers — Workbench-owned tool
  // state — handed to the provider as `onFrameNavigated` (a seam). The reload
  // latch (set by the text tool via the frame model's `ignoreNextNavigation`)
  // suppresses this on a self-triggered re-mark, inside the provider.
  function resetToolsOnFrameNavigation() {
    setSelectedHit(undefined);
    setDrillStack([]);
    setTool("preview");
  }
  // A persisted selection to replay after the entry renders. Blocks
  // selection write-through until CanvasOverlay has restored (or dropped) it,
  // so the initial empty selection can't clobber what we're about to restore.
  const [pendingSelection, setPendingSelection] = useState<
    SelectionSnapshot | undefined
  >(() => init.selection ?? undefined);
  const [selectedScreenId, setSelectedScreenId] = useState<
    string | undefined
  >();
  /** Code-panel context set by "Go to component": the target component's
   * definition, shown until a real canvas selection replaces it. Not a
   * canvas hit — the go-to navigation remounts the stage, so a hit rect
   * from the previous page would draw a stale selection box. */
  const [goToSelection, setGoToSelection] = useState<
    CanvasNodeSelection | undefined
  >();

  const nodePath = nodeIds.length > 0 ? resolveScreenPath(nodeIds) : undefined;
  const routeKey = showAppPage ? "app" : nodeIds.join("/");

  // Persist the canvas selection as a durable structural address. Held
  // off until any pending restore is consumed so we don't overwrite it with the
  // initial empty selection.
  useEffect(() => {
    if (!persist.enabled || pendingSelection) return;
    persist.update({
      selection: selectedHit
        ? encodeSelection(
            selectedHit.anchor,
            selectedHit.kind,
            selectedHit.entry.id,
            selectedHit.name,
            drillStack.length,
          )
        : null,
    });
  }, [persist, pendingSelection, selectedHit, drillStack]);

  const selectedFlowScreen = selectedScreenId
    ? getFlowScreen(selectedScreenId)
    : undefined;

  // codeTarget presence is decided when the hit is built (see codeTargets.ts):
  // only the outermost chain level lacks one, so a fresh click shows the
  // component's definition while every drilled selection highlights its JSX
  // usage site in the owner's file — no separate drill-state check needed.
  const selection: CanvasNodeSelection | undefined = selectedHit
    ? {
        label: canvasHitLabel(selectedHit),
        description: selectedHit.dom
          ? `${selectedHit.dom.tag} inside ${selectedHit.entry.label}`
          : selectedHit.entry.sourcePath,
        exportName: selectedHit.entry.key,
        path: selectedHit.entry.sourcePath,
        dom: selectedHit.dom,
        codeTarget: selectedHit.codeTarget,
      }
    : (goToSelection ??
      (selectedFlowScreen
        ? {
            label: selectedFlowScreen.label,
            description: selectedFlowScreen.description,
            path: "",
          }
        : undefined));

  const activeEntryId =
    nodeIds.length > 0 ? nodeIds[nodeIds.length - 1] : undefined;

  // The open component entry the Figma tab targets — same gate NodeDetailView
  // uses for its header sync controls (the entry's preview must be on canvas
  // for push to have something to serialize).
  const figmaEntry = activeEntryId ? getRegistryEntry(activeEntryId) : undefined;

  function openEntry(entryId: string) {
    setGoToSelection(undefined);
    if (nodeIds[nodeIds.length - 1] === entryId) return;
    setSelectedHit(undefined);
    setDrillStack([]);
    navigate([entryId]);
  }

  // Deep-link navigation from the injected boot module (`navigateTo`): live
  // requests via the bus, plus any queued before this component subscribed
  // (the `/__designbook/component/<id>` boot path fires before first paint).
  // The bus stays as the boot seam (a separate module graph can't call a
  // context action); its in-tree receiver now drives the catalog's `navigate`.
  // No dep array — re-subscribes each render so the closed-over `openEntry`
  // (which reads current nodeIds) stays fresh, mirroring the keydown effect.
  useEffect(() => onNavigate((entryId) => openEntry(entryId)));
  useEffect(() => {
    const pending = takePendingNavigate();
    if (pending) openEntry(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // App page deep link: expand-from-strip carries the live page's
  // path via `WorkbenchHandle.navigateToApp` → the same navigation bus, mirrored
  // for the "app" route the way `onNavigate`/`openEntry` cover component entries.
  // The receiver now drives the catalog's `navigateApp`.
  useEffect(() => onNavigateApp((appRoutePath) => navigateApp(appRoutePath)));
  useEffect(() => {
    const pending = takePendingNavigateApp();
    if (pending) navigateApp(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Shared between the canvas's own select tool (component pages) and the App
  // page's frame overlay — "Go to component" means the same thing either
  // way: navigate to the component's own designbook page (same route the files
  // panel uses) and point the code tab at its definition.
  function goToComponent(hit: CanvasHitResult) {
    const entry = hit.entry;
    setDiffFile(undefined);
    setGoToSelection({
      label: entry.label,
      description: entry.sourcePath,
      exportName: entry.key,
      path: entry.sourcePath,
    });
    setSelectedHit(undefined);
    setDrillStack([]);
    setSelectedScreenId(undefined);
    openRightTab("code");
    if (nodeIds[nodeIds.length - 1] !== entry.id) {
      navigate([entry.id]);
    }
  }

  function selectHit(hit: CanvasHitResult | undefined) {
    setSelectedHit(hit);
    if (hit) {
      setSelectedScreenId(undefined);
      setGoToSelection(undefined);
      // A fresh canvas selection replaces the Changes-tab diff override.
      setDiffFile(undefined);
    }
  }

  const overlay =
    tool === "text" ? (
      nodePath ? (
        <TextToolOverlay />
      ) : showAppPage ? (
        <AppFrameTextOverlay onDisarm={() => setTool("preview")} />
      ) : undefined
    ) : tool === "select" ? (
      nodePath ? (
        <CanvasOverlay
          selectedHit={selectedHit}
          drillStack={drillStack}
          pendingRestore={pendingSelection}
          onRestoreConsumed={() => setPendingSelection(undefined)}
          onDrillChange={setDrillStack}
          onHover={() => {}}
          onGoToComponent={goToComponent}
          onSelect={selectHit}
        />
      ) : showAppPage ? (
        <AppFrameOverlay
          selectedHit={selectedHit}
          drillStack={drillStack}
          onDrillChange={setDrillStack}
          onGoToComponent={goToComponent}
          onSelect={selectHit}
          onPromptPi={(hit) => {
            setChatDraft(buildFramePromptPrefill(hit));
            openRightTab("chat");
            setSelectedHit(undefined);
          }}
        />
      ) : undefined
    ) : undefined;

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.closest("[role='dialog']") !== null
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;

      if (event.key === "Enter") {
        if (tool === "select" && selectedHit) {
          event.preventDefault();
          openEntry(selectedHit.entry.id);
        } else if (!nodePath && selectedScreenId) {
          event.preventDefault();
          navigate([selectedScreenId]);
        }
        return;
      }

      if (event.key === "Escape") {
        if (drillStack.length > 0) {
          const { drillPath, selected } = resolveEscape(drillStack);
          setDrillStack(drillPath);
          setSelectedHit(selected);
        } else if (selectedHit) {
          setSelectedHit(undefined);
        } else if (selectedScreenId) {
          setSelectedScreenId(undefined);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <SelectionProvider>
      <BranchProvider
        data={{
          currentBranch,
          worktrees,
          loaded: worktreesLoaded,
          switching,
          error,
        }}
        switchBranch={(branch) => void switchBranch(branch, nodeIds, flowId)}
        retry={retry}
      >
      <ChangesProvider
        data={{
          git: changesState.git,
          changes: changesState.changes,
          loaded: changesState.loaded,
        }}
        refresh={changesState.refresh}
        discard={changesState.discard}
        openDiff={openDiff}
      >
      <ConfigStateProvider
        data={{
          themeId,
          themeOptions,
          dimensions: adapterRuntime.dimensions,
          context: contextState,
          follow,
          darkMode,
          hideDarkToggle: Boolean(modeDimension),
          hideThemePreset: Boolean(variantDimension),
          datasets: previewDatasets,
          datasetId,
        }}
        setTheme={setThemeId}
        setContext={(id, value) => adapterRuntime.setContext(id, value)}
        toggleDarkMode={toggleDarkMode}
        setDataset={setDatasetId}
      >
    <div
      className={cn(
        "flex h-screen overflow-hidden bg-background text-foreground",
        panelResizing && "select-none",
      )}
    >
      <SideRail
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        adapterTabs={adapterRuntime.tabs}
      />
      <aside
        className="relative flex shrink-0 flex-col border-r"
        style={{ width: leftWidth }}
      >
        <div className="border-b p-2">
          {/* No git repo → no branch instances; hide the selector instead of
              rendering a permanently-"preparing" control. */}
          {!worktreesLoaded || currentBranch || worktrees.length > 0 ? (
            <BranchSelector />
          ) : (
            <p className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
              no git repo — branches unavailable
            </p>
          )}
          {error ? (
            <p className="px-2 pt-1 text-xs text-destructive">
              <span className="break-words whitespace-pre-wrap">{error}</span>{" "}
              <button
                type="button"
                onClick={retry}
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                {copy.retryButton}
              </button>
            </p>
          ) : null}
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {activeTab === "files" ? (
            <FilesPanel
              activeFlowId={
                !showAppPage && nodeIds.length === 0
                  ? (flowId ?? activeFlow.id)
                  : undefined
              }
              activeEntryId={activeEntryId}
              appActive={showAppPage}
              onOpenApp={() => navigateApp(DEFAULT_APP_PATH)}
            />
          ) : null}
          {activeTab === "changes" ? <ChangesPanel /> : null}
          {activeTab === "figma" ? (
            <FigmaPanel
              entry={
                figmaEntry
                  ? {
                      id: figmaEntry.id,
                      label: figmaEntry.label,
                      sourcePath: figmaEntry.sourcePath,
                    }
                  : undefined
              }
              onAddToChat={draftPromptToChat}
            />
          ) : null}
          {activeAdapterTab ? <AdapterPanel tab={activeAdapterTab} /> : null}
        </div>
        <PanelResizeHandle
          edge="right"
          width={leftWidth}
          onWidthChange={setLeftWidth}
          onResizingChange={setPanelResizing}
        />
      </aside>
      <main
        className={cn(
          "relative min-w-0 flex-1 overflow-hidden bg-muted",
          panelResizing && "pointer-events-none",
        )}
      >
        <DatasetContext.Provider value={dataset}>
          <FrameProvider onFrameNavigated={resetToolsOnFrameNavigation}>
          <CanvasStage
            key={routeKey || "flow"}
            initial={
              nodePath || showAppPage
                ? { y: 96, scale: 0.75 }
                : { y: 80, scale: 0.22 }
            }
            persisted={
              persist.enabled
                ? persist.getTransform(routeKey || "flow")
                : undefined
            }
            onTransformChange={(transform) =>
              persist.updateTransform(routeKey || "flow", transform)
            }
            overlay={overlay}
          >
            <CanvasProviders>
            {nodePath ? (
              <NodeDetailView
                nodePath={nodePath}
                layout={nodeLayouts[nodePath[nodePath.length - 1].id]}
                tool={tool}
                datasetId={dataset.id}
                datasets={previewDatasets}
                onDatasetChange={setDatasetId}
                themeClassName={previewThemeClass}
              />
            ) : showAppPage ? (
              <AppPage path={appPath ?? DEFAULT_APP_PATH} />
            ) : (
              <FlowCanvas
                screens={activeFlow.screens}
                viewport={viewport}
                themeClassName={previewThemeClass}
                selectedScreenId={selectedScreenId}
                onSelectScreen={(screenId) => {
                  setSelectedScreenId(screenId);
                  if (screenId) {
                    setSelectedHit(undefined);
                    setDrillStack([]);
                  }
                }}
                onOpenScreen={(screenId) => navigate([screenId])}
              />
            )}
            </CanvasProviders>
          </CanvasStage>
          </FrameProvider>
        </DatasetContext.Provider>
        {nodePath ? (
          <NodeDetailHeader
            nodePath={nodePath}
            layout={nodeLayouts[nodePath[nodePath.length - 1].id]}
            textEditMode={tool === "text"}
            onLayoutChange={(nodeId, layout) =>
              setNodeLayouts((current) => ({ ...current, [nodeId]: layout }))
            }
          />
        ) : null}
        <CanvasSettingsBar />
        {!nodePath && !showAppPage ? (
          <ViewportPicker viewport={viewport} onViewportChange={setViewport} />
        ) : null}
        <CanvasToolbar
          tool={tool}
          onToolChange={(nextTool) => {
            setTool(nextTool);
            if (nextTool !== "select") {
              setSelectedHit(undefined);
              setDrillStack([]);
            }
          }}
        />
      </main>
      <RightPanel
        activeTab={rightTab}
        collapsed={rightCollapsed}
        width={rightWidth}
        onWidthChange={setRightWidth}
        onResizingChange={setPanelResizing}
        onSelectTab={setRightTab}
        onToggleCollapsed={() => setRightCollapsed((current) => !current)}
      >
        {rightTab === "chat" ? (
          <DesignChat
            selectedNode={selection}
            draft={chatDraft}
            onDraftChange={setChatDraft}
            embedded
          />
        ) : null}
        {rightTab === "props" ? (
          <PropsPanel selectedNode={selection} selectedHit={selectedHit} />
        ) : null}
        {rightTab === "code" ? (
          <CodePanel selectedNode={selection} diffFile={diffFile} />
        ) : null}
      </RightPanel>
    </div>
      </ConfigStateProvider>
      </ChangesProvider>
      </BranchProvider>
    </SelectionProvider>
  );
}

export { Workbench };
