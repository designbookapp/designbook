/**
 * The `sandbox` model — pure state for app-mode pins (docs/specs/sandbox.md).
 *
 * The server orchestrator broadcasts `sandbox-event`s over the existing SSE
 * channel as pin turns run and variants land in `.designbook/sandbox/<pinId>/`.
 * This module owns the PURE folds over those events, the GET /api/sandbox →
 * state mapping (reload reconstruction from the durable index, D4), and the
 * `/@fs/` module-URL helper the canvas uses to import wrapper + variant
 * modules (the variations landing mechanism, reused verbatim).
 *
 * The stateful lifecycle (EventSource, fetches) lives in `SandboxProvider`.
 */

type SandboxVariantStatus = "generating" | "ready" | "failed" | "updating";

type SandboxThreadMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

type SandboxTargetState = {
  file: string;
  exportName: string;
  name: string;
  entryId?: string;
  instancePath?: string;
};

/** One live-activity line inside a session's run (U4): a coalesced thinking
 * chunk or one tool call with its live status — the chat ActivityEntry shape,
 * sandbox-local so the fold stays DOM/chat-free. */
type SandboxActivityEntry =
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      status: "running" | "done" | "error";
      detail?: string;
    };

/** Entry cap per activity list (director / one variant) — a runaway session
 * must not grow client state unboundedly; oldest entries drop first. */
const ACTIVITY_ENTRY_CAP = 120;

type SandboxVariantState = {
  id: string;
  intent: string;
  /** Repo-relative variant path. */
  file: string;
  /** Absolute variant path — the /@fs/ module URL base (present once ready). */
  absPath?: string;
  x: number;
  y: number;
  /** User-resized frame size (px). Absent = auto-size to content (the
   * default; old index entries have neither — revive compat). */
  w?: number;
  h?: number;
  status: SandboxVariantStatus;
  /** Bumped per landing/update; cache-busts the dynamic import (?t=). */
  rev: number;
  error?: string;
  /** U4: this variant session's live thinking/tool rows (transient — reset
   * per generation attempt, never persisted/revived). */
  activity: SandboxActivityEntry[];
  /** U4: the CURRENT attempt number while retrying (1 = manual retry). */
  attempt?: number;
  /** O3: the variant's FULL-MODULE override artifact (element pins / edit
   * variants). `moduleFile === file` = the variant IS a full module — the
   * canvas mounts the owner export directly, not through the controller. */
  moduleFile?: string;
};

/** UX v3 (U3): what the classifier routed the LATEST prompt to — the thread
 * shows "generating N variants…" vs plain turn activity from this. */
type SandboxRoutedIntent = { intent: "turn" | "variants"; n?: number };

/** The pin's persisted element locator (U5): how the live DOM element is
 * RE-RESOLVED after a reload dropped the transient anchor. Element pins have
 * always carried one; component pins gained a best-effort copy at creation.
 * Mirrors the server's SandboxElementLocator (outerHtml omitted — matching
 * uses tag/class/text only). */
type SandboxPinLocator = {
  tag: string;
  textHash: string;
  childIndexPath: number[];
  text?: string;
  className?: string;
};

type SandboxPinState = {
  id: string;
  createdAt: number;
  /** Element pins mount through the controller (three layers, E2);
   * component pins keep the two-layer mount (E3). */
  kind: "component" | "element";
  /** Thread title (UX v3 U2): LLM-generated server-side after the first
   * assistant response; absent = fall back to the truncated first prompt. */
  title?: string;
  /** L3: the conversation this pin was born from (drawer grouping). Absent
   * = legacy/ungrouped. */
  conversationId?: string;
  /** Routing of the in-flight/last ask() prompt (cleared per new prompt). */
  routedIntent?: SandboxRoutedIntent;
  /** U5: live-element re-resolution locator (absent on old component pins —
   * preview then needs the transient anchor to still be connected). */
  locator?: SandboxPinLocator;
  target: SandboxTargetState;
  resolved: boolean;
  /** A model op (prompt/iterate/replace) is in flight for this pin. */
  busy: boolean;
  /** The variants-run director step is running (skeleton state). */
  planning: boolean;
  thread: SandboxThreadMessage[];
  variants: SandboxVariantState[];
  /** U4: the DIRECTOR session's live thinking/tool rows for the current
   * variants run (reset at `director-started`; transient). */
  directorActivity: SandboxActivityEntry[];
  /** Absolute path of the pin's generated context wrapper. */
  wrapperAbsPath?: string;
  /** Absolute path of an ELEMENT pin's controller module (once authored). */
  controllerAbsPath?: string;
  /** Last turn/replace error (surface in the prompt box / canvas header). */
  lastError?: string;
};

/** All pins, keyed by pin id. */
type SandboxState = Record<string, SandboxPinState>;

// ---------------------------------------------------------------------------
// Changesets + switches (sandbox overrides O1).
// ---------------------------------------------------------------------------

/** One module override inside a changeset (mirror of the server record).
 * `alternatives` (changeset layers) carry the ALT/variant ids — mirrored
 * layer paths keep the module basename, so ids are never derived from file
 * names. */
type SandboxOverrideState = {
  module: string;
  exportName: string;
  variantFiles: string[];
  alternatives: string[];
  /** The layer's live selection for this module (absent = original). */
  selection?: string;
};

/** A changeset: one exploration's overrides — 1:1 with a pin thread, or a
 * conversation's pin-less DIRECT-EDITS layer (L3: threadPinId ""). */
