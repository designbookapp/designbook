/**
 * Full-app-view layout — THE designbook UI. The old expanded workbench and
 * the collapsed page-tools toolbar are retired; the boot pencil expands
 * straight into this view on every route, and the play button exits back to
 * the running app.
 *
 * Dark chrome (left icon rail + left panel + right panel) around a LIGHT,
 * running-app center:
 *  - top-left dropdown: the CURRENT GIT BRANCH (unlabeled) — real worktrees
 *    via useWorktrees, switching runs the real prepare-and-navigate flow;
 *  - center top bar: ONE compact unlabeled picker per adapter dimension
 *    (theme, color scheme, tenant, language, …) via adapterRuntime.setContext;
 *    segmented dimensions (light/dark) render as icon segments and the frame
 *    document mirrors the scheme (FrameSchemeSync); extra dropdowns collapse
 *    into a "+N" popover;
 *  - chat panel: the thread system (ChatPanel.tsx);
 *  - changes: real changes model grouped by sandbox changeset (panels.tsx),
 *    including the conflict strip's Keep/Compose actions;
 *  - tokens/flags: the existing AdapterPanel tabs mounted whole;
 *  - center: the live app iframe — FrameProvider owns the handle,
 *    AppFrameOverlay (select) and AppFrameTextOverlay (text) are the REAL
 *    tools, and the selection feeds the selection-context (CodePanel / chat
 *    prompt) — or, on the sandbox route, the fullscreen sandbox canvas
 *    (`#/b/<branch>/sandbox/<pinId>` in host mode; catalog memory route in
 *    injected mode, reached via a thread's "Open canvas");
 *  - right panel: Props inspector (mock, kept) + the real CodePanel on the
 *    Code tab;
 *  - entry/exit: pencil/play ONLY — injected mode collapses the overlay via
 *    the boot seam (host-mode fallback: an internal full-bleed collapse).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getFiberProps } from "@designbook-ui/previewHost";
import {
  ChevronDownIcon,
  FlagIcon,
  GitPullRequestIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  MousePointer2Icon,
  PaletteIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PencilIcon,
  PenLineIcon,
  PlayIcon,
  PlusIcon,
  SmartphoneIcon,
  SunIcon,
  TabletIcon,
  TypeIcon,
} from "lucide-react";
import {
  apiUrl,
  datasets as previewDatasets,
  routing,
} from "@designbook-ui/designbook";
import {
  getAdapterRuntime,
  useAdapterSnapshot,
} from "@designbook-ui/adapterRuntime";
import {
  CatalogProvider,
  useCatalogModel,
} from "@designbook-ui/models/catalog/CatalogProvider";
import {
  SandboxProvider,
  useSandboxApi,
} from "@designbook-ui/models/sandbox/SandboxProvider";
import { useLiveChatMeta } from "@designbook-ui/models/chat/liveChatMeta";
import {
  onNavigateApp,
  onNavigateSandbox,
  takePendingNavigateApp,
  takePendingNavigateSandbox,
} from "@designbook-ui/navigationBus";
import { SelectionProvider } from "@designbook-ui/models/selection/SelectionProvider";
import {
  FrameProvider,
  useFrameModel,
} from "@designbook-ui/models/frame/FrameProvider";
import { ConfigStateProvider } from "@designbook-ui/models/configState/ConfigStateProvider";
import { themeOptions as themePresetOptions } from "@designbook-ui/models/configState/themes";
import { FOLLOW_APP } from "@designbook-ui/hostContext";
import {
  shouldAutoSwitchBranch,
  useWorktrees,
} from "@designbook-ui/models/branch/useWorktrees";
import { useChanges } from "@designbook-ui/models/branch/useChanges";
import { runSelectionContext } from "@designbook-ui/models/selectionContext/store";
import { buildFramePromptPrefill } from "@designbook-ui/models/frame/appFrameHit";
import {
  StageElementContext,
  StageTransformContext,
} from "@designbook-ui/screens/stageContext";
import {
  canvasHitLabel,
  type CanvasHitResult,
} from "@designbook-ui/screens/CanvasOverlay";
import { AppFrameOverlay } from "@designbook-ui/screens/AppFrameOverlay";
import { AppFrameTextOverlay } from "@designbook-ui/screens/AppFrameTextOverlay";
import { SandboxCanvas } from "@designbook-ui/screens/sandbox/SandboxCanvas";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import type { PropsPanelSectionContext } from "@designbook-ui/integrations";
import type { NamespacedDimension } from "@designbook-ui/adapterAggregate";
import { protoCss } from "./styles";
import { Dropdown } from "./ui";
import { ChatPanel, type ChatView } from "./ChatPanel";
import { ChangesSection, FlagsSection, TokensSection } from "./panels";
import { RightPanel } from "./RightPanel";

type SectionId = "chat" | "changes" | "tokens" | "flags";
type Viewport = "desktop" | "tablet" | "mobile";
type Tool = "preview" | "select" | "text";

/** Center container is always full height; presets drive its WIDTH. */
const viewportWidths: Record<Viewport, number | string> = {
  desktop: "100%",
  tablet: 768,
  mobile: 390,
};

/** The proto center is 1:1 with the frame (no pan/zoom stage). */
const IDENTITY_TRANSFORM = { x: 0, y: 0, scale: 1 };

const railItems: { id: SectionId; label: string; Icon: typeof MessageSquareIcon }[] = [
  { id: "chat", label: "Chat", Icon: MessageSquareIcon },
  { id: "changes", label: "Changes", Icon: GitPullRequestIcon },
  { id: "tokens", label: "Tokens", Icon: PaletteIcon },
  { id: "flags", label: "Flags", Icon: FlagIcon },
];

