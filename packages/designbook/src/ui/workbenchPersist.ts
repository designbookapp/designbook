/**
 * Reload rehydration store.
 *
 * In INJECTED mode the workbench must never touch the app's URL, so navigation
 * and mutable UI state live in memory and are mirrored to `sessionStorage` under
 * a single versioned blob, keyed by project root. On a full reload (defer pill,
 * F5, dep re-optimize) the boot module re-expands and the workbench rehydrates
 * from this blob — same component, drill selection, canvas transform, chat
 * draft, tab/tool, and adapter-adjacent selections restored.
 *
 * In HOST mode the persist controller is DISABLED (routing stays "hash"), so
 * nothing here reads or writes storage and host behavior is byte-identical.
 *
 * ## Ownership (single blob, two cooperative writers, one JS context)
 * The boot module (plugin.ts, plain JS) owns `expanded` / `deferredReloadPending`
 * and reads them BEFORE the workbench mounts (to re-expand without a flash). The
 * workbench (this controller) owns everything else. Both do read-merge-write of
 * the same key, so neither clobbers the other's fields. They run in the same
 * window, so the merges are cooperative — never truly concurrent.
 *
 * The pure parts (blob parse/version-drop, dom-path encode/decode) are unit
 * tested in `workbenchPersist.test.ts`; the storage IO is a thin shell.
 */

/** Bump to invalidate every persisted blob on a schema change. MUST match the
 * literal baked into the boot module (src/node/plugin.ts bootSource). */
const PERSIST_VERSION = 1;

const KEY_PREFIX = "designbook:wb:";