type SandboxChangesetState = {
  id: string;
  threadPinId: string;
  /** L3: the owning conversation (drawer grouping). Absent = ungrouped. */
  conversationId?: string;
  /** Display title (direct-edits layers carry "Direct edits"). */
  title?: string;
  /** L3: a conversation's direct-edits layer (pin-less). Absent = false. */
  direct?: boolean;
  active: boolean;
  /** O2 drift: the real module changed out-of-band under this active
   * override — the UI badges it and Bake asks for an explicit confirm. */
  drifted: boolean;
  /** O3 stacking: a changeset this work built on (base/bases) is no longer
   * active — badge-only warning (re-run generation to rebase). */
  basedOnInactive: boolean;
  /** Adapter-data keys this exploration's variants ADDED to the real layer
   * (row badge: "adds N strings"); GC'd on discard. */
  dataAdditionCount: number;
  overrides: SandboxOverrideState[];
  /** G3 bake-to-branch: the visible branch this changeset last baked to
   * (badge; the changeset stays active — re-bake stacks commits). */
  bakedTo?: { branch: string; commit: string };
  /** G4 PARK: the live history-preview pointer (the "viewing turn N"
   * banner + the graph marker). Absent = at the selected tips. */
  parked?: { commit: string; ref: string; turn?: string };
  /** G4: sliced fork conversations bound to this changeset (thread
   * grouping — the forked chat shares the parent's layer). */
  forkConversationIds?: string[];
};

/** Per-component switch selection (absent key = original). */
type SandboxSwitchSelection = { changesetId: string; variantId: string };

/** componentKey (`module#export`) → selection. Server-persisted + SSE-synced
 * — every browser agrees on what renders in place. */
type SandboxSwitchesState = Record<string, SandboxSwitchSelection>;

/** One changeset's live bake progress (O2), folded from `bake-status` SSE
 * events. TRANSIENT — never persisted; a reload only sees the durable
 * outcome (resolved pin + thread marker). */
type SandboxBakeState = {
  changesetId: string;
  pinId: string;
  status: "queued" | "running" | "gated" | "done" | "failed";
  error?: string;
  /** G3: set when this bake targets a VISIBLE branch (bake-to-branch). */
  branch?: string;
};

/** One changeset's live REBASE progress (G3 drift→rebase), folded from
 * `rebase-status` SSE events. TRANSIENT — never persisted. */
type SandboxRebaseState = {
  changesetId: string;
  pinId: string;
  status: "running" | "conflict" | "done" | "failed";
  error?: string;
};

/** SERVER-computed file-level layer conflict (changeset layers): the same
 * repo file is overridden by ≥2 ACTIVE layers (data files exempt). Mirrors
 * the node LayerConflict wire shape (GET /api/sandbox + the
 * `changesets-changed` event). */
type SandboxFileConflict = { file: string; changesetIds: string[] };

/** SERVER-computed data-merge conflict: the same key changed by ≥2 active
 * layers with different values (serve-time structured merge). */
type SandboxDataConflict = { file: string; key: string; changesetIds: string[] };

/** G2 reapply (spec §Selection): the ONE live offer/progress after a variant
 * switch left post-selection edits behind. TRANSIENT — never persisted; a
 * decline (dismiss) simply clears it, the edits stay on the old branch. */
type SandboxReapplyState = {
  changesetId: string;
  /** The owning pin thread (empty for direct-edits layers). */
  pinId: string;
  fromRef: string;
  fromAlt: string;
  toRef: string;
  toAlt: string;
  /** Pending post-selection commits on the old branch. */
  count: number;
  status: "offered" | "running" | "conflict" | "failed";
  error?: string;
};

/** The full sandbox store: pins + the O1 changeset/switch state + the O2
 * transient bake progress (keyed by changeset id) + the server's live
 * conflict surfacing (file-level layer conflicts + data-key conflicts) +
 * the G2 transient reapply offer. */
type SandboxStore = {
  pins: SandboxState;
  changesets: SandboxChangesetState[];
  switches: SandboxSwitchesState;
  bakes: Record<string, SandboxBakeState>;
  /** G3 transient rebase progress per changeset (`rebase-status` SSE). */
  rebases: Record<string, SandboxRebaseState>;
  conflicts: SandboxFileConflict[];
  dataConflicts: SandboxDataConflict[];
  reapply?: SandboxReapplyState;
};

/** The switch identity of one overridable component (server parity). */
function sandboxComponentKey(module: string, exportName: string): string {
  return `${module}#${exportName}`;
}

type SandboxEvent = {
  type?: string;
  pinId?: string;
  pin?: unknown;
  message?: { role?: string; text?: string; at?: number };
  variants?: Array<{
    id?: string;
    intent?: string;
    file?: string;
    x?: number;
    y?: number;
  }>;
  variantId?: string;
  intent?: string;
  /** `intent-routed`: the variant count the classifier settled on. */
  n?: number;
  /** `pin-title`: the generated thread title (U2). */
  title?: string;
  file?: string;
  absPath?: string;
  /** `variant-retrying`: the upcoming attempt number (1 = manual retry). */
  attempt?: number;
  /** `session-activity` (U4): which ephemeral session spoke. */
  sessionRole?: string;
  /** `session-activity`: one coalesced thinking/tool delta. */
  entry?: {
    kind?: string;
    text?: string;
    id?: string;
    name?: string;
    status?: string;
    detail?: string;
  };
  wrapperAbsPath?: string;
  controllerAbsPath?: string;
  x?: number;
  y?: number;
  rev?: number;
  error?: string;
  mode?: string;
  /** `switch-changed`: which component flipped (absent on bulk clears). */
  component?: string;
  /** `switch-changed`: the new selection (null = original). */
  selection?: { changesetId?: string; variantId?: string } | null;
  /** `switch-changed`: the home's FULL switch snapshot (fold source). */
  switches?: unknown;
  /** `changesets-changed`: the home's full changeset list. */
  changesets?: unknown;
  /** `changesets-changed`: file-level layer conflicts (server-computed). */
  conflicts?: unknown;
  /** `changesets-changed`: data-key merge conflicts (server-computed). */
  dataConflicts?: unknown;
  /** `bake-status` (O2): which changeset's bake progressed. */
  changesetId?: string;
  /** `bake-status`: queued | running | gated | done | failed. */
  status?: string;
  /** `reapply-*` (G2): the branches + pending-commit count of the offer. */
  fromRef?: string;
  fromAlt?: string;
  toRef?: string;
  toAlt?: string;
  count?: number;
  applied?: number;
  /** `bake-status`/`baked-to-branch` (G3): the visible target branch.
   * (`targetBranch` on the wire — the top-level `branch` field is the
   * branch-session tag, see `sandboxEventMatchesBranch`.) */
  targetBranch?: string;
  /** Branch-session tag (absent = primary) — every sandbox event carries
   * the branch of the HOME it belongs to. */
  branch?: string;
  commit?: string;
};