const sectionTitles: Record<SectionId, { title: string; sub: string }> = {
  chat: { title: "Chat", sub: "Design conversation" },
  changes: { title: "Changes", sub: "Changesets + working tree" },
  tokens: { title: "Tokens", sub: "Theme design tokens" },
  flags: { title: "Flags", sub: "Feature flags per tenant" },
};

const copy = {
  comingSoon: "Coming soon",
  loadingBranch: "Preparing worktree…",
  newBranchPlaceholder: "design/my-exploration",
  resizeLeft: "Resize chat panel",
  resizeRight: "Resize inspector panel",
  retry: "Retry",
};

// ---------------------------------------------------------------------------
// Panel resize: drag the inner edge of either side panel; widths persist per
// tab (sessionStorage). The center app container flexes to absorb the change.
// ---------------------------------------------------------------------------

type PanelSide = "left" | "right";

const panelWidthStore: Record<PanelSide, string> = {
  left: "designbook:proto:left-panel-width",
  right: "designbook:proto:right-panel-width",
};

/** Clamps: wide enough for the panel content (variant-card grid / CodeMirror),
 * small enough that the center app always keeps real estate. */
const panelWidthLimits: Record<
  PanelSide,
  { min: number; max: number; fallback: number }
> = {
  left: { min: 300, max: 640, fallback: 380 },
  right: { min: 260, max: 640, fallback: 320 },
};

function clampPanelWidth(side: PanelSide, width: number): number {
  const { min, max } = panelWidthLimits[side];
  return Math.round(Math.min(max, Math.max(min, width)));
}

function readStoredPanelWidth(side: PanelSide): number {
  try {
    const stored = Number(window.sessionStorage.getItem(panelWidthStore[side]));
    if (Number.isFinite(stored) && stored > 0) {
      return clampPanelWidth(side, stored);
    }
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return panelWidthLimits[side].fallback;
}

function storePanelWidth(side: PanelSide, width: number): void {
  try {
    window.sessionStorage.setItem(panelWidthStore[side], String(width));
  } catch {
    // Storage unavailable — the width lives for this mount only.
  }
}

/** Collapse the injected overlay back to the running app (the boot module
 * exposes the seam on the proto route). Undefined in host mode. */
function overlayCollapse(): (() => void) | undefined {
  const g = (
    window as unknown as { __designbook?: { collapseOverlay?: () => void } }
  ).__designbook;
  return typeof g?.collapseOverlay === "function" ? g.collapseOverlay : undefined;
}

export function FullView() {
  const worktrees = useWorktrees();
  return (
    // Router mode follows the mount: "memory" in injected mode (never touch
    // the target app's URL), "hash" in host mode — which keeps the
    // `#/b/<branch>/sandbox/<pinId>` deep link alive.
    <CatalogProvider currentBranch={worktrees.currentBranch} routeMode={routing}>
      <SandboxProvider>
        <SelectionProvider>
          <FullViewBody worktrees={worktrees} />
        </SelectionProvider>
      </SandboxProvider>
    </CatalogProvider>
  );
}

/** The live app iframe — same instrumentation target the old App page used:
 * the frame model owns the element handle (setIframe) and every `load`
 * reports through notifyNavigated (generation bump + tool rewire). `path` is
 * the LATCHED app route (FullViewBody holds it steady across the sandbox
 * route so the frame never reloads underneath the canvas). */
function ProtoAppFrame({ path }: { path: string | undefined }) {
  const { buildFrameSrc, defaultPath, setIframe, notifyNavigated } = useFrameModel();
  return (
    <iframe
      ref={setIframe}
      src={buildFrameSrc(path ?? defaultPath)}
      title="Running app"
      onLoad={notifyNavigated}
    />
  );
}

// ---------------------------------------------------------------------------
// Generic adapter-dimension pickers (center top bar). ONE control per
// registered dimension — whatever the registry provides (theme, tenant, color
// scheme, language, future dimensions) — all writing through the same
// `adapterRuntime.setContext` path the old expanded view used.
// ---------------------------------------------------------------------------

/** Human label for a value from a dimension's options, falling back to the raw value. */
function dimensionOptionLabel(
  dimension: NamespacedDimension,
  value: string | undefined,
): string {
  if (value === undefined) return "";
  return (
    dimension.options.find((option) => option.value === value)?.label ?? value
  );
}

/** Icons for well-known segmented values (light/dark feels first-class). */
const segmentedValueIcons: Record<string, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
};

/** Effective value + follow status for a dimension (host-context aware). */
function useDimensionValue(dimension: NamespacedDimension) {
  const runtime = getAdapterRuntime();
  const { context, follow } = useAdapterSnapshot();
  const followState = follow[dimension.id];
  const following = Boolean(followState?.following);
  const effective = context[dimension.id] ?? dimension.defaultValue;
  return {
    runtime,
    followState,
    following,
    /** What the target app actually shows right now. */
    effective,
    /** The pick the control should highlight (the sentinel while following). */
    pick: following ? FOLLOW_APP : effective,
  };
}

/** Unlabeled adapter-dimension dropdown: shows just the current value;
 * selecting writes the REAL adapter context. A host-context dimension gets a
 * "Follow app" row and an `App ·` prefix while following. */
function DimensionDropdown({ dimension }: { dimension: NamespacedDimension }) {
  const { runtime, followState, following, effective, pick } =
    useDimensionValue(dimension);
  const label = dimensionOptionLabel(dimension, effective);
  return (
    <Dropdown
      label={following ? `App · ${label}` : label}
      value={pick}
      onSelect={(next) => runtime.setContext(dimension.id, next)}
      options={[
        ...(followState
          ? [
              {
                id: FOLLOW_APP,
                label: followState.appValue
                  ? `App · ${dimensionOptionLabel(dimension, followState.appValue)}`
                  : "Follow app",
              },
            ]
          : []),
        ...dimension.options.map((option) => ({
          id: option.value,
          label: option.label,
        })),
      ]}
    />
  );
}