/** sessionStorage key for a project, namespaced by config dir (stable per app). */
function persistStorageKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId || "."}`;
}

type StageTransform = { x: number; y: number; scale: number };

/** Durable address for a canvas selection: a structural DOM path from the
 * previewed entry's `[data-db-entry]` root to the selected level's anchor
 * element, plus the drill depth and validation metadata. Fiber refs and the
 * ephemeral per-anchor instanceIds do NOT survive a reload, so selection is
 * replayed structurally and silently dropped when the component's shape changed. */
type SelectionSnapshot = {
  /** `data-db-entry` value of the previewed entry the selection lives in. */
  dbEntry: string;
  /** Child-index path from the `[data-db-entry]` root to the anchor element. */
  domPath: number[];
  /** `drillStack.length` — the outermost drillable levels that were entered. */
  drillDepth: number;
  kind: "component" | "dom";
  /** Selected level's registry entry id, checked on restore (shape drift → drop). */
  entryId: string;
  /** Selected level's display name, checked on restore. */
  name: string;
};

type RouteSnapshot = {
  branch?: string;
  flowId?: string;
  nodeIds: string[];
  /** App page route — the workbench-relative path shown in the
   * frame cell, when the persisted route is the App page. */
  appPath?: string;
};

type PersistBlob = {
  v: number;
  // --- boot-owned ---
  expanded: boolean;
  deferredReloadPending: boolean;
  // --- workbench-owned ---
  route: RouteSnapshot | null;
  activeTab: string | null;
  /** Right-hand panel tab (info / chat / code) — see workbenchTabs.ts.
   * Legacy "props" blobs migrate to "info" in resolveInitialTabs. */
  rightTab: string | null;
  /** Whether the right-hand panel is collapsed to its rail. */
  rightCollapsed: boolean | null;
  /** Left panel width in px (resize handle) — null = default. */
  leftWidth: number | null;
  /** Right panel width in px (resize handle) — null = default. A collapsed
   * panel keeps its stored width; the width only applies when expanded. */
  rightWidth: number | null;
  tool: string | null;
  themeId: string | null;
  darkMode: boolean | null;
  datasetId: string | null;
  /** Canvas pan/zoom per route key (nodeIds.join("/") or "flow"). */
  transforms: Record<string, StageTransform>;
  chatDraft: string;
  selection: SelectionSnapshot | null;
};

/** Fields the workbench controller owns (never `expanded`/`deferredReloadPending`). */
type WorkbenchState = Omit<
  PersistBlob,
  "v" | "expanded" | "deferredReloadPending"
>;

function emptyState(): WorkbenchState {
  return {
    route: null,
    activeTab: null,
    rightTab: null,
    rightCollapsed: null,
    leftWidth: null,
    rightWidth: null,
    tool: null,
    themeId: null,
    darkMode: null,
    datasetId: null,
    transforms: {},
    chatDraft: "",
    selection: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse a raw sessionStorage string into a blob, or `undefined` when it's
 * absent / unparseable / a different schema version (migration-drop). The
 * returned blob is normalized so every consumer sees defined fields.
 */
function parseBlob(raw: string | null | undefined): PersistBlob | undefined {
  if (!raw) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(obj)) return undefined;
  if (obj.v !== PERSIST_VERSION) return undefined;

  const transforms: Record<string, StageTransform> = {};
  if (isRecord(obj.transforms)) {
    for (const [key, value] of Object.entries(obj.transforms)) {
      if (
        isRecord(value) &&
        typeof value.x === "number" &&
        typeof value.y === "number" &&
        typeof value.scale === "number"
      ) {
        transforms[key] = { x: value.x, y: value.y, scale: value.scale };
      }
    }
  }

  return {
    v: PERSIST_VERSION,
    expanded: obj.expanded === true,
    deferredReloadPending: obj.deferredReloadPending === true,
    route: parseRoute(obj.route),
    activeTab: typeof obj.activeTab === "string" ? obj.activeTab : null,
    rightTab: typeof obj.rightTab === "string" ? obj.rightTab : null,
    rightCollapsed:
      typeof obj.rightCollapsed === "boolean" ? obj.rightCollapsed : null,
    leftWidth:
      typeof obj.leftWidth === "number" && Number.isFinite(obj.leftWidth)
        ? obj.leftWidth
        : null,
    rightWidth:
      typeof obj.rightWidth === "number" && Number.isFinite(obj.rightWidth)
        ? obj.rightWidth
        : null,
    tool: typeof obj.tool === "string" ? obj.tool : null,
    themeId: typeof obj.themeId === "string" ? obj.themeId : null,
    darkMode: typeof obj.darkMode === "boolean" ? obj.darkMode : null,
    datasetId: typeof obj.datasetId === "string" ? obj.datasetId : null,
    transforms,
    chatDraft: typeof obj.chatDraft === "string" ? obj.chatDraft : "",
    selection: parseSelection(obj.selection),
  };
}

function parseRoute(value: unknown): RouteSnapshot | null {
  if (!isRecord(value)) return null;
  const nodeIds = Array.isArray(value.nodeIds)
    ? value.nodeIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    branch: typeof value.branch === "string" ? value.branch : undefined,
    flowId: typeof value.flowId === "string" ? value.flowId : undefined,
    nodeIds,
    appPath: typeof value.appPath === "string" ? value.appPath : undefined,
  };
}

function parseSelection(value: unknown): SelectionSnapshot | null {
  if (!isRecord(value)) return null;
  if (typeof value.dbEntry !== "string") return null;
  if (
    !Array.isArray(value.domPath) ||
    !value.domPath.every((n): n is number => typeof n === "number")
  ) {
    return null;
  }
  if (typeof value.drillDepth !== "number") return null;
  if (value.kind !== "component" && value.kind !== "dom") return null;
  if (typeof value.entryId !== "string" || typeof value.name !== "string") {
    return null;
  }
  return {
    dbEntry: value.dbEntry,
    domPath: value.domPath,
    drillDepth: value.drillDepth,
    kind: value.kind,
    entryId: value.entryId,
    name: value.name,
  };
}

// ---------------------------------------------------------------------------
// Structural DOM addressing (pure — testable without a DOM via a tiny shape).
// ---------------------------------------------------------------------------

interface DomNodeLike {
  parentElement: DomNodeLike | null;
  children: ArrayLike<DomNodeLike>;
}

function indexInParent(node: DomNodeLike, parent: DomNodeLike): number {
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    if (children[i] === node) return i;
  }
  return -1;
}

/**
 * Child-index path from `root` (exclusive) down to `node` (inclusive), or
 * `undefined` when `node` is not a descendant of `root`.
 */
function domPathTo<T extends DomNodeLike>(
  node: T,
  root: T,
): number[] | undefined {
  const path: number[] = [];
  let current: DomNodeLike | null = node;
  while (current && current !== root) {
    const parent: DomNodeLike | null = current.parentElement;
    if (!parent) return undefined;
    const index = indexInParent(current, parent);
    if (index === -1) return undefined;
    path.unshift(index);
    current = parent;
  }
  return current === root ? path : undefined;
}

/**
 * Encode a live selection into a durable snapshot: the structural DOM path from
 * the previewed entry's `[data-db-entry]` root to the selected level's anchor
 * element, plus the drill depth and validation metadata. Returns `null` when
 * there's no anchor or the anchor isn't inside a previewed entry (nothing to
 * restore later).
 */
function encodeSelection(
  anchor: Element | undefined | null,
  kind: "component" | "dom",
  entryId: string,
  name: string,
  drillDepth: number,
): SelectionSnapshot | null {
  if (!anchor) return null;
  const root = anchor.closest("[data-db-entry]");
  if (!root) return null;
  const domPath = domPathTo(anchor, root);
  if (!domPath) return null;
  return {
    dbEntry: root.getAttribute("data-db-entry") ?? "",
    domPath,
    drillDepth,
    kind,
    entryId,
    name,
  };
}

/** Walk `path` (child indices) from `root`, or `undefined` if any step misses. */
function elementAtDomPath<T extends DomNodeLike>(
  root: T,
  path: number[],
): T | undefined {
  let current: DomNodeLike = root;
  for (const index of path) {
    const next = current.children[index];
    if (!next) return undefined;
    current = next;
  }
  return current as T;
}

// ---------------------------------------------------------------------------
// Storage IO + write-through controller.
// ---------------------------------------------------------------------------

function readRawBlob(projectId: string): PersistBlob | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return parseBlob(window.sessionStorage.getItem(persistStorageKey(projectId)));
  } catch {
    return undefined;
  }
}

const WRITE_DEBOUNCE_MS = 150;

/**
 * Owns the workbench slice of the persist blob. Merges into the on-disk blob so
 * the boot module's `expanded`/`deferredReloadPending` are preserved; debounces
 * writes and flushes on demand. A DISABLED controller (host mode) is inert —
 * every method is a no-op and the initial snapshot is empty defaults.
 *
 * Lifecycle listeners (pagehide / hidden → flush) are owned by the mounting
 * hook's effect, NOT the constructor, so React StrictMode's simulated
 * unmount/remount re-registers them cleanly (the constructor runs once; effects
 * run twice).
 */
class WorkbenchPersist {
  readonly enabled: boolean;
  /** The disk snapshot at construction time — initial values for the UI. */
  readonly initial: PersistBlob;
  private readonly projectId: string;
  private state: WorkbenchState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly flushBound = () => this.flush();

  constructor(projectId: string, enabled: boolean) {
    this.projectId = projectId;
    this.enabled = enabled;
    const disk = enabled ? readRawBlob(projectId) : undefined;
    this.initial = disk ?? {
      v: PERSIST_VERSION,
      expanded: false,
      deferredReloadPending: false,
      ...emptyState(),
    };
    this.state = {
      route: this.initial.route,
      activeTab: this.initial.activeTab,
      rightTab: this.initial.rightTab,
      rightCollapsed: this.initial.rightCollapsed,
      leftWidth: this.initial.leftWidth,
      rightWidth: this.initial.rightWidth,
      tool: this.initial.tool,
      themeId: this.initial.themeId,
      darkMode: this.initial.darkMode,
      datasetId: this.initial.datasetId,
      transforms: { ...this.initial.transforms },
      chatDraft: this.initial.chatDraft,
      selection: this.initial.selection,
    };
  }

  /** Merge workbench fields and schedule a debounced write. */
  update(partial: Partial<WorkbenchState>): void {
    if (!this.enabled) return;
    this.state = { ...this.state, ...partial };
    this.schedule();
  }

  /** Record the canvas transform for a route key. */
  updateTransform(routeKey: string, transform: StageTransform): void {
    if (!this.enabled) return;
    this.state = {
      ...this.state,
      transforms: { ...this.state.transforms, [routeKey]: transform },
    };
    this.schedule();
  }

  /** Live transform for a route key (in-session values included). */
  getTransform(routeKey: string): StageTransform | undefined {
    return this.state.transforms[routeKey];
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(this.flushBound, WRITE_DEBOUNCE_MS);
  }

  /** Write immediately, merging over the current on-disk blob. */
  flush(): void {
    if (!this.enabled) return;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (typeof window === "undefined") return;
    // Re-read disk so the boot module's expanded/deferredReloadPending win.
    const disk = readRawBlob(this.projectId);
    const merged: PersistBlob = {
      v: PERSIST_VERSION,
      expanded: disk?.expanded ?? this.initial.expanded,
      deferredReloadPending:
        disk?.deferredReloadPending ?? this.initial.deferredReloadPending,
      ...this.state,
    };
    try {
      window.sessionStorage.setItem(
        persistStorageKey(this.projectId),
        JSON.stringify(merged),
      );
    } catch {
      // ignore quota / inaccessible storage
    }
  }

}

export {
  PERSIST_VERSION,
  WorkbenchPersist,
  domPathTo,
  elementAtDomPath,
  emptyState,
  encodeSelection,
  parseBlob,
  persistStorageKey,
};
export type {
  DomNodeLike,
  PersistBlob,
  RouteSnapshot,
  SelectionSnapshot,
  StageTransform,
  WorkbenchState,
};