// ---------------------------------------------------------------------------
// Status payload → state (reload reconstruction).
// ---------------------------------------------------------------------------

type SandboxStatusPayload = {
  pins?: Array<{
    id?: string;
    createdAt?: number;
    kind?: string;
    title?: string;
    conversationId?: string;
    target?: Partial<SandboxTargetState>;
    locator?: {
      tag?: string;
      textHash?: string;
      childIndexPath?: number[];
      text?: string;
      className?: string;
    };
    resolved?: boolean;
    busy?: boolean;
    thread?: Array<{ role?: string; text?: string; at?: number }>;
    wrapperAbsPath?: string;
    controllerAbsPath?: string;
    variants?: Array<{
      id?: string;
      intent?: string;
      file?: string;
      absPath?: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      status?: string;
      rev?: number;
      error?: string;
      moduleFile?: string;
    }>;
  }>;
};

const VARIANT_STATUSES: SandboxVariantStatus[] = [
  "generating",
  "ready",
  "failed",
  "updating",
];

function threadFromWire(
  raw: Array<{ role?: string; text?: string; at?: number }> | undefined,
): SandboxThreadMessage[] {
  return (raw ?? []).flatMap((message) =>
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string"
      ? [{ role: message.role, text: message.text, at: message.at ?? 0 }]
      : [],
  );
}

function pinsFromStatus(payload: SandboxStatusPayload): SandboxState {
  const state: SandboxState = {};
  for (const raw of payload.pins ?? []) {
    if (!raw.id || !raw.target?.file || !raw.target.exportName) continue;
    state[raw.id] = {
      id: raw.id,
      createdAt: raw.createdAt ?? 0,
      // Pre-v2 servers/indexes carry no kind — component pins (compat).
      kind: raw.kind === "element" ? "element" : "component",
      // Pre-v3 pins carry no title — clients fall back to the first prompt.
      ...(typeof raw.title === "string" && raw.title
        ? { title: raw.title }
        : {}),
      // L3: conversation linkage (absent on legacy pins — "ungrouped").
      ...(typeof raw.conversationId === "string" && raw.conversationId
        ? { conversationId: raw.conversationId }
        : {}),
      // U5: the persisted locator revives element re-resolution (absent on
      // old component pins — preview needs a live anchor then).
      ...(raw.locator &&
      typeof raw.locator.tag === "string" &&
      raw.locator.tag &&
      typeof raw.locator.textHash === "string"
        ? {
            locator: {
              tag: raw.locator.tag,
              textHash: raw.locator.textHash,
              childIndexPath: Array.isArray(raw.locator.childIndexPath)
                ? raw.locator.childIndexPath.filter(
                    (index): index is number => typeof index === "number",
                  )
                : [],
              ...(typeof raw.locator.text === "string" && raw.locator.text
                ? { text: raw.locator.text }
                : {}),
              ...(typeof raw.locator.className === "string" &&
              raw.locator.className
                ? { className: raw.locator.className }
                : {}),
            },
          }
        : {}),
      target: {
        file: raw.target.file,
        exportName: raw.target.exportName,
        name: raw.target.name ?? raw.target.exportName,
        entryId: raw.target.entryId,
        instancePath: raw.target.instancePath,
      },
      resolved: raw.resolved === true,
      busy: raw.busy === true,
      planning: false,
      directorActivity: [],
      thread: threadFromWire(raw.thread),
      wrapperAbsPath: raw.wrapperAbsPath,
      controllerAbsPath: raw.controllerAbsPath,
      variants: (raw.variants ?? []).flatMap((variant) => {
        if (!variant.id || !variant.file) return [];
        const status = VARIANT_STATUSES.includes(
          variant.status as SandboxVariantStatus,
        )
          ? (variant.status as SandboxVariantStatus)
          : "failed";
        return [
          {
            id: variant.id,
            intent: variant.intent ?? "",
            file: variant.file,
            absPath: variant.absPath,
            x: variant.x ?? 0,
            y: variant.y ?? 0,
            // Absent w/h = auto-size (old entries + non-resized variants).
            ...(typeof variant.w === "number" && variant.w > 0
              ? { w: variant.w }
              : {}),
            ...(typeof variant.h === "number" && variant.h > 0
              ? { h: variant.h }
              : {}),
            status,
            rev: variant.rev ?? 0,
            error: variant.error,
            activity: [],
            ...(typeof variant.moduleFile === "string" && variant.moduleFile
              ? { moduleFile: variant.moduleFile }
              : {}),
          },
        ];
      }),
    };
  }
  return state;
}