/** A `control: "segmented"` dimension as a compact icon-or-label segment —
 * the proto's first-class light/dark switch (sun/moon), same
 * `setContext` path as everything else. */
function SegmentedDimension({ dimension }: { dimension: NamespacedDimension }) {
  const { runtime, effective } = useDimensionValue(dimension);
  return (
    <div className="dbproto-seg">
      {dimension.options.map((option) => {
        const Icon = segmentedValueIcons[option.value];
        return (
          <button
            key={option.value}
            className={option.value === effective ? "active" : ""}
            onClick={() => runtime.setContext(dimension.id, option.value)}
            title={`${dimension.label}: ${option.label}`}
          >
            {Icon ? <Icon size={14} /> : option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Picker for one dimension: segmented control when the adapter asked for one
 * (and it stays compact), dropdown otherwise. */
function DimensionControl({ dimension }: { dimension: NamespacedDimension }) {
  if (dimension.control === "segmented" && dimension.options.length <= 3) {
    return <SegmentedDimension dimension={dimension} />;
  }
  return <DimensionDropdown dimension={dimension} />;
}

/** Dropdown dimensions beyond the visible cap collapse into ONE "+N" popover
 * (a section per dimension), so a many-dimension app never crowds the bar. */
function OverflowDimensions({
  dimensions,
}: {
  dimensions: NamespacedDimension[];
}) {
  const runtime = getAdapterRuntime();
  const { context } = useAdapterSnapshot();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      // composedPath, not e.target — shadow-DOM retargeting (see Dropdown).
      if (ref.current && !e.composedPath().includes(ref.current)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div className="dbproto-dd" ref={ref}>
      <button
        className="dbproto-dd-btn"
        onClick={() => setOpen((o) => !o)}
        title={dimensions.map((dimension) => dimension.label).join(", ")}
      >
        <span>+{dimensions.length}</span>
        <ChevronDownIcon size={14} style={{ color: "var(--muted)" }} />
      </button>
      {open ? (
        <div className="dbproto-dd-menu">
          {dimensions.map((dimension) => {
            const value = context[dimension.id] ?? dimension.defaultValue;
            return (
              <div key={dimension.id} className="dbproto-dd-section">
                <div className="dbproto-dd-group">{dimension.label}</div>
                {dimension.options.map((option) => (
                  <button
                    key={option.value}
                    className={`dbproto-dd-item ${
                      option.value === value ? "active" : ""
                    }`}
                    onClick={() =>
                      runtime.setContext(dimension.id, option.value)
                    }
                  >
                    <span style={{ minWidth: 0 }}>{option.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Dropdown pickers beyond this many collapse into the "+N" popover
 * (segmented controls are tiny and always stay visible). */
const MAX_VISIBLE_DROPDOWN_DIMENSIONS = 3;

/** Split the registry's dimensions into always-visible segmented controls,
 * visible dropdowns (registry order), and the overflow rest. */
function splitDimensions(dimensions: NamespacedDimension[]): {
  visible: NamespacedDimension[];
  overflow: NamespacedDimension[];
} {
  const visible: NamespacedDimension[] = [];
  const overflow: NamespacedDimension[] = [];
  let dropdowns = 0;
  for (const dimension of dimensions) {
    const segmented =
      dimension.control === "segmented" && dimension.options.length <= 3;
    if (segmented || dropdowns < MAX_VISIBLE_DROPDOWN_DIMENSIONS) {
      visible.push(dimension);
      if (!segmented) dropdowns += 1;
    } else {
      overflow.push(dimension);
    }
  }
  return { visible, overflow };
}

/** Mirrors the frame document's color scheme from the adapter context — the
 * frame counterpart of the old expanded view's `previewThemeClass` (`dark`
 * class on the preview surface, `theme:mode` dimension as source of truth).
 * Reapplied on every frame load (a fresh document boots light). */
function FrameSchemeSync({ dark }: { dark: boolean }) {
  const { iframe, generation } = useFrameModel();
  useEffect(() => {
    let doc: Document | null | undefined;
    try {
      doc = iframe?.contentDocument;
    } catch {
      // Cross-origin navigation inside the frame — nothing to restyle.
      return;
    }
    doc?.documentElement.classList.toggle("dark", dark);
  }, [iframe, generation, dark]);
  return null;
}

/** Does this resource URL look like the frame's own i18next module (vite dep
 * or plain file), excluding react-i18next and locale JSONs? */
function isI18nextModuleUrl(url: string): boolean {
  const pathname = url.split("?")[0];
  const file = pathname.slice(pathname.lastIndexOf("/") + 1);
  return file === "i18next.js" || file === "i18next.mjs";
}

/** Retry delays for the frame-locale apply after a mount/reload (ms). */
const FRAME_LOCALE_RETRIES_MS = [0, 600, 1800];

/**
 * Best-effort mirror of the `locale` dimension into the FRAME app's own
 * i18next instance, so the language picker re-renders the center app live
 * (the frame counterpart of the old expanded view's canvas re-render through
 * the workbench i18next Provider).
 *
 * The frame is a separate module instantiation, so the workbench's
 * `changeLanguage` can never reach it directly. `appFrameMark.ts` documents
 * why an eval'd `import("/@id/i18next")` also fails — Vite resolves it to a
 * DIFFERENT `?v=` cache entry than the frame's own import. The fix here: read
 * the EXACT i18next module URL the frame already loaded (its own resource
 * timing entries, `?v=` included) and indirect-eval an `import()` of that
 * exact URL inside the frame realm — the ESM module map is keyed by resolved
 * URL, so this returns the LIVE instance the app renders through (verified
 * against the demo). Apps that bundle i18next into an unrecognizable chunk
 * (or don't use i18next) are silently left alone; every step is try/caught.
 * Reapplied on every frame load (a fresh boot starts at the app default).
 */
function FrameLocaleSync({ locale }: { locale: string | undefined }) {
  const { iframe, generation } = useFrameModel();
  useEffect(() => {
    if (!locale || !iframe) return;
    const targetLocale = locale;
    let cancelled = false;

    /** Try once; true = done (applied, nothing to do, or unreachable). */
    async function apply(): Promise<boolean> {
      let win: Window | null;
      try {
        win = iframe!.contentWindow;
      } catch {
        return true; // Cross-origin — not our frame anymore.
      }
      if (!win) return false;
      let urls: string[];
      try {
        urls = win.performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter(isI18nextModuleUrl);
      } catch {
        return false;
      }
      if (urls.length === 0) return false; // Module not loaded yet — retry.
      let reached = false;
      for (const url of urls) {
        try {
          // Indirect eval: runs in the FRAME's own realm/module map.
          const mod = (await (win as Window & typeof globalThis).eval(
            `import(${JSON.stringify(url)})`,
          )) as {
            default?: {
              isInitialized?: boolean;
              language?: string;
              changeLanguage?: (locale: string) => Promise<unknown>;
            };
          };
          const instance = mod?.default;
          if (!instance?.isInitialized || !instance.changeLanguage) continue;
          reached = true;
          if (!cancelled && instance.language !== targetLocale) {
            await instance.changeLanguage(targetLocale);
          }
        } catch {
          // Best effort — an app without a reachable instance keeps its own.
        }
      }
      return reached;
    }

    const timers: number[] = [];
    let attempt = 0;
    function schedule() {
      if (attempt >= FRAME_LOCALE_RETRIES_MS.length) return;
      const delay = FRAME_LOCALE_RETRIES_MS[attempt];
      attempt += 1;
      timers.push(
        window.setTimeout(() => {
          void apply().then((done) => {
            if (!done && !cancelled) schedule();
          });
        }, delay),
      );
    }
    schedule();
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [iframe, generation, locale]);
  return null;
}

function BranchDropdown({
  worktrees,
}: {
  worktrees: ReturnType<typeof useWorktrees>;
}) {
  const [newBranch, setNewBranch] = useState("");
  const { currentBranch, switching, switchBranch } = worktrees;

  function submitNewBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const branch = newBranch.trim();
    if (!branch) return;
    setNewBranch("");
    void switchBranch(branch, []);
  }

  return (
    <Dropdown
      mono
      disabled={switching}
      label={switching ? copy.loadingBranch : (currentBranch ?? copy.loadingBranch)}
      value={currentBranch ?? ""}
      onSelect={(branch) => void switchBranch(branch, [])}
      options={worktrees.worktrees.map((worktree) => {
        const agent = worktrees.agentStatuses[worktree.branch];
        const subs = [
          worktree.branch === currentBranch ? "current" : undefined,
          worktree.running && worktree.branch !== currentBranch
            ? "running"
            : undefined,
          worktree.dirtyCount
            ? `${worktree.dirtyCount >= 99 ? "99+" : worktree.dirtyCount} uncommitted`
            : undefined,
          worktree.branch !== currentBranch && agent === "working"
            ? "agent working"
            : undefined,
          worktree.branch !== currentBranch && agent === "done"
            ? "agent finished"
            : undefined,
        ].filter(Boolean);
        return {
          id: worktree.branch,
          label: worktree.branch,
          sub: subs.length > 0 ? subs.join(" · ") : undefined,
        };
      })}
      footer={
        <form onSubmit={submitNewBranch} style={{ display: "flex", gap: 6, padding: 4 }}>
          <input
            className="dbproto-input"
            style={{ height: 26, fontSize: 11.5, fontFamily: "ui-monospace, Menlo, monospace" }}
            value={newBranch}
            placeholder={copy.newBranchPlaceholder}
            onChange={(event) => setNewBranch(event.target.value)}
          />
          <button
            type="submit"
            className="dbproto-minibtn"
            disabled={!newBranch.trim()}
            title="Create new branch"
          >
            <PlusIcon size={12} />
          </button>
        </form>
      }
    />
  );
}

function FullViewBody({
  worktrees,
}: {
  worktrees: ReturnType<typeof useWorktrees>;
}) {
  // Host-mode fallback only — with the injected overlay, play COLLAPSES the
  // overlay (the real exit) and this stays true forever.
  const [editMode, setEditMode] = useState(true);

  // The catalog owns the route (app path + the sandbox-canvas pin).
  const catalog = useCatalogModel();
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const sandboxPinId = catalog.sandboxPinId;

  // Deep-link bus (injected mode): the boot module reports the live page's
  // route on expand (navigateToApp) and can land on a sandbox pin
  // (navigateToSandbox). Pending values cover requests made before mount.
  useEffect(() => {
    const pendingApp = takePendingNavigateApp();
    if (pendingApp) catalogRef.current.navigateApp(pendingApp);
    const pendingSandbox = takePendingNavigateSandbox();
    if (pendingSandbox) catalogRef.current.navigateSandbox(pendingSandbox);
    const offApp = onNavigateApp((path) =>
      catalogRef.current.navigateApp(path),
    );
    const offSandbox = onNavigateSandbox((pinId) =>
      catalogRef.current.navigateSandbox(pinId),
    );
    return () => {
      offApp();
      offSandbox();
    };
  }, []);

  // Hash-mode deep links (#/b/<branch>/…) drive a server switch. Memory
  // (injected) routing NEVER auto-switches from the route: its branch is
  // restored from the reload-persist blob, which is stale right after a proxy
  // branch switch — switching on it would silently revert the switch the user
  // just made (the "switched back to main" bug). See shouldAutoSwitchBranch;
  // memory mode reconciles the route to the server instead (useCanvasRoute).
  const urlBranch = catalog.urlBranch;
  const currentBranch = worktrees.currentBranch;
  useEffect(() => {
    if (urlBranch && shouldAutoSwitchBranch(routing, urlBranch, currentBranch)) {
      void worktrees.switchBranch(
        urlBranch,
        catalogRef.current.nodeIds,
        catalogRef.current.flowId,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when the branches involved change
  }, [urlBranch, currentBranch]);

  // Latch the app path across the sandbox route (appPath and sandboxPinId are
  // mutually exclusive in the route) so the frame keeps rendering the same
  // page under the canvas and "Back" restores it without a reload.
  const framePathRef = useRef<string | undefined>(undefined);
  if (sandboxPinId === undefined) framePathRef.current = catalog.appPath;
  const framePath = framePathRef.current;

  /** Open the fullscreen sandbox canvas on a pin (thread "Open canvas"). */
  function openCanvas(pinId: string) {
    catalog.navigateSandbox(pinId);
  }

  /** Leave the sandbox canvas — back to the latched app route. */
  function closeCanvas() {
    if (framePath !== undefined) catalog.navigateApp(framePath);
    else catalog.navigate([]);
  }
  const [section, setSection] = useState<SectionId>("chat");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(() => readStoredPanelWidth("left"));
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredPanelWidth("right"),
  );
  /** Which panel edge is being dragged — suppresses the width transition and
   * the iframe's pointer events for the duration. */
  const [resizing, setResizing] = useState<PanelSide>();
  const [rightTab, setRightTab] = useState<"props" | "code">("props");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [tool, setTool] = useState<Tool>("select");
  const [chatView, setChatView] = useState<ChatView>({ kind: "list" });
  const [chatDraft, setChatDraft] = useState("");
  const [diffFile, setDiffFile] = useState<string>();

  // REAL frame selection state (Workbench parity, minus the pan/zoom stage).
  const [selectedHit, setSelectedHit] = useState<CanvasHitResult>();
  const [drillStack, setDrillStack] = useState<CanvasHitResult[]>([]);
  const [goToSelection, setGoToSelection] = useState<CanvasNodeSelection>();
  const [frameWrapEl, setFrameWrapEl] = useState<HTMLDivElement | null>(null);

  // Real changes state (Changes tab + selection-context snapshot).
  const changesState = useChanges({ active: section === "changes" });

  // L3: report the ACTIVE conversation (drawer-equivalent semantics — the
  // spec's active-conversation definition mapped onto the proto): the CHAT
  // panel is open on the live conversation's chat view, or on a pin thread
  // whose pin carries that conversationId. List/history views, other
  // sections, and a closed left panel all clear it. Manual data edits (the
  // text tool) then route into the conversation's direct-edits changeset;
  // conversation turns get the overlay toolset + bash write-capture.
  const sandboxApi = useSandboxApi();
  const liveChat = useLiveChatMeta();
  const chatPanelOpen = leftOpen && section === "chat";
  const activeConversationId = chatPanelOpen
    ? chatView.kind === "chat"
      ? liveChat.conversationId
      : chatView.kind === "thread"
        ? sandboxApi?.pins[chatView.pinId]?.conversationId
        : undefined
    : undefined;
  const reportedConversationRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const next = activeConversationId ?? null;
    if (reportedConversationRef.current === next) return;
    reportedConversationRef.current = next;
    void fetch(apiUrl("/api/sandbox/active-conversation"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: next }),
    }).catch(() => {
      // Retry on the next change (the server keeps its previous state).
      reportedConversationRef.current = undefined;
    });
  }, [activeConversationId]);
  useEffect(
    () => () => {
      // Full view torn down — no chat panel, no active conversation.
      void fetch(apiUrl("/api/sandbox/active-conversation"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: null }),
      }).catch(() => {});
    },
    [],
  );

  // Adapter runtime: the REAL theme/tenant dimensions + the ConfigState the
  // AdapterPanel tabs (Tokens/Flags) read.
  const adapterRuntime = getAdapterRuntime();
  const { context: contextState, follow } = useAdapterSnapshot();
  useEffect(() => {
    adapterRuntime.refreshHostContext();
    if (!adapterRuntime.needsFollowPolling) return;
    const timer = window.setInterval(
      () => adapterRuntime.refreshHostContext(),
      2000,
    );
    return () => window.clearInterval(timer);
  }, [adapterRuntime]);
  const modeDimension = adapterRuntime.dimensions.find((dimension) =>
    dimension.id.endsWith(":mode"),
  );
  const variantDimension = adapterRuntime.dimensions.find((dimension) =>
    dimension.id.endsWith(":variant"),
  );
  const localeDimension = adapterRuntime.dimensions.find((dimension) =>
    dimension.id.endsWith(":locale"),
  );
  const frameLocale = localeDimension
    ? (contextState[localeDimension.id] ?? localeDimension.defaultValue)
    : undefined;
  // EVERY registered dimension gets a picker (registry order); dropdowns
  // beyond the cap collapse into the "+N" popover.
  const { visible: visibleDimensions, overflow: overflowDimensions } =
    splitDimensions(adapterRuntime.dimensions);
  const [themeId, setThemeId] = useState(() => themePresetOptions[0]?.id ?? "");
  const [datasetId, setDatasetId] = useState(() => previewDatasets[0]?.id ?? "");
  const darkMode = modeDimension
    ? (contextState[modeDimension.id] ?? modeDimension.defaultValue) === "dark"
    : false;

  // Source-owner fallback hits (page-shell elements outside every registered
  // component) carry NO client-side sourcePath — resolve the owning file
  // server-side (the element-pin route's bounded export scan, read-only) so
  // the Code tab works for plain elements too.
  const [ownerSource, setOwnerSource] = useState<{
    instanceId: string;
    file: string;
    exportName: string;
  }>();
  useEffect(() => {
    if (
      !selectedHit ||
      selectedHit.ownerKind !== "source" ||
      selectedHit.entry.sourcePath
    ) {
      setOwnerSource(undefined);
      return;
    }
    const instanceId = selectedHit.instanceId;
    const names = [selectedHit.entry.key, ...(selectedHit.ownerNames ?? [])];
    let cancelled = false;
    void fetch(
      apiUrl(
        `/api/sandbox/source-owner?names=${encodeURIComponent(names.join(","))}`,
      ),
    )
      .then((response) => response.json())
      .then((payload: { file?: string; exportName?: string }) => {
        if (!cancelled && payload.file && payload.exportName) {
          setOwnerSource({
            instanceId,
            file: payload.file,
            exportName: payload.exportName,
          });
        }
      })
      .catch(() => {
        // Unresolvable — the Code tab keeps its empty state.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHit]);
  const resolvedOwner =
    selectedHit && ownerSource?.instanceId === selectedHit.instanceId
      ? ownerSource
      : undefined;

  // Derived selection → CodePanel / chat context.
  const selection: CanvasNodeSelection | undefined = selectedHit
    ? {
        label: canvasHitLabel(selectedHit),
        description: selectedHit.dom
          ? `${selectedHit.dom.tag} inside ${selectedHit.entry.label}`
          : selectedHit.entry.sourcePath,
        exportName: resolvedOwner?.exportName ?? selectedHit.entry.key,
        path: selectedHit.entry.sourcePath || resolvedOwner?.file || "",
        dom: selectedHit.dom,
        // A resolved source owner synthesizes the usage-line code target the
        // hit itself couldn't carry: highlight `<tag …>` in the owner's file.
        codeTarget:
          selectedHit.codeTarget ??
          (resolvedOwner && selectedHit.dom
            ? {
                file: resolvedOwner.file,
                ownerExportName: resolvedOwner.exportName,
                name: selectedHit.dom.tag,
                kind: "dom" as const,
                ...(selectedHit.dom.classes?.[0]
                  ? { className: selectedHit.dom.classes[0] }
                  : {}),
              }
            : undefined),
      }
    : goToSelection;

  // Live runtime prop values for the Props panel — snapshotted from the
  // selection's fiber (existing capture machinery). Undefined for DOM/restored
  // selections; the panel then renders schema-only / its empty state.
  const runtimeProps = useMemo<Record<string, unknown> | undefined>(() => {
    const fiber = selectedHit?.fiber;
    if (!fiber) return undefined;
    try {
      return getFiberProps(fiber as Parameters<typeof getFiberProps>[0]);
    } catch {
      return undefined;
    }
  }, [selectedHit]);

  // Live selection handles for plugin props-panel sections (Figma push
  // serializes the selection's DOM subtree). Only a component hit with a live
  // fiber + registry id is serializable; DOM/source-owner/restored selections
  // leave this undefined so the section disables its push action.
  const sectionLive = useMemo<PropsPanelSectionContext["live"]>(() => {
    if (
      !selectedHit ||
      selectedHit.kind !== "component" ||
      !selectedHit.fiber ||
      !selectedHit.entry.id
    ) {
      return undefined;
    }
    return {
      entryId: selectedHit.entry.id,
      root: selectedHit.anchor,
      fiber: selectedHit.fiber,
    };
  }, [selectedHit]);

  // Selection-context run — contributors snapshot the live hit + changed files.
  const changesRef = useRef(changesState.changes);
  changesRef.current = changesState.changes;
  useEffect(() => {
    runSelectionContext(
      selection
        ? {
            node: selection,
            live: selectedHit
              ? {
                  entryId: selectedHit.entry.id,
                  instanceId: selectedHit.instanceId,
                  fiber: selectedHit.fiber,
                  anchor: selectedHit.anchor,
                }
              : undefined,
            changes: changesRef.current,
          }
        : undefined,
      { apiUrl },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selection` is derived; run on its state sources
  }, [selectedHit, goToSelection]);

  function selectHit(hit: CanvasHitResult | undefined) {
    setSelectedHit(hit);
    if (hit) {
      setGoToSelection(undefined);
      setDiffFile(undefined);
    }
  }

  function clearSelection() {
    setSelectedHit(undefined);
    setDrillStack([]);
  }

  function changeTool(next: Tool) {
    setTool((current) => {
      const resolved = current === next ? "preview" : next;
      if (resolved !== "select") clearSelection();
      return resolved;
    });
  }

  /** "Go to component": point the Code tab at the definition (the proto has no
   * catalog canvas to navigate to). */
  function goToComponent(hit: CanvasHitResult) {
    setDiffFile(undefined);
    setGoToSelection({
      label: hit.entry.label,
      description: hit.entry.sourcePath,
      exportName: hit.entry.key,
      path: hit.entry.sourcePath,
    });
    clearSelection();
    setRightTab("code");
    setRightOpen(true);
  }

  /** "Prompt Pi" from the frame chip: draft into the REAL chat (general view). */
  function promptPi(hit: CanvasHitResult) {
    setChatDraft(buildFramePromptPrefill(hit));
    setChatView({ kind: "chat" });
    setSection("chat");
    setLeftOpen(true);
    setSelectedHit(undefined);
  }

  /** Draft a plugin section's prompt into the live conversation chat (Figma
   *  pull handoff). Mirrors `promptPi` but keeps the selection so the section's
   *  post-pull state stays visible. The user's send click is the confirm gate. */
  function openSectionChat(draft: string) {
    setChatDraft(draft);
    setChatView({ kind: "chat" });
    setSection("chat");
    setLeftOpen(true);
  }

  /** Drag-resize a side panel from its inner edge. Pointer capture keeps the
   * drag alive over the app iframe; the width transition is suppressed for
   * the duration (`.dbproto-resizing`). */
  function startPanelResize(
    event: ReactPointerEvent<HTMLDivElement>,
    side: PanelSide,
  ) {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    const setWidth = side === "left" ? setLeftWidth : setRightWidth;
    let latest = startWidth;
    setResizing(side);
    function onMove(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX;
      latest = clampPanelWidth(
        side,
        side === "left" ? startWidth + delta : startWidth - delta,
      );
      setWidth(latest);
    }
    function onEnd() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      storePanelWidth(side, latest);
      setResizing(undefined);
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  /** Open a changed file's diff in the right panel's REAL CodePanel. */
  function openDiff(path: string) {
    setDiffFile(path);
    setRightTab("code");
    setRightOpen(true);
  }

  /** Play: exit to the running app. Injected mode collapses the overlay (the
   * boot pencil brings it back — same screen spot); host mode falls back to
   * the internal full-bleed collapse. */
  function exitToApp() {
    const collapse = overlayCollapse();
    if (collapse) {
      collapse();
      return;
    }
    setEditMode(false);
  }

  // Escape ladder over the frame selection (Workbench parity): pop one drill
  // level, then the selection. Typing surfaces are excluded.
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      );
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || isEditableTarget(event.target)) return;
      if (drillStack.length > 0) {
        const next = drillStack.slice(0, -1);
        setDrillStack(next);
        setSelectedHit(next[next.length - 1] ?? selectedHit);
      } else if (selectedHit) {
        setSelectedHit(undefined);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const width = editMode ? viewportWidths[viewport] : viewportWidths.desktop;

  return (
    <ConfigStateProvider
      data={{
        themeId,
        themeOptions: themePresetOptions,
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
      toggleDarkMode={() => {
        if (modeDimension) {
          adapterRuntime.setContext(modeDimension.id, darkMode ? "light" : "dark");
        }
      }}
      setDataset={setDatasetId}
    >
      <FrameProvider onFrameNavigated={clearSelection}>
        <FrameSchemeSync dark={darkMode} />
        <FrameLocaleSync locale={frameLocale} />
        <div
          className={`dbproto ${editMode ? "" : "dbproto-collapsed"} ${
            resizing ? "dbproto-resizing" : ""
          }`}
        >
          <style>{protoCss}</style>
          <div className="dbproto-shell">
            <div className="dbproto-body">
              {/* ---- left icon rail ---- */}
              {editMode ? (
                <div className="dbproto-rail">
                  {railItems.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      className={`dbproto-railbtn ${section === id && leftOpen ? "active" : ""}`}
                      onClick={() => {
                        if (section === id) {
                          setLeftOpen((o) => !o);
                        } else {
                          setSection(id);
                          setLeftOpen(true);
                        }
                      }}
                      title={label}
                    >
                      <Icon size={19} />
                    </button>
                  ))}
                  <div className="dbproto-rail-spacer" />
                </div>
              ) : null}

              {/* ---- left panel ---- */}
              {editMode ? (
                <div
                  className={`dbproto-leftpanel ${leftOpen ? "" : "closed"}`}
                  style={leftOpen ? { width: leftWidth } : undefined}
                >
                  <div
                    className="dbproto-panel-inner"
                    style={{ width: leftWidth }}
                  >
                    <div className="dbproto-panel-head">
                      {/* The current BRANCH — unlabeled, real switch flow. */}
                      <BranchDropdown worktrees={worktrees} />
                      <div>
                        <div className="dbproto-panel-title">
                          {sectionTitles[section].title}
                        </div>
                        <div className="dbproto-panel-sub">
                          {sectionTitles[section].sub}
                        </div>
                      </div>
                    </div>
                    {worktrees.error ? (
                      <div className="dbproto-panel-error">
                        {worktrees.error}{" "}
                        <button onClick={worktrees.retry}>{copy.retry}</button>
                      </div>
                    ) : null}
                    {section === "chat" ? (
                      <ChatPanel
                        view={chatView}
                        onViewChange={setChatView}
                        draft={chatDraft}
                        onDraftChange={setChatDraft}
                        selection={selection}
                        selectedHit={selectedHit}
                        onOpenCanvas={openCanvas}
                      />
                    ) : null}
                    {section === "changes" ? (
                      <ChangesSection
                        changes={changesState.changes}
                        loaded={changesState.loaded}
                        git={changesState.git}
                        onOpenDiff={openDiff}
                      />
                    ) : null}
                    {section === "tokens" ? <TokensSection /> : null}
                    {section === "flags" ? <FlagsSection /> : null}
                  </div>
                </div>
              ) : null}

              {/* left resize handle (inner edge of the left panel) */}
              {editMode && leftOpen ? (
                <div
                  className={`dbproto-resizer ${resizing === "left" ? "active" : ""}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={copy.resizeLeft}
                  onPointerDown={(event) => startPanelResize(event, "left")}
                />
              ) : null}

              {/* ---- center: full-height rounded container w/ built-in bars ---- */}
              <div className="dbproto-mid">
                <div className="dbproto-stage">
                  <div
                    className={`dbproto-stage-inner ${editMode ? "" : "fullbleed"}`}
                    style={{ width }}
                  >
                    {/* center TOP bar: one unlabeled picker per adapter
                        dimension (values only) + viewport */}
                    {editMode ? (
                      <div className="dbproto-centerbar top">
                        <button
                          className="dbproto-iconbtn"
                          onClick={() => setLeftOpen((o) => !o)}
                          title={leftOpen ? "Collapse left panel" : "Expand left panel"}
                        >
                          {leftOpen ? (
                            <PanelLeftCloseIcon size={16} />
                          ) : (
                            <PanelLeftOpenIcon size={16} />
                          )}
                        </button>
                        {/* Theme-preset picker: only when no adapter variant
                            dimension supersedes it (old-view parity). */}
                        {!variantDimension && themePresetOptions.length > 0 ? (
                          <Dropdown
                            label={
                              themePresetOptions.find(
                                (option) => option.id === themeId,
                              )?.label ?? themeId
                            }
                            value={themeId}
                            onSelect={setThemeId}
                            options={themePresetOptions.map((option) => ({
                              id: option.id,
                              label: option.label,
                            }))}
                          />
                        ) : null}
                        {visibleDimensions.map((dimension) => (
                          <DimensionControl
                            key={dimension.id}
                            dimension={dimension}
                          />
                        ))}
                        {overflowDimensions.length > 0 ? (
                          <OverflowDimensions dimensions={overflowDimensions} />
                        ) : null}
                        <div className="dbproto-centerbar-spacer" />
                        <div className="dbproto-seg">
                          <button
                            className={viewport === "desktop" ? "active" : ""}
                            onClick={() => setViewport("desktop")}
                            title="Desktop"
                          >
                            <MonitorIcon size={15} />
                          </button>
                          <button
                            className={viewport === "tablet" ? "active" : ""}
                            onClick={() => setViewport("tablet")}
                            title="Tablet"
                          >
                            <TabletIcon size={15} />
                          </button>
                          <button
                            className={viewport === "mobile" ? "active" : ""}
                            onClick={() => setViewport("mobile")}
                            title="Mobile"
                          >
                            <SmartphoneIcon size={15} />
                          </button>
                        </div>
                        <button
                          className="dbproto-iconbtn"
                          onClick={() => setRightOpen((o) => !o)}
                          title={rightOpen ? "Collapse right panel" : "Expand right panel"}
                        >
                          {rightOpen ? (
                            <PanelRightCloseIcon size={16} />
                          ) : (
                            <PanelRightOpenIcon size={16} />
                          )}
                        </button>
                      </div>
                    ) : null}

                    {/* app iframe + the REAL tool overlays over it */}
                    <div className="dbproto-frame-wrap" ref={setFrameWrapEl}>
                      <ProtoAppFrame path={framePath} />
                      <StageElementContext.Provider value={frameWrapEl}>
                        <StageTransformContext.Provider value={IDENTITY_TRANSFORM}>
                          {editMode && tool === "select" && !sandboxPinId ? (
                            <AppFrameOverlay
                              selectedHit={selectedHit}
                              drillStack={drillStack}
                              onDrillChange={setDrillStack}
                              onGoToComponent={goToComponent}
                              onSelect={selectHit}
                              onPromptPi={promptPi}
                              // Full-view selection = outline + the dark name
                              // pill ONLY; prompting lives in the chat panel.
                              pillOnly
                            />
                          ) : null}
                          {editMode && tool === "text" && !sandboxPinId ? (
                            <AppFrameTextOverlay onDisarm={() => setTool("preview")} />
                          ) : null}
                        </StageTransformContext.Provider>
                      </StageElementContext.Provider>
                    </div>

                    {/* center BOTTOM bar: the REAL tool selector */}
                    {editMode ? (
                      <div className="dbproto-centerbar bottom">
                        <div className="dbproto-toolpick">
                          <button
                            className={tool === "select" ? "active" : ""}
                            onClick={() => changeTool("select")}
                            title="Select"
                          >
                            <MousePointer2Icon size={15} />
                          </button>
                          <button
                            className={tool === "text" ? "active" : ""}
                            onClick={() => changeTool("text")}
                            title="Edit text"
                          >
                            <TypeIcon size={15} />
                          </button>
                          <button disabled title={copy.comingSoon}>
                            <PenLineIcon size={15} />
                          </button>
                          <button disabled title={copy.comingSoon}>
                            <MessageCircleIcon size={15} />
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* fullscreen sandbox canvas (route-driven) — overlays the
                    stage; the app frame stays mounted (and latched) below */}
                {sandboxPinId ? (
                  <div className="dbproto-canvaslayer">
                    <SandboxCanvas pinId={sandboxPinId} onBack={closeCanvas} />
                  </div>
                ) : null}

                {/* host-mode fallback pencil (collapsed full-bleed state) */}
                {!editMode ? (
                  <button
                    className="dbproto-floatbtn"
                    onClick={() => setEditMode(true)}
                    title="Edit (expand chrome)"
                  >
                    <PencilIcon size={18} />
                  </button>
                ) : null}
              </div>

              {/* right resize handle (inner edge of the right panel) */}
              {editMode && rightOpen ? (
                <div
                  className={`dbproto-resizer ${resizing === "right" ? "active" : ""}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={copy.resizeRight}
                  onPointerDown={(event) => startPanelResize(event, "right")}
                />
              ) : null}

              {/* ---- right panel ---- */}
              {editMode ? (
                <RightPanel
                  closed={!rightOpen}
                  width={rightWidth}
                  tab={rightTab}
                  onTabChange={setRightTab}
                  selection={selection}
                  runtimeProps={runtimeProps}
                  live={sectionLive}
                  openChat={openSectionChat}
                  diffFile={diffFile}
                />
              ) : null}
            </div>
          </div>

          {/* play — EXACT same screen spot as the boot pencil (16/16, 44px,
              perfectly round); exits to the running app. */}
          {editMode ? (
            <button className="dbproto-playbtn" onClick={exitToApp} title="Play (back to the app)">
              <PlayIcon size={18} fill="currentColor" style={{ marginLeft: 2 }} />
            </button>
          ) : null}
        </div>
      </FrameProvider>
    </ConfigStateProvider>
  );
}