/** Changeset list off the wire (status payload or `changesets-changed`). */
function changesetsFromWire(raw: unknown): SandboxChangesetState[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    const record = candidate as {
      id?: unknown;
      threadPinId?: unknown;
      conversationId?: unknown;
      title?: unknown;
      direct?: unknown;
      active?: unknown;
      drifted?: unknown;
      basedOnInactive?: unknown;
      dataAdditionCount?: unknown;
      overrides?: unknown;
      bakedTo?: unknown;
      parked?: unknown;
      forkConversationIds?: unknown;
    } | null;
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.threadPinId !== "string"
    ) {
      return [];
    }
    return [
      {
        id: record.id,
        threadPinId: record.threadPinId,
        ...(typeof record.conversationId === "string" && record.conversationId
          ? { conversationId: record.conversationId }
          : {}),
        ...(typeof record.title === "string" && record.title
          ? { title: record.title }
          : {}),
        ...(record.direct === true ? { direct: true } : {}),
        active: record.active === true,
        drifted: record.drifted === true,
        basedOnInactive: record.basedOnInactive === true,
        dataAdditionCount:
          typeof record.dataAdditionCount === "number" &&
          record.dataAdditionCount > 0
            ? record.dataAdditionCount
            : 0,
        overrides: Array.isArray(record.overrides)
          ? record.overrides.flatMap((override) => {
              const entry = override as {
                module?: unknown;
                exportName?: unknown;
                variantFiles?: unknown;
                alternatives?: unknown;
                selection?: unknown;
              } | null;
              return entry &&
                typeof entry.module === "string" &&
                typeof entry.exportName === "string"
                ? [
                    {
                      module: entry.module,
                      exportName: entry.exportName,
                      variantFiles: Array.isArray(entry.variantFiles)
                        ? entry.variantFiles.filter(
                            (file): file is string => typeof file === "string",
                          )
                        : [],
                      alternatives: Array.isArray(entry.alternatives)
                        ? entry.alternatives.filter(
                            (alt): alt is string => typeof alt === "string",
                          )
                        : [],
                      ...(typeof entry.selection === "string" &&
                      entry.selection
                        ? { selection: entry.selection }
                        : {}),
                    },
                  ]
                : [];
            })
          : [],
        ...(() => {
          const bakedTo = record.bakedTo as {
            branch?: unknown;
            commit?: unknown;
          } | null;
          return bakedTo &&
            typeof bakedTo === "object" &&
            typeof bakedTo.branch === "string" &&
            bakedTo.branch
            ? {
                bakedTo: {
                  branch: bakedTo.branch,
                  commit:
                    typeof bakedTo.commit === "string" ? bakedTo.commit : "",
                },
              }
            : {};
        })(),
        ...(() => {
          // G4 park pointer (banner + graph marker).
          const parked = record.parked as {
            commit?: unknown;
            ref?: unknown;
            turn?: unknown;
          } | null;
          return parked &&
            typeof parked === "object" &&
            typeof parked.commit === "string" &&
            parked.commit &&
            typeof parked.ref === "string" &&
            parked.ref
            ? {
                parked: {
                  commit: parked.commit,
                  ref: parked.ref,
                  ...(typeof parked.turn === "string" && parked.turn
                    ? { turn: parked.turn }
                    : {}),
                },
              }
            : {};
        })(),
        ...(Array.isArray(record.forkConversationIds)
          ? {
              forkConversationIds: record.forkConversationIds.filter(
                (id): id is string => typeof id === "string" && id.length > 0,
              ),
            }
          : {}),
      },
    ];
  });
}

/** Switch snapshot off the wire (status payload or `switch-changed`). */
function switchesFromWire(raw: unknown): SandboxSwitchesState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SandboxSwitchesState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const selection = value as {
      changesetId?: unknown;
      variantId?: unknown;
    } | null;
    if (
      selection &&
      typeof selection.changesetId === "string" &&
      typeof selection.variantId === "string"
    ) {
      out[key] = {
        changesetId: selection.changesetId,
        variantId: selection.variantId,
      };
    }
  }
  return out;
}

/** File-level conflict list off the wire (status payload or
 * `changesets-changed`). Malformed entries drop. */
function fileConflictsFromWire(raw: unknown): SandboxFileConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    const record = candidate as { file?: unknown; changesetIds?: unknown } | null;
    if (!record || typeof record.file !== "string" || !record.file) return [];
    const ids = Array.isArray(record.changesetIds)
      ? record.changesetIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [];
    return ids.length >= 2 ? [{ file: record.file, changesetIds: ids }] : [];
  });
}

/** Data-key conflict list off the wire. Malformed entries drop. */
function dataConflictsFromWire(raw: unknown): SandboxDataConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    const record = candidate as {
      file?: unknown;
      key?: unknown;
      changesetIds?: unknown;
    } | null;
    if (
      !record ||
      typeof record.file !== "string" ||
      !record.file ||
      typeof record.key !== "string"
    ) {
      return [];
    }
    const ids = Array.isArray(record.changesetIds)
      ? record.changesetIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [];
    return ids.length >= 2
      ? [{ file: record.file, key: record.key, changesetIds: ids }]
      : [];
  });
}

/** GET /api/sandbox → the full store (legacy servers: pins only). Bake
 * progress is transient SSE state — a reload starts with none. */
/** Revive the status payload's LIVE reapply offer (G2 — a selection switch
 * full-reloads the page, so the offer must survive reload reconstruction). */
function reapplyFromWire(raw: unknown): SandboxReapplyState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.changesetId !== "string" || !record.changesetId) {
    return undefined;
  }
  return {
    changesetId: record.changesetId,
    pinId: typeof record.pinId === "string" ? record.pinId : "",
    fromRef: typeof record.fromRef === "string" ? record.fromRef : "",
    fromAlt: typeof record.fromAlt === "string" ? record.fromAlt : "",
    toRef: typeof record.toRef === "string" ? record.toRef : "",
    toAlt: typeof record.toAlt === "string" ? record.toAlt : "",
    count: typeof record.count === "number" ? record.count : 0,
    status: "offered",
  };
}

function storeFromStatus(
  payload: SandboxStatusPayload & {
    changesets?: unknown;
    switches?: unknown;
    conflicts?: unknown;
    dataConflicts?: unknown;
    reapply?: unknown;
  },
): SandboxStore {
  const reapply = reapplyFromWire(payload.reapply);
  return {
    pins: pinsFromStatus(payload),
    changesets: changesetsFromWire(payload.changesets),
    switches: switchesFromWire(payload.switches),
    bakes: {},
    rebases: {},
    conflicts: fileConflictsFromWire(payload.conflicts),
    dataConflicts: dataConflictsFromWire(payload.dataConflicts),
    ...(reapply ? { reapply } : {}),
  };
}

// ---------------------------------------------------------------------------
// Event folds.
// ---------------------------------------------------------------------------

function patchPin(
  state: SandboxState,
  pinId: string,
  patch: (pin: SandboxPinState) => SandboxPinState,
): SandboxState {
  const pin = state[pinId];
  if (!pin) return state;
  return { ...state, [pinId]: patch(pin) };
}

function patchVariant(
  pin: SandboxPinState,
  variantId: string,
  patch: Partial<SandboxVariantState>,
): SandboxPinState {
  return {
    ...pin,
    variants: pin.variants.map((variant) =>
      variant.id === variantId ? { ...variant, ...patch, id: variantId } : variant,
    ),
  };
}

/**
 * Fold one live-activity delta into an entry list (U4): thinking chunks
 * EXTEND the trailing thinking entry (the server ships coalesced deltas of a
 * streamed block); tool entries UPSERT by call id so start→end flips
 * running→done/error in place (the end event carries no detail — keep the
 * start's). Capped at ACTIVITY_ENTRY_CAP, oldest first out.
 */
function appendSandboxActivity(
  entries: SandboxActivityEntry[],
  entry: SandboxActivityEntry,
): SandboxActivityEntry[] {
  let next: SandboxActivityEntry[];
  const last = entries[entries.length - 1];
  if (entry.type === "thinking" && last?.type === "thinking") {
    next = [
      ...entries.slice(0, -1),
      { type: "thinking", text: last.text + entry.text },
    ];
  } else if (entry.type === "tool") {
    const index = entries.findIndex(
      (candidate) => candidate.type === "tool" && candidate.id === entry.id,
    );
    next =
      index === -1
        ? [...entries, entry]
        : entries.map((candidate, i) =>
            i === index
              ? {
                  ...entry,
                  detail:
                    entry.detail ??
                    (candidate.type === "tool" ? candidate.detail : undefined),
                }
              : candidate,
          );
  } else {
    next = [...entries, entry];
  }
  return next.length > ACTIVITY_ENTRY_CAP
    ? next.slice(next.length - ACTIVITY_ENTRY_CAP)
    : next;
}

/** Parse a `session-activity` wire entry; undefined = malformed (dropped). */
function activityEntryFromWire(
  raw: SandboxEvent["entry"],
): SandboxActivityEntry | undefined {
  if (!raw) return undefined;
  if (raw.kind === "thinking" && typeof raw.text === "string" && raw.text) {
    return { type: "thinking", text: raw.text };
  }
  if (raw.kind === "tool" && typeof raw.name === "string") {
    return {
      type: "tool",
      id: typeof raw.id === "string" && raw.id ? raw.id : raw.name,
      name: raw.name,
      status:
        raw.status === "done" || raw.status === "error" ? raw.status : "running",
      ...(typeof raw.detail === "string" && raw.detail
        ? { detail: raw.detail }
        : {}),
    };
  }
  return undefined;
}

/** Fold one `sandbox-event` into the state. Unknown types are no-ops. */
function applySandboxEvent(
  state: SandboxState,
  event: SandboxEvent,
): SandboxState {
  const pinId = event.pinId;
  if (!pinId) return state;

  switch (event.type) {
    case "pin-created": {
      const folded = pinsFromStatus({
        pins: [event.pin as NonNullable<SandboxStatusPayload["pins"]>[number]],
      });
      const pin = folded[pinId];
      return pin ? { ...state, [pinId]: pin } : state;
    }
    case "thread": {
      const message = event.message;
      const role = message?.role;
      const text = message?.text;
      if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
        return state;
      }
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: true,
        // A NEW user prompt hasn't been routed yet (U3) — clear stale intent.
        ...(role === "user" ? { routedIntent: undefined } : {}),
        thread: [...pin.thread, { role, text, at: message?.at ?? 0 }],
      }));
    }
    case "intent-routed":
      // U3: the classifier decided — the thread shows "generating N
      // variants…" vs plain turn activity from this.
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: true,
        routedIntent:
          event.intent === "variants"
            ? { intent: "variants", ...(event.n ? { n: event.n } : {}) }
            : { intent: "turn" },
      }));
    case "pin-title":
      // U2: the generated thread title landed (also persisted in the index).
      if (typeof event.title !== "string" || !event.title) return state;
      return patchPin(state, pinId, (pin) => ({ ...pin, title: event.title }));
    case "director-started":
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: true,
        planning: true,
        lastError: undefined,
        // A fresh variants run — the transparency rows restart (U4).
        directorActivity: [],
      }));
    case "session-activity": {
      // U4: one coalesced thinking/tool delta from an ephemeral session,
      // keyed {pinId, sessionRole, variantId?}.
      const entry = activityEntryFromWire(event.entry);
      if (!entry) return state;
      if (event.sessionRole === "director") {
        return patchPin(state, pinId, (pin) => ({
          ...pin,
          directorActivity: appendSandboxActivity(pin.directorActivity, entry),
        }));
      }
      if (event.sessionRole === "variant" && event.variantId) {
        return patchPin(state, pinId, (pin) =>
          patchVariant(pin, event.variantId!, {
            activity: appendSandboxActivity(
              pin.variants.find((v) => v.id === event.variantId)?.activity ??
                [],
              entry,
            ),
          }),
        );
      }
      return state;
    }
    case "variants-planned":
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        planning: false,
        variants: [
          ...pin.variants,
          ...(event.variants ?? []).flatMap((variant) =>
            variant.id && !pin.variants.some((v) => v.id === variant.id)
              ? [
                  {
                    id: variant.id,
                    intent: variant.intent ?? "",
                    file: variant.file ?? "",
                    x: variant.x ?? 0,
                    y: variant.y ?? 0,
                    status: "generating" as const,
                    rev: 0,
                    activity: [],
                  },
                ]
              : [],
          ),
        ],
      }));
    case "variant-ready":
      if (!event.variantId) return state;
      return patchPin(state, pinId, (pin) =>
        patchVariant(
          {
            ...pin,
            ...(event.wrapperAbsPath
              ? { wrapperAbsPath: event.wrapperAbsPath }
              : {}),
            ...(event.controllerAbsPath
              ? { controllerAbsPath: event.controllerAbsPath }
              : {}),
          },
          event.variantId!,
          {
            status: "ready",
            absPath: event.absPath,
            rev: event.rev ?? 1,
            error: undefined,
            attempt: undefined,
            ...(typeof event.intent === "string" ? { intent: event.intent } : {}),
          },
        ),
      );
    case "variant-failed":
      if (!event.variantId) return state;
      return patchPin(state, pinId, (pin) =>
        patchVariant(pin, event.variantId!, {
          status: "failed",
          error: event.error ?? "Generation failed.",
          attempt: undefined,
        }),
      );
    case "variant-retrying":
      // Auto-retry after a transient turn failure, or a manual Retry: the
      // variant is generating again (its card returns to the skeleton state,
      // its activity restarts for the fresh attempt).
      if (!event.variantId) return state;
      return patchPin(state, pinId, (pin) => ({
        ...patchVariant(pin, event.variantId!, {
          status: "generating",
          error: undefined,
          activity: [],
          ...(typeof event.attempt === "number"
            ? { attempt: event.attempt }
            : {}),
        }),
        busy: true,
      }));
    case "variant-updating":
      if (!event.variantId) return state;
      return patchPin(state, pinId, (pin) => ({
        ...patchVariant(pin, event.variantId!, { status: "updating" }),
        busy: true,
      }));
    case "variant-updated":
      if (!event.variantId) return state;
      return patchPin(state, pinId, (pin) => ({
        ...patchVariant(pin, event.variantId!, {
          status: "ready",
          absPath: event.absPath,
          rev: event.rev ?? 1,
          error: undefined,
        }),
        busy: false,
      }));
    case "turn-start":
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: true,
        lastError: undefined,
      }));
    case "turn-end":
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: false,
        lastError: event.error,
      }));
    case "run-complete":
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: false,
        planning: false,
      }));
    case "replace-started":
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: true,
        lastError: undefined,
      }));
    case "replace-failed":
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: false,
        lastError: event.error ?? "Replace failed.",
      }));
    case "replaced":
    case "baked":
    case "discarded":
      // D3: resolved = kept as history, hidden from canvas. Bake and discard
      // (O2) resolve the pin the same way — the thread carries the marker.
      return patchPin(state, pinId, (pin) => ({
        ...pin,
        busy: false,
        resolved: true,
      }));
    default:
      return state;
  }
}

/**
 * Fold one `sandbox-event` into the full STORE: the O1 events
 * (`switch-changed`, `changesets-changed`) replace their slice from the
 * event's snapshot; everything else is the pins fold above.
 */
const BAKE_STATUSES: SandboxBakeState["status"][] = [
  "queued",
  "running",
  "gated",
  "done",
  "failed",
];

function applySandboxStoreEvent(
  store: SandboxStore,
  event: SandboxEvent,
): SandboxStore {
  if (event.type === "switch-changed") {
    return { ...store, switches: switchesFromWire(event.switches) };
  }
  if (event.type === "changesets-changed") {
    return {
      ...store,
      changesets: changesetsFromWire(event.changesets),
      // The event carries the server's live conflict recompute alongside the
      // list (older wires omit it — treat as none, matching the payload).
      conflicts: fileConflictsFromWire(event.conflicts),
      dataConflicts: dataConflictsFromWire(event.dataConflicts),
    };
  }
  if (event.type === "bake-status") {
    // O2: one changeset's bake progressed (queued/running/gated/done/failed).
    if (
      typeof event.changesetId !== "string" ||
      !event.changesetId ||
      typeof event.pinId !== "string" ||
      !BAKE_STATUSES.includes(event.status as SandboxBakeState["status"])
    ) {
      return store;
    }
    return {
      ...store,
      bakes: {
        ...store.bakes,
        [event.changesetId]: {
          changesetId: event.changesetId,
          pinId: event.pinId,
          status: event.status as SandboxBakeState["status"],
          ...(typeof event.error === "string" && event.error
            ? { error: event.error }
            : {}),
          ...(typeof event.targetBranch === "string" && event.targetBranch
            ? { branch: event.targetBranch }
            : {}),
        },
      },
    };
  }
  if (event.type === "rebase-status") {
    // G3: one changeset's rebase progressed (running/conflict/done/failed).
    const statuses: SandboxRebaseState["status"][] = [
      "running",
      "conflict",
      "done",
      "failed",
    ];
    if (
      typeof event.changesetId !== "string" ||
      !event.changesetId ||
      !statuses.includes(event.status as SandboxRebaseState["status"])
    ) {
      return store;
    }
    return {
      ...store,
      rebases: {
        ...store.rebases,
        [event.changesetId]: {
          changesetId: event.changesetId,
          pinId: typeof event.pinId === "string" ? event.pinId : "",
          status: event.status as SandboxRebaseState["status"],
          ...(typeof event.error === "string" && event.error
            ? { error: event.error }
            : {}),
        },
      },
    };
  }
  // G2 reapply (spec §Selection): one transient offer/progress at a time —
  // a fresh offer replaces any stale one; done/dismissed clears it.
  if (event.type === "reapply-available") {
    if (typeof event.changesetId !== "string" || !event.changesetId) {
      return store;
    }
    return {
      ...store,
      reapply: {
        changesetId: event.changesetId,
        pinId: typeof event.pinId === "string" ? event.pinId : "",
        fromRef: typeof event.fromRef === "string" ? event.fromRef : "",
        fromAlt: typeof event.fromAlt === "string" ? event.fromAlt : "",
        toRef: typeof event.toRef === "string" ? event.toRef : "",
        toAlt: typeof event.toAlt === "string" ? event.toAlt : "",
        count: typeof event.count === "number" ? event.count : 0,
        status: "offered",
      },
    };
  }
  if (
    event.type === "reapply-started" ||
    event.type === "reapply-conflict"
  ) {
    if (!store.reapply || store.reapply.changesetId !== event.changesetId) {
      return store;
    }
    return {
      ...store,
      reapply: {
        ...store.reapply,
        status: event.type === "reapply-conflict" ? "conflict" : "running",
      },
    };
  }
  if (event.type === "reapply-failed") {
    if (!store.reapply || store.reapply.changesetId !== event.changesetId) {
      return store;
    }
    return {
      ...store,
      reapply: {
        ...store.reapply,
        status: "failed",
        ...(typeof event.error === "string" && event.error
          ? { error: event.error }
          : {}),
      },
    };
  }
  if (event.type === "reapply-done" || event.type === "reapply-dismissed") {
    if (!store.reapply) return store;
    const { reapply: _cleared, ...rest } = store;
    return rest;
  }
  const pins = applySandboxEvent(store.pins, event);
  return pins === store.pins ? store : { ...store, pins };
}

// ---------------------------------------------------------------------------
// Derived views (O1 switches).
// ---------------------------------------------------------------------------

/** The pin's ACTIVE changeset (1:1 by threadPinId), if any. */
function activeChangesetForPin(
  changesets: SandboxChangesetState[],
  pinId: string,
): SandboxChangesetState | undefined {
  return changesets.find(
    (changeset) => changeset.threadPinId === pinId && changeset.active,
  );
}

/**
 * The variant of `pin` currently switched IN PLACE (via the pin's own
 * changeset), or undefined when the component renders the original / another
 * changeset's variant.
 */
function inPlaceVariantId(
  store: Pick<SandboxStore, "changesets" | "switches">,
  pin: Pick<SandboxPinState, "id" | "target">,
): string | undefined {
  const changeset = activeChangesetForPin(store.changesets, pin.id);
  if (!changeset) return undefined;
  const selection =
    store.switches[
      sandboxComponentKey(pin.target.file, pin.target.exportName)
    ];
  return selection && selection.changesetId === changeset.id
    ? selection.variantId
    : undefined;
}

/** "Sandbox active" badge state: any ACTIVE changeset with landed overrides. */
function sandboxOverridesActive(
  changesets: SandboxChangesetState[],
): boolean {
  return activeChangesetCount(changesets) > 0;
}

/** How many changesets are ACTIVE with landed overrides (tray badge count,
 * O2 — the "sandbox active" pill extends with it). */
function activeChangesetCount(changesets: SandboxChangesetState[]): number {
  return changesets.filter(
    (changeset) =>
      changeset.active &&
      changeset.overrides.some(
        (override) =>
          override.variantFiles.length > 0 ||
          (override.alternatives?.length ?? 0) > 0,
      ),
  ).length;
}

/** The live bake progress for a pin's changeset (O2), if any. */
function bakeStateForPin(
  bakes: Record<string, SandboxBakeState>,
  pinId: string,
): SandboxBakeState | undefined {
  return Object.values(bakes).find((bake) => bake.pinId === pinId);
}

// ---------------------------------------------------------------------------
// Derived views (O3 same-export conflicts).
// ---------------------------------------------------------------------------

/** One FILE-LEVEL conflict (changeset layers): the same repo file is
 * overridden by ≥2 ACTIVE changesets — the UI surfaces choose-or-compose.
 * `component` keeps the first participant's componentKey for the wire
 * actions (setSwitch/compose parse the module off it). */
type SandboxExportConflict = {
  component: string;
  file: string;
  changesetIds: string[];
};

/** All file-level conflicts across the active changesets (layers: two
 * changesets touching different exports of one file IS a conflict —
 * accepted narrowing, docs/specs/changeset-layers.md). */
function sameExportConflicts(
  changesets: SandboxChangesetState[],
): SandboxExportConflict[] {
  const byFile = new Map<string, { component: string; ids: string[] }>();
  for (const changeset of changesets) {
    if (!changeset.active) continue;
    for (const override of changeset.overrides) {
      if (
        override.variantFiles.length === 0 &&
        (override.alternatives?.length ?? 0) === 0
      ) {
        continue;
      }
      const entry = byFile.get(override.module) ?? {
        component: sandboxComponentKey(override.module, override.exportName),
        ids: [],
      };
      if (!entry.ids.includes(changeset.id)) entry.ids.push(changeset.id);
      byFile.set(override.module, entry);
    }
  }
  return [...byFile]
    .filter(([, entry]) => entry.ids.length >= 2)
    .map(([file, entry]) => ({
      component: entry.component,
      file,
      changesetIds: entry.ids,
    }));
}

/** The conflict a pin's ACTIVE changeset participates in, if any (O3 —
 * drives the thread row badge + the thread view's choose/compose bar). */
function conflictForPin(
  changesets: SandboxChangesetState[],
  pinId: string,
): SandboxExportConflict | undefined {
  const own = activeChangesetForPin(changesets, pinId);
  if (!own) return undefined;
  return sameExportConflicts(changesets).find((conflict) =>
    conflict.changesetIds.includes(own.id),
  );
}

/** Changeset ids participating in ANY server-reported conflict (file-level
 * layer conflicts + data-key conflicts) — the Changes-panel group badges. */
function conflictedChangesetIds(
  conflicts: SandboxFileConflict[],
  dataConflicts: SandboxDataConflict[],
): Set<string> {
  return new Set([
    ...conflicts.flatMap((conflict) => conflict.changesetIds),
    ...dataConflicts.flatMap((conflict) => conflict.changesetIds),
  ]);
}

/** Pin ids whose active changeset is in ANY same-export conflict (badges). */
function conflictedPinIds(
  changesets: SandboxChangesetState[],
): Set<string> {
  const conflicted = new Set(
    sameExportConflicts(changesets).flatMap(
      (conflict) => conflict.changesetIds,
    ),
  );
  return new Set(
    changesets
      .filter((changeset) => conflicted.has(changeset.id))
      .map((changeset) => changeset.threadPinId),
  );
}

// ---------------------------------------------------------------------------
// Derived views.
// ---------------------------------------------------------------------------

/** Pins the tray/bubbles show: unresolved, newest last (creation order). */
function activePins(state: SandboxState): SandboxPinState[] {
  return Object.values(state)
    .filter((pin) => !pin.resolved)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** One-word pin status for bubbles/tray badges. */
function pinStatus(
  pin: SandboxPinState,
): "idle" | "working" | "generating" | "ready" | "failed" {
  if (pin.planning || pin.variants.some((v) => v.status === "generating")) {
    return "generating";
  }
  if (pin.busy) return "working";
  if (pin.variants.some((v) => v.status === "ready")) return "ready";
  if (pin.variants.length > 0 && pin.variants.every((v) => v.status === "failed")) {
    return "failed";
  }
  return "idle";
}

/** `n/m ready` progress for a generating pin's bubble. */
function readyCounts(pin: SandboxPinState): { ready: number; total: number } {
  return {
    ready: pin.variants.filter((v) => v.status === "ready").length,
    total: pin.variants.length,
  };
}

/**
 * Dev-server module URL for a sandbox file. `/@fs/` + absolute path works in
 * BOTH modes (probe-verified for variations; same mechanism). `?t=<rev>`
 * cache-busts re-imports after an iterate edit.
 */
function sandboxModuleUrl(absPath: string, rev: number): string {
  return `/@fs${absPath.startsWith("/") ? "" : "/"}${absPath}?t=${rev}`;
}

// ---------------------------------------------------------------------------
// Canvas-frame sizing (pure): the auto-size-by-default / user-resize fold.
// ---------------------------------------------------------------------------

/** Explicit user-resize bounds. Below MIN a frame is unusably small; MAX keeps
 * a single frame from swallowing the canvas. Auto (fit-content) frames clamp
 * their WIDTH to [AUTO_MIN_WIDTH, AUTO_MAX_WIDTH] in CSS; height grows freely. */
const SANDBOX_FRAME_MIN_WIDTH = 200;
const SANDBOX_FRAME_MIN_HEIGHT = 120;
const SANDBOX_FRAME_MAX_WIDTH = 2000;
const SANDBOX_FRAME_MAX_HEIGHT = 2000;
/** Auto-size width band (CSS min/max on the fit-content frame). */
const SANDBOX_AUTO_MIN_WIDTH = 320;
const SANDBOX_AUTO_MAX_WIDTH = 640;

type SandboxFrameSize = { w: number; h: number };

/** Clamp a user-dragged frame size to sane bounds (rounded, finite). */
function clampFrameSize(w: number, h: number): SandboxFrameSize {
  const clamp = (value: number, min: number, max: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
  return {
    w: clamp(w, SANDBOX_FRAME_MIN_WIDTH, SANDBOX_FRAME_MAX_WIDTH),
    h: clamp(h, SANDBOX_FRAME_MIN_HEIGHT, SANDBOX_FRAME_MAX_HEIGHT),
  };
}

/**
 * The size fold for one frame: a local resize echo wins over the persisted
 * record until the next reload (size POSTs aren't broadcast — the resizing
 * client owns the truth, mirroring drag positions). An echo of `null` is an
 * explicit reset-to-auto; `undefined`/absent falls through to the record's
 * persisted w/h, and a record with no w/h (old entries) is auto-size.
 */
function resolveFrameSize(
  echo: SandboxFrameSize | null | undefined,
  variant: Pick<SandboxVariantState, "w" | "h">,
): SandboxFrameSize | undefined {
  if (echo === null) return undefined;
  if (echo) return echo;
  return typeof variant.w === "number" && typeof variant.h === "number"
    ? { w: variant.w, h: variant.h }
    : undefined;
}

// ---------------------------------------------------------------------------
// Thread titles (UX v3 U2) — fallback derivation.
// ---------------------------------------------------------------------------

const THREAD_TITLE_CAP = 48;

/** A pin thread's display title: the generated title, else the truncated
 * first prompt, else the anchor label (a pin with no prompt yet). */
function pinThreadTitle(
  pin: Pick<SandboxPinState, "title" | "thread"> & {
    target: Pick<SandboxTargetState, "name">;
  },
): string {
  if (pin.title) return pin.title;
  const first = pin.thread.find((message) => message.role === "user")?.text;
  const line = first?.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return pin.target.name;
  return line.length > THREAD_TITLE_CAP
    ? `${line.slice(0, THREAD_TITLE_CAP - 1)}…`
    : line;
}

/** Epoch ms of a pin thread's latest activity (list ordering + row time). */
function pinLastActivity(
  pin: Pick<SandboxPinState, "createdAt" | "thread">,
): number {
  return Math.max(pin.createdAt, ...pin.thread.map((message) => message.at));
}

/**
 * Branch-session scoping for sandbox events (per-branch-sessions spec, the
 * pi-event rule applied to the sandbox stream): every `sandbox-event` is
 * tagged with the branch of the HOME it belongs to (absent = primary), and
 * a client folds ONLY its own branch's events — another branch's turn
 * completing must not rewrite this page's pins/changesets/switches (they
 * belong to a different repo root). `viewedBranch` is the page's session
 * branch (the `state` event's `branch`; undefined until it arrives =
 * primary, the DesignChat convention).
 */
function sandboxEventMatchesBranch(
  event: { branch?: unknown },
  viewedBranch: string | undefined,
): boolean {
  const tag = typeof event.branch === "string" && event.branch
    ? event.branch
    : undefined;
  return tag === viewedBranch;
}

export {
  activeChangesetCount,
  activeChangesetForPin,
  activePins,
  appendSandboxActivity,
  bakeStateForPin,
  applySandboxEvent,
  applySandboxStoreEvent,
  sandboxEventMatchesBranch,
  changesetsFromWire,
  conflictForPin,
  conflictedChangesetIds,
  conflictedPinIds,
  dataConflictsFromWire,
  fileConflictsFromWire,
  sameExportConflicts,
  inPlaceVariantId,
  pinLastActivity,
  pinThreadTitle,
  clampFrameSize,
  pinStatus,
  pinsFromStatus,
  readyCounts,
  resolveFrameSize,
  sandboxComponentKey,
  sandboxModuleUrl,
  sandboxOverridesActive,
  storeFromStatus,
  switchesFromWire,
  SANDBOX_AUTO_MAX_WIDTH,
  SANDBOX_AUTO_MIN_WIDTH,
};
export type {
  SandboxActivityEntry,
  SandboxBakeState,
  SandboxChangesetState,
  SandboxDataConflict,
  SandboxEvent,
  SandboxExportConflict,
  SandboxFileConflict,
  SandboxFrameSize,
  SandboxOverrideState,
  SandboxPinLocator,
  SandboxPinState,
  SandboxReapplyState,
  SandboxRebaseState,
  SandboxRoutedIntent,
  SandboxState,
  SandboxStatusPayload,
  SandboxStore,
  SandboxSwitchSelection,
  SandboxSwitchesState,
  SandboxTargetState,
  SandboxThreadMessage,
  SandboxVariantState,
  SandboxVariantStatus,
};
