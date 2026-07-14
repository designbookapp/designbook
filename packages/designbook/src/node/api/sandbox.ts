/**
 * Sandbox orchestrator (docs/specs/sandbox.md, DECIDED 2026-07-10).
 *
 * In app mode, selecting a live component instance creates a PIN — a durable
 * record of the selection's code target + captured runtime context. Prompting
 * a pin either runs a direct edit against the REAL source (one ephemeral Pi
 * turn, D6) or generates N design variants that land progressively on the
 * sandbox canvas via `sandbox-event` SSE (the wrapper module re-creating the
 * captured context stays in `.designbook/sandbox/<pinId>/` — D2: adapters
 * live, app contexts snapshot-stubbed).
 *
 * CHANGESET LAYERS (docs/specs/changeset-layers.md, L1 — supersedes the
 * shim/switch model): every changeset is a FILE LAYER under
 * `.designbook/changesets/<id>/` — alternatives stored at the real file's
 * repo-relative path, stacked over the real tree, topmost active layer wins
 * per file, resolved by the build host through the unchanged
 * ModuleOverrideHost redirect table. Data files (json/po/cssvar) merge
 * additions at serve time instead of shadowing. Bake copies the selected
 * alternative deterministically (3-way merge on drift; ONE merge-agent turn
 * only on conflict), gated by a typecheck; discard drops the layer dir.
 *
 * This module is the PURE seam: everything model-shaped (`runTurn`) and
 * environment-shaped (`runTypecheck`) is injected, so the state machine tests
 * run against fakes — the variations-orchestrator pattern, deliberately.
 * The variations feature itself is untouched (D1); shared low-level helpers
 * (`containedPath`, director-reply parsing, turn diagnostics) are imported
 * from variations.ts rather than duplicated.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, sep } from "node:path";
import { promisify } from "node:util";
import {
  FALLBACK_DIRECTIONS,
  containedPath,
  normalizeAppDir,
  parseDirectorReply,
  slugify,
  truncateDiagnostic,
} from "./variations.ts";
import { dataFormatFor } from "./dataClassify.ts";
import { lookupExportFiles } from "./exportIndexStore.ts";
import {
  GitRequiredError,
  altIdOfRef,
  createGitChangesets,
  refBase,
  refTrunk,
  refVariant,
  worktreePathFor,
  type GitExec,
  type TurnGitCapture,
} from "../overrides/gitChangesets.ts";
import {
  applyDataChanges,
  computeDataChanges,
  mergeDataLayers,
  type DataKeyConflict,
} from "./dataMerge.ts";
import {
  DIRECT_ALT_ID,
  directChangesetId,
  isDirectChangesetId,
} from "./conversations.ts";
import {
  forkTitleFromPrompt,
  parseTurnSummary,
  SUMMARY_PROMPT_INSTRUCTION,
} from "./turnSummary.ts";
import {
  DATA_ALT_ID,
  activeLayers,
  altFilePath,
  changesetDir,
  changesetMetaPath,
  changesetsDir,
  computeLayerConflicts,
  computeLayerRedirects,
  isChangesetPath,
  mergedDataPath,
  parseLayerMeta,
  serializeLayerMeta,
  visibleLayers,
  type ChangesetLayer,
  type LayerOverride,
  type LayerConflict,
} from "../overrides/layerStore.ts";

const execFileAsync = promisify(execFile);

/** The switch identity of one overridable component (wire compat with the
 * pre-layer UI: `module#export`). */
function componentKey(moduleRel: string, exportName: string): string {
  return `${moduleRel}#${exportName}`;
}

/** Data files layer by structured MERGE, never by shadowing (spec §Data
 * merge) — anything the dataClassify machinery understands is data. */
function isDataPath(relPath: string): boolean {
  return dataFormatFor(relPath) !== undefined;
}

/** Dir name of the sandbox home — sibling namespace to `.designbook/
 * variations`, same base rule (configDir, rebased per worktree; D5). */
const SANDBOX_DIR = ".designbook/sandbox";

const DEFAULT_VARIANT_COUNT = 3;
const MAX_VARIANT_COUNT = 5;

/** Upper bound on one turn-diff payload (G2 history rows) — past this the
 * diff is cut at a line boundary and flagged `truncated`. */
const TURN_DIFF_MAX_BYTES = 200 * 1024;

/** Auto-retry budget for TRANSIENT variant-turn failures (attempts = 1 + 2). */
const MAX_TRANSIENT_RETRIES = 2;
/** Short backoff before auto-retry attempt n (indexed by retry number). */
const RETRY_BACKOFF_MS = [500, 1500];

/** Render-failure auto-fix budget: ONE fix turn per variant per generation
 * ("ready" must mean renders — a second render failure stays failed with the
 * manual Retry button). Persisted per variant in the index. */
const MAX_RENDER_AUTOFIXES = 1;

/** Total extra source context added to director/variant prompts (~8KB;
 * imported-module bodies are truncated to signatures first). */
const SOURCE_CONTEXT_BUDGET = 8 * 1024;

/** Bound for the deterministic provider-import scan over the app source. */
const PROVIDER_SCAN_FILE_CAP = 800;

/** Canvas card geometry the position seeding assumes. Cards auto-size to
 * content (up to ~640px wide) and grow with height, so seed on a GENEROUS
 * grid — auto width can still overlap a neighbor, but the user drags freely. */
const GRID_CELL_WIDTH = 680;
const GRID_CELL_HEIGHT = 560;
const GRID_COLUMNS = 3;
const GRID_MARGIN = 24;

/** Post-replace crash-report window the client arms (~20s, E4). */
const REPLACE_CRASH_WINDOW_MS = 20_000;

/** Locator caps: the outerHTML snippet the director locates the span with. */
const LOCATOR_OUTER_HTML_CAP = 2048;
const LOCATOR_TEXT_CAP = 160;
const LOCATOR_PATH_CAP = 32;

/** Export-name convention for ELEMENT pins: the extracted span is a temp
 * presentational component `Original`; variants export the same name and are
 * mounted through the controller (E2). */
const ELEMENT_EXPORT_NAME = "Original";
const CONTROLLER_EXPORT_NAME = "Controller";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** The pin's durable identity: a code target, never a DOM node. */
type SandboxTarget = {
  /** Repo-relative source file of the selected component. */
  file: string;
  /** The component's export name (the variant must export the same). */
  exportName: string;
  /** Display label (registry label / JSX name). */
  name: string;
  /** Registry entry id, when the selection resolved to one. */
  entryId?: string;
  /** Stable per-instance path within the running app (anchor re-resolution). */
  instancePath?: string;
};

type SandboxThreadMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

/** ELEMENT pins only (E1/E5): what the selection pointed at inside the owner.
 * The DIRECTOR resolves this locator to the exact JSX span in the owner
 * source — LLM locates + extracts, no AST build-out. */
type SandboxElementLocator = {
  /** Lowercase DOM tag of the selected element. */
  tag: string;
  /** outerHTML snippet at capture time (capped ~2KB). */
  outerHtml: string;
  /** Element-child index path from the owner's rendered root to the element
   * (a hint — the outerHTML + text are the primary locate signals). */
  childIndexPath: number[];
  /** Hash of the normalized text content (revive-time identity check). */
  textHash: string;
  /** Normalized text content, capped (director readability). */
  text?: string;
  className?: string;
};

type SandboxVariantStatus = "generating" | "ready" | "failed" | "updating";

type SandboxVariant = {
  id: string;
  intent: string;
  /** Repo-relative variant file inside the pin's sandbox dir. */
  file: string;
  /** Canvas position (persisted per drag, D4). */
  x: number;
  y: number;
  /** User-resized frame size in px (persisted per resize). Absent = auto-size
   * to content (the default; pre-resize/old entries carry neither). */
  w?: number;
  h?: number;
  status: SandboxVariantStatus;
  /** Bumped per landing/update — the UI's ?t= cache-bust key. */
  rev: number;
  error?: string;
  /** The designer request this variant was generated for (manual Retry
   * re-runs with the same request; absent on pre-retry records). */
  request?: string;
  /** Render-failure auto-fix turns consumed since the last landing (max 1 per
   * generation — the debounce that keeps a broken variant from looping). */
  renderFixes?: number;
  /** O3: the FULL-MODULE sandbox variant file (the owner module with this
   * variant re-inlined) — the changeset override artifact for ELEMENT pins
   * (and edit-variants, where it equals `file`). Present once the module
   * re-inline turn landed; absent = not yet overridable in place. */
  moduleFile?: string;
};

/** COMPONENT pins are the original feature (unchanged, E3); ELEMENT pins add
 * the extracted-span + controller contract (docs/specs/sandbox.md v2). */
type SandboxPinKind = "component" | "element";

type SandboxPin = {
  id: string;
  createdAt: number;
  /** Absent in pre-v2 indexes — revives as "component" (compat REQUIRED). */
  kind: SandboxPinKind;
  /** Thread title (UX v3 U2): LLM-generated after the thread's first
   * assistant response; absent until then (clients fall back to the
   * truncated first prompt). Absent in pre-v3 indexes — revive compat. */
  title?: string;
  target: SandboxTarget;
  /** L3: the conversation this pin was created from (its prompt/ask flow) —
   * changesets inherit it; absent on legacy pins ("ungrouped"). */
  conversationId?: string;
  /** ELEMENT pins: the selected element's locator inside the owner (E1). */
  locator?: SandboxElementLocator;
  /** ELEMENT pins: repo-relative controller module, once the director
   * authored it (`<pinId>/controller.tsx`, E2). */
  controllerFile?: string;
  /** Captured runtime context (JSON-safe; produced by the UI capture). */
  contextSnapshot: unknown;
  thread: SandboxThreadMessage[];
  variants: SandboxVariant[];
  /** Replace happened — kept as history, hidden from canvas (D3). */
  resolved: boolean;
};

// ---------------------------------------------------------------------------
// Changesets = layers (docs/specs/changeset-layers.md, L1).
// ---------------------------------------------------------------------------

/**
 * One exploration's whole body of work — a changeset LAYER, 1:1 with a
 * thread/pin in L1. Durable record = `meta.json` in the layer's own dir
 * (`.designbook/changesets/<id>/`), NOT the sandbox index. The model lives
 * in src/node/overrides/layerStore.ts.
 */
type SandboxChangeset = ChangesetLayer;

/** A per-component switch selection (wire compat: absent key = original).
 * SYNTHESIZED from the layer state — the resolved winner per module. */
type SandboxSwitchSelection = { changesetId: string; variantId: string };

/** componentKey(`module#export`) → selection (wire compat snapshot). */
type SandboxSwitches = Record<string, SandboxSwitchSelection>;

/** The durable index: pins only (layers own their own meta records; the
 * pre-layer index shapes carried changesets/switches — parsed and IGNORED). */
type SandboxIndex = {
  pins: SandboxPin[];
};

/** In-memory pin state: the durable record + the roots it resolves against. */
type PinSet = {
  pin: SandboxPin;
  repoRoot: string;
  appDir: string;
  /** One in-flight model op per pin (prompt/iterate/replace). */
  busy: boolean;
};

/** One live-activity item off an ephemeral session (U4 transparency): a
 * COALESCED thinking chunk or a tool call's start/end flip. Deliberately
 * delta-shaped — the SSE ships increments, never whole transcripts. */
type SandboxTurnActivity =
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      /** The execution id — the client upserts start→end by it. */
      id: string;
      name: string;
      status: "running" | "done" | "error";
      /** Compact primary-argument summary (path/command/pattern), capped. */
      detail?: string;
    };

type SandboxRunTurn = (params: {
  /** The session's working directory — a changeset WORKTREE for git-backed
   * turns (G1: built-in SDK tools, bash included for conversation turns,
   * operate on a real checkout); the repo root for bake merge turns. */
  cwd: string;
  prompt: string;
  /** `intent`/`title` are the CHEAP UX-v3 turns (classification + thread
   * titling) — read-only tool set, never write files. */
  mode: "director" | "variant" | "edit" | "replace" | "intent" | "title";
  /**
   * G1 per-tool-write commit seam: when present, the runner calls
   * `noteToolEnd` from its tool_execution_end event stream — the capture
   * commits whatever the tool wrote onto the turn's hidden ref (message =
   * tool + files summary, trailer Designbook-Tool-Call). Absent = no commit
   * capture (scratch/cheap turns, bake merge turns).
   */
  capture?: Pick<TurnGitCapture, "noteToolEnd">;
  /** U4 transparency: when present, the runner relays the session's
   * thinking/tool activity here (see `createTurnActivityRelay`). Absent =
   * log-only sessions, exactly as before. */
  onActivity?: (entry: SandboxTurnActivity) => void;
  /** L3: the parent conversation this sub-turn belongs to — the runner TAGS
   * the ephemeral session's transcript identity with it (conversations.ts).
   * `undefined` = untagged (legacy pins, bake merge turns). */
  conversationId?: string | undefined;
}) => Promise<{ text: string; errorMessage?: string; sessionId?: string }>;

type SandboxTypecheck = (
  repoRoot: string,
  /** Config dir, repo-root-relative ("" = repo root) — the APP owns the
   * tsconfig the gate runs against (monorepo rule). */
  appDir: string,
) => Promise<{ ok: boolean; output?: string; skipped?: boolean }>;

type SandboxDeps = {
  runTurn: SandboxRunTurn;
  /** The Replace gate (spec: tsc after the replace turn). */
  runTypecheck: SandboxTypecheck;
  broadcast: (eventName: string, payload: unknown) => void;
  log: (message: string) => void;
  /** Injectable backoff sleep (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  /** The ModuleOverrideHost push seam: called with the full redirect table
   * (absolute real path → absolute selected-alternative path) whenever it —
   * or the CONTENT of any live redirect target — changes. `stamps` carries a
   * monotonic content stamp per redirected real path: park/rollback/turn-end
   * re-projections rewrite alt files at UNCHANGED paths, and without the
   * stamp the push channel stayed silent (the canvas-staleness bug — the
   * only re-render channel left was the target vite's watcher, racy against
   * atomic renames). Host mode wires this straight into its vite host; the
   * injected topology instead polls GET /api/sandbox/redirects. */
  onOverridesChanged?: (
    redirects: Record<string, string>,
    stamps: Record<string, number>,
  ) => void;
  /** Branch/commit tagging for layer metas (layers from OTHER branches are
   * hidden and never resolved). Default shells out to git; tests inject. */
  gitInfo?: (repoRoot: string) => Promise<{ branch: string; commit: string }>;
  /** 3-way merge for DRIFTED bakes (`git merge-file` semantics: base
   * snapshot, current real, layer alternative). Default shells out to git;
   * tests inject. `conflicted` = markers remain → ONE merge-agent turn. */
  mergeFile?: (
    base: string,
    current: string,
    layered: string,
  ) => Promise<{ content: string; conflicted: boolean }>;
  /** Drift-watch cadence (O2): when set, a periodic check re-hashes every
   * real module under an ACTIVE override and flags drift. Absent = lazy-only
   * (status reads + bake admission still check) — tests stay timer-free. */
  driftWatchMs?: number;
  /** G1 git-core seams (changesets-on-git.md): injectable exec + clock for
   * the hidden-ref/worktree machinery. Defaults shell out to real git. */
  gitExec?: GitExec;
  now?: () => number;
  worktreeIdleMs?: number;
  /** Sidecar linkage (G1): called once per git-backed turn that produced
   * commits — api.ts records the turn's commit range next to the
   * conversation map (designbook-conversations.json). */
  recordTurn?: (entry: {
    repoRoot: string;
    changesetId: string;
    ref: string;
    from: string;
    to: string;
    conversationId?: string;
    sessionId?: string;
    at: number;
    /** Agent-supplied turn summary (the reply's `Summary:` line) — the
     * sidecar record's label, available synchronously at turn end. */
    label?: string;
  }) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Turn-failure classification (auto-retry policy).
// ---------------------------------------------------------------------------

type TurnFailureKind = "transient" | "permanent";

/** Message fragments that indicate a retryable infrastructure hiccup. */
const TRANSIENT_FAILURE_PATTERN = new RegExp(
  [
    // Stream/connection died mid-turn.
    "stream (?:ended|closed|error|terminated)",
    "ended (?:early|prematurely|unexpectedly)",
    "premature(?:ly)? (?:close|end)",
    "socket hang ?up",
    "connection (?:reset|closed|refused|error|aborted|terminated)",
    "network(?: error| issue|error)?",
    "fetch failed",
    "terminated",
    "aborted",
    // Timeouts.
    "timed? ?out",
    "timeout",
    "deadline",
    // Node-level network errno codes.
    "econnreset|econnrefused|epipe|etimedout|eai_again|enotfound|enetunreach",
    // Server-side hiccups: any 5xx, provider overload, rate limiting.
    "\\b5\\d\\d\\b",
    "internal server error",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "overloaded",
    "rate limit",
    "too many requests",
    "\\b429\\b",
    "\\b408\\b",
  ].join("|"),
  "i",
);

/** Failures no retry can fix — auth/quota/billing. Checked FIRST so a quota
 * message that also mentions a status code (e.g. 429) still fails fast. */
const PERMANENT_FAILURE_PATTERN = new RegExp(
  [
    "out of (?:extra )?usage",
    "quota",
    "credit",
    "billing",
    "payment",
    "api key",
    "unauthorized",
    "forbidden",
    "authentication",
    "not authenticated",
    "permission denied",
    "\\b401\\b|\\b402\\b|\\b403\\b",
  ].join("|"),
  "i",
);

/**
 * Classify a failed variant turn: TRANSIENT (stream ended early, 5xx,
 * timeouts, network, provider overload/rate limits) auto-retries; everything
 * else — auth/quota/other 4xx ("out of extra usage", invalid key…) and any
 * unrecognized failure — is PERMANENT and fails immediately with the real
 * diagnostic (retrying can't fix it and would just burn quota/time).
 */
function classifySandboxTurnFailure(message: string): TurnFailureKind {
  if (PERMANENT_FAILURE_PATTERN.test(message)) return "permanent";
  return TRANSIENT_FAILURE_PATTERN.test(message) ? "transient" : "permanent";
}

// ---------------------------------------------------------------------------
// Turn-activity relay (U4 transparency) — pi-events → coalesced deltas.
// ---------------------------------------------------------------------------

/** Flush a buffered thinking run once it reaches this many chars (or on any
 * tool/turn boundary) — one SSE event per ~sentence, not per token. */
const ACTIVITY_THINKING_FLUSH_CHARS = 200;
/** Per-turn thinking relay budget: past this the session stays observable via
 * its tool rows only (a runaway thinking stream must not flood the SSE). */
const ACTIVITY_THINKING_BUDGET_CHARS = 12_000;
/** Cap for the tool-call detail line (path/command summary). */
const ACTIVITY_TOOL_DETAIL_CAP = 80;

/** Arg keys that make a good one-line tool summary, in preference order
 * (mirrors the chat's getToolCallDetail — kept node-local, no ui import). */
const ACTIVITY_TOOL_DETAIL_KEYS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "pattern",
  "query",
  "url",
];

/** Compact primary-argument summary of a tool call (start events only). */
function toolDetailFromArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  let value = ACTIVITY_TOOL_DETAIL_KEYS.map((key) => args[key]).find(
    (candidate): candidate is string =>
      typeof candidate === "string" && Boolean(candidate.trim()),
  );
  value ??= Object.values(args).find(
    (candidate): candidate is string =>
      typeof candidate === "string" && Boolean(candidate.trim()),
  );
  if (value === undefined) return undefined;
  const line = value.trim().replace(/\s*\n\s*/g, " ");
  if (line.length <= ACTIVITY_TOOL_DETAIL_CAP) return line;
  // Paths keep their (most specific) tail; prose keeps its head.
  return line.includes("/")
    ? `…${line.slice(line.length - ACTIVITY_TOOL_DETAIL_CAP + 1)}`
    : `${line.slice(0, ACTIVITY_TOOL_DETAIL_CAP - 1)}…`;
}

/** The pi-event fields the relay reads (structural — no SDK type import). */
type RelayedPiEvent = {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Relay one ephemeral session's pi-events as `SandboxTurnActivity` deltas:
 * thinking deltas COALESCE into ≥~200-char chunks (flushed on any tool
 * boundary and at turn end), tool start/end map to running/done/error
 * entries upserted by call id. Everything else (text deltas, message events)
 * is dropped — the thread gets the final reply through the orchestrator, not
 * through this stream. Call `flush()` when the turn settles.
 */
function createTurnActivityRelay(
  onActivity: (entry: SandboxTurnActivity) => void,
): { handle: (event: unknown) => void; flush: () => void } {
  let buffered = "";
  let relayedThinking = 0;

  function flush(): void {
    if (!buffered) return;
    const text = buffered;
    buffered = "";
    onActivity({ kind: "thinking", text });
  }

  function handle(raw: unknown): void {
    const event = raw as RelayedPiEvent;
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "thinking_delta" &&
      event.assistantMessageEvent.delta
    ) {
      if (relayedThinking >= ACTIVITY_THINKING_BUDGET_CHARS) return;
      buffered += event.assistantMessageEvent.delta;
      relayedThinking += event.assistantMessageEvent.delta.length;
      if (buffered.length >= ACTIVITY_THINKING_FLUSH_CHARS) flush();
      return;
    }
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      flush();
      const name = event.toolName ?? "tool";
      const start = event.type === "tool_execution_start";
      const detail = start ? toolDetailFromArgs(event.args) : undefined;
      onActivity({
        kind: "tool",
        id: event.toolCallId ?? name,
        name,
        status: start ? "running" : event.isError ? "error" : "done",
        ...(detail ? { detail } : {}),
      });
    }
  }

  return { handle, flush };
}

// ---------------------------------------------------------------------------
// Pure helpers: paths, ids, index serialization, position seeding, prompts.
// ---------------------------------------------------------------------------

/** Repo-relative sandbox home for an app dir. */
function sandboxDir(appDir: string): string {
  return appDir ? `${appDir}/${SANDBOX_DIR}` : SANDBOX_DIR;
}

/**
 * Repo-relative path of the durable index for an app dir. O1 moved it OUT of
 * `.designbook/sandbox/` (a Tailwind `@source` content dir): tailwind v4
 * FULL-RELOADS the page — silently — whenever a scanned file with no real
 * module changes, and the index is rewritten on every drag/flip/landing
 * (live-run finding; switch flips must never reload).
 */
function sandboxIndexFile(appDir: string): string {
  const base = ".designbook/sandbox-index.ts";
  return appDir ? `${appDir}/${base}` : base;
}

/** Pre-O1 index path (INSIDE the sandbox dir) — revive fallback only. */
function legacySandboxIndexFile(appDir: string): string {
  return `${sandboxDir(appDir)}/index.ts`;
}

/** Repo-relative dir of one pin's generated files. */
function pinDir(appDir: string, pinId: string): string {
  return `${sandboxDir(appDir)}/${pinId}`;
}

/** Repo-relative path of a pin's generated context wrapper. */
function wrapperPath(appDir: string, pinId: string): string {
  return `${pinDir(appDir, pinId)}/wrapper.tsx`;
}

/** Repo-relative path of an ELEMENT pin's gallery span-variant file (canvas
 * concern only — the LAYER artifact is the full-module alternative at the
 * mirrored path, see `moduleAltPath`). */
function variantFilePath(appDir: string, pinId: string, slug: string): string {
  return `${pinDir(appDir, pinId)}/${slug}.tsx`;
}

/** The DETERMINISTIC changeset id of a pin's layer (1:1 in L1). */
function changesetIdForPin(pinId: string): string {
  return `cs-${pinId}`;
}

/** Repo-relative path of one ALTERNATIVE of the pin's target module inside
 * its layer: the real file MIRRORED under `alts/<altId>/` — same
 * repo-relative path, so imports/aliases/tailwind just work (no
 * re-pointing). Component-pin gallery variants ARE these files (the canvas
 * imports them by absolute path); element pins put their full-module
 * re-inline artifacts here. */
function moduleAltPath(
  appDir: string,
  pinId: string,
  altId: string,
  moduleRel: string,
): string {
  return altFilePath(appDir, changesetIdForPin(pinId), altId, moduleRel);
}

/** Repo-relative path of an element pin's extracted-span component (E1). */
function originalPath(appDir: string, pinId: string): string {
  return `${pinDir(appDir, pinId)}/original.tsx`;
}

/** Repo-relative path of an element pin's controller module (E2). */
function controllerPath(appDir: string, pinId: string): string {
  return `${pinDir(appDir, pinId)}/controller.tsx`;
}

function isSandboxPath(relPath: string, appDir: string): boolean {
  return relPath.startsWith(`${sandboxDir(appDir)}/`);
}

/** Filesystem-safe pin id: slugged export name + a time/random suffix. */
function makePinId(exportName: string, now: number = Date.now()): string {
  const base = slugify(exportName || "pin");
  const suffix = `${now.toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
  return `${base}-${suffix}`;
}

/** Valid pin/variant id segment (server-generated; guards file paths). */
function isValidIdSegment(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/**
 * Seed x/y for the next `count` variants in a simple non-overlapping grid
 * (3 columns of w-80 cards), continuing after `existingCount` cells.
 */
function seedVariantPositions(
  existingCount: number,
  count: number,
): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const index = existingCount + i;
    positions.push({
      x: GRID_MARGIN + (index % GRID_COLUMNS) * GRID_CELL_WIDTH,
      y: GRID_MARGIN + Math.floor(index / GRID_COLUMNS) * GRID_CELL_HEIGHT,
    });
  }
  return positions;
}

/** Server-side frame-size bounds (the client clamps too; this guards the
 * persisted record against a hostile/buggy client). */
const FRAME_MIN_DIMENSION = 120;
const FRAME_MAX_DIMENSION = 4000;

/**
 * Normalize one resize dimension for persistence: a positive finite number is
 * clamped to bounds; `null` (reset-to-auto) and any non-positive/garbage value
 * become `undefined` (auto-size — the field is dropped from the record).
 */
function applyFrameDimension(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(FRAME_MAX_DIMENSION, Math.max(FRAME_MIN_DIMENSION, Math.round(value)));
}

const INDEX_HEADER = [
  "// .designbook/sandbox-index.ts — maintained by designbook.",
  "// Durable record of sandbox pins (threads + canvas positions); safe to delete (drops all pins).",
  "export const sandbox =",
].join("\n");

/**
 * Emit the durable index. The record is a plain JSON literal (valid TS), so
 * the parse is a deterministic slice + JSON.parse of our own writer's output
 * — no fragile regex over nested structures. L1 shape: `{pins}` (changesets
 * moved into their own layer meta records); the parser also revives every
 * prior shape (a bare pins array; the O1 `{pins, changesets, switches}`
 * object — the extra slices are IGNORED, old shim changesets are dead).
 */
function serializeSandboxIndex(index: SandboxIndex): string {
  return `${INDEX_HEADER}\n${JSON.stringify(index, null, 2)};\n`;
}

/** Pin-record revive (shared by both index shapes). */
function revivePinRecords(parsed: unknown): SandboxPin[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (candidate): candidate is SandboxPin =>
        typeof (candidate as { id?: unknown }).id === "string" &&
        typeof (candidate as { target?: unknown }).target === "object",
    )
    .map((record) => ({
      ...record,
      // Revive compat (v2): pre-element indexes carry no `kind` — they are
      // component pins. Anything unrecognized degrades to "component" too.
      kind: record.kind === "element" ? "element" : "component",
    }));
}

/**
 * Parse the records back out of the serializer's format. REVIVE COMPAT with
 * every prior shape is required: a pre-O1 index is a bare pins ARRAY; the O1
 * shim-era shape is `{pins, changesets, switches}` (the extra slices are
 * dropped — shim changesets cannot be resolved by the layer engine); the L1
 * shape is `{pins}`.
 */
function parseSandboxIndex(source: string): SandboxIndex {
  const empty: SandboxIndex = { pins: [] };
  const marker = "export const sandbox =";
  const start = source.indexOf(marker);
  if (start === -1) return empty;
  const literal = source
    .slice(start + marker.length)
    .trim()
    .replace(/;\s*$/, "");
  try {
    const parsed = JSON.parse(literal) as unknown;
    if (Array.isArray(parsed)) {
      return { pins: revivePinRecords(parsed) };
    }
    if (!parsed || typeof parsed !== "object") return empty;
    const shaped = parsed as { pins?: unknown };
    return { pins: revivePinRecords(shaped.pins) };
  } catch {
    return empty;
  }
}

/**
 * Sanitize a client-supplied element locator (element pins): caps applied,
 * wrong shapes rejected. Undefined = not a usable locator.
 */
function sanitizeElementLocator(
  raw: unknown,
): SandboxElementLocator | undefined {
  const input = raw as {
    tag?: unknown;
    outerHtml?: unknown;
    childIndexPath?: unknown;
    textHash?: unknown;
    text?: unknown;
    className?: unknown;
  } | null;
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.tag !== "string" || !/^[a-z][a-z0-9-]*$/.test(input.tag)) {
    return undefined;
  }
  if (typeof input.outerHtml !== "string" || !input.outerHtml.trim()) {
    return undefined;
  }
  const childIndexPath = Array.isArray(input.childIndexPath)
    ? input.childIndexPath
        .filter(
          (index): index is number =>
            typeof index === "number" && Number.isInteger(index) && index >= 0,
        )
        .slice(0, LOCATOR_PATH_CAP)
    : [];
  return {
    tag: input.tag,
    outerHtml: input.outerHtml.slice(0, LOCATOR_OUTER_HTML_CAP),
    childIndexPath,
    textHash: typeof input.textHash === "string" ? input.textHash.slice(0, 32) : "",
    ...(typeof input.text === "string" && input.text
      ? { text: input.text.slice(0, LOCATOR_TEXT_CAP) }
      : {}),
    ...(typeof input.className === "string" && input.className
      ? { className: input.className.slice(0, 256) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Iterate element descriptor (canvas element selection).
// ---------------------------------------------------------------------------

const ITERATE_ELEMENT_OUTER_HTML_CAP = 1024;
const ITERATE_ELEMENT_TEXT_CAP = 300;
const ITERATE_ELEMENT_LABEL_CAP = 120;
const ITERATE_ELEMENT_CLASS_CAP = 12;

/**
 * The element the designer selected INSIDE a variant's rendered canvas
 * preview when dispatching an iterate turn: a compact tag/classes/label
 * descriptor plus a trimmed outerHTML snippet and text content. Transient —
 * folded into the iterate prompt, never persisted on the pin.
 */
type SandboxIterateElement = {
  tag: string;
  id?: string;
  classes?: string[];
  /** Chip-style label ("div.flex", "ProductPrice"). */
  label: string;
  text?: string;
  outerHtml?: string;
  /** Registered component label when the selection was a component level. */
  componentHint?: string;
};

/**
 * Sanitize a client-supplied iterate element descriptor: caps re-applied
 * server-side, wrong shapes rejected. Undefined = plain (frame-level)
 * iterate — the request must never fail on a bad descriptor.
 */
function sanitizeIterateElement(
  raw: unknown,
): SandboxIterateElement | undefined {
  const input = raw as {
    tag?: unknown;
    id?: unknown;
    classes?: unknown;
    label?: unknown;
    text?: unknown;
    outerHtml?: unknown;
    componentHint?: unknown;
  } | null;
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.tag !== "string" || !/^[a-z][a-z0-9-]*$/.test(input.tag)) {
    return undefined;
  }
  if (typeof input.label !== "string" || !input.label.trim()) return undefined;
  const classes = Array.isArray(input.classes)
    ? input.classes
        .filter((cls): cls is string => typeof cls === "string" && cls !== "")
        .slice(0, ITERATE_ELEMENT_CLASS_CAP)
        .map((cls) => cls.slice(0, 128))
    : [];
  return {
    tag: input.tag,
    ...(typeof input.id === "string" && input.id
      ? { id: input.id.slice(0, 128) }
      : {}),
    ...(classes.length > 0 ? { classes } : {}),
    label: input.label.trim().slice(0, ITERATE_ELEMENT_LABEL_CAP),
    ...(typeof input.text === "string" && input.text.trim()
      ? { text: input.text.trim().slice(0, ITERATE_ELEMENT_TEXT_CAP) }
      : {}),
    ...(typeof input.outerHtml === "string" && input.outerHtml.trim()
      ? { outerHtml: input.outerHtml.slice(0, ITERATE_ELEMENT_OUTER_HTML_CAP) }
      : {}),
    ...(typeof input.componentHint === "string" && input.componentHint
      ? { componentHint: input.componentHint.slice(0, ITERATE_ELEMENT_LABEL_CAP) }
      : {}),
  };
}

/** Marker shape the UI capture uses for values it could not serialize. */
function isUnserializableMarker(
  value: unknown,
): value is { $unserializable: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $unserializable?: unknown }).$unserializable === "string"
  );
}

type CaptureContextEntry = {
  name?: string;
  value?: unknown;
  ownerName?: string;
  ownerFile?: string;
  providerName?: string;
  providerFile?: string;
  providerProps?: Record<string, unknown>;
};

type CaptureShape = {
  props?: Record<string, unknown>;
  contexts?: CaptureContextEntry[];
  adapters?: Record<string, string>;
  /** ELEMENT pins: the selected element subtree's resolved values (fiber
   * props + text) — the raw material for the controller's inlined locals. */
  element?: { tag?: string; text?: string; props?: Record<string, unknown> };
  viewport?: { width?: number; height?: number };
  i18n?: {
    localePathPattern?: string;
    defaultNamespace?: string;
    defaultLocale?: string;
  };
  /** App route (location.pathname) at capture; seeds `<MemoryRouter>`. */
  capturedPath?: string;
};

// ---------------------------------------------------------------------------
// Deterministic wrapper generation (the PRIMARY path — the model never writes
// wrapper.tsx; a live eval showed wrapper quality is model-nondeterministic).
// ---------------------------------------------------------------------------

/**
 * Deep-strip `$unserializable` markers from a captured value, recording their
 * paths in `omitted`. Object keys are dropped; array slots become `null`
 * (indexes must stay stable for the consuming component).
 */
function sanitizeCapturedValue(
  value: unknown,
  path: string,
  omitted: string[],
): unknown {
  if (isUnserializableMarker(value)) {
    omitted.push(`${path || "(value)"}: ${value.$unserializable}`);
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const cleaned = sanitizeCapturedValue(item, `${path}[${index}]`, omitted);
      return cleaned === undefined ? null : cleaned;
    });
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = sanitizeCapturedValue(
        item,
        path ? `${path}.${key}` : key,
        omitted,
      );
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

/** True when `source` exports `name` (declaration or export-list forms). */
function moduleExportsName(source: string, name: string): boolean {
  const declaration = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|class|let|var|enum)\\s+${name}\\b`,
  );
  const list = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
  return declaration.test(source) || list.test(source);
}

const PROVIDER_SCAN_EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "locales",
]);

/** DETERMINISTIC (sorted, bounded) listing of an app dir's .ts/.tsx files. */
async function listAppSourceFiles(appRootAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dirAbs: string, rel: string): Promise<void> {
    if (out.length >= PROVIDER_SCAN_FILE_CAP) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= PROVIDER_SCAN_FILE_CAP) return;
      if (entry.name.startsWith(".")) continue; // hidden incl. .designbook
      if (entry.isDirectory()) {
        if (PROVIDER_SCAN_EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(
          join(dirAbs, entry.name),
          rel ? `${rel}/${entry.name}` : entry.name,
        );
      } else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !/\.(test|spec)\./.test(entry.name)
      ) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }
  await walk(appRootAbs, "");
  return out;
}

/**
 * Per-generation resolver: exported symbol name → repo-relative source file.
 * Ladder (config-slim spec): the capture's attributed file first, then the
 * plugin-pushed EXPORT INDEX (verified against the real file — the index may
 * lag a rename), then the deterministic bounded scan of the app source as the
 * fallback for unindexed files. Every read is cached for the generation.
 */
function makeExportResolver(repoRoot: string, appDir: string) {
  let filesPromise: Promise<string[]> | undefined;
  const sources = new Map<string, Promise<string | undefined>>();
  function sourceOf(repoRel: string): Promise<string | undefined> {
    let cached = sources.get(repoRel);
    if (!cached) {
      cached = readFile(join(repoRoot, repoRel), "utf8").catch(() => undefined);
      sources.set(repoRel, cached);
    }
    return cached;
  }
  async function resolveExport(
    name: string,
    hintFile?: string,
  ): Promise<string | undefined> {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return undefined;
    if (hintFile && containedPath(repoRoot, hintFile)) {
      const hinted = await sourceOf(hintFile);
      if (hinted && moduleExportsName(hinted, name)) return hintFile;
    }
    // INDEX LOOKUP: candidates already sorted; multiple files exporting the
    // same name is legitimate (barrels, twins) — verify each against the real
    // source and take the first that still exports the name, logging the
    // ambiguity so it is diagnosable.
    const indexed = lookupExportFiles(name);
    if (indexed.length > 1) {
      console.warn(
        `[designbook] export index: "${name}" is exported from ${indexed.length} files (${indexed
          .slice(0, 4)
          .join(", ")}${indexed.length > 4 ? ", …" : ""}); picking the first that verifies.`,
      );
    }
    for (const repoRel of indexed.slice(0, 8)) {
      if (!containedPath(repoRoot, repoRel)) continue;
      const source = await sourceOf(repoRel);
      if (source && moduleExportsName(source, name)) return repoRel;
    }
    filesPromise ??= listAppSourceFiles(
      appDir ? join(repoRoot, appDir) : repoRoot,
    );
    for (const rel of await filesPromise) {
      const repoRel = appDir ? `${appDir}/${rel}` : rel;
      const source = await sourceOf(repoRel);
      if (source && moduleExportsName(source, name)) return repoRel;
    }
    return undefined;
  }
  // `readSource` shares the per-generation cache so the router-nesting guard
  // can re-read a resolved provider's source without a second disk read.
  return { resolveExport, readSource: sourceOf };
}

/**
 * Source-owner resolution over a named-owner chain (nearest owner first):
 * the first candidate the bounded export scan finds a file for wins — a
 * node_modules component like react-router's `Link` scans to nothing and the
 * page shell above it resolves instead. The shared implementation behind
 * element pins arriving with `target.file: ""` (createPin) AND the read-only
 * `/api/sandbox/source-owner` route (the code panel's owning-file lookup —
 * no pin created). Returns the deduped candidate list either way, so callers
 * can name the misses in their error copy.
 */
async function resolveOwnerSource(params: {
  repoRoot: string;
  appDir: string;
  names: Array<string | undefined>;
}): Promise<{
  resolved?: { file: string; exportName: string };
  candidates: string[];
}> {
  const appDir = normalizeAppDir(params.appDir);
  if (appDir === undefined) return { candidates: [] };
  const candidates = params.names
    .filter((name): name is string => typeof name === "string" && name !== "")
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 8);
  const { resolveExport } = makeExportResolver(params.repoRoot, appDir);
  for (const name of candidates) {
    const file = await resolveExport(name);
    if (file) return { resolved: { file, exportName: name }, candidates };
  }
  return { candidates };
}

/** Wrapper-relative import specifier for a repo-relative file (extension
 * stripped for code modules; .json keeps it — vite serves JSON default). */
function wrapperImportSpecifier(
  appDir: string,
  pinId: string,
  repoRelFile: string,
): string {
  let rel = posix.relative(pinDir(appDir, pinId), repoRelFile);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.(tsx|ts)$/, "");
}

/** The captured value of the adapter dimension whose id ends `:{suffix}`. */
function adapterDimension(
  adapters: Record<string, string> | undefined,
  suffix: string,
): string | undefined {
  for (const [key, value] of Object.entries(adapters ?? {})) {
    if (key.endsWith(`:${suffix}`)) return value;
  }
  return undefined;
}

/** An i18n-owned scope entry (covered by the generated i18next section). */
function isI18nContextEntry(entry: CaptureContextEntry): boolean {
  const owner = entry.providerName ?? entry.ownerName ?? "";
  return owner === "I18nextProvider" || /i18n/i.test(entry.name ?? "");
}

type WrapperLayer = { open: string; close: string; importLine?: string };

type I18nSection = {
  imports: string[];
  setup: string[];
  layer: WrapperLayer;
};

/**
 * The i18next section of the wrapper, when the app uses react-i18next:
 * `createInstance().use(initReactI18next).init(...)` with the app's OWN
 * locale JSON for the captured locale, wrapped as `<I18nextProvider>`. The
 * proven shape from the earlier good live run, generated in code.
 */
async function buildI18nSection(params: {
  repoRoot: string;
  appDir: string;
  pinId: string;
  capture: CaptureShape;
}): Promise<I18nSection | undefined> {
  const { repoRoot, appDir, pinId, capture } = params;
  // Detect react-i18next: the app package.json, else the captured graph.
  let hasReactI18next = (capture.contexts ?? []).some(
    (entry) => (entry.providerName ?? entry.ownerName) === "I18nextProvider",
  );
  try {
    const packageJson = JSON.parse(
      await readFile(
        join(repoRoot, appDir ? `${appDir}/package.json` : "package.json"),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (
      packageJson.dependencies?.["react-i18next"] ||
      packageJson.devDependencies?.["react-i18next"]
    ) {
      hasReactI18next = true;
    }
  } catch {
    // No readable package.json — the captured-graph signal decides.
  }
  if (!hasReactI18next) return undefined;

  // LOCALE RULE: the ADAPTER-captured locale is the truth. A live run showed
  // the adapter (fr-FR) and a provider snapshot (en-US) disagreeing — the
  // adapter reflects the designer's live pick at capture time, so it wins.
  const locale =
    adapterDimension(capture.adapters, "locale") ??
    capture.i18n?.defaultLocale ??
    "en-US";

  // Locale resources: the config's pattern first, then a conventional probe.
  const namespaces: Array<{ namespace: string; repoRel: string }> = [];
  const pattern = capture.i18n?.localePathPattern;
  const defaultNamespace = capture.i18n?.defaultNamespace;
  async function probe(namespace: string, repoRel: string): Promise<void> {
    if (namespaces.some((existing) => existing.namespace === namespace)) return;
    try {
      if ((await stat(join(params.repoRoot, repoRel))).isFile()) {
        namespaces.push({ namespace, repoRel });
      }
    } catch {
      // Not there — keep probing.
    }
  }
  if (pattern) {
    for (const namespace of [
      ...(defaultNamespace ? [defaultNamespace] : []),
      "app",
      "translation",
      "common",
    ]) {
      await probe(
        namespace,
        pattern.replace("{locale}", locale).replace("{namespace}", namespace),
      );
      if (namespaces.length > 0) break;
    }
  }
  if (namespaces.length === 0) {
    // Conventional layout: <appDir>/locales/<locale>/<namespace>.json.
    const localesDirRel = appDir ? `${appDir}/locales/${locale}` : `locales/${locale}`;
    try {
      const files = (await readdir(join(repoRoot, localesDirRel)))
        .filter((name) => name.endsWith(".json"))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const file of files) {
        namespaces.push({
          namespace: file.replace(/\.json$/, ""),
          repoRel: `${localesDirRel}/${file}`,
        });
      }
    } catch {
      // No locales dir — the instance still initializes (keys render as keys).
    }
  }

  const imports = [
    'import { I18nextProvider, initReactI18next } from "react-i18next";',
    'import { createInstance } from "i18next";',
    ...namespaces.map(
      (entry, index) =>
        `import localeResources${index} from "${wrapperImportSpecifier(appDir, pinId, entry.repoRel)}";`,
    ),
  ];
  const namespaceNames = namespaces.map((entry) => entry.namespace);
  const primaryNamespace =
    defaultNamespace && namespaceNames.includes(defaultNamespace)
      ? defaultNamespace
      : (namespaceNames[0] ?? defaultNamespace ?? "translation");
  const resourcesLiteral =
    namespaces.length > 0
      ? `{ ${JSON.stringify(locale)}: { ${namespaces
          .map((entry, index) => `${JSON.stringify(entry.namespace)}: localeResources${index}`)
          .join(", ")} } }`
      : "{}";
  const setup = [
    "/**",
    " * i18next re-created from the app's own locale resources at the CAPTURED",
    ` * locale (${locale}). Locale rule: the ADAPTER-captured locale wins over any`,
    " * provider-snapshot value (the adapter reflects the live pick at capture).",
    " */",
    "const sandboxI18n = createInstance();",
    "void sandboxI18n.use(initReactI18next).init({",
    `  lng: ${JSON.stringify(locale)},`,
    `  fallbackLng: ${JSON.stringify(locale)},`,
    ...(namespaceNames.length > 0
      ? [`  ns: ${JSON.stringify(namespaceNames)},`]
      : []),
    `  defaultNS: ${JSON.stringify(primaryNamespace)},`,
    `  resources: ${resourcesLiteral},`,
    "  interpolation: { escapeValue: false },",
    "  returnNull: false,",
    "  returnEmptyString: false,",
    "});",
  ];
  return {
    imports,
    setup,
    layer: {
      open: "<I18nextProvider i18n={sandboxI18n}>",
      close: "</I18nextProvider>",
    },
  };
}

/**
 * Component identities that ARE a react-router Router (importing any of these
 * and rendering it re-instantiates a Router). Used by the router-nesting guard.
 */
const ROUTER_PROVIDER_NAMES = new Set([
  "BrowserRouter",
  "HashRouter",
  "MemoryRouter",
  "StaticRouter",
  "RouterProvider",
  "Router",
]);

/** Last-ditch heuristic when a provider's source is unreadable at codegen time
 * (matches the app root and any `*Router*` wrapper — deliberately broad). */
const ROUTER_NAME_HEURISTIC = /^(App|.*Router.*)$/;

/**
 * Static, conservative check: does `source` render a react-router Router? True
 * when it imports a Router symbol (default or named) from `react-router(-dom)`
 * AND uses that symbol as a JSX element. Cheap regex read — no parse — so it
 * over- rather than under-excludes (a Router-rendering provider re-instantiated
 * under the wrapper's own MemoryRouter crashes react-router; a missed context
 * only degrades to a literal/stub).
 */
function sourceRendersRouter(source: string): boolean {
  const importRe =
    /import\s+(?:type\s+)?([^;]*?)\s+from\s+["']react-router(?:-dom)?["']/g;
  const routerSymbols = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source))) {
    const clause = match[1];
    // Default/namespace import: leading identifier before any `{`/`,`.
    const defaultName = clause.match(/^\s*(\w+)/)?.[1];
    if (defaultName && /Router/.test(defaultName)) routerSymbols.add(defaultName);
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    if (named) {
      for (const raw of named.split(",")) {
        const local = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (local && /Router/.test(local)) routerSymbols.add(local);
      }
    }
  }
  for (const symbol of routerSymbols) {
    if (new RegExp(`<${symbol}[\\s/>]`).test(source)) return true;
  }
  return false;
}

/**
 * Would re-instantiating this captured provider introduce a second Router? True
 * when (a) its component identity IS a react-router Router export, or (b) its
 * readable source renders one, or (c) — source unreadable — its name matches the
 * broad `App`/`*Router*` heuristic. The wrapper excludes such providers whenever
 * it emits its own MemoryRouter (react-router throws on a nested Router).
 */
async function providerIntroducesRouter(
  name: string,
  providerFile: string,
  readSource: (repoRel: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (ROUTER_PROVIDER_NAMES.has(name)) return true;
  const source = await readSource(providerFile);
  if (source !== undefined) return sourceRendersRouter(source);
  return ROUTER_NAME_HEURISTIC.test(name);
}

/**
 * The router section of the wrapper, when the app depends on react-router. A
 * react-router `Link`/`NavLink`/`useNavigate` throws outside a Router, so the
 * variant model used to downgrade `Link`→`<a>` to avoid the crash (and Replace
 * then re-inlined the downgrade into real source — the bug this fixes). We wrap
 * the whole provider tree in `<MemoryRouter initialEntries={[capturedPath]}>`
 * (imported from the APP's own react-router package) so navigation components
 * render at their real route and never need downgrading.
 *
 * ROUTER SUPPORT = react-router ONLY for now (designbook doesn't target
 * Next.js — no Next router/app-router handling here).
 *
 * Detection is deterministic: the app package.json's react-router(-dom) dep is
 * the primary signal; a captured `*Router` provider in the component graph is a
 * secondary one (covers an unreadable package.json). Emits nothing when neither
 * fires — an app without a router gets no new wrapper code.
 */
async function buildRouterSection(params: {
  repoRoot: string;
  appDir: string;
  capture: CaptureShape;
}): Promise<WrapperLayer | undefined> {
  const { repoRoot, appDir, capture } = params;
  let specifier: string | undefined;
  try {
    const packageJson = JSON.parse(
      await readFile(
        join(repoRoot, appDir ? `${appDir}/package.json` : "package.json"),
        "utf8",
      ),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...packageJson.devDependencies, ...packageJson.dependencies };
    // react-router-dom re-exports MemoryRouter; prefer it, else react-router
    // (v7 exports MemoryRouter from the core package too).
    if (deps["react-router-dom"]) specifier = "react-router-dom";
    else if (deps["react-router"]) specifier = "react-router";
  } catch {
    // No readable package.json — fall through to the captured-graph signal.
  }
  if (!specifier) {
    // Secondary signal: a Router provider observed in the captured graph.
    const hasRouterProvider = (capture.contexts ?? []).some((entry) =>
      /router/i.test(entry.providerName ?? entry.ownerName ?? ""),
    );
    if (!hasRouterProvider) return undefined;
    specifier = "react-router-dom";
  }
  const path = capture.capturedPath || "/";
  return {
    open: `<MemoryRouter initialEntries={[${JSON.stringify(path)}]}>`,
    close: "</MemoryRouter>",
    importLine: `import { MemoryRouter } from "${specifier}";`,
  };
}

/**
 * Generate the pin's context wrapper DETERMINISTICALLY from the captured
 * snapshot (byte-identical for the same snapshot — no timestamps, sorted
 * scans). Per captured context, preference order:
 *   1. the REAL provider component (importable `providerName` + resolvable
 *      source) re-instantiated with the captured serializable props;
 *   2. a literal `<Ctx.Provider value={snapshot}>` when the Context object
 *      itself is exported under its captured name;
 *   3. a documented comment stub (nothing importable).
 * Plus: an i18next section when the app uses react-i18next, and the captured
 * theme mode/variant applied as canvas classes/data attrs on the root div.
 * Never throws — resolution failures degrade to stubs.
 */
async function generateSandboxWrapper(params: {
  repoRoot: string;
  appDir: string;
  pinId: string;
  contextSnapshot: unknown;
}): Promise<string> {
  const { repoRoot, appDir, pinId } = params;
  const capture = (params.contextSnapshot ?? {}) as CaptureShape;

  // Captured props literal (markers stripped + documented).
  const omittedProps: string[] = [];
  const props = sanitizeCapturedValue(
    capture.props ?? {},
    "",
    omittedProps,
  ) as Record<string, unknown>;

  const imports: string[] = ['import type { ReactNode } from "react";'];
  const setup: string[] = [];
  const layers: WrapperLayer[] = [];
  const notes: string[] = [];

  let i18nSection: I18nSection | undefined;
  try {
    i18nSection = await buildI18nSection({ repoRoot, appDir, pinId, capture });
  } catch {
    i18nSection = undefined;
  }
  if (i18nSection) {
    imports.push(...i18nSection.imports);
    setup.push(...i18nSection.setup);
    layers.push(i18nSection.layer);
  }

  // Router section computed BEFORE the provider loop: when the wrapper will
  // emit its own MemoryRouter, any captured provider that would render another
  // Router must be excluded from re-instantiation (react-router throws on a
  // Router nested inside a Router — the crash this guards). Built here so the
  // loop can consult `willEmitRouter`; layered in OUTERMOST further below.
  let routerLayer: WrapperLayer | undefined;
  try {
    routerLayer = await buildRouterSection({ repoRoot, appDir, capture });
  } catch {
    routerLayer = undefined;
  }
  const willEmitRouter = Boolean(routerLayer);

  // App contexts, FARTHEST first so outer providers wrap inner ones (the
  // snapshot records them nearest-first).
  const { resolveExport, readSource } = makeExportResolver(repoRoot, appDir);
  const seenProviders = new Set<string>();
  for (const entry of [...(capture.contexts ?? [])].reverse()) {
    const label = entry.name ?? "Context";
    if (i18nSection && isI18nContextEntry(entry)) continue; // covered above
    try {
      // 1) The real provider component with captured serializable props.
      const providerName = entry.providerName ?? entry.ownerName;
      if (providerName) {
        const providerFile = await resolveExport(
          providerName,
          entry.providerFile ?? entry.ownerFile,
        );
        if (
          providerFile &&
          willEmitRouter &&
          (await providerIntroducesRouter(providerName, providerFile, readSource))
        ) {
          // This provider renders its own Router; re-instantiating it under the
          // wrapper's MemoryRouter would crash react-router. Skip rung 1 and
          // fall through to the context-literal/stub rungs — the router
          // contexts it provided are supplied by the wrapper's MemoryRouter,
          // and any NON-router context it also provided is re-provided as a
          // literal below when its Context object is exported.
          notes.push(
            ` *  - <${providerName}> NOT re-instantiated (renders its own Router; the wrapper's MemoryRouter provides routing).`,
          );
        } else if (providerFile) {
          const dedupeKey = `${providerFile}#${providerName}`;
          if (seenProviders.has(dedupeKey)) continue;
          seenProviders.add(dedupeKey);
          imports.push(
            `import { ${providerName} } from "${wrapperImportSpecifier(appDir, pinId, providerFile)}";`,
          );
          const omitted: string[] = [];
          const providerProps = sanitizeCapturedValue(
            entry.providerProps ?? {},
            "",
            omitted,
          ) as Record<string, unknown>;
          const propsText = Object.entries(providerProps)
            .map(([key, value]) => `${key}={${JSON.stringify(value)}}`)
            .join(" ");
          if (omitted.length > 0) {
            notes.push(
              ` *  - <${providerName}> re-created WITHOUT unserializable props: ${omitted.join(", ")}.`,
            );
          }
          layers.push({
            open: `<${providerName}${propsText ? ` ${propsText}` : ""}>`,
            close: `</${providerName}>`,
          });
          continue;
        }
      }
      // 2) The Context object itself, provided the captured literal value.
      if (label !== "Context" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(label)) {
        const contextFile = await resolveExport(label, entry.ownerFile);
        if (contextFile) {
          const dedupeKey = `${contextFile}#${label}`;
          if (seenProviders.has(dedupeKey)) continue;
          seenProviders.add(dedupeKey);
          imports.push(
            `import { ${label} } from "${wrapperImportSpecifier(appDir, pinId, contextFile)}";`,
          );
          const omitted: string[] = [];
          const value = sanitizeCapturedValue(entry.value, "", omitted);
          if (omitted.length > 0) {
            notes.push(
              ` *  - <${label}.Provider> value misses unserializable entries: ${omitted.join(", ")}.`,
            );
          }
          layers.push({
            open: `<${label}.Provider value={${JSON.stringify(value) ?? "undefined"}}>`,
            close: `</${label}.Provider>`,
          });
          continue;
        }
      }
      // 3) Documented stub — nothing importable for this context.
      notes.push(
        ` *  - ${label}${entry.ownerName ? ` via ${entry.ownerName}` : ""}: NOT re-created (no importable provider); captured value: ${truncateDiagnostic(JSON.stringify(entry.value) ?? "undefined")}.`,
      );
    } catch {
      notes.push(` *  - ${label}: NOT re-created (resolution failed).`);
    }
  }

  // Captured theme, applied per the canvas convention: `.designbook-theme`
  // scopes the injected theme variables; a non-default mode is a class on the
  // same element (`.designbook-theme.dark`); the preset variant rides along
  // as a data attribute (its override CSS is canvas-injected when active).
  const themeMode = adapterDimension(capture.adapters, "mode");
  const themeVariant = adapterDimension(capture.adapters, "variant");
  if (themeMode !== undefined || themeVariant !== undefined) {
    const classes = ["designbook-theme"];
    if (themeMode && themeMode !== "light") classes.push(themeMode);
    const dataAttr =
      themeVariant && themeVariant !== "default"
        ? ` data-theme-variant=${JSON.stringify(themeVariant)}`
        : "";
    layers.unshift({
      open: `<div className=${JSON.stringify(classes.join(" "))}${dataAttr}>`,
      close: "</div>",
    });
  }

  // Router OUTERMOST (above every provider + the theme div) so any provider or
  // variant that calls react-router hooks/components has a Router in scope.
  // (`routerLayer` was resolved before the provider loop so its presence could
  // exclude Router-rendering providers from re-instantiation.)
  if (routerLayer) {
    if (routerLayer.importLine) imports.push(routerLayer.importLine);
    layers.unshift(routerLayer);
  }

  const adapterLine = Object.entries(capture.adapters ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");

  // Assemble the JSX body with plain indentation.
  const body: string[] = [];
  body.push("  return (");
  layers.forEach((layer, index) => {
    body.push(`${"  ".repeat(index + 2)}${layer.open}`);
  });
  body.push(`${"  ".repeat(layers.length + 2)}{children}`);
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    body.push(`${"  ".repeat(index + 2)}${layers[index].close}`);
  }
  body.push("  );");
  if (layers.length === 0) {
    body.length = 0;
    body.push("  return <>{children}</>;");
  }

  return [
    "/** designbook:sandbox wrapper — GENERATED deterministically from the pin's",
    " * captured context snapshot (captured state, D2). Not model-authored; do",
    " * not edit — it is overwritten on every variants run. */",
    ...imports,
    "",
    "/** Captured props (sampled at pin time; unserializable values omitted",
    ` * ${omittedProps.length > 0 ? `— omitted: ${omittedProps.join(", ")}` : "— none omitted"}). */`,
    `export const capturedProps: Record<string, unknown> = ${JSON.stringify(props, null, 2)};`,
    "",
    ...(setup.length > 0 ? [...setup, ""] : []),
    "/** Re-creates the selection's captured runtime context around a variant.",
    ...(notes.length > 0 ? [" * Not fully re-created:", ...notes] : []),
    ` * Adapter state at capture: ${adapterLine || "none"}.`,
    " */",
    "export function SandboxProviders({ children }: { children?: ReactNode }) {",
    ...body,
    "}",
    "",
  ].join("\n");
}

/** Bounded text rendering of the captured context for turn prompts. */
function renderContextForPrompt(contextSnapshot: unknown): string {
  const capture = (contextSnapshot ?? {}) as CaptureShape;
  const lines: string[] = [];
  const props = Object.entries(capture.props ?? {});
  if (props.length > 0) {
    lines.push("Captured props:");
    for (const [key, value] of props.slice(0, 16)) {
      const rendered = isUnserializableMarker(value)
        ? `<unserializable: ${value.$unserializable}>`
        : truncateDiagnostic(JSON.stringify(value) ?? "undefined");
      lines.push(`- ${key}: ${rendered}`);
    }
  }
  const contexts = capture.contexts ?? [];
  if (contexts.length > 0) {
    lines.push("Consumed app contexts (snapshot values — captured state):");
    for (const entry of contexts.slice(0, 8)) {
      lines.push(
        `- ${entry.name ?? "Context"}${entry.ownerName ? ` via ${entry.ownerName}` : ""}${
          entry.ownerFile ? ` (${entry.ownerFile})` : ""
        }: ${truncateDiagnostic(JSON.stringify(entry.value) ?? "undefined")}`,
      );
    }
  }
  const adapters = Object.entries(capture.adapters ?? {});
  if (adapters.length > 0) {
    lines.push(
      `Adapter state: ${adapters.map(([key, value]) => `${key}=${value}`).join("; ")}`,
    );
  }
  const element = capture.element;
  if (element) {
    lines.push(
      `Selected element subtree (resolved at capture): <${element.tag ?? "element"}>` +
        (element.text ? ` text: ${truncateDiagnostic(element.text)}` : ""),
    );
    for (const [key, value] of Object.entries(element.props ?? {}).slice(0, 12)) {
      const rendered = isUnserializableMarker(value)
        ? `<unserializable: ${value.$unserializable}>`
        : truncateDiagnostic(JSON.stringify(value) ?? "undefined");
      lines.push(`- element.${key}: ${rendered}`);
    }
  }
  return lines.join("\n");
}

/** Bounded locator rendering for element-pin director/replace prompts. */
function renderLocatorForPrompt(locator: SandboxElementLocator): string {
  return [
    "Selected ELEMENT locator (find this exact JSX span in the owner source):",
    `- tag: <${locator.tag}>${locator.className ? ` className="${locator.className}"` : ""}`,
    ...(locator.text ? [`- rendered text: ${locator.text}`] : []),
    ...(locator.childIndexPath.length > 0
      ? [
          `- element-child index path from the owner's rendered root: [${locator.childIndexPath.join(", ")}]`,
        ]
      : []),
    "- outerHTML at capture time:",
    locator.outerHtml,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Prompt source-context enrichment (~8KB: the original component's full
// source + the local modules it imports, atom bodies truncated to signatures
// first).
// ---------------------------------------------------------------------------

/** Declaration/signature lines of a module (bodies dropped) — the truncated
 * form of an imported atom file when the source-context budget runs low. */
function extractSignatures(source: string): string {
  return source
    .split("\n")
    .filter((line) =>
      /^\s*(export\b|function\b|const\b|type\b|interface\b|class\b)/.test(line),
    )
    .join("\n");
}

/** Resolve a relative import specifier to a repo-relative code file. */
async function resolveRelativeModule(
  repoRoot: string,
  fromDir: string,
  specifier: string,
): Promise<string | undefined> {
  if (/\.(css|json|svg|png|jpe?g|gif)$/.test(specifier)) return undefined;
  const base = posix.normalize(posix.join(fromDir, specifier));
  const candidates = /\.(tsx?|jsx?)$/.test(base)
    ? [base]
    : [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`];
  for (const candidate of candidates) {
    if (!containedPath(repoRoot, candidate)) continue;
    try {
      if ((await stat(join(repoRoot, candidate))).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * The source-context block for director/variant prompts: the ORIGINAL
 * component's full source, then each locally-imported module (atoms,
 * primitives, context — names + paths from its import statements), capped at
 * ~SOURCE_CONTEXT_BUDGET with atom BODIES truncated to signatures first.
 */
async function buildSandboxSourceContext(
  repoRoot: string,
  targetFile: string,
  /** L2 stacking: the path the PROMPT names (the real module path) when the
   * content comes from a resolved alternative — reads go THROUGH the layer
   * without leaking layer paths into the prompt. Default: targetFile. */
  label: string = targetFile,
): Promise<string> {
  let original: string;
  try {
    original = await readFile(join(repoRoot, targetFile), "utf8");
  } catch {
    return "";
  }
  let budget = SOURCE_CONTEXT_BUDGET;
  const originalText =
    original.length > budget - 1024
      ? `${original.slice(0, budget - 1024)}\n// …truncated…`
      : original;
  const sections = [
    `--- ORIGINAL COMPONENT SOURCE: ${label} ---`,
    originalText,
  ];
  budget -= originalText.length;

  const targetDir = posix.dirname(targetFile);
  for (const match of original.matchAll(
    /import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g,
  )) {
    if (budget <= 256) break;
    const names = match[1].replace(/\s+/g, " ").trim();
    const specifier = match[2];
    if (!specifier.startsWith(".")) continue; // local atoms/primitives only
    const resolved = await resolveRelativeModule(repoRoot, targetDir, specifier);
    if (!resolved) continue;
    let source: string;
    try {
      source = await readFile(join(repoRoot, resolved), "utf8");
    } catch {
      continue;
    }
    // Full body when it fits; signatures only when the budget runs low.
    let body = source.length <= budget - 256 ? source : extractSignatures(source);
    const truncated = body !== source;
    if (body.length > budget - 256) body = `${body.slice(0, budget - 256)}\n// …truncated…`;
    sections.push(
      `--- IMPORTED BY THE ORIGINAL: ${names} from "${specifier}" (${resolved})${truncated ? " — signatures only" : ""} ---`,
      body,
    );
    budget -= body.length;
  }
  return sections.join("\n");
}

/** The explicit quality contract for every variant (fix #3). */
const SANDBOX_QUALITY_CONTRACT =
  "Quality contract: each variant must be a RECOGNIZABLE VARIATION of THIS exact component — same data, same atoms/primitives where possible, same visual language and theme tokens — varying layout, hierarchy, and emphasis. Not a redesign, not a generic component.";

/** PRESERVE-IMPORTS rule (fix: router in the wrapper): the sandbox now wraps
 * every variant in a MemoryRouter, so framework/navigation components render
 * fine — the model must NOT downgrade them. Injected into variant/iterate/
 * render-fix/element prompts. */
const SANDBOX_PRESERVE_NAV_RULE =
  "PRESERVE the original's component imports — keep every framework/navigation component the original uses (react-router Link/NavLink/useNavigate, etc.). The sandbox provides a router (MemoryRouter at the captured route), so NEVER downgrade Link/NavLink to a raw <a> or swap out framework components to avoid a crash — they render correctly as-is.";

/** L2 (§Agent transparency): the ADAPTER-DATA EXCEPTION prompt rule died
 * with the overlay toolset, and the round-2 policy change (2026-07-14) also
 * dropped the "never change existing keys" prohibition — mutations of
 * existing data keys are first-class layer overrides now (git + layer-wins
 * made the ban obsolete). What SURVIVES is one soft QUALITY line (kept
 * deliberately: without it models fake i18n via runtime `i18n.addResource`
 * — live 2026-07-13 — and skip non-active locales). No mechanism talk, no
 * "allowed write" framing. */
const SANDBOX_DATA_QUALITY_NOTE =
  "New text or design tokens: add NEW keys to the app's data files (locale JSON in EVERY locale, theme token files) and reference them — never register translations at runtime (no i18n.addResource).";

function buildSandboxDirectorPrompt(params: {
  pin: SandboxPin;
  appDir: string;
  count: number;
  request: string;
  sourceContext?: string;
}): string {
  const { pin, count, request, sourceContext } = params;
  return [
    `You are the design DIRECTOR for a variation run on the component "${pin.target.exportName}" (source file: ${pin.target.file}), selected live in the running app.`,
    `Designer's request: ${request}`,
    "",
    // The context wrapper is GENERATED IN CODE from the captured snapshot —
    // the model never writes it (live-eval finding: wrapper quality was
    // model-nondeterministic and a bad wrapper crashed every variant).
    "Your ONLY job is to propose design directions. designbook generates the context wrapper itself — do not write, plan, or mention any files.",
    `Reply with ONLY a JSON array (no prose, no code fence) of ${count} DISTINCT design directions:`,
    '[{"slug": "short-kebab-slug", "intent": "one-line design intent"}, …]',
    "Slugs must be unique, lowercase kebab-case, max 24 chars. Directions must differ in LAYOUT/HIERARCHY/DENSITY/EMPHASIS — not just color.",
    SANDBOX_QUALITY_CONTRACT,
    "",
    renderContextForPrompt(pin.contextSnapshot),
    ...(sourceContext ? ["", sourceContext] : []),
  ].join("\n");
}

/**
 * L2 (§Agent transparency): the variant turn edits the REAL module path —
 * the overlay stages the result as this variant's alternative, so every
 * WHERE-files-live rule (drop-in-module framing, served-at-path, self-import,
 * "no other file") died. The prompt is the DESIGN task.
 */
function buildSandboxVariantPrompt(params: {
  pin: SandboxPin;
  appDir: string;
  slug: string;
  intent: string;
  request: string;
  sourceContext?: string;
}): string {
  const { pin, appDir, sourceContext } = params;
  const wrapper = wrapperPath(appDir, pin.id);
  const target = pin.target.file;
  return [
    `Create ONE design variant of the component "${pin.target.exportName}" (source file: ${target} — read it first).`,
    `Design direction "${params.slug}": ${params.intent}`,
    `Designer's request: ${params.request}`,
    "",
    `Apply the design by EDITING ${target}: redesign the ${pin.target.exportName} component per the direction. Your working copy is isolated — other variants are generated in parallel from the same original, and the designer picks between them afterwards.`,
    "",
    "Design rules:",
    `- Keep every export the module has today (same names, same prop interfaces); redesign only what the direction needs.`,
    `- The captured runtime context is re-created by a FIXED, code-generated wrapper at ${wrapper} (exports: capturedProps, SandboxProviders). designbook renders your component as <SandboxProviders><${pin.target.exportName} {...capturedProps} /></SandboxProviders>. Do NOT create, edit, or import the wrapper, and do NOT re-create providers in your file.`,
    "- Reuse the app's existing components/atoms, i18n keys, and design tokens.",
    `- ${SANDBOX_DATA_QUALITY_NOTE}`,
    `- First line: a provenance header comment: /** designbook:sandbox variant of ${target} — "${params.slug}": <one-line intent> */`,
    "- The component's ROOT must have intrinsic height: never size it solely via absolutely-positioned children (that collapses to an empty render).",
    "- The variant renders in the selection's CAPTURED state (context below) — design for those values.",
    `- ${SANDBOX_PRESERVE_NAV_RULE}`,
    `- ${SANDBOX_QUALITY_CONTRACT}`,
    "",
    renderContextForPrompt(pin.contextSnapshot),
    ...(sourceContext ? ["", sourceContext] : []),
  ].join("\n");
}

/** The exported-component name a pin's variants must use: the owner's export
 * for component pins; the `Original` convention for element pins (E2). */
function variantExportName(pin: SandboxPin): string {
  return pin.kind === "element" ? ELEMENT_EXPORT_NAME : pin.target.exportName;
}

/** Repo-root import prefix for a file living in `dir` (variant-prompt rule). */
function repoImportPrefix(dir: string): string {
  return posix.relative(dir, "") || ".";
}

/**
 * ELEMENT-pin director turn (E1/E2): extract the located span into
 * `original.tsx`, author `controller.tsx` (real hooks + inlined locals +
 * `// from:` mapping — the Replace contract), THEN reply with the directions
 * JSON. The SandboxProviders wrapper stays code-generated and deterministic.
 */
function buildElementDirectorPrompt(params: {
  pin: SandboxPin;
  appDir: string;
  count: number;
  request: string;
  sourceContext?: string;
}): string {
  const { pin, appDir, count, request, sourceContext } = params;
  const originalFile = originalPath(appDir, pin.id);
  const controllerFile = controllerPath(appDir, pin.id);
  const wrapper = wrapperPath(appDir, pin.id);
  const dir = pinDir(appDir, pin.id);
  const locator = pin.locator;
  return [
    `You are the design DIRECTOR for a variation run on a SELECTED DOM ELEMENT inside the component "${pin.target.exportName}" (owner source file: ${pin.target.file}), selected live in the running app.`,
    `Designer's request: ${request}`,
    "",
    "Do these THREE things, in order:",
    "",
    `1. Write ${originalFile} — extract the selected element's EXACT JSX span from the owner source into a temp presentational component:`,
    `- Exactly one exported React component named ${ELEMENT_EXPORT_NAME}.`,
    `- Its props are the FREE VARIABLES the span references (translated strings, context values, loop items, computed locals, handlers) — the span's JSX otherwise byte-faithful to the owner source.`,
    `- Purely presentational: NO hooks, NO context reads, NO data fetching in this file. It may import the same app atoms/components the span uses.`,
    `- First line: /** designbook:sandbox original — extracted from ${pin.target.file} */`,
    "",
    `2. Write ${controllerFile} — the controller that re-derives the props (this file is rendered INSIDE the code-generated provider wrapper at ${wrapper}; providers for i18n, app contexts, and theme already exist ABOVE it — do NOT create, edit, or import the wrapper, and do NOT re-create providers):`,
    `- Exactly one exported React component named ${CONTROLLER_EXPORT_NAME} with the signature: function ${CONTROLLER_EXPORT_NAME}({ V }: { V: React.ComponentType<any> }).`,
    "- PROVIDER-BACKED values (translations, app-context values, anything a hook supplied) must be derived by calling the app's REAL hooks — the same hooks/expressions the span's values came from (useTranslation/t, useProduct, useLanguage, …). NEVER inline a resolved string for a provider-backed value.",
    "- PURELY-LOCAL values (loop item, computed locals, literal props) are inlined as literals from the captured snapshot below.",
    `- Build a single props object and render the active variant as <V {...props} />.`,
    '- THE REPLACE CONTRACT: every prop MUST be declared on its own line with a trailing comment `// from: <the exact expression the original span used>`. Example: `title: t("product.title"), // from: t("product.title")`. If the span references NO free variables, pass an empty props object ({}) — no mapping comments needed.',
    `- The file lives in ${dir}/, so a repo file <path> is imported as "${repoImportPrefix(dir)}/<path>". Repo path aliases work as usual.`,
    "",
    `3. Reply with ONLY a JSON array (no prose, no code fence) of ${count} DISTINCT design directions for the element:`,
    '[{"slug": "short-kebab-slug", "intent": "one-line design intent"}, …]',
    "Slugs must be unique, lowercase kebab-case, max 24 chars. Directions must differ in LAYOUT/HIERARCHY/DENSITY/EMPHASIS — not just color.",
    SANDBOX_QUALITY_CONTRACT,
    SANDBOX_PRESERVE_NAV_RULE,
    "",
    ...(locator ? [renderLocatorForPrompt(locator), ""] : []),
    renderContextForPrompt(pin.contextSnapshot),
    ...(sourceContext ? ["", sourceContext] : []),
  ].join("\n");
}

/**
 * ELEMENT-pin variant turn: one presentational variant of the extracted span,
 * over the controller's flat props contract (the controller source IS the
 * contract — name, sample derivation, `from:` expression per prop).
 */
function buildElementVariantPrompt(params: {
  pin: SandboxPin;
  appDir: string;
  targetPath: string;
  slug: string;
  intent: string;
  request: string;
  originalSource: string;
  controllerSource: string;
  sourceContext?: string;
}): string {
  const { pin, appDir, targetPath, sourceContext } = params;
  const targetDir = posix.dirname(targetPath);
  return [
    `Create ONE design variant of a SELECTED ELEMENT (a <${pin.locator?.tag ?? "div"}> section inside "${pin.target.exportName}", owner source: ${pin.target.file}).`,
    `Design direction "${params.slug}": ${params.intent}`,
    `Designer's request: ${params.request}`,
    "",
    `Write the variant to EXACTLY this file: ${targetPath}`,
    "",
    "Hard rules:",
    `- Exactly one exported React component named ${ELEMENT_EXPORT_NAME}, with the SAME props contract as the extracted original below — it renders in the original's place.`,
    `- Your component is rendered through a fixed controller (source below) that derives every prop from the app's real providers: accept the props, do NOT re-create providers, call app data hooks, or hardcode the prop values.`,
    `- You MAY use the app's existing components/atoms and design tokens (providers exist above the controller). The file lives in ${targetDir}/, so a repo file <path> is imported as "${repoImportPrefix(targetDir)}/<path>". Repo path aliases work as usual.`,
    `- First line: a provenance header comment: /** designbook:sandbox element variant of ${pin.target.file} — "${params.slug}": <one-line intent> */`,
    "- The component's ROOT must have intrinsic height: never size it solely via absolutely-positioned children (that collapses to an empty render).",
    `- ${SANDBOX_PRESERVE_NAV_RULE}`,
    `- ${SANDBOX_QUALITY_CONTRACT}`,
    "",
    `--- EXTRACTED ORIGINAL (the props contract): ${originalPath(appDir, pin.id)} ---`,
    params.originalSource,
    "",
    `--- CONTROLLER (how each prop is derived; \`// from:\` = original expression): ${controllerPath(appDir, pin.id)} ---`,
    params.controllerSource,
    "",
    renderContextForPrompt(pin.contextSnapshot),
    ...(sourceContext ? ["", sourceContext] : []),
  ].join("\n");
}

/**
 * O3 — element pins as full-module variants: the PROVEN Replace re-inline
 * turn (E4) targeted at a SANDBOX file instead of real source. The output is
 * the whole owner module with only the extracted span replaced by the
 * variant's design; it becomes the changeset override artifact the shim
 * serves in place of the owner ("Preview in place" at every instance).
 */
function buildElementModuleVariantPrompt(params: {
  pin: SandboxPin;
  variant: SandboxVariant;
  appDir: string;
}): string {
  const { pin, variant, appDir } = params;
  const controllerFile = pin.controllerFile ?? controllerPath(appDir, pin.id);
  return [
    `Apply a finished element design to its owner module: EDIT ${pin.target.file} so the exact JSX span the design was extracted from carries the design from ${variant.file}. Leave the rest of the module untouched.`,
    "",
    "Files (read ALL THREE first):",
    `- Owner module to edit: ${pin.target.file}`,
    `- Winning variant (presentational component "${ELEMENT_EXPORT_NAME}" over a flat props contract): ${variant.file}`,
    `- Controller (THE MAPPING — every prop carries a trailing \`// from: <original expression>\` comment): ${controllerFile}`,
    "",
    "Hard rules:",
    `- Keep the module's exports (${pin.target.exportName} and everything else it exports) and prop interfaces intact — byte-faithful outside the replaced span wherever possible.`,
    "- RE-WIRE every prop reference in the variant's JSX back to its `// from:` expression from the controller: translation values become the original t()/i18n calls again, context values the original context expressions, loop items stay the loop variable. NEVER inline resolved strings or captured literals for provider-backed values.",
    "- The file must typecheck.",
    "",
    ...(pin.locator ? [renderLocatorForPrompt(pin.locator)] : []),
  ].join("\n");
}

/**
 * O3/L2 — the COMPOSE merge-agent turn (the ONLY merge-agent LLM step, spec
 * §Rules): combine two changesets' designs of one module into ONE design.
 * L2: the turn is OVERLAY-BOUND to the NEW composed changeset — the agent
 * edits the REAL module path and the result stages as the composed layer's
 * alternative. Both parents' designs are EMBEDDED (they shadow the same
 * path, so a merged read could only ever show the topmost one).
 */
function buildComposePrompt(params: {
  module: string;
  exportName: string;
  originalSource: string;
  inputs: Array<{ label: string; source: string }>;
}): string {
  const { module, exportName, originalSource, inputs } = params;
  return [
    `Two independent design explorations modify the component "${exportName}" (source file: ${module}). COMPOSE them: EDIT ${module} into ONE design that combines BOTH changes coherently.`,
    "",
    "Hard rules:",
    `- Keep the exported component named ${exportName} with the original props contract — plus every other export the original has.`,
    "- Merge the INTENT of both designs: where they touch different aspects, keep both; where they conflict on the same aspect, pick the coherent combination and note the choice in the header comment.",
    `- First line: a provenance header comment: /** designbook:sandbox composed variant of ${module} — merges ${inputs.map((input) => `"${input.label}"`).join(" + ")} */`,
    `- ${SANDBOX_PRESERVE_NAV_RULE}`,
    `- ${SANDBOX_QUALITY_CONTRACT}`,
    "",
    `--- ORIGINAL COMPONENT SOURCE: ${module} ---`,
    originalSource,
    ...inputs.flatMap((input) => [
      "",
      `--- DESIGN ${input.label} ---`,
      input.source,
    ]),
  ].join("\n");
}

/** One auto-fix turn after a reported render failure ("ready" must render). */
function buildSandboxRenderFixPrompt(params: {
  pin: SandboxPin;
  variant: SandboxVariant;
  renderError: string;
}): string {
  const { pin, variant, renderError } = params;
  // Element pins render through the controller — a crash may be the
  // controller's hook wiring rather than the variant (the loop covers both).
  const controllerFile = pin.kind === "element" ? pin.controllerFile : undefined;
  // L2: a COMPONENT variant lives AT the module path in this session's view.
  const variantFile =
    pin.kind === "element" ? variant.file : pin.target.file;
  return [
    `The design variant "${variant.id}" of "${pin.target.exportName}" (file: ${variantFile}) THROWS when rendered on the canvas:`,
    renderError,
    "",
    "Fix the variant so it renders. Read the file first.",
    "",
    "Hard rules:",
    ...(controllerFile
      ? [
          `- The variant renders as <Controller V={variant} /> inside the generated providers. If the error clearly originates in the controller (${controllerFile}), fix THAT file (keep every prop's \`// from:\` mapping comment); otherwise fix the variant file (${variantFile}).`,
        ]
      : []),
    `- Keep exactly one exported component named ${variantExportName(pin)} with the original props contract.`,
    "- Keep the design intent — change only what the error requires.",
    "- Keep the root's intrinsic height.",
    // A react-router Link/NavLink crash is NOT fixed by downgrading to <a>: the
    // sandbox wraps the variant in a MemoryRouter, so keep navigation
    // components as-is and fix the real cause.
    `- ${SANDBOX_PRESERVE_NAV_RULE}`,
  ].join("\n");
}

/** L2 (§Agent transparency): the shared edit-target lines. The overlay makes
 * the turn's edits land in the changeset mechanically, so the fresh-copy /
 * live-resolved framing and every "never edit X" rule died — the agent just
 * edits the real path. */
function renderEditTargetLines(pin: SandboxPin): string[] {
  return [
    `Apply any code change by editing ${pin.target.file} (read it first) — your edit previews instantly in the running app.`,
    SANDBOX_DATA_QUALITY_NOTE,
  ];
}

function buildSandboxEditPrompt(params: {
  pin: SandboxPin;
  request: string;
  /** Single-variation framing ("give me 1 design variation" routes here). */
  variation?: boolean;
}): string {
  const { pin, request } = params;
  return [
    `Designer request on the live component "${pin.target.exportName}" (source: ${pin.target.file}), selected in the running app:`,
    request,
    "",
    ...(params.variation
      ? [
          "The designer asked for ONE design variation — produce it as an edit of the component (a RECOGNIZABLE variation: same data, same atoms/primitives where possible, varying layout/hierarchy/emphasis — not a redesign).",
        ]
      : ["Apply the request."]),
    ...renderEditTargetLines(pin),
    "Keep the exported prop interface intact unless the request requires changing it.",
    "",
    "Selection context (captured at pin time):",
    renderContextForPrompt(pin.contextSnapshot),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// UX v3 (docs/specs/sandbox.md §UX v3): intent routing + thread titles.
// ---------------------------------------------------------------------------

/** Default variant count when the designer asked for variations without a
 * number (UX v3 rule: default 3, cap MAX_VARIANT_COUNT). */
const INTENT_DEFAULT_VARIANT_COUNT = 3;

/** Thread-title length cap (UI truncates further as needed). */
const TITLE_MAX_LENGTH = 64;

/**
 * The U3 classification step: ONE cheap constrained turn deciding only
 * whether the designer CLEARLY asked for multiple variations (and how many).
 * Everything else — edits, questions, ambiguity — is a normal agent turn on
 * the pin's session (the agent decides what to do); NEVER variants.
 */
function buildSandboxIntentPrompt(params: {
  pin: SandboxPin;
  request: string;
}): string {
  const { pin, request } = params;
  return [
    `A designer selected the live ${pin.kind === "element" ? `<${pin.locator?.tag ?? "element"}> element inside` : "component"} "${pin.target.exportName}" in their running app and wrote:`,
    request,
    "",
    "Answer ONE question: does this message CLEARLY ask for MULTIPLE design variations/options/alternatives/versions to compare?",
    'Reply with ONLY one JSON object on a single line, no prose, no code fence:',
    '{"variants":false} or {"variants":true,"n":<count>}',
    "Rules:",
    '- "variants":true ONLY when the message unmistakably asks for more than one option (e.g. "variations", "a few options", "show me alternatives").',
    '- Questions, edit requests, feedback, and anything ambiguous are {"variants":false}.',
    `- n: the number the designer named, if any ("a couple" = 2, "a few" = 3; cap ${MAX_VARIANT_COUNT}). If they asked for variants without a number, use ${INTENT_DEFAULT_VARIANT_COUNT}.`,
    "Do not read or write any files.",
  ].join("\n");
}

type SandboxRoutedIntent =
  | { intent: "turn" }
  | { intent: "variants"; n: number };

/**
 * Parse the classification reply. ANYTHING unparseable or ambiguous degrades
 * to a normal turn (the U3 default) — a broken classifier can never
 * accidentally fan out variants. n clamps to [1, MAX_VARIANT_COUNT], with the
 * spec default when the model omitted it.
 */
function parseIntentReply(text: string): SandboxRoutedIntent {
  const match = text.match(/\{[^{}]*"variants"[^{}]*\}/);
  if (!match) return { intent: "turn" };
  try {
    const parsed = JSON.parse(match[0]) as { variants?: unknown; n?: unknown };
    if (parsed.variants !== true) return { intent: "turn" };
    const n =
      typeof parsed.n === "number" && Number.isFinite(parsed.n) && parsed.n >= 1
        ? Math.min(MAX_VARIANT_COUNT, Math.round(parsed.n))
        : INTENT_DEFAULT_VARIANT_COUNT;
    return { intent: "variants", n };
  } catch {
    return { intent: "turn" };
  }
}

/**
 * The NORMAL turn a routed non-variants request runs (U3): the agent gets the
 * request + selection context and decides for itself — answer a question
 * conversationally, or apply an edit to the real source. Deliberately no
 * "apply the edit" framing (contrast buildSandboxEditPrompt, kept for the
 * mode-button surfaces).
 */
function buildSandboxTurnPrompt(params: {
  pin: SandboxPin;
  request: string;
}): string {
  const { pin, request } = params;
  return [
    `The designer selected the live ${pin.kind === "element" ? `<${pin.locator?.tag ?? "element"}> element inside` : "component"} "${pin.target.exportName}" (source: ${pin.target.file}) in their running app and says:`,
    request,
    "",
    "You are their design assistant for this selection. Use your judgment: answer questions directly and concisely; when the message asks for a change, apply it. Not every message needs a file edit.",
    ...renderEditTargetLines(pin),
    "Keep the exported prop interface intact unless the request requires changing it.",
    "",
    "Selection context (captured at pin time):",
    renderContextForPrompt(pin.contextSnapshot),
    ...(pin.kind === "element" && pin.locator
      ? ["", renderLocatorForPrompt(pin.locator)]
      : []),
  ].join("\n");
}

/** U2 thread titles: one cheap turn, title only. */
function buildSandboxTitlePrompt(request: string): string {
  return [
    "Title this design request in 3-6 words.",
    `Request: ${request}`,
    "Reply with ONLY the title — plain text, one line, no quotes, no trailing punctuation. Do not read or write any files.",
  ].join("\n");
}

/** First non-empty line, quotes/trailing punctuation stripped, capped.
 * Undefined = unusable (the client keeps its truncated-prompt fallback). */
function sanitizeTitle(raw: string): string | undefined {
  const line = raw
    .trim()
    .split("\n")
    .map((candidate) => candidate.trim())
    .find(Boolean)
    ?.replace(/^["'`“”]+|["'`“”]+$/g, "")
    .replace(/[.:;,]+$/, "")
    .trim();
  if (!line) return undefined;
  return line.length > TITLE_MAX_LENGTH
    ? `${line.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : line;
}

/** The iterate prompt's element-context block (canvas element selection). */
function renderIterateElementForPrompt(element: SandboxIterateElement): string[] {
  const identity =
    `<${element.tag}>` +
    (element.id ? ` id="${element.id}"` : "") +
    (element.classes?.length ? ` classes: ${element.classes.join(" ")}` : "") +
    (element.componentHint ? ` (component: ${element.componentHint})` : "");
  return [
    "",
    `The designer selected a specific ELEMENT inside this variant's rendered preview (${element.label}) — apply the request to that element; leave the rest of the variant unchanged unless the request says otherwise.`,
    `Selected element: ${identity}`,
    ...(element.text ? [`Rendered text: ${element.text}`] : []),
    ...(element.outerHtml
      ? ["Rendered outerHTML (trimmed):", element.outerHtml]
      : []),
    "Locate the JSX in the variant file that renders this element (match the tag/classes/text above) and apply the change there.",
  ];
}

function buildSandboxIteratePrompt(params: {
  pin: SandboxPin;
  variant: SandboxVariant;
  request: string;
  /** Canvas element selection — scopes the note to one element. */
  element?: SandboxIterateElement;
}): string {
  const { pin, variant, request, element } = params;
  // L2: a COMPONENT variant lives AT the module path in this session's view
  // (reading the module shows THIS variant's current design); element span
  // variants stay standalone artifacts in the pin's working dir.
  const targetFile =
    pin.kind === "element" ? variant.file : pin.target.file;
  return [
    `Revise the design variant "${variant.id}" of "${pin.target.exportName}": edit ${targetFile} — its current content IS this variant's design.`,
    `Designer's note: ${request}`,
    "Read the file before editing.",
    ...(element ? renderIterateElementForPrompt(element) : []),
    "",
    "Hard rules:",
    `- ${SANDBOX_DATA_QUALITY_NOTE}`,
    `- Keep exactly one exported component named ${variantExportName(pin)} with the original props contract.`,
    "- Keep the root's intrinsic height.",
    `- ${SANDBOX_PRESERVE_NAV_RULE}`,
  ].join("\n");
}

/**
 * The ONE merge-agent turn a DRIFTED bake runs when the deterministic 3-way
 * merge (`git merge-file` semantics over the stored base snapshot) reports
 * conflicts (docs/specs/changeset-layers.md §Bake). Clean bakes and clean
 * 3-way merges never see a model.
 */
/** The reapply conflict-resolution merge turn (G2, spec §Selection): the
 * worktree sits mid cherry-pick with conflict markers — ONE turn resolves
 * preserving both intents and continues the sequence. */
function buildReapplyConflictPrompt(params: {
  fromLabel: string;
  toLabel: string;
}): string {
  return [
    "You are resolving a git cherry-pick conflict inside a designbook",
    "changeset worktree (your current working directory).",
    "",
    `Edits made on the "${params.fromLabel}" design are being reapplied onto`,
    `the "${params.toLabel}" design, and the cherry-pick paused on conflicts.`,
    "",
    "Do exactly this:",
    "1. Run `git status` to see the conflicted files.",
    "2. Resolve every conflict in place, preserving BOTH intents: keep the",
    `   "${params.toLabel}" design as the base, and carry the reapplied edit's`,
    "   change onto it (adapt it if the surrounding code differs).",
    "3. `git add` the resolved files and run `git cherry-pick --continue`",
    "   (repeat resolve/continue if more commits conflict) until the",
    "   cherry-pick completes.",
    "",
    "Rules:",
    "- Never run `git cherry-pick --abort`, never switch branches, never",
    "  reset or rebase.",
    "- Do not create new files or make unrelated edits.",
    "- Keep the default commit messages the cherry-pick proposes.",
  ].join("\n");
}

/** The rebase conflict-resolution merge turn (G3, spec §Drift/bake): the
 * changeset worktree sits mid `git rebase` with conflict markers — ONE turn
 * per conflicted branch resolves preserving both intents and continues. */
function buildRebaseConflictPrompt(params: { branchLabel: string }): string {
  return [
    "You are resolving a git rebase conflict inside a designbook changeset",
    "worktree (your current working directory).",
    "",
    `The changeset's "${params.branchLabel}" design is being rebased onto the`,
    "project's CURRENT source (the real files changed outside this changeset),",
    "and the rebase paused on conflicts.",
    "",
    "Do exactly this:",
    "1. Run `git status` to see the conflicted files.",
    "2. Resolve every conflict in place, preserving BOTH intents: keep the",
    "   current source's out-of-band changes as the base, and carry the",
    "   design's change onto it (adapt it if the surrounding code differs).",
    "3. `git add` the resolved files and run `git rebase --continue`",
    "   (repeat resolve/continue if more commits conflict) until the rebase",
    "   completes.",
    "",
    "Rules:",
    "- Never run `git rebase --abort`, never switch branches, never reset.",
    "- Do not create new files or make unrelated edits.",
    "- Keep the default commit messages the rebase proposes.",
  ].join("\n");
}

function buildBakeMergePrompt(params: {
  module: string;
  baseFile: string;
  layeredFile: string;
  conflictSummary: string;
}): string {
  const { module, baseFile, layeredFile } = params;
  return [
    `Merge a designbook changeset into drifted real source: ${module} changed on disk after the changeset's design was captured, and the automatic 3-way merge reported conflicts.`,
    "",
    "Files (read ALL THREE first):",
    `- REAL source to edit (already drifted — its current content is one side of the merge): ${module}`,
    `- BASE snapshot (what the file looked like when the changeset captured it): ${baseFile}`,
    `- CHANGESET design (the content the designer approved in place): ${layeredFile}`,
    "",
    "Hard rules:",
    `- Rewrite ${module} to combine BOTH sides: keep every out-of-band change the current file gained since the base snapshot, and apply the changeset's design on top of it.`,
    "- Where both sides changed the same code, the CHANGESET's design wins for presentation/layout; the current file wins for logic/data/wiring.",
    `- PRESERVE the file's exported prop interface and export names; no imports from .designbook/ may remain.`,
    `- Do not create, edit, or delete ANY file other than ${module}.`,
    "- The file must typecheck.",
    "",
    `Automatic merge conflict summary:\n${params.conflictSummary}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

/** Default branch/commit prober: plain git. Non-git repos tag layers with
 * empty branch/commit — everything stays visible (branch "" === branch ""). */
async function defaultGitInfo(
  repoRoot: string,
): Promise<{ branch: string; commit: string }> {
  try {
    const [branch, commit] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoRoot,
      }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    ]);
    return { branch: branch.stdout.trim(), commit: commit.stdout.trim() };
  } catch {
    return { branch: "", commit: "" };
  }
}

/** Default 3-way merge: `git merge-file -p` over temp files (exit 0 = clean,
 * >0 = that many conflicts — the marked content still comes back on stdout).
 * A spawn failure degrades to "conflicted" with the layered content, which
 * routes to the merge-agent turn rather than silently clobbering. */
async function defaultMergeFile(
  base: string,
  current: string,
  layered: string,
): Promise<{ content: string; conflicted: boolean }> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "designbook-merge-"));
    const basePath = join(dir, "base");
    const currentPath = join(dir, "current");
    const layeredPath = join(dir, "layered");
    await Promise.all([
      writeFile(basePath, base, "utf8"),
      writeFile(currentPath, current, "utf8"),
      writeFile(layeredPath, layered, "utf8"),
    ]);
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["merge-file", "-p", currentPath, basePath, layeredPath],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      return { content: stdout, conflicted: false };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string };
      if (typeof failure.code === "number" && failure.code > 0) {
        return { content: failure.stdout ?? "", conflicted: true };
      }
      return { content: layered, conflicted: true };
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function createSandboxOrchestrator(deps: SandboxDeps) {
  const { runTurn, runTypecheck, broadcast, log } = deps;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const gitInfo = deps.gitInfo ?? defaultGitInfo;
  const mergeFile = deps.mergeFile ?? defaultMergeFile;
  /** The G1 git core: hidden refs + worktrees + per-write commit capture. */
  const gitOps = createGitChangesets({
    ...(deps.gitExec ? { exec: deps.gitExec } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.worktreeIdleMs ? { worktreeIdleMs: deps.worktreeIdleMs } : {}),
    log: deps.log,
  });
  /**
   * Live pins, keyed by HOME + pin id. The sandbox index is often
   * git-TRACKED, so a branch worktree's checkout revives the SAME pin ids
   * as the primary checkout — with an id-only map, whichever home revived
   * first claimed the id GLOBALLY and every other home's copy was hijacked:
   * an ask from a branch page then ran against the WRONG repo root (refs,
   * worktrees and events all landing under the other root — the live
   * branch-topology bug). Per-home keys let both copies coexist; requests
   * resolve within their own home (see resolvePin).
   */
  const pins = new Map<string, PinSet>();

  function pinMapKey(repoRoot: string, appDir: string, pinId: string): string {
    return `${repoRoot}\u0000${appDir}\u0000${pinId}`;
  }

  /** A home's copy of a pin (exact — never another home's). */
  function pinFor(
    home: { repoRoot: string; appDir: string },
    pinId: string,
  ): PinSet | undefined {
    return pins.get(pinMapKey(home.repoRoot, home.appDir, pinId));
  }

  /**
   * Resolve a pin for an API request: scoped to the request's home when the
   * caller names one (api.ts always does — activeRepoRoot at request time);
   * id-only calls (legacy surfaces/tests) fall back to the first id match.
   */
  function resolvePin(params: {
    pinId: string;
    repoRoot?: string;
    appDir?: string;
  }): PinSet | undefined {
    if (params.repoRoot !== undefined && params.appDir !== undefined) {
      const appDir = normalizeAppDir(params.appDir) ?? params.appDir;
      return pins.get(pinMapKey(params.repoRoot, appDir, params.pinId));
    }
    for (const set of pins.values()) {
      if (set.pin.id === params.pinId) return set;
    }
    return undefined;
  }
  /** Per-index-file write queue (parallel landings serialize here). */
  const indexQueues = new Map<string, Promise<void>>();

  /** One sandbox HOME's layer state (L1), keyed by home. Layers are loaded
   * from their meta.json records on revive; `branch` is the CURRENT git
   * branch (refreshed per public entry, cached briefly) — foreign-branch
   * layers stay in `changesets` but are hidden and never resolved. */
  type HomeState = {
    repoRoot: string;
    appDir: string;
    changesets: SandboxChangeset[];
    /** Current git branch (layer visibility filter). */
    branch: string;
    branchProbedAt: number;
    /** Last content written per repo-relative generated path (merged data
     * artifacts — byte-compare so unchanged regenerations never touch
     * disk / HMR). */
    written: Map<string, string>;
    /** This home's contribution to the redirect table (abs real → abs alt). */
    redirects: Record<string, string>;
    /** Monotonic content stamps per PROJECTED file (abs target path →
     * stamp), bumped whenever a projection/data-merge write actually landed
     * bytes. Rides the redirect push so content-only changes (park,
     * rollback, turn-end re-projections at unchanged paths) still reach the
     * hosts as a hot update. */
    projectionStamps: Map<string, number>;
    /** Same-key-different-value data collisions from the last sync. */
    dataConflicts: DataKeyConflict[];
    /** Layer metas scanned from disk at least once. */
    revived: boolean;
  };
  const homes = new Map<string, HomeState>();

  /** Branch cache TTL — every public entry refreshes at most this often. */
  const BRANCH_TTL_MS = 2000;

  function homeKey(repoRoot: string, appDir: string): string {
    return `${repoRoot} ${appDir}`;
  }

  function homeFor(repoRoot: string, appDir: string): HomeState {
    const key = homeKey(repoRoot, appDir);
    let home = homes.get(key);
    if (!home) {
      home = {
        repoRoot,
        appDir,
        changesets: [],
        branch: "",
        branchProbedAt: 0,
        written: new Map(),
        redirects: {},
        projectionStamps: new Map(),
        dataConflicts: [],
        revived: false,
      };
      homes.set(key, home);
    }
    return home;
  }

  /** Refresh the home's current-branch tag (cached ~2s). */
  async function ensureBranch(home: HomeState): Promise<string> {
    const now = Date.now();
    if (now - home.branchProbedAt > BRANCH_TTL_MS) {
      home.branchProbedAt = now;
      home.branch = (await gitInfo(home.repoRoot)).branch;
    }
    return home.branch;
  }

  /** The global redirect table version (bumped when the table OR any live
   * target's content stamp changes). */
  let redirectsVersion = 0;
  let redirectsTable: Record<string, string> = {};
  /** Content stamps for the CURRENT table, keyed by real path (wire shape —
   * hosts diff them to hot-update content-only re-projections). */
  let redirectsStamps: Record<string, number> = {};
  /** Monotonic projection-write counter (stamp source; never reused within
   * a process, so equal stamps always mean "same write"). */
  let projectionStampSeq = 0;

  /**
   * The HOME a sandbox event belongs to. Every emit names its home
   * EXPLICITLY (a PinSet or HomeState — both carry repoRoot/appDir), so the
   * wire `branch` tag derives from the event's OWN home instead of whatever
   * branch happens to be active at emit time (the branch-topology bug: a
   * turn finishing after a switch — or running for a non-viewed home — was
   * tagged with the wrong branch and mis-delivered). api.ts maps the
   * attached `__home` to the wire tag and strips it.
   */
  type EmitScope = { repoRoot: string; appDir: string } | undefined;

  function emit(scope: EmitScope, payload: Record<string, unknown>): void {
    const branch = scope
      ? (homes.get(homeKey(scope.repoRoot, scope.appDir))?.branch ?? "")
      : "";
    broadcast(
      "sandbox-event",
      scope
        ? { ...payload, __home: { repoRoot: scope.repoRoot, branch } }
        : payload,
    );
  }

  function absPath(set: PinSet, relPath: string): string {
    return join(set.repoRoot, relPath);
  }

  async function fileExists(abs: string): Promise<boolean> {
    try {
      return (await stat(abs)).isFile();
    } catch {
      return false;
    }
  }

  /** ATOMIC durable-record write (index.js / meta.json): write a sibling
   * temp file, then rename over the target. Plain `writeFile` truncates
   * first, so a concurrent reader (the CLI, a test's sync read) can observe
   * an empty/partial file while a queued write is in flight — rename makes
   * every read see the old or the new content, never a torn one. */
  let atomicWriteSeq = 0;
  async function writeFileAtomic(abs: string, content: string): Promise<void> {
    const tmp = `${abs}.${process.pid}.${atomicWriteSeq++}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, abs);
  }

  /** Queue a full-index rewrite from the current in-memory state of one home. */
  function persist(set: PinSet): Promise<void> {
    return persistHome(set.repoRoot, set.appDir);
  }

  function persistHome(repoRoot: string, appDir: string): Promise<void> {
    const indexAbs = join(repoRoot, sandboxIndexFile(appDir));
    const queued = (indexQueues.get(indexAbs) ?? Promise.resolve()).then(
      async () => {
        const records = [...pins.values()]
          .filter(
            (candidate) =>
              candidate.repoRoot === repoRoot && candidate.appDir === appDir,
          )
          .map((candidate) => candidate.pin)
          .sort((a, b) => a.createdAt - b.createdAt);
        await mkdir(dirname(indexAbs), { recursive: true });
        await writeFileAtomic(indexAbs, serializeSandboxIndex({ pins: records }));
      },
    );
    // The LOGGED promise is both the chain tail and the return value: several
    // callers fire-and-forget (`void persist(...)`), and returning the raw
    // `queued` would turn any write failure into an UNHANDLED rejection.
    const settled = queued.catch((error: unknown) => {
      log(`sandbox index write failed: ${String(error)}`);
    });
    indexQueues.set(indexAbs, settled);
    return settled;
  }

  /** Persist ONE layer's meta.json (queued per meta file). */
  function persistChangeset(
    home: HomeState,
    changeset: SandboxChangeset,
  ): Promise<void> {
    const metaAbs = join(
      home.repoRoot,
      changesetMetaPath(home.appDir, changeset.id),
    );
    const queued = (indexQueues.get(metaAbs) ?? Promise.resolve()).then(
      async () => {
        await mkdir(dirname(metaAbs), { recursive: true });
        await writeFileAtomic(metaAbs, serializeLayerMeta(changeset));
      },
    );
    // Same discipline as persistHome: return the logged promise so a voided
    // call can never surface an unhandled rejection.
    const settled = queued.catch((error: unknown) => {
      log(`sandbox layer meta write failed: ${String(error)}`);
    });
    indexQueues.set(metaAbs, settled);
    void ensureLayersExcluded(home.repoRoot);
    return settled;
  }

  /** TEST/SHUTDOWN seam: resolve once every durable write (index + meta)
   * queued so far has flushed. Writes queued after the call are not covered
   * — pair with whatever run-completion event the caller already awaits. */
  async function settle(): Promise<void> {
    await Promise.all([...indexQueues.values()]);
  }

  /** Delete a layer's whole dir (discard / dissolve-after-bake). */
  async function removeChangesetFiles(
    home: HomeState,
    changesetId: string,
  ): Promise<void> {
    const dirAbs = join(home.repoRoot, changesetDir(home.appDir, changesetId));
    await rm(dirAbs, { recursive: true, force: true }).catch(() => {});
  }

  /** Repos that already got the `.designbook/changesets/` exclude line. */
  const layersExcluded = new Set<string>();

  /**
   * Keep layer dirs OUT of source control (spec §Storage: layers are
   * short-lived working state). Client repos get the rule appended to
   * `.git/info/exclude` (local, uncommitted — same mechanism as the branch
   * worktrees dir). Idempotent + best-effort: respects an existing
   * `.gitignore`/exclude entry, never fails a layer write.
   */
  async function ensureLayersExcluded(repoRoot: string): Promise<void> {
    if (layersExcluded.has(repoRoot)) return;
    layersExcluded.add(repoRoot);
    const pattern = "**/.designbook/changesets/";
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--git-common-dir"],
        { cwd: repoRoot },
      );
      const excludeAbs = join(repoRoot, stdout.trim(), "info", "exclude");
      const covered = (content: string) =>
        content
          .split("\n")
          .some((line) => line.trim().replace(/\/+$/, "") === pattern.replace(/\/+$/, ""));
      const [excludeContent, gitignoreContent] = await Promise.all([
        readFile(excludeAbs, "utf8").catch(() => ""),
        readFile(join(repoRoot, ".gitignore"), "utf8").catch(() => ""),
      ]);
      if (covered(excludeContent) || covered(gitignoreContent)) return;
      const prefix =
        excludeContent.length && !excludeContent.endsWith("\n") ? "\n" : "";
      await mkdir(dirname(excludeAbs), { recursive: true });
      await writeFile(
        excludeAbs,
        `${excludeContent}${prefix}# designbook changeset layers (working state; bake/discard removes them)\n${pattern}\n`,
        "utf8",
      );
    } catch {
      // Not a git repo / read-only .git — best-effort only.
    }
  }

  /** Revive pins from the durable index + layers from their meta records
   * (restart). Index compat: the O1 path first, then the legacy
   * in-sandbox-dir path; pre-layer changesets/switches slices are ignored. */
  async function revive(repoRoot: string, appDir: string): Promise<void> {
    let index: SandboxIndex | undefined;
    for (const candidate of [
      sandboxIndexFile(appDir),
      legacySandboxIndexFile(appDir),
    ]) {
      try {
        const source = await readFile(join(repoRoot, candidate), "utf8");
        index = parseSandboxIndex(source);
        break;
      } catch {
        // Try the next candidate.
      }
    }
    for (const record of index?.pins ?? []) {
      if (pins.has(pinMapKey(repoRoot, appDir, record.id))) continue;
      // In-flight statuses cannot survive a restart: anything not landed is
      // failed-with-reason after a revive.
      for (const variant of record.variants) {
        if (variant.status === "generating" || variant.status === "updating") {
          variant.status = "failed";
          variant.error = "The server restarted during this generation.";
        }
      }
      pins.set(pinMapKey(repoRoot, appDir, record.id), {
        pin: record,
        repoRoot,
        appDir,
        busy: false,
      });
    }
    const home = homeFor(repoRoot, appDir);
    await ensureBranch(home);
    if (!home.revived) {
      home.revived = true;
      const homeAbs = join(repoRoot, changesetsDir(appDir));
      let entries: string[] = [];
      try {
        entries = await readdir(homeAbs);
      } catch {
        // No layer home yet.
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith("_") || entry.startsWith(".")) continue;
        if (home.changesets.some((candidate) => candidate.id === entry)) {
          continue;
        }
        const metaSource = await readFile(
          join(repoRoot, changesetMetaPath(appDir, entry)),
          "utf8",
        ).catch(() => undefined);
        if (metaSource === undefined) continue;
        const meta = parseLayerMeta(metaSource);
        if (!meta || meta.id !== entry) continue;
        home.changesets.push(meta);
      }
      // G1: re-derive every revived layer from its refs (a restart after a
      // ref move must not serve a stale projection). No-op without refs.
      for (const changeset of home.changesets) {
        try {
          await projectChangeset(home, changeset);
        } catch (error) {
          log(`sandbox projection failed on revive (${changeset.id}): ${String(error)}`);
        }
      }
      // Rebuild the redirect table for the revived state (a server restart
      // must not orphan an active layer's redirects).
      if (home.changesets.some((changeset) => changeset.active)) {
        await syncOverrides(home);
        ensureDriftWatch();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layer resolution (L1): the redirect table + serve-time data merge.
  // -------------------------------------------------------------------------

  /** Serialize per-home layer work (parallel landings, revive, bake). */
  function queueOverrideWork(
    home: HomeState,
    work: () => Promise<void>,
  ): Promise<void> {
    const key = `override:${homeKey(home.repoRoot, home.appDir)}`;
    const queued = (indexQueues.get(key) ?? Promise.resolve()).then(work);
    indexQueues.set(
      key,
      queued.catch((error: unknown) => {
        log(`sandbox layer sync failed: ${String(error)}`);
      }),
    );
    return queued;
  }

  /** Recompute the merged (all homes) redirect table + per-target content
   * stamps; on ANY change (paths or stamps) bump the version, push through
   * the ModuleOverrideHost seam, and broadcast. Content stamps make
   * content-only re-projections (park/rollback/turn-end at unchanged paths)
   * observable — the hosts hot-update the rewritten modules instead of
   * relying on their own watcher (the canvas-staleness race). */
  function refreshRedirectTable(scope?: EmitScope): void {
    const merged: Record<string, string> = {};
    const stamps: Record<string, number> = {};
    for (const home of [...homes.values()].sort((a, b) =>
      homeKey(a.repoRoot, a.appDir) < homeKey(b.repoRoot, b.appDir) ? -1 : 1,
    )) {
      Object.assign(merged, home.redirects);
      for (const [real, target] of Object.entries(home.redirects)) {
        const stamp = home.projectionStamps.get(target);
        if (stamp !== undefined) stamps[real] = stamp;
      }
    }
    const stable = (table: Record<string, string>) =>
      JSON.stringify(Object.keys(table).sort().map((key) => [key, table[key]]));
    const stableStamps = (table: Record<string, number>) =>
      JSON.stringify(Object.keys(table).sort().map((key) => [key, table[key]]));
    if (
      stable(merged) === stable(redirectsTable) &&
      stableStamps(stamps) === stableStamps(redirectsStamps)
    ) {
      return;
    }
    redirectsTable = merged;
    redirectsStamps = stamps;
    // Time-seeded so a SERVER RESTART never reissues a version an injected
    // vite (a separate, longer-lived process) has already seen and skipped.
    redirectsVersion = Math.max(redirectsVersion + 1, Date.now());
    deps.onOverridesChanged?.(redirectsTable, redirectsStamps);
    emit(scope, { type: "overrides-changed", version: redirectsVersion });
    log(
      `sandbox overrides: redirect table v${redirectsVersion} (${Object.keys(redirectsTable).length} modules)`,
    );
  }

  /**
   * Rebuild a home's redirect table + merged DATA artifacts from its ACTIVE
   * layers (docs/specs/changeset-layers.md §Resolution / §Data merge):
   *
   *   - Code files: real path → the TOPMOST active layer's SELECTED
   *     alternative. One table refresh per flip — the host driver diffs and
   *     pushes ONE batched hot update, so cross-module changesets flip
   *     atomically and never full-reload.
   *   - Data files (json/po/cssvar): a merged artifact under
   *     `.designbook/changesets/_merged/` — current real content + each
   *     active layer's ADDITIONS in stack order, byte-compared so unchanged
   *     regenerations never touch disk. Same-key-different-value across two
   *     layers = a data conflict (recorded + surfaced, bottom-most wins in
   *     the served output).
   */
  async function syncOverrides(home: HomeState): Promise<void> {
    await queueOverrideWork(home, async () => {
      const stack = activeLayers(home.changesets, home.branch);
      const redirectsRel = computeLayerRedirects({
        layers: home.changesets,
        branch: home.branch,
        appDir: home.appDir,
        isDataPath,
      });
      const redirects: Record<string, string> = {};
      for (const [real, alt] of redirectsRel) {
        redirects[join(home.repoRoot, real)] = join(home.repoRoot, alt);
      }

      // Serve-time data merge.
      const dataFiles = new Map<string, SandboxChangeset[]>();
      for (const layer of stack) {
        for (const path of Object.keys(layer.overrides)) {
          if (!isDataPath(path)) continue;
          const list = dataFiles.get(path) ?? [];
          list.push(layer);
          dataFiles.set(path, list);
        }
      }
      const dataConflicts: DataKeyConflict[] = [];
      for (const [path, layers] of [...dataFiles].sort()) {
        const format = dataFormatFor(path)!;
        const current = await readFile(join(home.repoRoot, path), "utf8").catch(
          () => "",
        );
        const inputs: Array<{ changesetId: string; additions: Map<string, string> }> = [];
        for (const layer of layers) {
          // G1: the 3-way base is the layer's baseCommit BLOB (the stored
          // base/ snapshot died — git is the truth plane).
          const base = layer.baseCommit
            ? ((await gitOps
                .readBlob(home.repoRoot, layer.baseCommit, path)
                .catch(() => undefined)) ?? "")
            : "";
          const alt = await readFile(
            join(
              home.repoRoot,
              altFilePath(home.appDir, layer.id, DATA_ALT_ID, path),
            ),
            "utf8",
          ).catch(() => undefined);
          if (alt === undefined) continue;
          inputs.push({
            changesetId: layer.id,
            // CHANGES, not just additions (L3): direct-edits layers carry
            // key mutations; additive layers yield the same map either way.
            additions: computeDataChanges(format, base, alt),
          });
        }
        if (inputs.length === 0) continue;
        const merged = mergeDataLayers({
          format,
          file: path,
          current,
          layers: inputs,
        });
        dataConflicts.push(...merged.conflicts);
        const mergedRel = mergedDataPath(home.appDir, path);
        const mergedAbs = join(home.repoRoot, mergedRel);
        let existing = home.written.get(mergedRel);
        if (existing === undefined) {
          existing = await readFile(mergedAbs, "utf8").catch(() => undefined);
        }
        if (existing !== merged.content) {
          await mkdir(dirname(mergedAbs), { recursive: true });
          await writeFile(mergedAbs, merged.content, "utf8");
          home.projectionStamps.set(mergedAbs, ++projectionStampSeq);
          log(`sandbox data merge written: ${mergedRel}`);
        }
        home.written.set(mergedRel, merged.content);
        redirects[join(home.repoRoot, path)] = mergedAbs;
      }
      home.dataConflicts = dataConflicts;
      home.redirects = redirects;
      refreshRedirectTable(home);
    });
  }

  /**
   * The ACTIVE RESOLUTION of a module: the topmost active layer's selected
   * alternative, or undefined (the original serves). New work builds on this
   * ("generation reads the ACTIVE resolution as its original") and agent
   * edit turns target it (edits-follow-resolution).
   */
  function resolveActiveResolution(
    home: HomeState,
    module: string,
  ): { file: string; changesetId: string; variantId: string } | undefined {
    const stack = activeLayers(home.changesets, home.branch);
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const layer = stack[index];
      const override = layer.overrides[module];
      if (!override?.selection) continue;
      if (!override.alternatives.includes(override.selection)) continue;
      return {
        file: altFilePath(home.appDir, layer.id, override.selection, module),
        changesetId: layer.id,
        variantId: override.selection,
      };
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // G1 — turns on git worktrees (docs/specs/changesets-on-git.md).
  //
  // Git is the truth plane: agent turns run with cwd = a REAL worktree whose
  // HEAD is symref'd onto the changeset's hidden branch, with the SDK's
  // built-in tools. Every tool-write becomes a commit (api.ts drives
  // capture.noteToolEnd from the tool_execution_end seam); turn end commits
  // any remainder, stamps the boundary trailers, and re-projects the layer
  // cache the serve plane reads.
  // -------------------------------------------------------------------------

  /** The altId a changeset's TRUNK projects under: direct-edits layers use
   * the `direct` alternative, pin layers the `edit` alternative (edit-only
   * asks commit on trunk — spec §Refs). */
  function trunkAltId(changesetId: string): string {
    return isDirectChangesetId(changesetId) ? DIRECT_ALT_ID : "edit";
  }

  /** The hidden ref an alternative id lives on. */
  function refForAlt(changesetId: string, altId: string): string {
    return altId === trunkAltId(changesetId)
      ? refTrunk(changesetId)
      : refVariant(changesetId, altId);
  }

  /** The alternative id a changeset ref projects under (undefined for
   * base/selected). */
  function altForRef(changesetId: string, ref: string): string | undefined {
    if (ref === refTrunk(changesetId)) return trunkAltId(changesetId);
    return altIdOfRef(changesetId, ref);
  }

  /** Is this repo path designbook working state or infrastructure (never a
   * layer override)? node_modules can only appear via the shared-deps
   * symlinks — belt against a commit that slipped them in. */
  function isDesignbookPath(relPath: string): boolean {
    return (
      relPath.startsWith(".designbook/") ||
      relPath.includes("/.designbook/") ||
      relPath.split("/").includes("node_modules")
    );
  }

  /** Seed designbook pin artifacts (wrapper/original/controller/spans — the
   * REAL tree owns them) into a worktree so element-pin turns can read and
   * revise them there. Committed as a seed commit so the turn's own range
   * stays clean of pre-existing content. */
  async function seedWorktreeArtifacts(
    worktreeAbs: string,
    repoRoot: string,
    relDirs: readonly string[],
  ): Promise<void> {
    let seeded = false;
    for (const rel of relDirs) {
      const sourceAbs = join(repoRoot, rel);
      try {
        if (!(await stat(sourceAbs)).isDirectory()) continue;
      } catch {
        continue;
      }
      await cp(sourceAbs, join(worktreeAbs, rel), {
        recursive: true,
        force: true,
      });
      seeded = true;
    }
    if (seeded) {
      await gitOps.commitAll(worktreeAbs, "designbook: seed pin artifacts");
    }
  }

  /** Copy designbook working artifacts a turn changed (element span files,
   * controller revisions) back into the REAL tree — the canvas gallery
   * imports them from there. Layer/worktree paths are never copied. */
  async function copyBackDesignbookArtifacts(
    home: HomeState,
    range: { from: string; to: string },
  ): Promise<string[]> {
    if (range.from === range.to) return [];
    const copied: string[] = [];
    for (const change of await gitOps.changedFiles(
      home.repoRoot,
      range.from,
      range.to,
    )) {
      const rel = change.path;
      if (!isDesignbookPath(rel)) continue;
      if (isChangesetPath(rel, home.appDir)) continue;
      if (rel.includes(".designbook/worktrees/")) continue;
      if (change.status === "D") continue;
      const content = await gitOps.readBlob(home.repoRoot, range.to, rel);
      if (content === undefined) continue;
      const abs = containedPath(home.repoRoot, rel);
      if (!abs) continue;
      const existing = await readFile(abs, "utf8").catch(() => undefined);
      if (existing === content) continue;
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      copied.push(rel);
    }
    return copied;
  }

  type GitTurnResult = {
    text: string;
    errorMessage?: string;
    sessionId?: string;
    from: string;
    to: string;
    commits: string[];
  };

  /**
   * ONE git-backed agent turn on a changeset branch: ensure the worktree
   * (shared per changeset — or a TEMP one for parallel fan-out arms), run
   * the turn with per-write commit capture, flush + stamp the turn trailers,
   * copy designbook artifacts back to the real tree, and record the turn's
   * commit range in the sidecar. Throws only on infrastructure failures
   * (worktree/git); turn-level errors ride the result.
   */
  async function runGitTurn(params: {
    home: HomeState;
    changesetId: string;
    ref: string;
    mode: Parameters<SandboxRunTurn>[0]["mode"];
    prompt: string;
    onActivity?: (entry: SandboxTurnActivity) => void;
    conversationId?: string | undefined;
    /** Fan-out arms get their own temp worktree (parallel turns must not
     * share the changeset worktree). */
    temp?: boolean;
    /** Repo-relative dirs of pin artifacts to seed into the worktree. */
    seedDirs?: readonly string[];
  }): Promise<GitTurnResult> {
    const { home } = params;
    const repoRoot = home.repoRoot;
    const worktreeAbs = params.temp
      ? await gitOps.createTempWorktree({
          repoRoot,
          ref: params.ref,
          appDir: home.appDir,
        })
      : await gitOps.ensureWorktree({
          repoRoot,
          changesetId: params.changesetId,
          ref: params.ref,
          appDir: home.appDir,
        });
    try {
      if (params.seedDirs?.length) {
        await seedWorktreeArtifacts(worktreeAbs, repoRoot, params.seedDirs);
      }
      const startTip = (await gitOps.resolveCommit(repoRoot, params.ref))!;
      const capture = gitOps.createTurnCapture({
        repoRoot,
        worktreeAbs,
        ref: params.ref,
        startTip,
      });
      // Agent-supplied summaries (turnSummary.ts): write-class turns close
      // their reply with a `Summary:` metadata line (+ optional `Title:`).
      const wantsSummary = params.mode === "edit" || params.mode === "variant";
      let turn: Awaited<ReturnType<SandboxRunTurn>>;
      try {
        turn = await runTurn({
          cwd: worktreeAbs,
          mode: params.mode,
          prompt: wantsSummary
            ? `${params.prompt}\n\n${SUMMARY_PROMPT_INSTRUCTION}`
            : params.prompt,
          capture,
          ...(params.onActivity ? { onActivity: params.onActivity } : {}),
          conversationId: params.conversationId,
        });
      } catch (error) {
        // Salvage whatever committed before the seam threw, then rethrow —
        // callers classify the failure exactly as before.
        await capture.finish({}).catch(() => {});
        throw error;
      }
      const meta = wantsSummary
        ? parseTurnSummary(turn.text)
        : { cleaned: turn.text };
      // The metadata lines never reach a visible surface (pin threads show
      // `turn.text` verbatim).
      turn = { ...turn, text: meta.cleaned };
      const range = await capture.finish({
        ...(params.conversationId
          ? { conversationId: params.conversationId }
          : {}),
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        turnIndex: 1,
        ...(meta.summary ? { summary: meta.summary } : {}),
      });
      await copyBackDesignbookArtifacts(home, range);
      if (range.commits.length > 0) {
        try {
          await deps.recordTurn?.({
            repoRoot,
            changesetId: params.changesetId,
            ref: params.ref,
            from: range.from,
            to: range.to,
            ...(params.conversationId
              ? { conversationId: params.conversationId }
              : {}),
            ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
            at: Date.now(),
            ...(meta.summary ? { label: meta.summary } : {}),
          });
        } catch (error) {
          log(`sandbox turn sidecar record failed: ${String(error)}`);
        }
        // Optional agent retitle of the branch it worked on (ignored when
        // the user renamed the ref — user names are locked).
        if (meta.title) {
          await applyRefTitle({
            home,
            changesetId: params.changesetId,
            ref: params.ref,
            title: meta.title,
            source: "agent",
          }).catch((error: unknown) => {
            log(`agent ref title failed: ${String(error)}`);
          });
        }
      }
      return { ...turn, ...range };
    } finally {
      if (params.temp) {
        await gitOps.removeTempWorktree(repoRoot, worktreeAbs);
      } else {
        void gitOps
          .pruneIdleWorktrees(repoRoot)
          .catch(() => {});
      }
    }
  }

  /**
   * A SCRATCH turn (director / intent / title): runs in the changeset's
   * shared worktree on TRUNK with NO commit capture — designbook artifacts
   * it wrote (the element director's original/controller) are copied back to
   * the real tree, then the worktree resets so nothing it strayed into can
   * ever commit.
   */
  async function runScratchTurn(params: {
    home: HomeState;
    changesetId: string;
    mode: Parameters<SandboxRunTurn>[0]["mode"];
    prompt: string;
    onActivity?: (entry: SandboxTurnActivity) => void;
    conversationId?: string | undefined;
    seedDirs?: readonly string[];
  }): Promise<{ text: string; errorMessage?: string }> {
    const { home } = params;
    const repoRoot = home.repoRoot;
    await gitOps.ensureChangesetRefs(repoRoot, params.changesetId);
    // Scratch turns read "what the user sees": the SELECTED branch when one
    // is checked out, trunk otherwise.
    const ref =
      (await gitOps.getSelected(repoRoot, params.changesetId)) ??
      refTrunk(params.changesetId);
    const worktreeAbs = await gitOps.ensureWorktree({
      repoRoot,
      changesetId: params.changesetId,
      ref,
      appDir: home.appDir,
    });
    if (params.seedDirs?.length) {
      await seedWorktreeArtifacts(worktreeAbs, repoRoot, params.seedDirs);
    }
    try {
      return await runTurn({
        cwd: worktreeAbs,
        mode: params.mode,
        prompt: params.prompt,
        ...(params.onActivity ? { onActivity: params.onActivity } : {}),
        conversationId: params.conversationId,
      });
    } finally {
      // Copy back designbook artifacts the turn wrote, then drop strays.
      try {
        for (const rel of await gitOps.dirtyPaths(worktreeAbs)) {
          if (!isDesignbookPath(rel)) continue;
          if (isChangesetPath(rel, home.appDir)) continue;
          const abs = containedPath(repoRoot, rel);
          if (!abs) continue;
          const content = await readFile(join(worktreeAbs, rel), "utf8").catch(
            () => undefined,
          );
          if (content === undefined) continue;
          const existing = await readFile(abs, "utf8").catch(() => undefined);
          if (existing !== content) {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, content, "utf8");
          }
        }
        await gitOps.cleanWorktree(worktreeAbs);
      } catch (error) {
        log(`sandbox scratch sweep failed: ${String(error)}`);
      }
    }
  }

  /**
   * PROJECTION (spec §Projection): derive the changeset's ENTIRE layer state
   * from git — after any ref move, diff base..tip per branch and write the
   * changed blobs into the EXISTING `.designbook/changesets/<id>/alts/…`
   * layout, byte-compared so unchanged files never touch disk (HMR
   * discipline). meta.json's overrides/baseHashes/selections re-derive;
   * active/order/title ride along from the in-memory record. Data files
   * project as key CHANGES against the base blob — additions AND mutations
   * of existing keys, for EVERY layer kind (round-2 policy change: the
   * pin-layer additive-only drop died; layer-wins + git made it obsolete).
   * Returns the data warnings for thread surfacing.
   */
  async function projectChangeset(
    home: HomeState,
    changeset: SandboxChangeset,
  ): Promise<{ warnings: string[] }> {
    const repoRoot = home.repoRoot;
    const id = changeset.id;
    const refs = await gitOps.listRefs(repoRoot, id);
    if (refs.length === 0) return { warnings: [] }; // No git state — leave as-is.
    const byRef = new Map(refs.map((entry) => [entry.ref, entry.commit]));
    const base = byRef.get(refBase(id)) ?? changeset.baseCommit;
    if (base) changeset.baseCommit = base;
    const selectedRef = await gitOps.getSelected(repoRoot, id);
    const selectedAlt = selectedRef
      ? altForRef(id, selectedRef)
      : undefined;

    // Branches to project: trunk (under its canonical alt) + every variant.
    const branches: Array<{ altId: string; tip: string }> = [];
    const trunkTip = byRef.get(refTrunk(id));
    if (trunkTip) branches.push({ altId: trunkAltId(id), tip: trunkTip });
    for (const { ref, commit } of refs) {
      const altId = altIdOfRef(id, ref);
      if (altId) branches.push({ altId, tip: commit });
    }
    branches.sort((a, b) => (a.altId < b.altId ? -1 : 1));

    // G4 PARK: a parked changeset projects the parked ref's state AS OF the
    // parked commit — a pure cache substitution; NO ref moves. Every other
    // branch keeps projecting from its real tip.
    if (changeset.parked) {
      const parkedAlt = altForRef(id, changeset.parked.ref);
      const parkedBranch = branches.find(
        (candidate) => candidate.altId === parkedAlt,
      );
      if (
        parkedBranch &&
        (await gitOps.resolveCommit(repoRoot, changeset.parked.commit))
      ) {
        parkedBranch.tip = changeset.parked.commit;
      }
    }

    const warnings: string[] = [];
    const overrides: Record<string, LayerOverride> = {};
    const baseHashes: Record<string, string> = {};
    const wanted = new Map<string, string>();
    const dataUnion = new Map<string, Map<string, string>>();
    const baseBlobCache = new Map<string, string>();
    const baseBlob = async (path: string): Promise<string> => {
      let text = baseBlobCache.get(path);
      if (text === undefined) {
        text = (await gitOps.readBlob(repoRoot, base, path)) ?? "";
        baseBlobCache.set(path, text);
      }
      return text;
    };

    for (const branch of branches) {
      if (branch.tip === base) continue;
      for (const change of await gitOps.changedFiles(
        repoRoot,
        base,
        branch.tip,
      )) {
        const path = change.path;
        if (isDesignbookPath(path)) continue;
        if (change.status === "D") continue; // Layers cannot express deletes.
        const format = dataFormatFor(path);
        if (format) {
          const baseText = await baseBlob(path);
          const tipText =
            (await gitOps.readBlob(repoRoot, branch.tip, path)) ?? "";
          // Round-2 policy change (Michael, 2026-07-14): mutations of
          // EXISTING data keys are first-class layer overrides for EVERY
          // layer kind — recorded key-level like additions, layer-wins while
          // active, same-key-two-layers rides the existing conflict surface,
          // discard reverts, bake merges into the real file. The pin-layer
          // additive-only drop died here (git + layer-wins made the
          // prohibition obsolete).
          const changes = computeDataChanges(format, baseText, tipText);
          if (changes.size === 0) continue;
          const union = dataUnion.get(path) ?? new Map<string, string>();
          for (const [key, value] of changes) union.set(key, value);
          dataUnion.set(path, union);
          continue;
        }
        const content = await gitOps.readBlob(repoRoot, branch.tip, path);
        if (content === undefined) continue;
        // Identical-to-base blobs (a variant branch carrying only trunk's
        // history for this file) still project — every variant tip projects
        // (canvas gallery needs all of them).
        wanted.set(altFilePath(home.appDir, id, branch.altId, path), content);
        const override = (overrides[path] ??= { alternatives: [] });
        if (!override.alternatives.includes(branch.altId)) {
          override.alternatives.push(branch.altId);
        }
        if (baseHashes[path] === undefined) {
          baseHashes[path] = hashModuleSource(await baseBlob(path));
        }
      }
    }

    for (const [path, union] of [...dataUnion].sort()) {
      if (union.size === 0) continue;
      const format = dataFormatFor(path)!;
      const baseText = await baseBlob(path);
      wanted.set(
        altFilePath(home.appDir, id, DATA_ALT_ID, path),
        applyDataChanges(format, baseText, union),
      );
      overrides[path] = {
        selection: DATA_ALT_ID,
        alternatives: [DATA_ALT_ID],
        addedKeys: [...union.keys()].sort(),
      };
    }

    // Cross-layer same-key collision: another ACTIVE layer already adds one
    // of these keys (surfaced as a warning at landing; the serve-time merge
    // records the conflict too).
    for (const [path, override] of Object.entries(overrides)) {
      if (!isDataPath(path) || !override.addedKeys) continue;
      for (const other of activeLayers(home.changesets, home.branch)) {
        if (other.id === id) continue;
        const otherKeys = other.overrides[path]?.addedKeys ?? [];
        for (const key of override.addedKeys) {
          if (otherKeys.includes(key)) {
            warnings.push(
              `"${key}" in ${path} is also added by changeset ${other.id} — both explorations add the same key.`,
            );
          }
        }
      }
    }

    // Selection = checkout: the selected branch's alternative serves for
    // every code file it changed; files it never touched clear (the L2
    // "flips follow the target" rule, now mechanical).
    for (const [path, override] of Object.entries(overrides)) {
      if (isDataPath(path)) continue;
      override.alternatives.sort();
      if (selectedAlt && override.alternatives.includes(selectedAlt)) {
        override.selection = selectedAlt;
      }
    }

    // Write the projected cache: byte-compare before writing (unchanged
    // regenerations never touch disk), then sweep stale files.
    for (const [rel, content] of [...wanted].sort()) {
      const abs = join(repoRoot, rel);
      const existing = await readFile(abs, "utf8").catch(() => undefined);
      if (existing === content) continue;
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(abs, content);
      // Content stamp: rides the redirect push so a rewrite at an UNCHANGED
      // path (park/rollback/turn-end) still reaches the hosts as a hot
      // update (never watcher-dependent).
      home.projectionStamps.set(abs, ++projectionStampSeq);
    }
    const altsRootAbs = join(repoRoot, changesetDir(home.appDir, id), "alts");
    const keep = new Set([...wanted.keys()].map((rel) => join(repoRoot, rel)));
    await sweepStaleProjection(altsRootAbs, keep);
    for (const abs of [...home.projectionStamps.keys()]) {
      if (abs.startsWith(`${altsRootAbs}${sep}`) && !keep.has(abs)) {
        home.projectionStamps.delete(abs);
      }
    }
    // The stored base/ snapshot dir died with G1 (3-way inputs come from
    // git) — drop any legacy leftover.
    await rm(join(repoRoot, changesetDir(home.appDir, id), "base"), {
      recursive: true,
      force: true,
    }).catch(() => {});

    changeset.overrides = overrides;
    changeset.baseHashes = baseHashes;
    await persistChangeset(home, changeset);
    return { warnings };
  }

  /** Remove projected files that no longer derive from any branch, pruning
   * emptied dirs bottom-up. */
  async function sweepStaleProjection(
    rootAbs: string,
    keep: ReadonlySet<string>,
  ): Promise<void> {
    let entries: Array<{ name: string; abs: string; dir: boolean }> = [];
    try {
      entries = (await readdir(rootAbs, { withFileTypes: true })).map(
        (entry) => ({
          name: entry.name,
          abs: join(rootAbs, entry.name),
          dir: entry.isDirectory(),
        }),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.dir) {
        await sweepStaleProjection(entry.abs, keep);
      } else if (!keep.has(entry.abs)) {
        await rm(entry.abs, { force: true }).catch(() => {});
      }
    }
    await rmdir(rootAbs).catch(() => {}); // Only succeeds when emptied.
  }

  /** Surface projection data warnings on the owning pin thread (the L2
   * "Adapter-data note" discipline, unchanged on the wire). */
  async function surfaceDataWarnings(
    home: HomeState,
    set: PinSet | undefined,
    changesetId: string,
    warnings: string[],
  ): Promise<void> {
    if (warnings.length === 0) return;
    if (set) {
      pushThread(set, {
        role: "assistant",
        text: `Adapter-data note:\n${warnings.map((w) => `• ${w}`).join("\n")}`,
        at: Date.now(),
      });
      await persist(set);
    }
    emit(home, {
      type: "data-warning",
      ...(set ? { pinId: set.pin.id } : {}),
      changesetId,
      warnings,
    });
  }

  /** File-level conflicts across the active stack (data files exempt). */
  function fileConflicts(home: HomeState): LayerConflict[] {
    return computeLayerConflicts({
      layers: home.changesets,
      branch: home.branch,
      isDataPath,
    });
  }

  /** The export name a layer override of `path` is known by on the wire
   * (componentKey compat): the owning pin's target export when the path IS
   * the pin's component file; otherwise unknown. */
  function exportNameFor(
    home: HomeState,
    changeset: SandboxChangeset,
    path: string,
  ): string {
    const owner = pinFor(home, changeset.pinId);
    return owner && owner.pin.target.file === path
      ? owner.pin.target.exportName
      : "";
  }

  /** The synthesized per-component switch snapshot (wire compat): for every
   * module, the RESOLVED winner. Bottom→top iteration — topmost wins. */
  function synthSwitches(home: HomeState): SandboxSwitches {
    const out: SandboxSwitches = {};
    for (const layer of activeLayers(home.changesets, home.branch)) {
      for (const [path, override] of Object.entries(layer.overrides)) {
        if (isDataPath(path)) continue;
        if (!override.selection) continue;
        if (!override.alternatives.includes(override.selection)) continue;
        out[componentKey(path, exportNameFor(home, layer, path))] = {
          changesetId: layer.id,
          variantId: override.selection,
        };
      }
    }
    return out;
  }

  /** Broadcast the synthesized switch snapshot (wire-compat event). */
  function emitSwitchState(
    home: HomeState,
    extra: Record<string, unknown> = {},
  ): void {
    emit(home, { type: "switch-changed", switches: synthSwitches(home), ...extra });
  }

  /** The wire shape of one changeset (status payloads + events): the layer
   * record mapped onto the pre-layer shape the UI folds — `threadPinId`,
   * `overrides: [{module, exportName, variantFiles}]`, `dataAdditionCount`,
   * plus the `drifted` and `basedOnInactive` badges. */
  function publicChangeset(home: HomeState, changeset: SandboxChangeset) {
    const activeIds = new Set(
      activeLayers(home.changesets, home.branch).map((layer) => layer.id),
    );
    let dataAdditionCount = 0;
    const overrides: Array<{
      module: string;
      exportName: string;
      variantFiles: string[];
      alternatives: string[];
      selection?: string;
    }> = [];
    for (const [path, override] of Object.entries(changeset.overrides).sort()) {
      if (isDataPath(path)) {
        dataAdditionCount += override.addedKeys?.length ?? 0;
        continue;
      }
      overrides.push({
        module: path,
        exportName: exportNameFor(home, changeset, path),
        variantFiles: override.alternatives.map((alt) =>
          altFilePath(home.appDir, changeset.id, alt, path),
        ),
        // Layer alt ids ARE the variant ids (mirrored paths keep the module
        // basename, so clients must not derive ids from file names).
        alternatives: [...override.alternatives],
        ...(override.selection ? { selection: override.selection } : {}),
      });
    }
    return {
      id: changeset.id,
      threadPinId: changeset.pinId,
      // L3 grouping key (+ direct-edits identification for the drawer).
      ...(changeset.conversationId
        ? { conversationId: changeset.conversationId }
        : {}),
      ...(changeset.title ? { title: changeset.title } : {}),
      direct: isDirectChangesetId(changeset.id) && !changeset.pinId,
      active: changeset.active,
      drifted: changeset.drifted === true,
      basedOnInactive:
        changeset.active &&
        (changeset.bases ?? []).some((id) => !activeIds.has(id)),
      dataAdditionCount,
      overrides,
      // G3 bake-to-branch badge (+ the re-bake default target).
      ...(changeset.bakedTo ? { bakedTo: changeset.bakedTo } : {}),
      // G4 park preview (the "viewing turn N" banner + graph marker).
      ...(changeset.parked
        ? {
            parked: {
              commit: changeset.parked.commit,
              ref: changeset.parked.ref,
              ...(changeset.parked.turn
                ? { turn: changeset.parked.turn }
                : {}),
            },
          }
        : {}),
      // G4 fork bindings: sliced conversations bound to this changeset
      // (thread grouping + the fork pills' title join).
      ...(changeset.forks &&
      Object.values(changeset.forks).some((fork) => fork.conversationId)
        ? {
            forkConversationIds: Object.values(changeset.forks).flatMap(
              (fork) => (fork.conversationId ? [fork.conversationId] : []),
            ),
          }
        : {}),
    };
  }

  /** Broadcast a home's changeset list + conflicts (thread badges, tray). */
  function emitChangesets(home: HomeState): void {
    emit(home, {
      type: "changesets-changed",
      changesets: visibleLayers(home.changesets, home.branch).map((changeset) =>
        publicChangeset(home, changeset),
      ),
      conflicts: fileConflicts(home),
      dataConflicts: home.dataConflicts,
    });
  }

  /** sha256 hex of a module source (registration + drift comparison). */
  function hashModuleSource(source: string): string {
    return createHash("sha256").update(source).digest("hex");
  }

  /** The stack-top order value for a newly (re)activated layer. */
  function nextOrder(home: HomeState): number {
    return (
      Math.max(0, ...home.changesets.map((changeset) => changeset.order)) + 1
    );
  }

  /**
   * Register/refresh the pin's changeset LAYER (1:1 with the pin) from GIT
   * (G1): ensure the record exists (tagged {branch, baseCommit} from the
   * hidden refs, activated on first registration — an active layer with NO
   * selection is dormant for resolution: the gallery works, the page serves
   * the original until a card flips), then re-derive the whole layer state
   * via projection and refresh the serve plane. Returns projection data
   * warnings (surfaced by callers on the pin thread).
   */
  async function ensureChangesetForPin(
    set: PinSet,
    opts: { bases?: string[] } = {},
  ): Promise<{ warnings: string[] }> {
    const { pin } = set;
    if (pin.resolved) return { warnings: [] };
    const home = homeFor(set.repoRoot, set.appDir);
    await ensureBranch(home);
    const id = changesetIdForPin(pin.id);
    const refs = await gitOps.ensureChangesetRefs(set.repoRoot, id);
    let changeset = home.changesets.find((candidate) => candidate.id === id);
    if (!changeset) {
      changeset = {
        id,
        pinId: pin.id,
        ...(pin.title ? { title: pin.title } : {}),
        // L3: changesets inherit the pin's conversation (grouping key).
        ...(pin.conversationId ? { conversationId: pin.conversationId } : {}),
        branch: home.branch,
        baseCommit: refs.baseCommit,
        createdAt: Date.now(),
        active: true,
        order: nextOrder(home),
        baseHashes: {},
        overrides: {},
        ...(opts.bases && opts.bases.length > 0 ? { bases: opts.bases } : {}),
      };
      home.changesets.push(changeset);
      log(`sandbox layer registered: ${changeset.id} (${pin.target.file})`);
    }
    const projected = await projectChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    ensureDriftWatch();
    return projected;
  }

  /**
   * G2 reapply baseline: record an alternative's branch tip at the moment its
   * GENERATION landed (variant fan-out / render auto-fix / first trunk
   * registration). Commits past this tip count as post-selection EDITS — the
   * ones a later variant switch offers to reapply. Best-effort: a missing
   * changeset record or ref just skips (no baseline = no prompt).
   */
  async function recordGeneratedTip(
    home: HomeState,
    changesetId: string,
    altId: string,
  ): Promise<void> {
    try {
      const changeset = home.changesets.find(
        (candidate) => candidate.id === changesetId,
      );
      if (!changeset) return;
      const tip = await gitOps.resolveCommit(
        home.repoRoot,
        refForAlt(changesetId, altId),
      );
      if (!tip) return;
      if (changeset.generatedTips?.[altId] === tip) return;
      changeset.generatedTips = {
        ...(changeset.generatedTips ?? {}),
        [altId]: tip,
      };
      await persistChangeset(home, changeset);
    } catch (error) {
      log(`sandbox generated-tip record failed: ${String(error)}`);
    }
  }

  /**
   * Element pins as full-module ALTERNATIVES: after a span variant lands (or
   * is revised), ONE re-inline turn produces the mirrored-path artifact
   * `alts/<variantId>/<owner path>` and the pin's layer registers it —
   * "Preview in place" becomes a layer flip at every instance. Failures
   * never fail the gallery variant: the layer simply lacks that alternative
   * until the next landing re-runs the turn. Never throws.
   */
  async function ensureElementModuleVariant(
    set: PinSet,
    variant: SandboxVariant,
  ): Promise<void> {
    const { pin } = set;
    if (pin.kind !== "element" || pin.resolved) return;
    if (variant.status !== "ready") return;
    // Edit-variants ARE full modules already (moduleFile === file).
    if (variant.moduleFile === variant.file) return;
    const targetRel = moduleAltPath(
      set.appDir,
      pin.id,
      variant.id,
      pin.target.file,
    );
    try {
      // G1: the agent EDITS the real owner path in the variant branch's
      // worktree; the commit projects to the mirrored alternative
      // (targetRel) mechanically.
      const home = homeFor(set.repoRoot, set.appDir);
      await ensureBranch(home);
      const csId = changesetIdForPin(pin.id);
      await gitOps.ensureChangesetRefs(set.repoRoot, csId);
      const ref = refVariant(csId, variant.id);
      if (!(await gitOps.resolveCommit(set.repoRoot, ref))) {
        await gitOps.cutVariantBranch(set.repoRoot, csId, variant.id);
      }
      const turn = await runGitTurn({
        home,
        changesetId: csId,
        ref,
        conversationId: set.pin.conversationId,
        mode: "replace",
        prompt: buildElementModuleVariantPrompt({
          pin,
          variant,
          appDir: set.appDir,
        }),
        seedDirs: [pinDir(set.appDir, pin.id)],
      });
      if (turn.errorMessage) {
        throw new Error(truncateDiagnostic(turn.errorMessage));
      }
      const projected = await ensureChangesetForPin(set);
      await surfaceDataWarnings(home, set, csId, projected.warnings);
      const source = await readFile(absPath(set, targetRel), "utf8").catch(
        () => undefined,
      );
      if (!source || !moduleExportsName(source, pin.target.exportName)) {
        throw new Error(
          `the turn did not produce ${targetRel} exporting ${pin.target.exportName}`,
        );
      }
      variant.moduleFile = targetRel;
      await persist(set);
      emit(set, {
        type: "module-variant-ready",
        pinId: pin.id,
        variantId: variant.id,
        file: targetRel,
      });
      log(`sandbox module variant landed: ${targetRel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(set, {
        type: "module-variant-failed",
        pinId: pin.id,
        variantId: variant.id,
        error: message,
      });
      log(
        `sandbox module variant failed (${pin.id}/${variant.id}): ${message}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Drift detection, the bake queue, discard (L1 — bake is deterministic:
  // copy / 3-way merge; the merge-agent turn runs ONLY on merge conflicts).
  // -------------------------------------------------------------------------

  /** Changesets currently QUEUED or RUNNING a bake — excluded from drift
   * checks (the bake itself rewrites the real files) and from re-admission. */
  const bakingChangesets = new Set<string>();

  /**
   * Drift detection: re-hash every real CODE file under an ACTIVE layer
   * override and flag/clear `drifted` on its layer (data files are exempt —
   * the merge runs against the current file by construction). Flag flips
   * persist + broadcast, and a NEW drift pushes ONE warning marker into the
   * pin thread. Triggered lazily on status reads + bake admission, and
   * periodically when `driftWatchMs` is configured. The periodic pass also
   * refreshes the merged DATA artifacts (a real data file edited out-of-band
   * re-merges within a tick).
   */
  async function refreshDriftForHome(home: HomeState): Promise<void> {
    let changed = false;
    let dataOverridden = false;
    for (const changeset of visibleLayers(home.changesets, home.branch)) {
      if (!changeset.active || bakingChangesets.has(changeset.id)) continue;
      if (
        Object.keys(changeset.overrides).some((path) => isDataPath(path))
      ) {
        dataOverridden = true;
      }
      let drifted = false;
      const driftedModules: string[] = [];
      for (const [module, baseHash] of Object.entries(changeset.baseHashes)) {
        const source = await readFile(join(home.repoRoot, module), "utf8").catch(
          () => undefined,
        );
        if (source === undefined || hashModuleSource(source) !== baseHash) {
          drifted = true;
          driftedModules.push(module);
        }
      }
      if (drifted === (changeset.drifted === true)) continue;
      changed = true;
      if (drifted) {
        changeset.drifted = true;
        const set = pinFor(home, changeset.pinId);
        if (set) {
          pushThread(set, {
            role: "assistant",
            text:
              `Warning: ${driftedModules.join(", ")} changed outside this ` +
              "thread while its changeset was active. The design was " +
              "captured against older source — use \"Rebase onto current " +
              "source\" to replay it cleanly, or confirm the bake to " +
              "3-way-merge against the current file.",
            at: Date.now(),
          });
          await persist(set);
        }
        log(
          `sandbox drift detected: ${changeset.id} (${driftedModules.join(", ")})`,
        );
      } else {
        // The real module matches its registration hash again (e.g. an
        // out-of-band edit was reverted) — clear the flag; no new marker.
        delete changeset.drifted;
        log(`sandbox drift cleared: ${changeset.id}`);
      }
      await persistChangeset(home, changeset);
    }
    if (changed) {
      emitChangesets(home);
    }
    if (dataOverridden) {
      // Cheap when nothing changed: the merge output byte-compares before
      // any write, and an unchanged redirect table is a no-op push.
      await syncOverrides(home);
    }
  }

  /** The periodic drift watcher (opt-in via deps.driftWatchMs): one unref'd
   * interval while ANY home has an active changeset; self-clears when the
   * last changeset dissolves. */
  let driftTimer: ReturnType<typeof setInterval> | undefined;
  function ensureDriftWatch(): void {
    const cadence = deps.driftWatchMs;
    if (!cadence || cadence <= 0) return;
    const anyActive = [...homes.values()].some((home) =>
      home.changesets.some((changeset) => changeset.active),
    );
    if (!anyActive) {
      if (driftTimer) clearInterval(driftTimer);
      driftTimer = undefined;
      return;
    }
    if (driftTimer) return;
    driftTimer = setInterval(() => {
      for (const home of homes.values()) {
        if (home.changesets.some((changeset) => changeset.active)) {
          void refreshDriftForHome(home);
        }
      }
      ensureDriftWatch(); // Self-clear once nothing is active anymore.
    }, cadence);
    driftTimer.unref?.();
  }

  /** One admitted bake job: the changeset + the alternative RESOLVED per
   * code override at admission (the selection the user was looking at). */
  type BakeJob = {
    changesetId: string;
    home: HomeState;
    /** The owning pin thread. Absent for a conversation's DIRECT-EDITS
     * changeset (L3) — bake outcomes then surface via events only. */
    set?: PinSet;
    /** One entry per CODE override: the alternative baking into the file. */
    selections: Array<{ module: string; altId: string }>;
    /** The pre-layer Replace surface admitted this job — emit its legacy
     * events (replace-started already fired at admission). */
    legacyReplace?: { variantId: string };
    /** G3 bake-to-branch (B1): materialize onto a VISIBLE branch instead of
     * the working tree — the changeset stays ACTIVE, `bakedTo` records the
     * branch. `skipGate` bypasses the temp-worktree tsc gate. */
    toBranch?: { name: string; skipGate: boolean };
  };

  /** The serialized server bake QUEUE (one bake at a time; concurrent
   * requests queue behind it — spec: bake is a per-changeset unit, ordered). */
  const bakeQueue: BakeJob[] = [];
  let bakePumping = false;

  function emitBakeStatus(
    job: Pick<BakeJob, "changesetId" | "set" | "home">,
    status: "queued" | "running" | "gated" | "done" | "failed",
    extra: Record<string, unknown> = {},
  ): void {
    emit(job.home, {
      type: "bake-status",
      changesetId: job.changesetId,
      // Wire compat: pin-less (direct-edits) bakes carry pinId "".
      pinId: job.set?.pin.id ?? "",
      status,
      ...extra,
    });
  }

  /** Shared bake ADMISSION (bake endpoint + the legacy Replace surface):
   * validates NOW, resolves the alternative per code override, then queues.
   * Returns the queued job or the refusal. */
  async function admitBake(params: {
    home: HomeState;
    changeset: SandboxChangeset;
    force: boolean;
    legacyReplace?: { variantId: string };
    toBranch?: { name: string; skipGate: boolean };
  }): Promise<{ job?: BakeJob; error?: string; status?: number }> {
    const { home, changeset } = params;
    if (!changeset.active) {
      return { error: "Unknown or inactive changeset.", status: 400 };
    }
    if (bakingChangesets.has(changeset.id)) {
      return { error: "This changeset is already queued to bake.", status: 400 };
    }
    // Pin-less changesets (a conversation's direct-edits layer, L3) bake
    // without a thread; pin changesets still require their live pin.
    const set = changeset.pinId ? pinFor(home, changeset.pinId) : undefined;
    if (changeset.pinId && !set) {
      return { error: "The changeset's thread is gone.", status: 400 };
    }
    if (set?.busy) {
      return { error: "This pin already has a run in progress.", status: 400 };
    }
    // Drift confirm-gate: re-check against the CURRENT file hashes first so
    // the refusal reflects reality, not a stale flag.
    await refreshDriftForHome(home);
    if (changeset.drifted && params.force !== true) {
      return {
        error:
          "The real source changed since this changeset was captured " +
          "(drifted). Confirm the bake to 3-way-merge against the current " +
          "file.",
        status: 409,
      };
    }
    const selections: BakeJob["selections"] = [];
    for (const [module, override] of Object.entries(changeset.overrides).sort()) {
      if (isDataPath(module)) continue; // Data merges inside the job.
      if (override.alternatives.length === 0) {
        return { error: `No landed alternatives for ${module}.`, status: 400 };
      }
      const altId =
        override.selection && override.alternatives.includes(override.selection)
          ? override.selection
          : override.alternatives.length === 1
            ? override.alternatives[0]
            : undefined;
      if (!altId) {
        return {
          error:
            `Choose a variant for ${module} first (flip its card), then bake.`,
          status: 400,
        };
      }
      const variant = set?.pin.variants.find(
        (candidate) => candidate.id === altId,
      );
      if (variant && variant.status !== "ready") {
        return { error: `Variant "${altId}" is not ready to bake.`, status: 400 };
      }
      selections.push({ module, altId });
    }
    if (
      selections.length === 0 &&
      !Object.keys(changeset.overrides).some((path) => isDataPath(path))
    ) {
      return { error: "This changeset has nothing to bake.", status: 400 };
    }
    // Admitted: the pin is committed for the queue's duration (no concurrent
    // prompts/edits under a bake).
    if (set) set.busy = true;
    bakingChangesets.add(changeset.id);
    const job: BakeJob = {
      changesetId: changeset.id,
      home,
      ...(set ? { set } : {}),
      selections,
      ...(params.legacyReplace ? { legacyReplace: params.legacyReplace } : {}),
      ...(params.toBranch ? { toBranch: params.toBranch } : {}),
    };
    bakeQueue.push(job);
    emitBakeStatus(job, "queued", {
      position: bakeQueue.length,
      ...(params.toBranch ? { targetBranch: params.toBranch.name } : {}),
    });
    log(
      `sandbox bake queued: ${changeset.id} (${selections
        .map((entry) => `${entry.module}<-${entry.altId}`)
        .join(", ")})${params.toBranch ? ` -> branch ${params.toBranch.name}` : ""}`,
    );
    void pumpBakeQueue();
    return { job };
  }

  /**
   * Admit a bake (POST /api/sandbox/bake): active changeset, pin not busy,
   * drift confirm (`force`), a determinable alternative per code override
   * (the selection; the single landed alternative when none) — then queues.
   * Statuses stream as `bake-status` events: queued → running → gated →
   * done/failed.
   */
  async function bake(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    force?: boolean;
  }): Promise<{ error?: string; status?: number }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) {
      return { error: "Unknown or inactive changeset.", status: 400 };
    }
    // Bake reads REF tips — exit any park preview so what bakes is what
    // the cache shows again (G4).
    if (await clearParked(home, changeset)) {
      await projectChangeset(home, changeset);
      await syncOverrides(home);
      emitChangesets(home);
      emitSwitchState(home);
    }
    const admitted = await admitBake({
      home,
      changeset,
      force: params.force === true,
    });
    return admitted.error
      ? { error: admitted.error, status: admitted.status ?? 400 }
      : {};
  }

  /** Drain the bake queue, ONE job at a time (never throws). */
  async function pumpBakeQueue(): Promise<void> {
    if (bakePumping) return;
    bakePumping = true;
    try {
      let job: BakeJob | undefined;
      while ((job = bakeQueue.shift()) !== undefined) {
        try {
          await runBakeJob(job);
        } catch (error) {
          // Belt: runBakeJob handles its own failures; anything escaping
          // still must not stall the queue.
          log(`sandbox bake crashed (${job.changesetId}): ${String(error)}`);
          emitBakeStatus(job, "failed", { error: String(error) });
        } finally {
          bakingChangesets.delete(job.changesetId);
          if (job.set) job.set.busy = false;
        }
      }
    } finally {
      bakePumping = false;
    }
  }

  /**
   * G3 bake-via-merge (spec §Drift/bake): the selected branches' SQUASHED
   * diffs (base..tip, limited to the admitted code modules) apply onto the
   * REAL working tree with `git apply --3way` — a dirty tree merges natively,
   * the user's index is never touched, and the clean path runs ZERO model
   * turns. Files the apply cannot settle (conflict markers / unappliable
   * patch) are restored to their pre-bake content and fall back to the
   * per-file path below (copy / 3-way merge-file / ONE merge-agent turn).
   */
  async function bakeCodeSelections(
    job: BakeJob,
    changeset: SandboxChangeset,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { home } = job;
    if (job.selections.length === 0) return { ok: true };
    const altOf = new Map(
      job.selections.map((entry) => [entry.module, entry.altId]),
    );
    const base =
      (await gitOps.resolveCommit(home.repoRoot, refBase(changeset.id))) ??
      changeset.baseCommit;
    /** Modules the fast path could not settle — per-file fallback. */
    const fallback: string[] = [];
    if (!base) {
      fallback.push(...altOf.keys());
    } else {
      const groups = new Map<string, string[]>();
      for (const { module, altId } of job.selections) {
        groups.set(altId, [...(groups.get(altId) ?? []), module]);
      }
      for (const [altId, modules] of [...groups].sort()) {
        const tip = await gitOps.resolveCommit(
          home.repoRoot,
          refForAlt(changeset.id, altId),
        );
        if (!tip) {
          fallback.push(...modules);
          continue;
        }
        let patch = "";
        try {
          patch = await gitOps.diffPatch(home.repoRoot, base, tip, modules);
        } catch (error) {
          log(`sandbox bake diff failed (${altId}): ${String(error)}`);
          fallback.push(...modules);
          continue;
        }
        if (!patch.trim()) continue;
        // Pre-bake snapshots: a conflicted file is RESTORED before its
        // fallback runs (markers must never be an input to merge-file).
        const snapshots = new Map<string, string | undefined>();
        for (const module of modules) {
          snapshots.set(
            module,
            await readFile(join(home.repoRoot, module), "utf8").catch(
              () => undefined,
            ),
          );
        }
        const restore = async (module: string) => {
          const abs = containedPath(home.repoRoot, module);
          if (!abs) return;
          const snapshot = snapshots.get(module);
          if (snapshot === undefined) {
            await rm(abs, { force: true }).catch(() => {});
          } else {
            await writeFile(abs, snapshot, "utf8");
          }
        };
        const applied = await gitOps.applyPatch3Way(
          home.repoRoot,
          patch,
          modules,
        );
        if (applied.status === "clean") {
          log(
            `sandbox bake applied: ${altId} -> ${modules.join(", ")} (squashed 3-way)`,
          );
          continue;
        }
        if (applied.status === "conflict") {
          // Cleanly-applied files in the group stay; only the conflicted
          // ones rewind into the per-file path.
          for (const rel of applied.files) {
            if (!snapshots.has(rel)) continue;
            await restore(rel);
            fallback.push(rel);
          }
          log(
            `sandbox bake apply conflict: ${applied.files.join(", ")} — per-file fallback`,
          );
          continue;
        }
        // Hard apply failure: nothing landed — the whole group falls back.
        log(`sandbox bake apply failed (${altId}): ${applied.message}`);
        fallback.push(...modules);
      }
    }
    for (const module of fallback) {
      const result = await bakeCodeFile(job, changeset, module, altOf.get(module)!);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  /** Per-file fallback bake of ONE code override. Deterministic first:
   * unchanged base → plain copy (NO model turn); drifted → 3-way merge over
   * the baseCommit blob; merge conflict → ONE merge-agent turn. */
  async function bakeCodeFile(
    job: BakeJob,
    changeset: SandboxChangeset,
    module: string,
    altId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { home, set } = job;
    const altRel = altFilePath(home.appDir, changeset.id, altId, module);
    const layered = await readFile(join(home.repoRoot, altRel), "utf8").catch(
      () => undefined,
    );
    if (layered === undefined) {
      return { ok: false, message: `the alternative ${altRel} is missing.` };
    }
    const realAbs = containedPath(home.repoRoot, module);
    if (!realAbs || isChangesetPath(module, home.appDir)) {
      return { ok: false, message: `the override path ${module} is invalid.` };
    }
    const current = await readFile(realAbs, "utf8").catch(() => undefined);
    const baseHash = changeset.baseHashes[module];
    const unchanged =
      current === undefined || // Layer-only NEW file — nothing to merge.
      baseHash === undefined ||
      hashModuleSource(current) === baseHash;
    if (unchanged) {
      await mkdir(dirname(realAbs), { recursive: true });
      await writeFile(realAbs, layered, "utf8");
      log(`sandbox bake copied: ${altRel} -> ${module}`);
      return { ok: true };
    }
    // Drifted: 3-way merge (git merge-file semantics; the base is the
    // baseCommit's blob — G1 killed the stored base/ snapshot).
    const base = changeset.baseCommit
      ? ((await gitOps
          .readBlob(home.repoRoot, changeset.baseCommit, module)
          .catch(() => undefined)) ?? "")
      : "";
    const merged = await mergeFile(base, current, layered);
    if (!merged.conflicted) {
      await writeFile(realAbs, merged.content, "utf8");
      log(`sandbox bake 3-way merged: ${module}`);
      return { ok: true };
    }
    // Conflict → the ONE merge-agent turn.
    log(`sandbox bake merge conflict: ${module} — running one merge turn`);
    emit(home, {
      type: "bake-merge-turn",
      pinId: set?.pin.id ?? "",
      changesetId: changeset.id,
      module,
    });
    const conflictSummary = merged.content
      .split("\n")
      .filter((line) => /^(<{7}|={7}|>{7})/.test(line))
      .slice(0, 40)
      .join("\n");
    // Materialize the base blob for the merge agent to read (removed after
    // the turn — it is a turn input, not layer state).
    const baseRel = `${changesetDir(home.appDir, changeset.id)}/merge-base/${module.split("/").pop() ?? module}`;
    const baseAbs = join(home.repoRoot, baseRel);
    await mkdir(dirname(baseAbs), { recursive: true });
    await writeFile(baseAbs, base, "utf8");
    let turn: Awaited<ReturnType<SandboxRunTurn>>;
    try {
      turn = await runTurn({
        cwd: home.repoRoot,
        conversationId: set?.pin.conversationId ?? changeset.conversationId,
        mode: "replace",
        prompt: buildBakeMergePrompt({
          module,
          baseFile: baseRel,
          layeredFile: altRel,
          conflictSummary: conflictSummary || "(conflict markers unavailable)",
        }),
      });
    } finally {
      await rm(dirname(baseAbs), { recursive: true, force: true }).catch(
        () => {},
      );
    }
    if (turn.errorMessage) {
      return {
        ok: false,
        message: `the merge turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
      };
    }
    const after = await readFile(realAbs, "utf8").catch(() => undefined);
    if (after === undefined || after === current) {
      return {
        ok: false,
        message: `the merge turn did not update ${module}.`,
      };
    }
    return { ok: true };
  }

  /** Merge one DATA override's additions into the real file (structured —
   * json/po/cssvar; existing keys always win over stale layer copies). */
  async function bakeDataFile(
    job: BakeJob,
    changeset: SandboxChangeset,
    module: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { home } = job;
    const format = dataFormatFor(module)!;
    const altRel = altFilePath(home.appDir, changeset.id, DATA_ALT_ID, module);
    const layered = await readFile(join(home.repoRoot, altRel), "utf8").catch(
      () => undefined,
    );
    if (layered === undefined) return { ok: true }; // Nothing recorded.
    const base = changeset.baseCommit
      ? ((await gitOps
          .readBlob(home.repoRoot, changeset.baseCommit, module)
          .catch(() => undefined)) ?? "")
      : "";
    // CHANGES, not just additions (L3): a direct-edits layer bakes its key
    // mutations into the real file; additive layers bake identically to
    // before (changes == additions by construction).
    const changes = computeDataChanges(format, base, layered);
    if (changes.size === 0) return { ok: true };
    const realAbs = containedPath(home.repoRoot, module);
    if (!realAbs) {
      return { ok: false, message: `the data path ${module} is invalid.` };
    }
    const current = await readFile(realAbs, "utf8").catch(() => "");
    await mkdir(dirname(realAbs), { recursive: true });
    await writeFile(
      realAbs,
      applyDataChanges(format, current, changes),
      "utf8",
    );
    log(`sandbox bake data merged: ${module} (${changes.size} keys)`);
    return { ok: true };
  }

  /**
   * Execute one bake: per code override a deterministic copy (or 3-way
   * merge; merge-agent turn only on conflict), data additions merged
   * structurally, then ONE typecheck gate over the result. Success DISSOLVES
   * the layer — deactivate + DELETE the layer dir (the thread keeps the
   * history), redirects drop in ONE batched pass. Gate failure keeps the
   * changeset active with the diagnostics in the thread; the queue proceeds.
   */
  async function runBakeJob(job: BakeJob): Promise<void> {
    const { set, home, changesetId } = job;
    const changeset = home.changesets.find(
      (candidate) => candidate.id === changesetId,
    );
    if (!changeset || !changeset.active) {
      emitBakeStatus(job, "failed", {
        error: "The changeset dissolved before the bake ran.",
      });
      return;
    }
    if (job.toBranch) {
      await runBakeToBranchJob(job, changeset);
      return;
    }
    emitBakeStatus(job, "running");
    log(`sandbox bake running: ${changesetId}`);
    const codeResult = await bakeCodeSelections(job, changeset);
    if (!codeResult.ok) {
      await failBake(job, codeResult.message);
      return;
    }
    for (const module of Object.keys(changeset.overrides).sort()) {
      if (!isDataPath(module)) continue;
      const result = await bakeDataFile(job, changeset, module);
      if (!result.ok) {
        await failBake(job, result.message);
        return;
      }
    }
    // The gate: the written result must typecheck before anything reads as
    // done — a broken bake must never resolve.
    emitBakeStatus(job, "gated");
    const check = await runTypecheck(home.repoRoot, home.appDir);
    if (!check.ok) {
      await failBake(
        job,
        `typecheck failed after the bake — the files were left as written; fix or iterate. ${truncateDiagnostic(check.output ?? "")}`,
      );
      return;
    }
    if (check.skipped) {
      log("sandbox bake: typecheck unavailable in this repo — gate skipped");
    }
    // Dissolve: deactivate + DELETE the layer (files are dead after bake —
    // the thread keeps the history), ONE batched redirect pass. G1: the
    // hidden refs + worktree go too — nothing visible in any git surface
    // (commit objects linger unreachable until normal gc).
    home.changesets = home.changesets.filter(
      (candidate) => candidate.id !== changesetId,
    );
    await removeChangesetFiles(home, changesetId);
    await gitOps.removeWorktree(home.repoRoot, changesetId).catch(() => {});
    await gitOps.deleteChangesetRefs(home.repoRoot, changesetId).catch(() => {});
    if (set) {
      set.pin.resolved = true;
      pushThread(set, {
        role: "assistant",
        text: `Baked ${job.selections
          .map((entry) => `the "${entry.altId}" design into ${entry.module}`)
          .join("; ")}. The changeset dissolved; the real source serves it now.`,
        at: Date.now(),
      });
      await persist(set);
    }
    await syncOverrides(home);
    emitChangesets(home);
    emitSwitchState(home);
    emit(job.home, { type: "baked", pinId: set?.pin.id ?? "", changesetId });
    if (job.legacyReplace && set) {
      emit(job.home, {
        type: "replaced",
        pinId: set.pin.id,
        variantId: job.legacyReplace.variantId,
      });
    }
    emitBakeStatus(job, "done");
    ensureDriftWatch();
    log(
      `sandbox baked: ${changesetId} -> ${
        set?.pin.target.file ?? "(direct edits)"
      }`,
    );
  }

  /** Bake failure: diagnostics into the pin thread (existing discipline),
   * changeset stays active/untouched, drift re-checked (a half-written bake
   * may have changed the real files), queue proceeds. */
  async function failBake(job: BakeJob, message: string): Promise<void> {
    if (job.set) {
      pushThread(job.set, {
        role: "assistant",
        text: `Bake failed: ${message}`,
        at: Date.now(),
      });
      await persist(job.set);
    }
    // The failed bake may have changed real files — re-check BEFORE the
    // failure events fire (this job no longer counts as baking; the pump's
    // cleanup is idempotent). Ordering matters: the events are the "failure
    // settled" signal, so every write the failure path makes (thread marker,
    // drift flag + its index/meta persists) must be flushed first — a
    // consumer reacting to the event must never race an in-flight write.
    bakingChangesets.delete(job.changesetId);
    await refreshDriftForHome(job.home);
    emitBakeStatus(job, "failed", { error: message });
    if (job.legacyReplace && job.set) {
      emit(job.home, {
        type: "replace-failed",
        pinId: job.set.pin.id,
        variantId: job.legacyReplace.variantId,
        error: message,
      });
    }
    log(`sandbox bake failed (${job.changesetId}): ${message}`);
  }

  /**
   * G3 bake-to-branch (B1 — mechanics git-native, superseding the mktree
   * plumbing spec): materialize the squashed selected-branch changes (+
   * structured data merges) in a TEMP worktree cut from the current branch
   * HEAD, tsc-gate there (skippable), then move `refs/heads/<name>` —
   * plumbing only; the user's checkout/index/working tree are untouched and
   * NOTHING is pushed. The changeset stays ACTIVE with `bakedTo` recorded;
   * re-bake to the same branch stacks a new commit on it. Apply conflicts
   * (un-rebased drift forced past the 409) fail with a pointer at the
   * Rebase action — no merge turn on this path.
   */
  async function runBakeToBranchJob(
    job: BakeJob,
    changeset: SandboxChangeset,
  ): Promise<void> {
    const { home, set } = job;
    const { name, skipGate } = job.toBranch!;
    emitBakeStatus(job, "running", { targetBranch: name });
    log(`sandbox bake-to-branch running: ${changeset.id} -> ${name}`);
    const repoRoot = home.repoRoot;
    const head = await gitOps.resolveCommit(repoRoot, "HEAD");
    if (!head) {
      await failBake(job, "the repository has no commits.");
      return;
    }
    const base =
      (await gitOps.resolveCommit(repoRoot, refBase(changeset.id))) ??
      changeset.baseCommit;
    if (!base) {
      await failBake(job, "this changeset has no git history.");
      return;
    }
    let worktreeAbs: string | undefined;
    try {
      worktreeAbs = await gitOps.createDetachedTempWorktree({
        repoRoot,
        commit: head,
        appDir: home.appDir,
      });
      // Code: the squashed diff per selected branch, 3-way applied onto the
      // HEAD checkout (drift the user committed merges here natively).
      const groups = new Map<string, string[]>();
      for (const { module, altId } of job.selections) {
        groups.set(altId, [...(groups.get(altId) ?? []), module]);
      }
      for (const [altId, modules] of [...groups].sort()) {
        const tip = await gitOps.resolveCommit(
          repoRoot,
          refForAlt(changeset.id, altId),
        );
        if (!tip) {
          await failBake(job, `the "${altId}" branch is gone.`);
          return;
        }
        const patch = await gitOps.diffPatch(repoRoot, base, tip, modules);
        if (!patch.trim()) continue;
        const applied = await gitOps.applyPatch3Way(worktreeAbs, patch, modules);
        if (applied.status !== "clean") {
          const detail =
            applied.status === "conflict"
              ? `conflicts with the current source in ${applied.files.join(", ")}`
              : `could not apply onto the current source (${truncateDiagnostic(applied.message)})`;
          await failBake(
            job,
            `${detail}. Rebase the changeset onto the current source, then bake to branch again.`,
          );
          return;
        }
      }
      // Data: structured merge of the layer's key changes into the HEAD
      // checkout's files (same semantics as in-place bake).
      for (const module of Object.keys(changeset.overrides).sort()) {
        if (!isDataPath(module)) continue;
        const format = dataFormatFor(module)!;
        const altRel = altFilePath(
          home.appDir,
          changeset.id,
          DATA_ALT_ID,
          module,
        );
        const layered = await readFile(join(repoRoot, altRel), "utf8").catch(
          () => undefined,
        );
        if (layered === undefined) continue;
        const baseText =
          (await gitOps.readBlob(repoRoot, base, module).catch(() => undefined)) ??
          "";
        const changes = computeDataChanges(format, baseText, layered);
        if (changes.size === 0) continue;
        const targetAbs = containedPath(worktreeAbs, module);
        if (!targetAbs) {
          await failBake(job, `the data path ${module} is invalid.`);
          return;
        }
        const current = await readFile(targetAbs, "utf8").catch(() => "");
        await mkdir(dirname(targetAbs), { recursive: true });
        await writeFile(
          targetAbs,
          applyDataChanges(format, current, changes),
          "utf8",
        );
      }
      // One materialized commit (user identity when configured — this one is
      // user-visible; provenance rides the trailers).
      const title =
        changeset.title ?? set?.pin.title ?? set?.pin.target.name ?? changeset.id;
      const message = `designbook: bake "${title}"`;
      const commit = await gitOps.commitAll(
        worktreeAbs,
        message,
        [
          `Designbook-Changeset: ${changeset.id}`,
          ...(changeset.conversationId
            ? [`Designbook-Conversation: ${changeset.conversationId}`]
            : []),
        ],
        { preferUserIdent: true },
      );
      if (!commit) {
        await failBake(
          job,
          "the changeset produced no changes against the current branch.",
        );
        return;
      }
      // The gate runs against the TEMP worktree (the user's tree is never
      // touched); PR CI is the real backstop.
      if (!skipGate) {
        emitBakeStatus(job, "gated", { targetBranch: name });
        const check = await runTypecheck(worktreeAbs, home.appDir);
        if (!check.ok) {
          await failBake(
            job,
            `typecheck failed for the branch bake — no branch was created. ${truncateDiagnostic(check.output ?? "")}`,
          );
          return;
        }
        if (check.skipped) {
          log("sandbox bake-to-branch: typecheck unavailable — gate skipped");
        }
      }
      // Branch ref: first bake = the materialized commit (parent = HEAD);
      // re-bake = same tree, new commit parented on the branch tip.
      const existing = await gitOps.resolveCommit(
        repoRoot,
        `refs/heads/${name}`,
      );
      const finalCommit = existing
        ? await gitOps.commitTreeOnto({
            repoRoot,
            tree: await gitOps.treeOf(repoRoot, commit),
            parent: existing,
            message,
          })
        : commit;
      await gitOps.updateRef(repoRoot, `refs/heads/${name}`, finalCommit);
      changeset.bakedTo = { branch: name, commit: finalCommit, at: Date.now() };
      await persistChangeset(home, changeset);
      if (set) {
        pushThread(set, {
          role: "assistant",
          text:
            `Baked this changeset to branch "${name}"` +
            `${existing ? " (new commit on it)" : ""}. The changeset stays ` +
            "active here; nothing was pushed.",
          at: Date.now(),
        });
        await persist(set);
      }
      emitChangesets(home);
      emit(job.home, {
        type: "baked-to-branch",
        pinId: set?.pin.id ?? "",
        changesetId: changeset.id,
        targetBranch: name,
        commit: finalCommit,
      });
      emitBakeStatus(job, "done", { targetBranch: name, commit: finalCommit });
      log(
        `sandbox baked to branch: ${changeset.id} -> ${name} (${finalCommit})`,
      );
    } catch (error) {
      await failBake(
        job,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (worktreeAbs) {
        await gitOps.removeTempWorktree(repoRoot, worktreeAbs).catch(() => {});
      }
    }
  }

  /**
   * Admit a bake-to-branch (POST /api/sandbox/bake-to-branch): the same
   * admission ladder as bake (active changeset, pin not busy, drift 409
   * unless forced, determinable alternative per code override), then queues
   * a branch-materialization job. Default name `designbook/<changeset-slug>`,
   * editable; the CURRENT branch is refused (a checked-out ref must never
   * move under the user).
   */
  async function bakeToBranch(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    name?: string;
    skipGate?: boolean;
    force?: boolean;
  }): Promise<{ error?: string; status?: number; branch?: string }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) {
      return { error: "Unknown or inactive changeset.", status: 400 };
    }
    const owner = pinFor(home, changeset.pinId);
    const title =
      changeset.title ?? owner?.pin.title ?? owner?.pin.target.name ?? "";
    const slug = slugify(title) || slugify(changeset.id) || "changeset";
    const name = params.name?.trim() || `designbook/${slug}`;
    if (!(await gitOps.isValidBranchName(home.repoRoot, name))) {
      return { error: `"${name}" is not a valid branch name.`, status: 400 };
    }
    if (name === home.branch) {
      return {
        error: "That is the current branch — bake in place instead.",
        status: 400,
      };
    }
    const admitted = await admitBake({
      home,
      changeset,
      force: params.force === true,
      toBranch: { name, skipGate: params.skipGate === true },
    });
    return admitted.error
      ? { error: admitted.error, status: admitted.status ?? 400 }
      : { branch: name };
  }

  // ---------------------------------------------------------------------------
  // L3 conversations ON GIT (G1): the per-conversation DIRECT-EDITS
  // changeset is a hidden trunk; the live chat session runs with cwd = its
  // worktree and built-in tools (bash just works there), every tool-write
  // commits, and manual data edits become plumbing commits on the trunk.
  // The overlay toolset, bash write-capture, and lift-and-restore are gone.
  // ---------------------------------------------------------------------------

  /** Display title of a conversation's direct-edits layer. */
  const DIRECT_EDITS_TITLE = "Direct edits";

  /**
   * Find/create the ONE direct-edits layer RECORD of a conversation (lazy —
   * callers create it when the first commit lands). Pin-less: `pinId` is ""
   * and `conversationId` names the owner. A deactivated direct layer
   * REACTIVATES on the next routed edit (an invisible direct edit would
   * read as data loss).
   */
  /** The changeset a conversation's turns commit into: its OWN direct-edits
   * layer, or — for a park-fork's sliced conversation (G4) — the PARENT
   * changeset whose fork ref it was cut onto. */
  function changesetForConversation(
    home: HomeState,
    conversationId: string,
  ): SandboxChangeset | undefined {
    return (
      home.changesets.find(
        (candidate) => candidate.id === directChangesetId(conversationId),
      ) ??
      home.changesets.find((candidate) =>
        Object.values(candidate.forks ?? {}).some(
          (fork) => fork.conversationId === conversationId,
        ),
      )
    );
  }

  async function ensureDirectChangeset(
    home: HomeState,
    conversationId: string,
  ): Promise<SandboxChangeset> {
    // G4: a forked conversation is BOUND to its parent's changeset — its
    // turns land on the fork ref, never a fresh direct-edits layer.
    const bound = changesetForConversation(home, conversationId);
    if (bound && bound.id !== directChangesetId(conversationId)) {
      if (!bound.active) {
        bound.active = true;
        bound.order = nextOrder(home);
      }
      return bound;
    }
    const id = directChangesetId(conversationId);
    const refs = await gitOps.ensureChangesetRefs(home.repoRoot, id);
    // Direct edits preview immediately (L3): default the selection pointer
    // to trunk — every routed edit/capture re-selects, mirroring the old
    // capture-time selection (an explicit "original" flip clears it until
    // the next edit lands).
    if (!(await gitOps.getSelected(home.repoRoot, id))) {
      await gitOps.setSelected(home.repoRoot, id, refTrunk(id));
    }
    let changeset = home.changesets.find((candidate) => candidate.id === id);
    if (!changeset) {
      changeset = {
        id,
        pinId: "",
        title: DIRECT_EDITS_TITLE,
        conversationId,
        branch: home.branch || (await gitInfo(home.repoRoot)).branch,
        baseCommit: refs.baseCommit,
        createdAt: Date.now(),
        active: true,
        order: nextOrder(home),
        baseHashes: {},
        overrides: {},
      };
      home.changesets.push(changeset);
      log(`sandbox direct-edits layer created: ${id}`);
    } else if (!changeset.active) {
      changeset.active = true;
      changeset.order = nextOrder(home);
    }
    return changeset;
  }

  /**
   * Route ONE manual structured data edit (text tool i18n write / theme
   * token edit / flag write — the /api/i18n, /api/po, /api/json, /api/style
   * endpoints) into the ACTIVE conversation's direct-edits changeset: the
   * edit becomes a COMMIT on the changeset's trunk (temp-index plumbing, no
   * worktree needed), and the projection re-derives the served layer state.
   *
   * `apply` runs the endpoint's own structured editor against the RESOLVED
   * content the user is looking at (the serve-time merged artifact when the
   * file is under active layers). `unrepresentable` = the edit produced no
   * classifiable key change — the caller falls back to the real write.
   */
  async function stageDirectDataEdit(params: {
    repoRoot: string;
    appDir: string;
    conversationId: string;
    rel: string;
    apply: (current: string) => {
      updated?: string;
      error?: string;
      status?: number;
    };
  }): Promise<{
    error?: string;
    status?: number;
    staged?: boolean;
    unrepresentable?: boolean;
  }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    const rel = params.rel;
    const format = dataFormatFor(rel);
    const abs = containedPath(params.repoRoot, rel);
    if (
      !format ||
      !abs ||
      isSandboxPath(rel, appDir) ||
      isChangesetPath(rel, appDir)
    ) {
      return { error: "Not a routable data file path.", status: 400 };
    }
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    // What the user SEES: the merged artifact when the file redirects.
    const backingAbs = home.redirects[join(params.repoRoot, rel)] ?? abs;
    const before = await readFile(backingAbs, "utf8").catch(() => undefined);
    if (before === undefined) {
      return { error: `File not found: ${rel}`, status: 404 };
    }
    const applied = params.apply(before);
    if (applied.error || applied.updated === undefined) {
      return {
        error: applied.error ?? "The edit produced no result.",
        status: applied.status ?? 400,
      };
    }
    if (applied.updated === before) return { staged: true };
    const changes = computeDataChanges(format, before, applied.updated);
    if (changes.size === 0) return { unrepresentable: true };
    let changeset: SandboxChangeset;
    try {
      changeset = await ensureDirectChangeset(home, params.conversationId);
    } catch (error) {
      if (error instanceof GitRequiredError) {
        return { error: error.message, status: 400 };
      }
      throw error;
    }
    // Commit the key changes onto the trunk TIP's content (what the user
    // sees may include other layers' additions — only THIS edit's keys land).
    const trunk = refTrunk(changeset.id);
    const tip = await gitOps.resolveCommit(params.repoRoot, trunk);
    const tipText =
      (tip ? await gitOps.readBlob(params.repoRoot, tip, rel) : undefined) ??
      (await readFile(abs, "utf8").catch(() => ""));
    await gitOps.commitFileChange({
      repoRoot: params.repoRoot,
      ref: trunk,
      path: rel,
      content: applyDataChanges(format, tipText, changes),
      message: `direct edit: ${rel} (${changes.size} ${
        changes.size === 1 ? "key" : "keys"
      })`,
      trailers: [`Designbook-Conversation: ${params.conversationId}`],
    });
    await projectChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    ensureDriftWatch();
    log(
      `sandbox direct edit staged: ${rel} (${changes.size} ${
        changes.size === 1 ? "key" : "keys"
      } -> ${changeset.id})`,
    );
    return { staged: true };
  }

  /**
   * Route ONE manual CODE edit (a props-panel JSX-attribute write at a
   * component's usage site) into the ACTIVE conversation's direct-edits
   * changeset. Unlike {@link stageDirectDataEdit}, code files carry no
   * structured key-merge: the WHOLE updated file lands as one commit on the
   * trunk (temp-index plumbing), applied against the trunk tip's current
   * content (the direct-edits layer's own view of the file — prior prop edits
   * included). The projection re-derives the served layer state and the
   * caller records the sidecar turn (timeline row + label).
   *
   * `apply` runs the endpoint's precise editor against that content;
   * `unresolvable` = the usage site couldn't be edited safely (spread props /
   * no match) and the caller surfaces a read-only note. Returns the committed
   * range so the caller can record it.
   */
  async function stageDirectCodeEdit(params: {
    repoRoot: string;
    appDir: string;
    conversationId: string;
    rel: string;
    apply: (current: string) => {
      updated?: string;
      error?: string;
      status?: number;
      unresolvable?: string;
    };
  }): Promise<{
    error?: string;
    status?: number;
    staged?: boolean;
    unresolvable?: string;
    changesetId?: string;
    ref?: string;
    from?: string;
    to?: string;
  }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    const rel = params.rel;
    const abs = containedPath(params.repoRoot, rel);
    if (!abs || isSandboxPath(rel, appDir) || isChangesetPath(rel, appDir)) {
      return { error: "Not a routable source file path.", status: 400 };
    }
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    let changeset: SandboxChangeset;
    try {
      changeset = await ensureDirectChangeset(home, params.conversationId);
    } catch (error) {
      if (error instanceof GitRequiredError) {
        return { error: error.message, status: 400 };
      }
      throw error;
    }
    // Edit the trunk tip's own content (falling back to the real file when the
    // layer hasn't touched this path yet) — the usage site lives there too.
    const trunk = refTrunk(changeset.id);
    const tip = await gitOps.resolveCommit(params.repoRoot, trunk);
    const current =
      (tip ? await gitOps.readBlob(params.repoRoot, tip, rel) : undefined) ??
      (await readFile(abs, "utf8").catch(() => undefined));
    if (current === undefined) {
      return { error: `File not found: ${rel}`, status: 404 };
    }
    const applied = params.apply(current);
    if (applied.unresolvable) return { unresolvable: applied.unresolvable };
    if (applied.error || applied.updated === undefined) {
      return {
        error: applied.error ?? "The edit produced no result.",
        status: applied.status ?? 400,
      };
    }
    if (applied.updated === current) {
      return { staged: true, changesetId: changeset.id, ref: trunk };
    }
    const commit = await gitOps.commitFileChange({
      repoRoot: params.repoRoot,
      ref: trunk,
      path: rel,
      content: applied.updated,
      message: `direct edit: ${rel}`,
      trailers: [`Designbook-Conversation: ${params.conversationId}`],
    });
    await projectChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    ensureDriftWatch();
    log(`sandbox direct code edit staged: ${rel} -> ${changeset.id}`);
    return {
      staged: true,
      changesetId: changeset.id,
      ref: trunk,
      ...(tip ? { from: tip } : {}),
      to: commit,
    };
  }

  /**
   * The CONVERSATION session's git workspace (G1): the live chat runs with
   * cwd = the direct-edits changeset's worktree. Ensured at session
   * creation; undefined when the repo isn't git (the session degrades to
   * the repo root — changesets then error at creation, per spec).
   */
  async function ensureConversationWorkspace(params: {
    repoRoot: string;
    appDir: string;
    conversationId: string;
  }): Promise<{ worktreeAbs: string; changesetId: string } | undefined> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    // G4: a park-fork's conversation resolves to the PARENT changeset it
    // was cut onto (layer meta binding) — everyone else to their own
    // direct-edits layer.
    let changesetId = directChangesetId(params.conversationId);
    try {
      await revive(params.repoRoot, appDir);
      const home = homeFor(params.repoRoot, appDir);
      await ensureBranch(home);
      const bound = changesetForConversation(home, params.conversationId);
      if (bound) changesetId = bound.id;
    } catch (error) {
      log(`conversation workspace binding failed: ${String(error)}`);
    }
    try {
      await gitOps.ensureChangesetRefs(params.repoRoot, changesetId);
      const selected =
        (await gitOps.getSelected(params.repoRoot, changesetId)) ??
        refTrunk(changesetId);
      const worktreeAbs = await gitOps.ensureWorktree({
        repoRoot: params.repoRoot,
        changesetId,
        ref: selected,
        appDir,
      });
      return { worktreeAbs, changesetId };
    } catch (error) {
      log(`conversation workspace unavailable: ${String(error)}`);
      return undefined;
    }
  }

  /** One conversation-turn handle: api.ts opens it at prompt time, feeds
   * tool_execution_end events into `capture`, and closes it at turn end. */
  type ConversationTurnHandle = {
    capture: TurnGitCapture;
    changesetId: string;
    ref: string;
    worktreeAbs: string;
  };

  /** BEGIN one conversation turn window: attach the worktree to the selected
   * branch and open the per-write commit capture. Undefined = no git. */
  async function beginConversationGitTurn(params: {
    repoRoot: string;
    appDir: string;
    conversationId: string;
  }): Promise<ConversationTurnHandle | undefined> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const workspace = await ensureConversationWorkspace({
      repoRoot: params.repoRoot,
      appDir,
      conversationId: params.conversationId,
    });
    if (!workspace) return undefined;
    const ref =
      (await gitOps.getSelected(params.repoRoot, workspace.changesetId)) ??
      refTrunk(workspace.changesetId);
    const startTip = await gitOps.resolveCommit(params.repoRoot, ref);
    if (!startTip) return undefined;
    return {
      capture: gitOps.createTurnCapture({
        repoRoot: params.repoRoot,
        worktreeAbs: workspace.worktreeAbs,
        ref,
        startTip,
      }),
      changesetId: workspace.changesetId,
      ref,
      worktreeAbs: workspace.worktreeAbs,
    };
  }

  /** END the turn window: flush + stamp trailers, register/re-project the
   * direct-edits changeset, refresh the serve plane, and report what landed
   * (api.ts surfaces it as a server-notice + records the sidecar range). */
  async function finishConversationGitTurn(params: {
    repoRoot: string;
    appDir: string;
    conversationId: string;
    handle: ConversationTurnHandle;
    sessionId?: string;
    turnIndex?: number;
    /** Agent-supplied turn summary (the reply's `Summary:` line) — the
     * catch-all commit's subject. */
    summary?: string;
    /** Optional agent `Title:` line — renames the turn's ref display title
     * (user names stay locked). */
    title?: string;
  }): Promise<{
    from: string;
    to: string;
    commits: string[];
    files: string[];
    warnings: string[];
    changesetId: string;
    ref: string;
  }> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const range = await params.handle.capture.finish({
      conversationId: params.conversationId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      turnIndex: params.turnIndex ?? 1,
      ...(params.summary ? { summary: params.summary } : {}),
    });
    const result = {
      ...range,
      files: [] as string[],
      warnings: [] as string[],
      changesetId: params.handle.changesetId,
      ref: params.handle.ref,
    };
    if (range.commits.length === 0) return result;
    result.files = (
      await gitOps.changedFiles(params.repoRoot, range.from, range.to)
    )
      .map((change) => change.path)
      .filter((path) => !isDesignbookPath(path));
    await copyBackDesignbookArtifacts(home, range);
    const changeset = await ensureDirectChangeset(
      home,
      params.conversationId,
    );
    const projected = await projectChangeset(home, changeset);
    result.warnings = projected.warnings;
    await persistChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    emitSwitchState(home);
    ensureDriftWatch();
    emit(home, {
      type: "conversation-capture",
      conversationId: params.conversationId,
      changesetId: changeset.id,
      files: result.files,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
    if (params.title) {
      await applyRefTitle({
        home,
        changesetId: params.handle.changesetId,
        ref: params.handle.ref,
        title: params.title,
        source: "agent",
      }).catch((error: unknown) => {
        log(`agent ref title failed: ${String(error)}`);
      });
    }
    log(
      `sandbox conversation turn committed: ${range.commits.length} commit(s) -> ${changeset.id}`,
    );
    return result;
  }

  // ---------------------------------------------------------------------
  // CONVERSATION-ROUTED SELECTION ASKS (changesets-on-git.md §Conversation-
  // routed asks): a selection-scoped prompt runs as a NORMAL turn of the
  // persistent conversation session, with the session's workspace bound —
  // per turn — to the selected pin's changeset worktree. These functions are
  // the sandbox side of that seam; api.ts owns the session/gate.
  // ---------------------------------------------------------------------

  /** The changeset a SELECTION-scoped conversation turn will commit into
   * (resolution-aware — edits follow the active resolution exactly like the
   * pin ask path). api.ts resolves this BEFORE the turn to bind the
   * session's per-turn workspace. */
  async function selectionChangesetId(params: {
    repoRoot: string;
    appDir: string;
    pinId: string;
  }): Promise<{ changesetId?: string; error?: string }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir." };
    const set = resolvePin({
      pinId: params.pinId,
      repoRoot: params.repoRoot,
      appDir,
    });
    if (!set) return { error: "Unknown pin." };
    const home = homeFor(set.repoRoot, set.appDir);
    await ensureBranch(home);
    const resolution = resolveActiveResolution(home, set.pin.target.file);
    return {
      changesetId: resolution
        ? resolution.changesetId
        : changesetIdForPin(set.pin.id),
    };
  }

  /** Ensure a changeset WORKSPACE by explicit changeset id (the per-turn
   * conversation workspace binding — the selected pin's changeset). Same
   * shape as ensureConversationWorkspace; undefined = no git. */
  async function ensureChangesetWorkspace(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
  }): Promise<{ worktreeAbs: string; changesetId: string } | undefined> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    try {
      await revive(params.repoRoot, appDir);
      const home = homeFor(params.repoRoot, appDir);
      await ensureBranch(home);
      await gitOps.ensureChangesetRefs(params.repoRoot, params.changesetId);
      const selected =
        (await gitOps.getSelected(params.repoRoot, params.changesetId)) ??
        refTrunk(params.changesetId);
      const worktreeAbs = await gitOps.ensureWorktree({
        repoRoot: params.repoRoot,
        changesetId: params.changesetId,
        ref: selected,
        appDir,
      });
      return { worktreeAbs, changesetId: params.changesetId };
    } catch (error) {
      log(`selection workspace unavailable: ${String(error)}`);
      return undefined;
    }
  }

  /** One selection-scoped conversation turn's handle (superset of the
   * direct-edits ConversationTurnHandle — api.ts closes either through the
   * matching finish call). */
  type SelectionTurnHandle = ConversationTurnHandle & {
    pinId: string;
    editId: string;
    fresh: boolean;
  };

  /**
   * BEGIN one SELECTION-scoped conversation turn: implicit fork if parked
   * (existing rule), resolve the pin's changeset + edit branch
   * (edits-follow-resolution), attach the shared worktree, open the
   * per-write commit capture, and take the pin's busy latch (a concurrent
   * pin-thread run must not interleave with the conversation turn).
   */
  async function beginSelectionGitTurn(params: {
    repoRoot: string;
    appDir: string;
    pinId: string;
    conversationId: string;
    /** The driving prompt (fork naming + park-fork note). */
    promptText?: string;
  }): Promise<{ error: string } | { handle: SelectionTurnHandle }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir." };
    const set = resolvePin({
      pinId: params.pinId,
      repoRoot: params.repoRoot,
      appDir,
    });
    if (!set) return { error: "Unknown pin." };
    if (set.busy) return { error: "This pin already has a run in progress." };
    const home = homeFor(set.repoRoot, set.appDir);
    await ensureBranch(home);
    // Resolution-aware target: the changeset the turn will actually commit
    // into (a reused pin — or a sibling pin on the same module — follows
    // the ACTIVE resolution, not its own 1:1 changeset).
    const resolution = resolveActiveResolution(home, set.pin.target.file);
    const csId = resolution
      ? resolution.changesetId
      : changesetIdForPin(set.pin.id);
    let editId = resolution ? resolution.variantId : trunkAltId(csId);
    await gitOps.ensureChangesetRefs(set.repoRoot, csId);
    // New work while parked cuts an implicit fork first (existing rule —
    // selection asks while parked follow it on the conversation path too).
    // Checked on the RESOLVED changeset: the park the user is viewing is on
    // the changeset the turn targets, whatever pin record carried the ask.
    const parkedTarget = home.changesets.find(
      (candidate) => candidate.id === csId,
    );
    if (parkedTarget?.parked) {
      const forked = await forkFromPark({
        repoRoot: set.repoRoot,
        appDir: set.appDir,
        changesetId: csId,
        ...(params.promptText ? { promptText: params.promptText } : {}),
      });
      if (forked.altId) {
        // The turn continues ON the fork (selection moved there).
        editId = forked.altId;
      } else if (forked.error) {
        log(`selection park-fork failed: ${forked.error}`);
      }
    }
    const ref = refForAlt(csId, editId);
    const startTip = await gitOps.resolveCommit(set.repoRoot, ref);
    if (!startTip) {
      return { error: `The selected design has no git branch (${ref}).` };
    }
    const worktreeAbs = await gitOps.ensureWorktree({
      repoRoot: set.repoRoot,
      changesetId: csId,
      ref,
      appDir: set.appDir,
    });
    set.busy = true;
    return {
      handle: {
        capture: gitOps.createTurnCapture({
          repoRoot: set.repoRoot,
          worktreeAbs,
          ref,
          startTip,
        }),
        changesetId: csId,
        ref,
        worktreeAbs,
        pinId: set.pin.id,
        editId,
        fresh: !resolution,
      },
    };
  }

  /**
   * FINISH one selection-scoped conversation turn: flush + trailer-stamp
   * the commits (the agent-supplied `Summary:` becomes the catch-all
   * commit's subject and the returned label), LAND the committed work
   * through the shared landing (wrapper/trunk card/activation on first
   * work; owning-changeset re-projection otherwise), apply an optional
   * agent `Title:` to the ref (user names stay locked), and release the
   * pin's busy latch.
   */
  async function finishSelectionGitTurn(params: {
    repoRoot: string;
    appDir: string;
    conversationId: string;
    handle: SelectionTurnHandle;
    sessionId?: string;
    turnIndex?: number;
    /** The user's request (trunk-card intent labels on first landing). */
    request?: string;
    /** The turn's final assistant reply (Summary/Title metadata parse). */
    replyText?: string;
  }): Promise<{
    from: string;
    to: string;
    commits: string[];
    files: string[];
    warnings: string[];
    changesetId: string;
    ref: string;
    label?: string;
  }> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    const set = resolvePin({
      pinId: params.handle.pinId,
      repoRoot: params.repoRoot,
      appDir,
    });
    const home = homeFor(params.repoRoot, appDir);
    const meta = parseTurnSummary(params.replyText ?? "");
    let range: { from: string; to: string; commits: string[] };
    try {
      await ensureBranch(home);
      range = await params.handle.capture.finish({
        conversationId: params.conversationId,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        turnIndex: params.turnIndex ?? 1,
        ...(meta.summary ? { summary: meta.summary } : {}),
      });
    } finally {
      if (set) set.busy = false;
    }
    const result = {
      ...range,
      files: [] as string[],
      warnings: [] as string[],
      changesetId: params.handle.changesetId,
      ref: params.handle.ref,
      ...(meta.summary ? { label: meta.summary } : {}),
    };
    if (range.commits.length === 0) return result;
    const turnChanges = await gitOps.changedFiles(
      params.repoRoot,
      range.from,
      range.to,
    );
    result.files = turnChanges
      .map((change) => change.path)
      .filter((path) => !isDesignbookPath(path));
    await copyBackDesignbookArtifacts(home, range);
    if (set) {
      // Re-resolve for the rev-bump lookup; the turn's branch identity is
      // pinned by the handle either way.
      const resolution = resolveActiveResolution(home, set.pin.target.file);
      await landChangesetTurn(set, {
        home,
        csId: params.handle.changesetId,
        editId: params.handle.editId,
        fresh: params.handle.fresh,
        resolution:
          resolution?.changesetId === params.handle.changesetId
            ? resolution
            : undefined,
        framing: "conversation",
        request: params.request ?? "",
        error: undefined,
        turnCommitCount: range.commits.length,
        turnChanges,
      });
      await persist(set);
    }
    if (meta.title) {
      await applyRefTitle({
        home,
        changesetId: params.handle.changesetId,
        ref: params.handle.ref,
        title: meta.title,
        source: "agent",
      }).catch((error: unknown) => {
        log(`agent ref title failed: ${String(error)}`);
      });
    }
    ensureDriftWatch();
    emit(home, {
      type: "conversation-capture",
      conversationId: params.conversationId,
      changesetId: params.handle.changesetId,
      files: result.files,
    });
    log(
      `sandbox selection turn committed: ${range.commits.length} commit(s) -> ${params.handle.changesetId}`,
    );
    return result;
  }

  /** Release a selection turn's pin latch WITHOUT landing (the prompt never
   * reached the session — begin succeeded but dispatch failed). */
  function abandonSelectionGitTurn(params: {
    repoRoot: string;
    appDir: string;
    pinId: string;
  }): void {
    const set = resolvePin({
      pinId: params.pinId,
      repoRoot: params.repoRoot,
      appDir: normalizeAppDir(params.appDir) ?? params.appDir,
    });
    if (set) set.busy = false;
  }

  /**
   * The U3 intent classification, exposed for the conversation-routed ask
   * path: ONE cheap constrained turn deciding only variants-or-not. Any
   * failure degrades to a normal turn; a single-variation ask IS a normal
   * conversation turn (no fan-out).
   */
  async function classifySelectionIntent(params: {
    repoRoot: string;
    appDir: string;
    pinId: string;
    prompt: string;
  }): Promise<SandboxRoutedIntent> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    const set = resolvePin({
      pinId: params.pinId,
      repoRoot: params.repoRoot,
      appDir,
    });
    if (!set || set.pin.resolved) return { intent: "turn" };
    try {
      const home = homeFor(set.repoRoot, set.appDir);
      await ensureBranch(home);
      const turn = await runScratchTurn({
        home,
        changesetId: changesetIdForPin(set.pin.id),
        conversationId: set.pin.conversationId,
        mode: "intent",
        prompt: buildSandboxIntentPrompt({
          pin: set.pin,
          request: params.prompt,
        }),
      });
      const routed = turn.errorMessage
        ? ({ intent: "turn" } as SandboxRoutedIntent)
        : parseIntentReply(turn.text);
      if (routed.intent === "variants" && routed.n === 1) {
        return { intent: "turn" };
      }
      return routed;
    } catch {
      return { intent: "turn" };
    }
  }

  /** Fresh capture per message: refresh the pin's context snapshot from the
   * client's send-time re-capture (prompt context + wrapper codegen read
   * it — a reused pin must never serve a stale capture). */
  async function refreshPinCapture(params: {
    repoRoot: string;
    appDir: string;
    pinId: string;
    contextSnapshot: unknown;
  }): Promise<{ error?: string }> {
    const set = resolvePin({
      pinId: params.pinId,
      repoRoot: params.repoRoot,
      appDir: normalizeAppDir(params.appDir) ?? params.appDir,
    });
    if (!set) return { error: "Unknown pin." };
    if (
      !params.contextSnapshot ||
      typeof params.contextSnapshot !== "object"
    ) {
      return {};
    }
    set.pin.contextSnapshot = params.contextSnapshot;
    await persist(set);
    return {};
  }

  /**
   * The CONVERSATION-ROUTED selection turn's user message: the same
   * capture-derived context the pin turn prompts embed (owner/source,
   * props, contexts, element locator), framed for the persistent session —
   * whose cwd IS the changeset worktree, so the agent reads/edits the real
   * module path directly. The `[Selection: …]` first line is the client's
   * pin-chip anchor (rendered as a chip, never as text).
   */
  function buildSelectionTurnMessage(params: {
    repoRoot: string;
    appDir: string;
    pinId: string;
    request: string;
  }): { message?: string; label?: string; error?: string } {
    const set = resolvePin({
      pinId: params.pinId,
      repoRoot: params.repoRoot,
      appDir: normalizeAppDir(params.appDir) ?? params.appDir,
    });
    if (!set) return { error: "Unknown pin." };
    const pin = set.pin;
    const label = pin.target.name || pin.target.exportName;
    return {
      label,
      message: [
        `[Selection: ${label}] (pin ${pin.id})`,
        `The designer selected the live ${
          pin.kind === "element"
            ? `<${pin.locator?.tag ?? "element"}> element inside`
            : "component"
        } "${pin.target.exportName}" (source: ${pin.target.file}) in their running app.`,
        "Use your judgment: answer questions directly and concisely; when the message asks for a change, apply it. Not every message needs a file edit.",
        ...renderEditTargetLines(pin),
        "Keep the exported prop interface intact unless the request requires changing it.",
        "",
        "Selection context (captured at send time):",
        renderContextForPrompt(pin.contextSnapshot),
        ...(pin.kind === "element" && pin.locator
          ? ["", renderLocatorForPrompt(pin.locator)]
          : []),
        "",
        "User request:",
        params.request,
      ].join("\n"),
    };
  }

  /**
   * VARIANTS from a conversation-routed ask: the existing director/fan-out
   * pipeline runs UNCHANGED on the pin (ephemeral sub-agents, progressive
   * landing) — only the conversational surface differs (api.ts anchors the
   * results into the conversation thread and notes the outcome to the
   * session). Resolves when the fan-out completes, with THIS run's variant
   * outcomes.
   */
  async function runConversationVariants(params: {
    repoRoot: string;
    appDir: string;
    pinId: string;
    prompt: string;
    n: number;
  }): Promise<{
    error?: string;
    variants?: Array<{ id: string; intent: string; status: string }>;
  }> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    const set = resolvePin({
      pinId: params.pinId,
      repoRoot: params.repoRoot,
      appDir,
    });
    if (!set) return { error: "Unknown pin." };
    if (set.busy) return { error: "This pin already has a run in progress." };
    if (set.pin.resolved) return { error: "This pin is resolved." };
    const request = params.prompt.trim();
    if (!request) return { error: "A prompt is required." };
    const before = new Set(set.pin.variants.map((variant) => variant.id));
    set.busy = true;
    // The pin thread keeps the record (back-compat drill-in surface).
    pushThread(set, { role: "user", text: request, at: Date.now() });
    try {
      await forkPinChangesetIfParked(set, request);
      emit(set, {
        type: "intent-routed",
        pinId: set.pin.id,
        intent: "variants",
        n: params.n,
      });
      await executeVariants(set, request, params.n);
    } catch (error) {
      log(
        `conversation variants run crashed (${set.pin.id}): ${String(error)}`,
      );
      return { error: "The variants run failed." };
    } finally {
      set.busy = false;
    }
    void ensureTitle(set);
    return {
      variants: set.pin.variants
        .filter((variant) => !before.has(variant.id))
        .map((variant) => ({
          id: variant.id,
          intent: variant.intent,
          status: variant.status,
        })),
    };
  }

  /**
   * ROLLBACK (G1, server-side): move a changeset ref back to `commit`,
   * re-project, and push ONE batched hot update. Rolled-off commits stay
   * reflog/sha-recoverable until normal gc. `ref` narrows the branch when
   * the caller knows it (turn records carry it); otherwise the commit is
   * located on the selected branch, trunk, then variants.
   */
  async function rollback(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    commit: string;
    ref?: string;
  }): Promise<{ error?: string; status?: number; ref?: string }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    if (!/^[0-9a-f]{4,40}$/i.test(params.commit)) {
      return { error: "A target commit sha is required.", status: 400 };
    }
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) return { error: "Unknown changeset.", status: 400 };
    if (bakingChangesets.has(changeset.id)) {
      return { error: "This changeset is queued to bake.", status: 400 };
    }
    const refs = await gitOps.listRefs(params.repoRoot, changeset.id);
    if (refs.length === 0) {
      return { error: "This changeset has no git history.", status: 400 };
    }
    const commit = await gitOps.resolveCommit(params.repoRoot, params.commit);
    if (!commit) return { error: "Unknown commit.", status: 400 };
    const base = await gitOps.resolveCommit(
      params.repoRoot,
      refBase(changeset.id),
    );
    if (base && !(await gitOps.isAncestor(params.repoRoot, base, commit))) {
      return {
        error: "The commit predates this changeset.",
        status: 400,
      };
    }
    // Locate the branch: explicit ref first, then selected/trunk/variants.
    const branchRefs = refs
      .map((entry) => entry.ref)
      .filter(
        (ref) =>
          ref === refTrunk(changeset.id) ||
          altIdOfRef(changeset.id, ref) !== undefined,
      );
    const selected = await gitOps.getSelected(params.repoRoot, changeset.id);
    const ordered = [
      ...(params.ref ? [params.ref] : []),
      ...(selected ? [selected] : []),
      refTrunk(changeset.id),
      ...branchRefs,
    ].filter((ref, index, all) => all.indexOf(ref) === index);
    let targetRef: string | undefined;
    for (const ref of ordered) {
      if (!branchRefs.includes(ref)) continue;
      const tip = await gitOps.resolveCommit(params.repoRoot, ref);
      if (tip && (await gitOps.isAncestor(params.repoRoot, commit, tip))) {
        targetRef = ref;
        break;
      }
    }
    if (!targetRef) {
      return {
        error: "The commit is not on any of this changeset's branches.",
        status: 400,
      };
    }
    // A ref move supersedes any park preview (G4) — refs are truth again.
    await clearParked(home, changeset);
    await gitOps.updateRef(params.repoRoot, targetRef, commit);
    // Sync the shared worktree if it exists (best-effort — the next turn
    // re-attaches either way).
    const worktreeAbs = worktreePathFor(params.repoRoot, changeset.id);
    if (await stat(worktreeAbs).then(() => true, () => false)) {
      await gitOps.attachWorktree(worktreeAbs, targetRef).catch(() => {});
    }
    const projected = await projectChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    emitSwitchState(home);
    emit(home, {
      type: "rollback",
      changesetId: changeset.id,
      ref: targetRef,
      commit,
      ...(projected.warnings.length > 0
        ? { warnings: projected.warnings }
        : {}),
    });
    log(`sandbox rollback: ${changeset.id} ${targetRef} -> ${commit}`);
    return { ref: targetRef };
  }

  /**
   * TURN DIFF (G2, read-only): one turn's commit-range diff + its per-tool-
   * write commits, for the thread panel's history rows. `from`/`to` come from
   * the sidecar's turn record (api.ts resolves them); ancestry against the
   * changeset BASE guards arbitrary git reads — rolled-off ranges still
   * resolve (base never moves, shas stay reachable until gc).
   */
  async function turnDiff(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    from: string;
    to: string;
  }): Promise<{
    error?: string;
    status?: number;
    diff?: string;
    truncated?: boolean;
    commits?: Array<{ commit: string; subject: string; toolCall?: string }>;
  }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) return { error: "Unknown changeset.", status: 400 };
    const from = await gitOps.resolveCommit(params.repoRoot, params.from);
    const to = await gitOps.resolveCommit(params.repoRoot, params.to);
    if (!from || !to) {
      return { error: "The turn's commits are no longer available.", status: 410 };
    }
    const base = await gitOps.resolveCommit(
      params.repoRoot,
      refBase(changeset.id),
    );
    if (
      base &&
      !(
        (await gitOps.isAncestor(params.repoRoot, base, from)) &&
        (await gitOps.isAncestor(params.repoRoot, base, to))
      )
    ) {
      return { error: "The commits predate this changeset.", status: 400 };
    }
    const { diff, truncated } = await gitOps.diffRange(
      params.repoRoot,
      from,
      to,
      { maxBytes: TURN_DIFF_MAX_BYTES },
    );
    const commits: Array<{ commit: string; subject: string; toolCall?: string }> =
      [];
    for (const sha of await gitOps.commitsInRange(params.repoRoot, from, to)) {
      const info = await gitOps.commitInfo(params.repoRoot, sha);
      commits.push({
        commit: sha,
        subject: info.subject,
        ...(info.trailers["Designbook-Tool-Call"]
          ? { toolCall: info.trailers["Designbook-Tool-Call"] }
          : {}),
      });
    }
    return { diff, truncated, commits };
  }

  // -------------------------------------------------------------------------
  // G4 — history explorer: park (non-destructive preview), implicit fork,
  // and the conversation history graph. docs/specs/changesets-on-git.md §G4.
  // -------------------------------------------------------------------------

  /** Find a changeset visible on the current branch (shared admission). */
  async function findVisibleChangeset(
    repoRoot: string,
    appDir: string,
    changesetId: string,
  ): Promise<
    | { error: string; status: number }
    | { home: HomeState; changeset: SandboxChangeset }
  > {
    await revive(repoRoot, appDir);
    const home = homeFor(repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === changesetId,
    );
    if (!changeset) return { error: "Unknown changeset.", status: 400 };
    return { home, changeset };
  }

  /** Drop a changeset's park pointer WITHOUT re-projecting (ref-moving ops
   * call this right before they move refs and re-project themselves). */
  async function clearParked(
    home: HomeState,
    changeset: SandboxChangeset,
  ): Promise<boolean> {
    if (!changeset.parked) return false;
    delete changeset.parked;
    await persistChangeset(home, changeset);
    emit(home, { type: "unparked", changesetId: changeset.id });
    return true;
  }

  /**
   * PARK (G4): project one branch's state AS OF `commit` into the cache
   * WITHOUT moving any ref — a reversible preview pointer. `commit: null`
   * exits the preview (back to real tips). Restore/reapply/rebase stay
   * intact by construction: they read refs, which never moved.
   */
  async function park(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    /** Target commit; null/absent = exit the preview. */
    commit?: string | null;
    /** The branch ref the commit lives on (sidecar turn records carry it). */
    ref?: string;
    /** The turn label shown in the "viewing turn" banner, when known. */
    turn?: string;
  }): Promise<{
    error?: string;
    status?: number;
    parked?: { commit: string; ref: string; turn?: string };
  }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    const found = await findVisibleChangeset(
      params.repoRoot,
      appDir,
      params.changesetId,
    );
    if ("error" in found) return found;
    const { home, changeset } = found;
    if (bakingChangesets.has(changeset.id)) {
      return { error: "This changeset is queued to bake.", status: 400 };
    }

    if (!params.commit) {
      // EXIT: back to the selected tip; the cache re-derives from real refs.
      if (await clearParked(home, changeset)) {
        await projectChangeset(home, changeset);
        await syncOverrides(home);
        emitChangesets(home);
        emitSwitchState(home);
        log(`sandbox unparked: ${changeset.id}`);
      }
      return {};
    }

    if (!/^[0-9a-f]{4,40}$/i.test(params.commit)) {
      return { error: "A target commit sha is required.", status: 400 };
    }
    const commit = await gitOps.resolveCommit(params.repoRoot, params.commit);
    if (!commit) return { error: "Unknown commit.", status: 400 };
    const base = await gitOps.resolveCommit(
      params.repoRoot,
      refBase(changeset.id),
    );
    if (base && !(await gitOps.isAncestor(params.repoRoot, base, commit))) {
      return { error: "The commit predates this changeset.", status: 400 };
    }
    // Locate the branch the commit lives on: explicit ref, then selected,
    // trunk, variants (the rollback discipline — ancestry-guarded reads).
    const refs = (await gitOps.listRefs(params.repoRoot, changeset.id))
      .map((entry) => entry.ref)
      .filter(
        (ref) =>
          ref === refTrunk(changeset.id) ||
          altIdOfRef(changeset.id, ref) !== undefined,
      );
    const selected = await gitOps.getSelected(params.repoRoot, changeset.id);
    const ordered = [
      ...(params.ref ? [params.ref] : []),
      ...(selected ? [selected] : []),
      refTrunk(changeset.id),
      ...refs,
    ].filter((ref, index, all) => all.indexOf(ref) === index);
    let targetRef: string | undefined;
    for (const ref of ordered) {
      if (!refs.includes(ref)) continue;
      const tip = await gitOps.resolveCommit(params.repoRoot, ref);
      if (tip && (await gitOps.isAncestor(params.repoRoot, commit, tip))) {
        targetRef = ref;
        break;
      }
    }
    if (!targetRef) {
      return {
        error: "The commit is not on any of this changeset's branches.",
        status: 400,
      };
    }
    const tip = await gitOps.resolveCommit(params.repoRoot, targetRef);
    if (tip === commit && changeset.parked === undefined) {
      // Parking AT a tip of an unparked changeset is a no-op preview.
      return { parked: { commit, ref: targetRef } };
    }
    changeset.parked = {
      commit,
      ref: targetRef,
      ...(params.turn ? { turn: params.turn } : {}),
      at: Date.now(),
    };
    if (tip === commit) {
      // Re-parking at the tip = exit.
      delete changeset.parked;
    }
    await persistChangeset(home, changeset);
    await projectChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    emitSwitchState(home);
    if (changeset.parked) {
      emit(home, {
        type: "parked",
        changesetId: changeset.id,
        commit,
        ref: targetRef,
        ...(params.turn ? { turn: params.turn } : {}),
      });
      log(`sandbox parked: ${changeset.id} ${targetRef} @ ${commit}`);
      return {
        parked: {
          commit,
          ref: targetRef,
          ...(params.turn ? { turn: params.turn } : {}),
        },
      };
    }
    emit(home, { type: "unparked", changesetId: changeset.id });
    log(`sandbox unparked (tip): ${changeset.id}`);
    return {};
  }

  /** A changeset's live park pointer (api.ts consults it on the ask path). */
  async function parkState(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
  }): Promise<{ commit: string; ref: string; turn?: string } | undefined> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return undefined;
    const found = await findVisibleChangeset(
      params.repoRoot,
      appDir,
      params.changesetId,
    );
    if ("error" in found) return undefined;
    return found.changeset.parked;
  }

  /** The changeset a conversation's work commits into (fork-binding aware —
   * api.ts uses this to detect parked state on the prompt path). */
  async function conversationChangesetId(params: {
    repoRoot: string;
    appDir: string;
    conversationId: string;
  }): Promise<string> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    try {
      await revive(params.repoRoot, appDir);
      const home = homeFor(params.repoRoot, appDir);
      await ensureBranch(home);
      const bound = changesetForConversation(home, params.conversationId);
      if (bound) return bound.id;
    } catch {
      // Fall through to the direct id.
    }
    return directChangesetId(params.conversationId);
  }

  /**
   * Ref display titles (Michael's naming rules): stored per altId on the
   * layer meta (`refTitles`). Precedence: a USER rename LOCKS the name
   * (agent `Title:` lines are ignored from then on); "prompt" = a fork's
   * creation default; "agent" = a turn's optional `Title:` line.
   */
  async function applyRefTitle(params: {
    home: HomeState;
    changesetId: string;
    /** Full hidden ref or a bare altId (trunk altId included). */
    ref: string;
    title: string;
    source: "user" | "agent" | "prompt";
  }): Promise<{ error?: string; status?: number }> {
    const { home } = params;
    const changeset = home.changesets.find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) return { error: "Unknown changeset.", status: 400 };
    const altId = params.ref.includes("/")
      ? (altIdOfRef(params.changesetId, params.ref) ??
        (params.ref === refTrunk(params.changesetId)
          ? trunkAltId(params.changesetId)
          : undefined))
      : params.ref;
    if (!altId) return { error: "Unknown ref.", status: 400 };
    const title = params.title.trim();
    if (!title) return { error: "A title is required.", status: 400 };
    const existing = changeset.refTitles?.[altId];
    if (existing?.source === "user" && params.source !== "user") {
      return {}; // User-named is locked — silently keep the user's name.
    }
    if (existing?.title === title && existing.source === params.source) {
      return {};
    }
    changeset.refTitles = {
      ...(changeset.refTitles ?? {}),
      [altId]: { title, source: params.source, at: Date.now() },
    };
    await persistChangeset(home, changeset);
    emitChangesets(home);
    return {};
  }

  /** USER rename of a ref's display title (double-click a tip pill) —
   * POST /api/sandbox/ref-title. User names LOCK the ref. */
  async function renameRef(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    altId: string;
    title: string;
  }): Promise<{ error?: string; status?: number }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    const found = await findVisibleChangeset(
      params.repoRoot,
      appDir,
      params.changesetId,
    );
    if ("error" in found) return found;
    return applyRefTitle({
      home: found.home,
      changesetId: params.changesetId,
      ref: params.altId,
      title: params.title,
      source: "user",
    });
  }

  /** Mint a fork altId unique among the changeset's refs. */
  function mintForkAltId(taken: ReadonlySet<string>): string {
    const stem = `fork-${Date.now().toString(36)}`;
    let altId = stem;
    let n = 2;
    while (taken.has(altId)) altId = `${stem}-${n++}`;
    return altId;
  }

  /**
   * IMPLICIT FORK (G4): new work while parked cuts a NEW ref at the parked
   * commit, moves selection onto it, and clears the park — the graph grows a
   * rail (that visibility is what makes the implicit cut safe). No history
   * is moved or rewritten; the previous tips all stay put.
   */
  async function forkFromPark(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    /** The prompt that triggered the implicit fork — its first 10 chars
     * become the fork's initial display name (Michael's rule). */
    promptText?: string;
  }): Promise<{
    error?: string;
    status?: number;
    altId?: string;
    ref?: string;
    commit?: string;
    fromTurn?: string;
  }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    const found = await findVisibleChangeset(
      params.repoRoot,
      appDir,
      params.changesetId,
    );
    if ("error" in found) return found;
    const { home, changeset } = found;
    const parked = changeset.parked;
    if (!parked) return { error: "This changeset is not parked.", status: 400 };
    const taken = new Set(
      (await gitOps.listRefs(params.repoRoot, changeset.id)).flatMap(
        (entry) => {
          const altId = altIdOfRef(changeset.id, entry.ref);
          return altId ? [altId] : [];
        },
      ),
    );
    const altId = mintForkAltId(taken);
    const ref = refVariant(changeset.id, altId);
    await gitOps.updateRef(params.repoRoot, ref, parked.commit);
    changeset.forks = {
      ...(changeset.forks ?? {}),
      [altId]: {
        forkCommit: parked.commit,
        ...(parked.turn ? { fromTurn: parked.turn } : {}),
        at: Date.now(),
      },
    };
    // Reapply baseline: the fork's generation IS its cut point — commits
    // past it count as reapplyable edits on a later switch.
    changeset.generatedTips = {
      ...(changeset.generatedTips ?? {}),
      [altId]: parked.commit,
    };
    // Initial fork name = the creating prompt, truncated (naming rules).
    const promptTitle = forkTitleFromPrompt(params.promptText);
    if (promptTitle) {
      changeset.refTitles = {
        ...(changeset.refTitles ?? {}),
        [altId]: { title: promptTitle, source: "prompt", at: Date.now() },
      };
    }
    delete changeset.parked;
    await gitOps.setSelected(params.repoRoot, changeset.id, ref);
    const worktreeAbs = worktreePathFor(params.repoRoot, changeset.id);
    if (await stat(worktreeAbs).then(() => true, () => false)) {
      await gitOps.attachWorktree(worktreeAbs, ref).catch(() => {});
    }
    changeset.active = true;
    changeset.order = nextOrder(home);
    await persistChangeset(home, changeset);
    await projectChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    emitSwitchState(home);
    emit(home, {
      type: "forked",
      changesetId: changeset.id,
      altId,
      ref,
      commit: parked.commit,
      ...(parked.turn ? { fromTurn: parked.turn } : {}),
    });
    log(
      `sandbox forked (park): ${changeset.id} ${altId} @ ${parked.commit}` +
        (parked.turn ? ` (turn ${parked.turn})` : ""),
    );
    return {
      altId,
      ref,
      commit: parked.commit,
      ...(parked.turn ? { fromTurn: parked.turn } : {}),
    };
  }

  /** Bind a fork ref to its sliced conversation (api.ts calls this after
   * minting the forked chat — the layer meta is the durable binding the
   * workspace/turn resolution reads). */
  async function bindForkConversation(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    altId: string;
    conversationId: string;
  }): Promise<{ error?: string; status?: number }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    const found = await findVisibleChangeset(
      params.repoRoot,
      appDir,
      params.changesetId,
    );
    if ("error" in found) return found;
    const { home, changeset } = found;
    const fork = changeset.forks?.[params.altId];
    if (!fork) return { error: "Unknown fork.", status: 400 };
    changeset.forks = {
      ...changeset.forks,
      [params.altId]: { ...fork, conversationId: params.conversationId },
    };
    await persistChangeset(home, changeset);
    emitChangesets(home);
    return {};
  }

  /** Fork a PIN changeset before new work when it is parked (the sandbox
   * ask/prompt/iterate paths — the conversation path forks in api.ts where
   * the chat slice lives). Best-effort: a failure logs and the turn
   * proceeds on the selected branch. */
  async function forkPinChangesetIfParked(
    set: PinSet,
    promptText?: string,
  ): Promise<void> {
    try {
      const home = homeFor(set.repoRoot, set.appDir);
      await ensureBranch(home);
      const id = changesetIdForPin(set.pin.id);
      const changeset = home.changesets.find(
        (candidate) => candidate.id === id,
      );
      if (!changeset?.parked) return;
      const forked = await forkFromPark({
        repoRoot: set.repoRoot,
        appDir: set.appDir,
        changesetId: id,
        ...(promptText ? { promptText } : {}),
      });
      if (forked.altId) {
        pushThread(set, {
          role: "assistant",
          text:
            `Forked a new branch (${forked.altId}) from the viewed point — ` +
            "new work lands there; the other branches are untouched.",
          at: Date.now(),
        });
        await persist(set);
      }
    } catch (error) {
      log(`sandbox pin park-fork failed: ${String(error)}`);
    }
  }

  /** One graph node/ref wire shape (GET /api/sandbox/history-graph). */
  type HistoryGraphRef = {
    ref: string;
    altId: string;
    kind: "trunk" | "variant" | "fork";
    tip: string;
    title: string;
    /** The commit this rail leaves its parent at (absent for trunk). */
    forkCommit?: string;
    /** The parent rail's ref (absent for trunk). */
    forkOfRef?: string;
    /** A conversation this fork's sliced chat became (fork pills). */
    forkConversationId?: string;
    /** The parent turn the fork was cut at, when known. */
    fromTurn?: string;
  };

  /**
   * HISTORY GRAPH (G4): one conversation's full changeset DAG in one shot —
   * refs with titles + per-turn nodes + fork topology + selection + park.
   * `turns` are the caller's sidecar records (api.ts owns the session
   * store); everything else derives from refs + layer metas.
   */
  async function historyGraph(params: {
    repoRoot: string;
    appDir: string;
    conversationId?: string;
    changesetId?: string;
    turns: readonly {
      turn: string;
      conversationId?: string;
      changesetId: string;
      ref: string;
      from: string;
      to: string;
      at: number;
      /** Round-2 turn label (+ prompt-line fallback) — passed through to
       * the graph nodes for tooltips. */
      label?: string;
      prompt?: string;
    }[];
  }): Promise<{
    error?: string;
    status?: number;
    conversationId?: string;
    changesets?: Array<{
      id: string;
      title?: string;
      pinId: string;
      direct: boolean;
      active: boolean;
      base: string;
      selectedRef?: string;
      parked?: { commit: string; ref: string; turn?: string };
      refs: HistoryGraphRef[];
      turns: Array<{
        turn: string;
        ref: string;
        commit: string;
        from: string;
        at: number;
        conversationId?: string;
        label?: string;
        prompt?: string;
      }>;
    }>;
  }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    if (!params.conversationId && !params.changesetId) {
      return {
        error: "conversationId or changesetId is required.",
        status: 400,
      };
    }
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const conversationId = params.conversationId;
    // Changesets the conversation actually LANDED turns on (sidecar records)
    // — a conversation reusing an EXISTING pin (pins are reused per target
    // by design) commits onto that pin's changeset, whose meta names its
    // ORIGINAL conversation. Meta-only keying dropped those rails from the
    // graph (live finding: a chat with six landed turns showed only a bare
    // "Direct edits" rail).
    const turnMembers = new Set(
      conversationId
        ? params.turns
            .filter((record) => record.conversationId === conversationId)
            .map((record) => record.changesetId)
        : [],
    );
    const members = visibleLayers(home.changesets, home.branch).filter(
      (changeset) => {
        if (params.changesetId) return changeset.id === params.changesetId;
        if (!conversationId) return false;
        if (turnMembers.has(changeset.id)) return true;
        if (changeset.conversationId === conversationId) return true;
        if (changeset.id === directChangesetId(conversationId)) return true;
        // A fork's conversation sees the parent changeset it is bound to.
        if (
          Object.values(changeset.forks ?? {}).some(
            (fork) => fork.conversationId === conversationId,
          )
        ) {
          return true;
        }
        // Pin changesets group through their pin's conversation.
        const set = changeset.pinId ? pinFor(home, changeset.pinId) : undefined;
        return set?.pin.conversationId === conversationId;
      },
    );

    const out: NonNullable<
      Awaited<ReturnType<typeof historyGraph>>["changesets"]
    > = [];
    for (const changeset of members) {
      const refs = await gitOps.listRefs(params.repoRoot, changeset.id);
      const byRef = new Map(refs.map((entry) => [entry.ref, entry.commit]));
      const base =
        byRef.get(refBase(changeset.id)) ?? changeset.baseCommit ?? "";
      const trunkRef = refTrunk(changeset.id);
      const trunkTip = byRef.get(trunkRef);
      const set = changeset.pinId ? pinFor(home, changeset.pinId) : undefined;
      const direct = isDirectChangesetId(changeset.id) && !changeset.pinId;

      const rails: HistoryGraphRef[] = [];
      // Stored display titles (naming rules): a refTitles entry — user
      // rename (locked), agent Title: line, or a fork's prompt-derived
      // default — beats every derived fallback.
      const storedTitle = (altId: string) =>
        changeset.refTitles?.[altId]?.title;
      if (trunkTip) {
        rails.push({
          ref: trunkRef,
          altId: trunkAltId(changeset.id),
          kind: "trunk",
          tip: trunkTip,
          title:
            storedTitle(trunkAltId(changeset.id)) ??
            changeset.title ??
            (direct ? "Direct edits" : (set?.pin.title ?? "Edits")),
        });
      }
      for (const { ref, commit } of refs) {
        const altId = altIdOfRef(changeset.id, ref);
        if (!altId) continue;
        const fork = changeset.forks?.[altId];
        const variant = set?.pin.variants.find(
          (candidate) => candidate.id === altId,
        );
        rails.push({
          ref,
          altId,
          kind: fork ? "fork" : "variant",
          tip: commit,
          title:
            storedTitle(altId) ??
            (fork
              ? `Fork · ${altId.replace(/^fork-/, "")}`
              : (variant?.intent || altId)),
          ...(fork?.forkCommit ? { forkCommit: fork.forkCommit } : {}),
          ...(fork?.conversationId
            ? { forkConversationId: fork.conversationId }
            : {}),
          ...(fork?.fromTurn ? { fromTurn: fork.fromTurn } : {}),
        });
      }

      // Fork topology: where each non-trunk rail leaves which parent.
      for (const rail of rails) {
        if (rail.kind === "trunk") continue;
        let forkCommit = rail.forkCommit;
        if (!forkCommit && trunkTip) {
          forkCommit =
            (await gitOps.mergeBase(params.repoRoot, rail.tip, trunkTip)) ??
            base;
        }
        if (!forkCommit) continue;
        rail.forkCommit = forkCommit;
        // Parent rail: among the OTHER rails whose tip contains the fork
        // commit, prefer trunk; otherwise the rail closest to the cut
        // (fewest commits between the cut and its tip).
        let parent: { ref: string; distance: number } | undefined;
        for (const candidate of rails) {
          if (candidate.ref === rail.ref) continue;
          if (
            !(await gitOps.isAncestor(
              params.repoRoot,
              forkCommit,
              candidate.tip,
            ))
          ) {
            continue;
          }
          if (candidate.kind === "trunk") {
            parent = { ref: candidate.ref, distance: -1 };
            break;
          }
          const distance = (
            await gitOps.commitsInRange(
              params.repoRoot,
              forkCommit,
              candidate.tip,
            )
          ).length;
          if (!parent || distance < parent.distance) {
            parent = { ref: candidate.ref, distance };
          }
        }
        if (parent) rail.forkOfRef = parent.ref;
        else if (trunkTip && rail.ref !== trunkRef) rail.forkOfRef = trunkRef;
      }

      const selectedRef = await gitOps.getSelected(
        params.repoRoot,
        changeset.id,
      );
      out.push({
        id: changeset.id,
        ...(changeset.title ? { title: changeset.title } : {}),
        pinId: changeset.pinId,
        direct,
        active: changeset.active,
        base,
        ...(selectedRef ? { selectedRef } : {}),
        ...(changeset.parked
          ? {
              parked: {
                commit: changeset.parked.commit,
                ref: changeset.parked.ref,
                ...(changeset.parked.turn
                  ? { turn: changeset.parked.turn }
                  : {}),
              },
            }
          : {}),
        refs: rails,
        turns: params.turns
          .filter((record) => record.changesetId === changeset.id)
          .map((record) => ({
            turn: record.turn,
            ref: record.ref,
            commit: record.to,
            from: record.from,
            at: record.at,
            ...(record.conversationId
              ? { conversationId: record.conversationId }
              : {}),
            ...(record.label ? { label: record.label } : {}),
            ...(record.prompt ? { prompt: record.prompt } : {}),
          })),
      });
    }
    return {
      ...(conversationId ? { conversationId } : {}),
      changesets: out,
    };
  }

  /** The LIVE reapply offer per home (transient, server-held): a selection
   * switch triggers a vite full reload, so the SSE offer alone races the
   * page — status() re-serves it until it is accepted, dismissed, or
   * replaced by the next switch. */
  const pendingReapply = new Map<
    string,
    {
      changesetId: string;
      pinId: string;
      fromRef: string;
      fromAlt: string;
      toRef: string;
      toAlt: string;
      count: number;
    }
  >();

  /** Emit the non-blocking reapply offer after a selection switch, when the
   * previously-selected branch has commits past its generation baseline. */
  async function emitReapplyAvailable(
    home: HomeState,
    changeset: SandboxChangeset,
    previousRef: string | undefined,
    newRef: string,
  ): Promise<void> {
    try {
      if (!previousRef || previousRef === newRef) return;
      const fromAlt = altForRef(changeset.id, previousRef);
      if (!fromAlt) return;
      const base = changeset.generatedTips?.[fromAlt];
      if (!base) return; // Pre-G2 layer / no baseline — no prompt (safe).
      const fromTip = await gitOps.resolveCommit(home.repoRoot, previousRef);
      if (!fromTip || fromTip === base) return;
      const pending = await gitOps.commitsInRange(
        home.repoRoot,
        base,
        fromTip,
      );
      if (pending.length === 0) return;
      const offer = {
        changesetId: changeset.id,
        pinId: changeset.pinId,
        fromRef: previousRef,
        fromAlt,
        toRef: newRef,
        toAlt: altForRef(changeset.id, newRef) ?? "",
        count: pending.length,
      };
      // Survive the vite full reload a selection switch triggers: status()
      // re-serves the offer (a switch REPLACES any previous one).
      pendingReapply.set(homeKey(home.repoRoot, home.appDir), offer);
      emit(home, { type: "reapply-available", ...offer });
      log(
        `sandbox reapply available: ${pending.length} commit(s) on ${fromAlt} ` +
          `(${changeset.id})`,
      );
    } catch (error) {
      log(`sandbox reapply check failed: ${String(error)}`);
    }
  }

  /**
   * REAPPLY (G2, spec §Selection): cherry-pick the previously-selected
   * branch's post-selection edits onto the newly selected branch, in the
   * changeset's shared worktree. Clean → commits land + re-project + one hot
   * update. Conflict → ONE merge turn (the runTurn seam, worktree cwd)
   * resolves and continues. Total failure → abort, restore the target tip,
   * report — the edits stay on the old branch either way (cherry-pick copies,
   * never moves).
   */
  async function reapply(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    fromRef: string;
    toRef?: string;
    /** Decline: clear the server-held offer, touch NOTHING else (spec: the
     * edits simply stay on the old branch). */
    dismiss?: boolean;
  }): Promise<{ error?: string; status?: number; applied?: number }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    if (params.dismiss) {
      pendingReapply.delete(homeKey(params.repoRoot, home.appDir));
      emit(home, { type: "reapply-dismissed", changesetId: params.changesetId });
      return {};
    }
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) return { error: "Unknown changeset.", status: 400 };
    if (bakingChangesets.has(changeset.id)) {
      return { error: "This changeset is queued to bake.", status: 400 };
    }
    const fromAlt = altForRef(changeset.id, params.fromRef);
    if (!fromAlt) {
      return { error: "fromRef is not a branch of this changeset.", status: 400 };
    }
    const toRef =
      params.toRef ??
      (await gitOps.getSelected(params.repoRoot, changeset.id)) ??
      refTrunk(changeset.id);
    const toAlt = altForRef(changeset.id, toRef);
    if (!toAlt) {
      return { error: "toRef is not a branch of this changeset.", status: 400 };
    }
    if (toRef === params.fromRef) {
      return { error: "Source and target branches are the same.", status: 400 };
    }
    const fromTip = await gitOps.resolveCommit(params.repoRoot, params.fromRef);
    const preTip = await gitOps.resolveCommit(params.repoRoot, toRef);
    if (!fromTip || !preTip) {
      return { error: "Unknown branch tip.", status: 400 };
    }
    const base = changeset.generatedTips?.[fromAlt];
    if (!base || base === fromTip) {
      return { error: "Nothing to reapply from this branch.", status: 400 };
    }
    const pending = await gitOps.commitsInRange(params.repoRoot, base, fromTip);
    if (pending.length === 0) {
      return { error: "Nothing to reapply from this branch.", status: 400 };
    }

    // A reapply moves the target ref — any park preview ends first (G4).
    await clearParked(home, changeset);

    emit(home, {
      type: "reapply-started",
      changesetId: changeset.id,
      pinId: changeset.pinId,
      fromAlt,
      toAlt,
      count: pending.length,
    });
    const set = pinFor(home, changeset.pinId);

    const worktreeAbs = await gitOps.ensureWorktree({
      repoRoot: params.repoRoot,
      changesetId: changeset.id,
      ref: toRef,
      appDir: home.appDir,
    });

    /** Abort + restore the target branch exactly as it was. */
    const restore = async () => {
      await gitOps.abortCherryPick(worktreeAbs);
      await gitOps.updateRef(params.repoRoot, toRef, preTip);
      await gitOps.attachWorktree(worktreeAbs, toRef).catch(() => {});
    };
    const failed = async (message: string) => {
      await restore();
      emit(home, {
        type: "reapply-failed",
        changesetId: changeset.id,
        pinId: changeset.pinId,
        fromAlt,
        toAlt,
        error: message,
      });
      if (set) {
        pushThread(set, {
          role: "assistant",
          text:
            `Reapplying your edits onto "${toAlt}" failed: ` +
            `${truncateDiagnostic(message)} — the edits stay on "${fromAlt}" `
            + "(select it again to see them).",
          at: Date.now(),
        });
        await persist(set);
      }
      log(`sandbox reapply failed (${changeset.id}): ${message}`);
      return { error: message };
    };

    try {
      const picked = await gitOps.cherryPickRange(worktreeAbs, base, fromTip);
      if (picked.status === "error") {
        return await failed(
          `the cherry-pick failed: ${truncateDiagnostic(picked.message)}`,
        );
      }
      if (picked.status === "conflict") {
        // ONE merge turn resolves in the worktree, then continues. No commit
        // capture — `git cherry-pick --continue` advances the branch itself.
        emit(home, {
          type: "reapply-conflict",
          changesetId: changeset.id,
          pinId: changeset.pinId,
          fromAlt,
          toAlt,
        });
        let turnError: string | undefined;
        try {
          const turn = await runTurn({
            cwd: worktreeAbs,
            mode: "edit",
            prompt: buildReapplyConflictPrompt({
              fromLabel: fromAlt,
              toLabel: toAlt,
            }),
            conversationId: changeset.conversationId,
          });
          turnError = turn.errorMessage;
        } catch (error) {
          turnError = error instanceof Error ? error.message : String(error);
        }
        if (await gitOps.cherryPickInProgress(worktreeAbs)) {
          // The agent resolved but didn't continue — finish mechanically.
          await gitOps.continueCherryPick(worktreeAbs);
        }
        if (await gitOps.cherryPickInProgress(worktreeAbs)) {
          return await failed(
            turnError
              ? `the merge turn failed: ${truncateDiagnostic(turnError)}`
              : "the merge turn could not resolve the conflict",
          );
        }
        if (turnError) {
          // The sequence completed but the turn reported an error — treat the
          // git state as truth (completed = landed).
          log(
            `sandbox reapply merge turn reported an error after completing: ${turnError}`,
          );
        }
      }
    } catch (error) {
      return await failed(error instanceof Error ? error.message : String(error));
    }

    const landedTip =
      (await gitOps.resolveCommit(params.repoRoot, toRef)) ?? preTip;
    const applied = (
      await gitOps.commitsInRange(params.repoRoot, preTip, landedTip)
    ).length;
    pendingReapply.delete(homeKey(params.repoRoot, home.appDir));
    const projected = await projectChangeset(home, changeset);
    await syncOverrides(home);
    emitChangesets(home);
    emitSwitchState(home);
    emit(home, {
      type: "reapply-done",
      changesetId: changeset.id,
      pinId: changeset.pinId,
      fromAlt,
      toAlt,
      applied,
    });
    if (set) {
      pushThread(set, {
        role: "assistant",
        text: `Reapplied ${applied} ${applied === 1 ? "change" : "changes"} from "${fromAlt}" onto "${toAlt}".`,
        at: Date.now(),
      });
      await persist(set);
      await surfaceDataWarnings(home, set, changeset.id, projected.warnings);
    }
    log(
      `sandbox reapply: ${applied} commit(s) ${fromAlt} -> ${toAlt} (${changeset.id})`,
    );
    return { applied };
  }

  /**
   * G3 drift→rebase (spec §Drift/bake, "Rebase onto current source"): rebase
   * the changeset's branches onto a commit snapshotting the CURRENT source
   * (HEAD + the on-disk content of every overridden path — uncommitted drift
   * counts). TRUNK rebases first, then each variant branch onto the rebased
   * trunk at its original fork distance; generatedTips remap by tip distance
   * (`--empty=keep` keeps commit counts stable). A conflict gets ONE merge
   * turn per conflicted branch (runTurn, worktree cwd); an unresolved branch
   * aborts the WHOLE rebase and restores every pre-rebase tip. Success moves
   * the base ref, re-projects, and clears the drift flag mechanically.
   */
  async function rebase(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
  }): Promise<{ error?: string; status?: number; rebased?: boolean }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset || !changeset.active) {
      return { error: "Unknown or inactive changeset.", status: 400 };
    }
    if (bakingChangesets.has(changeset.id)) {
      return { error: "This changeset is queued to bake.", status: 400 };
    }
    const set = pinFor(home, changeset.pinId);
    if (set?.busy) {
      return { error: "This pin already has a run in progress.", status: 400 };
    }
    const repoRoot = home.repoRoot;
    const id = changeset.id;
    const base = await gitOps.resolveCommit(repoRoot, refBase(id));
    if (!base) {
      return { error: "This changeset has no git history.", status: 400 };
    }
    let newBase: string;
    try {
      newBase = await gitOps.snapshotBaseCommit(
        repoRoot,
        Object.keys(changeset.overrides).sort(),
      );
    } catch (error) {
      return {
        error: `Could not snapshot the current source: ${String(error)}`,
        status: 500,
      };
    }
    if (newBase === base) {
      // Already based on the current source — clear any stale flag.
      await refreshDriftForHome(home);
      return { rebased: false };
    }

    if (set) set.busy = true;
    // A rebase rewrites every branch — any park preview ends first (G4).
    await clearParked(home, changeset);
    bakingChangesets.add(id); // Blocks bake admission + drift flips mid-rebase.
    const emitStatus = (
      status: "running" | "conflict" | "done" | "failed",
      extra: Record<string, unknown> = {},
    ) =>
      emit(home, {
        type: "rebase-status",
        changesetId: id,
        pinId: changeset.pinId,
        status,
        ...extra,
      });
    let failure: string | undefined;
    try {
      emitStatus("running");
      log(`sandbox rebase running: ${id} (${base} -> ${newBase})`);
      const refs = await gitOps.listRefs(repoRoot, id);
      const byRef = new Map(refs.map((entry) => [entry.ref, entry.commit]));
      const oldTrunkTip = byRef.get(refTrunk(id)) ?? base;
      const variantRefs = refs.filter(
        (entry) => altIdOfRef(id, entry.ref) !== undefined,
      );
      const savedTips: Array<{ ref: string; commit: string }> = [
        { ref: refTrunk(id), commit: oldTrunkTip },
        ...variantRefs.map((entry) => ({ ref: entry.ref, commit: entry.commit })),
      ];
      const selectedRef = (await gitOps.getSelected(repoRoot, id)) ?? refTrunk(id);
      const worktreeAbs = await gitOps.ensureWorktree({
        repoRoot,
        changesetId: id,
        ref: selectedRef,
        appDir: home.appDir,
      });

      const restoreAll = async () => {
        await gitOps.abortRebase(worktreeAbs);
        for (const saved of savedTips) {
          await gitOps.updateRef(repoRoot, saved.ref, saved.commit).catch(
            () => {},
          );
        }
        await gitOps.attachWorktree(worktreeAbs, selectedRef).catch(() => {});
      };

      /** Rebase upstream..tip onto `onto`; undefined = unresolved (abort). */
      const rebaseBranch = async (
        label: string,
        range: { onto: string; upstream: string; tip: string },
      ): Promise<string | undefined> => {
        if (range.tip === range.upstream) return range.onto; // No own commits.
        const result = await gitOps.rebaseOnto(worktreeAbs, range);
        if (result.status === "clean") return result.newTip;
        if (result.status === "error") {
          log(`sandbox rebase refused (${id}/${label}): ${result.message}`);
          return undefined;
        }
        // Conflict → ONE merge turn for this branch, worktree cwd.
        emitStatus("conflict", { branch: label });
        log(`sandbox rebase conflict: ${id}/${label} — running one merge turn`);
        let turnError: string | undefined;
        try {
          const turn = await runTurn({
            cwd: worktreeAbs,
            mode: "edit",
            prompt: buildRebaseConflictPrompt({ branchLabel: label }),
            conversationId: changeset.conversationId,
          });
          turnError = turn.errorMessage;
        } catch (error) {
          turnError = error instanceof Error ? error.message : String(error);
        }
        // Mechanical finish when the agent resolved without continuing;
        // unresolved markers never commit.
        if (!(await gitOps.continueRebase(worktreeAbs))) {
          log(
            `sandbox rebase merge turn unresolved (${id}/${label})` +
              (turnError ? `: ${turnError}` : ""),
          );
          return undefined;
        }
        return (await gitOps.resolveCommit(worktreeAbs, "HEAD"))!;
      };

      /** Remap a generation baseline onto the rebased branch (distance from
       * the tip is invariant under --empty=keep). */
      const remapBaseline = async (
        altId: string,
        oldTip: string,
        newTip: string,
      ) => {
        const baseline = changeset.generatedTips?.[altId];
        if (!baseline || !changeset.generatedTips) return;
        const distance = (
          await gitOps.commitsInRange(repoRoot, baseline, oldTip)
        ).length;
        const mapped =
          distance === 0
            ? newTip
            : await gitOps.resolveCommit(repoRoot, `${newTip}~${distance}`);
        changeset.generatedTips[altId] = mapped ?? newTip;
      };

      // Rebase every branch FIRST, move refs only after ALL of them landed —
      // the shared worktree's HEAD is symref'd onto a changeset branch, and
      // moving that ref mid-run would make the checkout read as dirty (and a
      // late abort must find every tip untouched anyway). Trunk first.
      const movedRefs: Array<{ ref: string; commit: string }> = [];
      const newTrunkTip = await rebaseBranch(trunkAltId(id), {
        onto: newBase,
        upstream: base,
        tip: oldTrunkTip,
      });
      if (!newTrunkTip) {
        await restoreAll();
        failure = "the rebase could not resolve conflicts on the main branch.";
      } else {
        movedRefs.push({ ref: refTrunk(id), commit: newTrunkTip });
        // Then every variant branch, onto the rebased trunk at its original
        // fork distance.
        for (const entry of variantRefs) {
          const altId = altIdOfRef(id, entry.ref)!;
          const fork =
            (await gitOps.mergeBase(repoRoot, oldTrunkTip, entry.commit)) ??
            base;
          const distance = (
            await gitOps.commitsInRange(repoRoot, fork, oldTrunkTip)
          ).length;
          const onto =
            distance === 0
              ? newTrunkTip
              : ((await gitOps.resolveCommit(
                  repoRoot,
                  `${newTrunkTip}~${distance}`,
                )) ?? newTrunkTip);
          const newTip = await rebaseBranch(altId, {
            onto,
            upstream: fork,
            tip: entry.commit,
          });
          if (!newTip) {
            await restoreAll();
            failure = `the rebase could not resolve conflicts on the "${altId}" branch.`;
            break;
          }
          movedRefs.push({ ref: entry.ref, commit: newTip });
        }
      }

      if (!failure) {
        for (const moved of movedRefs) {
          await gitOps.updateRef(repoRoot, moved.ref, moved.commit);
        }
        await remapBaseline(trunkAltId(id), oldTrunkTip, newTrunkTip!);
        for (const entry of variantRefs) {
          const moved = movedRefs.find((m) => m.ref === entry.ref);
          if (moved) {
            await remapBaseline(
              altIdOfRef(id, entry.ref)!,
              entry.commit,
              moved.commit,
            );
          }
        }
        await gitOps.updateRef(repoRoot, refBase(id), newBase);
        changeset.baseCommit = newBase;
        delete changeset.drifted;
        await gitOps.attachWorktree(worktreeAbs, selectedRef).catch(() => {});
        const projected = await projectChangeset(home, changeset);
        await persistChangeset(home, changeset);
        await syncOverrides(home);
        emitChangesets(home);
        emitSwitchState(home);
        if (set) {
          pushThread(set, {
            role: "assistant",
            text:
              "Rebased this changeset onto the current source — the outside " +
              "changes and the design now share one base. Bake is clean again.",
            at: Date.now(),
          });
          await persist(set);
          await surfaceDataWarnings(home, set, id, projected.warnings);
        }
        emitStatus("done");
        log(`sandbox rebase done: ${id} (base -> ${newBase})`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      // Best-effort restore on unexpected failures.
      const worktreeAbs = worktreePathFor(repoRoot, id);
      await gitOps.abortRebase(worktreeAbs).catch(() => {});
    } finally {
      bakingChangesets.delete(id);
      if (set) set.busy = false;
    }
    if (failure) {
      emitStatus("failed", { error: failure });
      if (set) {
        pushThread(set, {
          role: "assistant",
          text:
            `Rebase onto the current source failed: ${truncateDiagnostic(failure)} ` +
            "— everything was restored exactly as before.",
          at: Date.now(),
        });
        await persist(set);
      }
      await refreshDriftForHome(home);
      log(`sandbox rebase failed (${id}): ${failure}`);
      return { error: failure };
    }
    return { rebased: true };
  }

  /**
   * Read-only changeset listing (L3 branch-filtering surface): the visible
   * (current-branch) layers by default; `allBranches` includes foreign-
   * branch layers TAGGED (`foreign: true`) — listed, never resolved or
   * activatable across branches.
   */
  async function listChangesets(params: {
    repoRoot: string;
    appDir: string;
    allBranches?: boolean;
  }): Promise<{
    branch: string;
    changesets: Array<
      ReturnType<typeof publicChangeset> & {
        branch: string;
        baseCommit: string;
        foreign: boolean;
      }
    >;
  }> {
    const appDir = normalizeAppDir(params.appDir) ?? "";
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const list = params.allBranches
      ? [...home.changesets].sort((a, b) =>
          a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order,
        )
      : visibleLayers(home.changesets, home.branch);
    return {
      branch: home.branch,
      changesets: list.map((candidate) => ({
        ...publicChangeset(home, candidate),
        branch: candidate.branch,
        baseCommit: candidate.baseCommit,
        foreign: candidate.branch !== home.branch,
      })),
    };
  }

  /**
   * Discard a changeset (POST /api/sandbox/discard): drop the LAYER —
   * deactivate, remove the record, DELETE the layer dir (alternatives, base
   * snapshots, data additions — nothing else to clean, no GC scan). The pin
   * thread stays as history; the pin resolves with a "discarded" marker.
   */
  async function discard(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
  }): Promise<{ error?: string; status?: number }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) return { error: "Unknown changeset.", status: 400 };
    if (bakingChangesets.has(changeset.id)) {
      return { error: "This changeset is queued to bake.", status: 400 };
    }
    const set = pinFor(home, changeset.pinId);
    if (set?.busy) {
      return { error: "This pin already has a run in progress.", status: 400 };
    }
    home.changesets = home.changesets.filter(
      (candidate) => candidate.id !== changeset.id,
    );
    await removeChangesetFiles(home, changeset.id);
    // G1 cleanup ("mess is temporary"): refs + worktree vanish with the
    // layer — no visible trace in any git surface from this moment.
    await gitOps.removeWorktree(home.repoRoot, changeset.id).catch(() => {});
    await gitOps
      .deleteChangesetRefs(home.repoRoot, changeset.id)
      .catch(() => {});
    if (set) {
      set.pin.resolved = true; // History (D3) — hidden from active surfaces.
      pushThread(set, {
        role: "assistant",
        text:
          "Discarded this exploration's changeset. The layer and its " +
          "alternatives were removed; the page serves the original source " +
          "again. The thread stays as history.",
        at: Date.now(),
      });
      await persist(set);
    }
    await syncOverrides(home);
    emitChangesets(home);
    emitSwitchState(home);
    if (set) {
      emit(set, { type: "discarded", pinId: set.pin.id, changesetId: changeset.id });
    }
    ensureDriftWatch();
    log(`sandbox discarded: ${changeset.id} (layer dir removed)`);
    return {};
  }

  /**
   * COMPOSE (POST /api/sandbox/compose): two independent ACTIVE changesets
   * over one file merge through ONE merge-agent LLM turn. The composed
   * variant registers as a NEW changeset layer (its own pin/thread — the
   * 1:1 rule) with `bases` recording BOTH parents, activates ON TOP of the
   * stack, and selects on success (the composed design resolves — parents
   * stay active underneath, exactly the pre-layer behavior). Gate failure
   * (turn error / missing artifact / wrong export) surfaces diagnostics in
   * the new thread + a `variant-failed` event; the parents stay untouched.
   * L2 replaces this with layer-merge composition; the endpoint stays wire-
   * compatible until then.
   */
  async function compose(params: {
    repoRoot: string;
    appDir: string;
    component: string;
    changesetIds?: string[];
  }): Promise<{ id?: string; error?: string; status?: number }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir.", status: 400 };
    const separator = params.component.lastIndexOf("#");
    if (separator <= 0) {
      return {
        error: 'component must be "<module>#<exportName>".',
        status: 400,
      };
    }
    const module = params.component.slice(0, separator);
    const exportName = params.component.slice(separator + 1);
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const matching = activeLayers(home.changesets, home.branch).filter(
      (changeset) =>
        (changeset.overrides[module]?.alternatives.length ?? 0) > 0,
    );
    const chosen =
      Array.isArray(params.changesetIds) && params.changesetIds.length > 0
        ? params.changesetIds.map((id) =>
            matching.find((candidate) => candidate.id === id),
          )
        : matching.slice(0, 2);
    if (
      chosen.length !== 2 ||
      chosen.some((candidate) => candidate === undefined) ||
      chosen[0]!.id === chosen[1]!.id
    ) {
      return {
        error:
          "Compose needs exactly two different ACTIVE changesets over this component.",
        status: 400,
      };
    }
    const [parentA, parentB] = chosen as [SandboxChangeset, SandboxChangeset];

    // The input per parent: its SELECTED alternative when set, else its
    // single/first (sorted) alternative. (`appDir` re-bound: closures don't
    // keep the undefined-guard narrowing.)
    const composeAppDir: string = appDir;
    function inputFor(changeset: SandboxChangeset) {
      const override = changeset.overrides[module]!;
      const alternatives = [...override.alternatives].sort();
      const altId =
        override.selection && alternatives.includes(override.selection)
          ? override.selection
          : alternatives[0]!;
      return {
        changesetId: changeset.id,
        file: altFilePath(composeAppDir, changeset.id, altId, module),
        variantId: altId,
      };
    }
    const inputA = inputFor(parentA);
    const inputB = inputFor(parentB);

    // The composed work is a NEW pin/thread (changesets stay 1:1 with pins).
    // The context snapshot rides over from a parent so the wrapper renders
    // the canvas cell in captured state.
    const parentPin = pinFor(home, parentA.pinId)?.pin;
    const created = await createPin({
      repoRoot: params.repoRoot,
      appDir,
      target: {
        file: module,
        exportName,
        name: `${exportName} (composed)`,
      },
      contextSnapshot: parentPin?.contextSnapshot ?? {},
      // L3: the composed thread stays in the parents' conversation.
      conversationId:
        parentA.conversationId ?? parentB.conversationId ?? undefined,
    });
    if (!created.id) {
      return {
        error: created.error ?? "Could not create the compose thread.",
        status: 400,
      };
    }
    const set = pinFor(home, created.id)!;
    set.busy = true;
    const position = seedVariantPositions(0, 1)[0];
    const variant: SandboxVariant = {
      id: "composed",
      intent: `composed: ${inputA.changesetId}/${inputA.variantId} + ${inputB.changesetId}/${inputB.variantId}`,
      file: moduleAltPath(appDir, created.id, "composed", module),
      x: position.x,
      y: position.y,
      status: "generating",
      rev: 0,
      request: `compose ${inputA.changesetId} + ${inputB.changesetId}`,
    };
    set.pin.thread.push({
      role: "user",
      text: `Compose the "${inputA.variantId}" and "${inputB.variantId}" designs of ${exportName}.`,
      at: Date.now(),
    });
    set.pin.variants.push(variant);
    await persist(set);
    emit(set, {
      type: "variants-planned",
      pinId: set.pin.id,
      variants: [
        {
          id: variant.id,
          intent: variant.intent,
          file: variant.file,
          x: variant.x,
          y: variant.y,
        },
      ],
    });
    log(
      `sandbox compose started: ${params.component} (${inputA.changesetId}/${inputA.variantId} + ${inputB.changesetId}/${inputB.variantId})`,
    );

    void (async () => {
      try {
        // Deterministic wrapper first (canvas context for the composed cell).
        const wrapperAbs = absPath(set, wrapperPath(set.appDir, set.pin.id));
        await mkdir(dirname(wrapperAbs), { recursive: true });
        await writeFile(
          wrapperAbs,
          await generateSandboxWrapper({
            repoRoot: set.repoRoot,
            appDir: set.appDir,
            pinId: set.pin.id,
            contextSnapshot: set.pin.contextSnapshot,
          }),
          "utf8",
        );
        const originalSource = await readFile(
          join(set.repoRoot, module),
          "utf8",
        ).catch(() => "");
        const sourceA = await readFile(
          join(set.repoRoot, inputA.file),
          "utf8",
        ).catch(() => "");
        const sourceB = await readFile(
          join(set.repoRoot, inputB.file),
          "utf8",
        ).catch(() => "");
        // G1: the merge agent runs on the NEW composed layer's variant
        // branch — it edits the REAL module path in the worktree and the
        // commit projects as the composed alternative. Both parents' designs
        // are EMBEDDED (their branches are invisible to this turn).
        const csId = changesetIdForPin(set.pin.id);
        await gitOps.ensureChangesetRefs(set.repoRoot, csId);
        await gitOps.cutVariantBranch(set.repoRoot, csId, variant.id);
        const turn = await runGitTurn({
          home,
          changesetId: csId,
          ref: refVariant(csId, variant.id),
          conversationId: set.pin.conversationId,
          mode: "variant",
          prompt: buildComposePrompt({
            module,
            exportName,
            originalSource,
            inputs: [
              {
                label: `${inputA.changesetId}/${inputA.variantId}`,
                source: sourceA,
              },
              {
                label: `${inputB.changesetId}/${inputB.variantId}`,
                source: sourceB,
              },
            ],
          }),
          onActivity: sessionActivity(set, "variant", variant.id),
        });
        if (turn.errorMessage) {
          throw new Error(
            `the compose turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
          );
        }
        // The composed result becomes the live resolution: selection =
        // checkout of the composed branch, THEN the projection derives the
        // layer state (selection included) in one pass.
        await gitOps.setSelected(
          set.repoRoot,
          csId,
          refVariant(csId, variant.id),
        );
        const projected = await ensureChangesetForPin(set, {
          bases: [parentA.id, parentB.id],
        });
        const source = await readFile(absPath(set, variant.file), "utf8").catch(
          () => undefined,
        );
        if (!source || !moduleExportsName(source, exportName)) {
          throw new Error(
            `the compose turn did not produce ${variant.file} exporting ${exportName}`,
          );
        }
        variant.status = "ready";
        variant.rev = 1;
        await persist(set);
        await surfaceDataWarnings(home, set, csId, projected.warnings);
        // Put the new layer on top of the stack.
        const changeset = home.changesets.find(
          (candidate) => candidate.pinId === set.pin.id,
        );
        if (changeset) {
          changeset.active = true;
          changeset.order = nextOrder(home);
          await persistChangeset(home, changeset);
          await syncOverrides(home);
          emitSwitchState(home, {
            component: params.component,
            selection: { changesetId: changeset.id, variantId: variant.id },
          });
          emitChangesets(home);
        }
        emit(set, {
          type: "variant-ready",
          pinId: set.pin.id,
          variantId: variant.id,
          intent: variant.intent,
          file: variant.file,
          absPath: absPath(set, variant.file),
          wrapperAbsPath: absPath(set, wrapperPath(set.appDir, set.pin.id)),
          x: variant.x,
          y: variant.y,
          rev: variant.rev,
        });
        pushThread(set, {
          role: "assistant",
          text:
            `Composed the two changesets into one "${variant.id}" design — ` +
            `switched in place. Bake to write it into ${module}.`,
          at: Date.now(),
        });
        await persist(set);
        emit(set, { type: "run-complete", pinId: set.pin.id });
        log(`sandbox composed: ${params.component} -> ${variant.file}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        variant.status = "failed";
        variant.error = message;
        await persist(set);
        emit(set, {
          type: "variant-failed",
          pinId: set.pin.id,
          variantId: variant.id,
          file: variant.file,
          error: variant.error,
        });
        pushThread(set, {
          role: "assistant",
          text: `Compose failed: ${message}`,
          at: Date.now(),
        });
        await persist(set);
        emit(set, { type: "run-complete", pinId: set.pin.id });
        log(`sandbox compose failed (${set.pin.id}): ${message}`);
      } finally {
        set.busy = false;
      }
    })();
    return { id: created.id };
  }

  /**
   * Flip a component's card (POST /api/sandbox/switch — wire compat with the
   * pre-layer UI): `selection` null = original; otherwise it must name a
   * changeset + one of its landed alternatives for that module. In layer
   * terms a flip SELECTS the alternative, ACTIVATES the layer, and bumps it
   * to the TOP of the stack (topmost wins); "original" clears the selection
   * on every active layer overriding the module. Either way the redirect
   * table refreshes once — ONE batched hot update, never a reload.
   */
  async function switchSelect(params: {
    repoRoot: string;
    appDir: string;
    component: string;
    selection: SandboxSwitchSelection | null;
  }): Promise<{ error?: string }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir." };
    if (typeof params.component !== "string" || !params.component.includes("#")) {
      return { error: 'component must be "<module>#<exportName>".' };
    }
    const module = params.component.slice(
      0,
      params.component.lastIndexOf("#"),
    );
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    if (params.selection) {
      const { changesetId, variantId } = params.selection;
      const changeset = visibleLayers(home.changesets, home.branch).find(
        (candidate) => candidate.id === changesetId,
      );
      const override = changeset?.overrides[module];
      if (!changeset || !override || !override.alternatives.includes(variantId)) {
        return { error: "Unknown changeset/variant for this component." };
      }
      // G1: SELECTION = CHECKOUT (spec §Selection). The selected symref
      // moves to the alternative's branch; the shared worktree (if
      // materialized) checks out onto it; the projection re-derives the
      // per-file selections — extra module files a turn committed alongside
      // the target FOLLOW mechanically (they live on the same branch), so
      // cross-module changesets flip atomically and never mix alternatives.
      const ref = refForAlt(changeset.id, variantId);
      if (!(await gitOps.resolveCommit(params.repoRoot, ref))) {
        return { error: "This variant has no git branch to select." };
      }
      // G2 reapply (spec §Selection): the PREVIOUS selection's branch may
      // carry post-selection edits — offer to cherry-pick them onto the new
      // branch. NEVER auto-applied; decline = the edits stay put.
      const previousRef = await gitOps.getSelected(
        params.repoRoot,
        changeset.id,
      );
      // Selecting a branch exits any park preview (G4) — refs are truth.
      await clearParked(home, changeset);
      await gitOps.setSelected(params.repoRoot, changeset.id, ref);
      const worktreeAbs = worktreePathFor(params.repoRoot, changeset.id);
      if (await stat(worktreeAbs).then(() => true, () => false)) {
        await gitOps.attachWorktree(worktreeAbs, ref).catch(() => {});
      }
      changeset.active = true;
      changeset.order = nextOrder(home);
      await projectChangeset(home, changeset);
      // A new switch REPLACES any stale offer (set again below if the
      // previous branch still has reapplyable edits).
      pendingReapply.delete(homeKey(home.repoRoot, home.appDir));
      await emitReapplyAvailable(home, changeset, previousRef, ref);
    } else {
      // Original: clear the selection pointer on every active layer
      // overriding the module (the layers stay active — gallery + data
      // additions live on; projections clear their per-file selections).
      pendingReapply.delete(homeKey(home.repoRoot, home.appDir));
      for (const changeset of activeLayers(home.changesets, home.branch)) {
        const override = changeset.overrides[module];
        if (override?.selection) {
          await clearParked(home, changeset);
          await gitOps.setSelected(params.repoRoot, changeset.id, null);
          await projectChangeset(home, changeset);
        }
      }
    }
    await syncOverrides(home);
    emitSwitchState(home, {
      component: params.component,
      selection: params.selection,
    });
    emitChangesets(home);
    log(
      `sandbox switch: ${params.component} -> ${
        params.selection
          ? `${params.selection.changesetId}/${params.selection.variantId}`
          : "original"
      }`,
    );
    return {};
  }

  /**
   * Activate/deactivate a WHOLE changeset layer (POST /api/sandbox/activate)
   * — the file-level conflict "choose" action (deactivate one) and the tray
   * toggle. Activation bumps the layer to the top of the stack. One batched
   * redirect refresh; cross-module changesets flip atomically.
   */
  async function activate(params: {
    repoRoot: string;
    appDir: string;
    changesetId: string;
    active: boolean;
  }): Promise<{ error?: string }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir." };
    await revive(params.repoRoot, appDir);
    const home = homeFor(params.repoRoot, appDir);
    await ensureBranch(home);
    const changeset = visibleLayers(home.changesets, home.branch).find(
      (candidate) => candidate.id === params.changesetId,
    );
    if (!changeset) return { error: "Unknown changeset." };
    if (bakingChangesets.has(changeset.id)) {
      return { error: "This changeset is queued to bake." };
    }
    if (changeset.active !== params.active) {
      changeset.active = params.active;
      if (params.active) changeset.order = nextOrder(home);
      await persistChangeset(home, changeset);
      await syncOverrides(home);
      emitChangesets(home);
      emitSwitchState(home);
      ensureDriftWatch();
      log(
        `sandbox layer ${params.active ? "activated" : "deactivated"}: ${changeset.id}`,
      );
    }
    return {};
  }

  /** The per-component switch snapshot for a home (wire compat bootstrap). */
  async function switches(
    repoRoot: string,
    rawAppDir: string,
  ): Promise<{ switches: SandboxSwitches }> {
    const appDir = normalizeAppDir(rawAppDir) ?? "";
    await revive(repoRoot, appDir);
    const home = homeFor(repoRoot, appDir);
    await ensureBranch(home);
    return { switches: synthSwitches(home) };
  }

  /** The redirect table (GET /api/sandbox/redirects — the injected vite
   * plugin polls this; version-gated so unchanged polls are no-ops).
   * `stamps` carries the per-target content stamps: a content-only
   * re-projection bumps the version, and the polling host diffs stamps to
   * hot-update the rewritten modules. */
  async function redirects(
    repoRoot: string,
    rawAppDir: string,
  ): Promise<{
    version: number;
    redirects: Record<string, string>;
    stamps: Record<string, number>;
  }> {
    const appDir = normalizeAppDir(rawAppDir) ?? "";
    await revive(repoRoot, appDir);
    return {
      version: redirectsVersion,
      redirects: redirectsTable,
      stamps: redirectsStamps,
    };
  }

  /** A serialized pin for status payloads/events (adds absolute paths). */
  function serializePin(set: PinSet) {
    const { pin } = set;
    return {
      ...pin,
      busy: set.busy,
      wrapperFile: wrapperPath(set.appDir, pin.id),
      wrapperAbsPath: absPath(set, wrapperPath(set.appDir, pin.id)),
      // Element pins: the canvas mounts through the controller (E2) — absent
      // until the director authored it.
      ...(pin.controllerFile
        ? { controllerAbsPath: absPath(set, pin.controllerFile) }
        : {}),
      variants: pin.variants.map((variant) => ({
        ...variant,
        absPath: absPath(set, variant.file),
      })),
    };
  }

  function pushThread(
    set: PinSet,
    message: SandboxThreadMessage,
  ): void {
    set.pin.thread.push(message);
    emit(set, { type: "thread", pinId: set.pin.id, message });
  }

  /** U4: broadcast one session's live activity into the pin thread, keyed
   * {pinId, sessionRole, variantId?} — `sandbox-event` only, NEVER the main
   * chat's pi-event stream. */
  function sessionActivity(
    set: PinSet,
    sessionRole: "director" | "variant",
    variantId?: string,
  ): (entry: SandboxTurnActivity) => void {
    return (entry) =>
      emit(set, {
        type: "session-activity",
        pinId: set.pin.id,
        sessionRole,
        ...(variantId ? { variantId } : {}),
        entry,
      });
  }

  /**
   * Create a pin. The pin is durable immediately (D4 — pins survive reload
   * before any prompt ran). Async ONLY for the source-owner fallback: an
   * ELEMENT pin whose client could not resolve the owner file (unregistered
   * authoring component, e.g. a page shell outside the config's
   * `sourceModules` glob) arrives with `target.file: ""` plus the
   * named-owner chain, and the file is resolved here via the same bounded
   * export scan the wrapper generator uses (`makeExportResolver`).
   */
  async function createPin(params: {
    repoRoot: string;
    appDir: string;
    target: SandboxTarget;
    contextSnapshot: unknown;
    /** Absent/"component" = the original flow (E3). */
    kind?: SandboxPinKind;
    /** Required for element pins: what the selection pointed at (E1). */
    locator?: unknown;
    /** Source-owner fallback: named-component chain, nearest owner first —
     * the first name the export scan resolves picks the file (a node_modules
     * component like react-router's Link scans to nothing and the page shell
     * above it wins instead). */
    ownerNames?: unknown;
    /** L3: the conversation this pin is born from (the live per-branch
     * session's conversation) — stamped onto the pin + its changeset. */
    conversationId?: string | undefined;
  }): Promise<{ id?: string; error?: string }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir." };
    const target = { ...params.target };
    if (typeof target.exportName !== "string" || !target.exportName) {
      return { error: "A target export name is required." };
    }
    const kind: SandboxPinKind = params.kind === "element" ? "element" : "component";
    if ((typeof target.file !== "string" || !target.file) && kind === "element") {
      const { resolved, candidates } = await resolveOwnerSource({
        repoRoot: params.repoRoot,
        appDir,
        names: [
          target.exportName,
          ...(Array.isArray(params.ownerNames)
            ? params.ownerNames.filter(
                (name): name is string => typeof name === "string",
              )
            : []),
        ],
      });
      if (!resolved) {
        return {
          error: `Could not find a source file exporting "${candidates.join('"/"')}" in the app.`,
        };
      }
      target.file = resolved.file;
      target.exportName = resolved.exportName;
    }
    if (!target || typeof target.file !== "string" || !target.file) {
      return { error: "A target source file is required." };
    }
    const targetAbs = containedPath(params.repoRoot, target.file);
    if (
      !targetAbs ||
      isSandboxPath(target.file, appDir) ||
      isChangesetPath(target.file, appDir)
    ) {
      return { error: "target.file must be a repo-relative component file." };
    }
    let locator: SandboxElementLocator | undefined;
    if (kind === "element") {
      locator = sanitizeElementLocator(params.locator);
      if (!locator) {
        return { error: "An element pin requires a usable element locator." };
      }
    } else if (params.locator) {
      // COMPONENT pins: a best-effort locator (the instance's root element at
      // creation) powers the U5 in-place preview's re-resolution after a
      // reload. Optional — an unusable one is simply dropped, never a gate.
      locator = sanitizeElementLocator(params.locator);
    }
    // Warm the home's branch probe so this pin's events are home-tagged
    // from the very first emit (pin-created included).
    await ensureBranch(homeFor(params.repoRoot, appDir));
    const id = makePinId(target.exportName);
    const set: PinSet = {
      pin: {
        id,
        createdAt: Date.now(),
        kind,
        ...(params.conversationId
          ? { conversationId: params.conversationId }
          : {}),
        ...(locator ? { locator } : {}),
        target: {
          file: target.file,
          exportName: target.exportName,
          name: typeof target.name === "string" && target.name
            ? target.name
            : target.exportName,
          ...(typeof target.entryId === "string" && target.entryId
            ? { entryId: target.entryId }
            : {}),
          ...(typeof target.instancePath === "string" && target.instancePath
            ? { instancePath: target.instancePath }
            : {}),
        },
        contextSnapshot: params.contextSnapshot ?? {},
        thread: [],
        variants: [],
        resolved: false,
      },
      repoRoot: params.repoRoot,
      appDir,
      busy: false,
    };
    pins.set(pinMapKey(set.repoRoot, set.appDir, id), set);
    void persist(set);
    emit(set, { type: "pin-created", pinId: id, pin: serializePin(set) });
    log(`sandbox pin created: ${id} -> ${target.file}`);
    return { id };
  }

  /** The element-pin artifacts variant prompts embed (the props contract). */
  type ElementPinSources = { originalSource: string; controllerSource: string };

  /** Read an element pin's extracted original + controller (bounded) — the
   * per-variant contract context. Undefined for component pins. */
  async function loadElementSources(
    set: PinSet,
  ): Promise<ElementPinSources | undefined> {
    if (set.pin.kind !== "element") return undefined;
    const read = async (rel: string) =>
      (await readFile(absPath(set, rel), "utf8").catch(() => "")).slice(
        0,
        SOURCE_CONTEXT_BUDGET,
      );
    return {
      originalSource: await read(originalPath(set.appDir, set.pin.id)),
      controllerSource: await read(
        set.pin.controllerFile ?? controllerPath(set.appDir, set.pin.id),
      ),
    };
  }

  /** One variant TURN attempt: run + diagnose. Never throws. L2: the turn is
   * OVERLAY-BOUND to the pin's changeset with the VARIANT's alt id as its
   * staging — component turns edit the REAL module path and land at the
   * mirrored alternative; N parallel turns stage under N distinct alt ids
   * and can never collide. The overlay is returned for post-turn capture. */
  async function attemptVariantTurn(
    set: PinSet,
    variant: SandboxVariant,
    request: string,
    sourceContext?: string,
    elementSources?: ElementPinSources,
  ): Promise<
    | { ok: true }
    | { ok: false; message: string; kind: TurnFailureKind }
  > {
    const home = homeFor(set.repoRoot, set.appDir);
    const csId = changesetIdForPin(set.pin.id);
    const ref = refVariant(csId, variant.id);
    const prompt =
      set.pin.kind === "element" && elementSources
        ? buildElementVariantPrompt({
            pin: set.pin,
            appDir: set.appDir,
            targetPath: variant.file,
            slug: variant.id,
            intent: variant.intent,
            request,
            originalSource: elementSources.originalSource,
            controllerSource: elementSources.controllerSource,
            sourceContext,
          })
        : buildSandboxVariantPrompt({
            pin: set.pin,
            appDir: set.appDir,
            slug: variant.id,
            intent: variant.intent,
            request,
            sourceContext,
          });
    let turn: GitTurnResult;
    try {
      // Clean slate per attempt: (re-)cut the variant branch at the trunk
      // tip, so a failed attempt's partial commits never leak into a retry.
      await gitOps.ensureChangesetRefs(set.repoRoot, csId);
      await gitOps.cutVariantBranch(set.repoRoot, csId, variant.id);
      turn = await runGitTurn({
        home,
        changesetId: csId,
        ref,
        // Fan-out arms run in PARALLEL — each on its own TEMP worktree (the
        // shared changeset worktree serves the serialized turns).
        temp: true,
        conversationId: set.pin.conversationId,
        mode: "variant",
        prompt,
        onActivity: sessionActivity(set, "variant", variant.id),
        ...(set.pin.kind === "element"
          ? { seedDirs: [pinDir(set.appDir, set.pin.id)] }
          : {}),
      });
    } catch (error) {
      // A THROW from the turn seam is infrastructure territory (the SDK never
      // completed a turn) — classify the message like an errorMessage.
      const raw = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `the agent turn failed: ${truncateDiagnostic(raw)}`,
        kind: classifySandboxTurnFailure(raw),
      };
    }
    if (turn.errorMessage) {
      return {
        ok: false,
        message: `the agent turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
        kind: classifySandboxTurnFailure(turn.errorMessage),
      };
    }
    // Landing check: COMPONENT turns must have committed a change to the
    // target module on their branch; ELEMENT span turns must have produced
    // their gallery artifact (copied back from the worktree commits).
    const landed =
      set.pin.kind === "element"
        ? await fileExists(absPath(set, variant.file))
        : (
            await gitOps.changedFiles(set.repoRoot, turn.from, turn.to)
          ).some((change) => change.path === set.pin.target.file);
    if (!landed) {
      const said = truncateDiagnostic(turn.text);
      const missing =
        set.pin.kind === "element" ? variant.file : set.pin.target.file;
      return {
        ok: false,
        // The turn COMPLETED but produced nothing — a model/agent outcome,
        // not an infrastructure hiccup; retrying automatically would just
        // repeat it. Manual Retry stays available.
        kind: "permanent",
        message:
          `the session ended without writing ${missing}` +
          (said ? ` — the agent said: "${said}"` : ""),
      };
    }
    return { ok: true };
  }

  /**
   * One variant generation run (fan-out arm; also the manual-Retry body).
   * TRANSIENT turn failures (stream ended early, 5xx, timeouts, network)
   * auto-retry up to MAX_TRANSIENT_RETRIES with short backoff, emitting a
   * `variant-retrying` event per attempt; PERMANENT failures (auth/quota/4xx)
   * fail immediately with the real diagnostic.
   */
  async function runVariantGeneration(
    set: PinSet,
    variant: SandboxVariant,
    request: string,
    sourceContext?: string,
    elementSources?: ElementPinSources,
  ): Promise<void> {
    const { pin } = set;
    let outcome = await attemptVariantTurn(
      set,
      variant,
      request,
      sourceContext,
      elementSources,
    );
    for (
      let retry = 1;
      !outcome.ok && outcome.kind === "transient" && retry <= MAX_TRANSIENT_RETRIES;
      retry += 1
    ) {
      emit(set, {
        type: "variant-retrying",
        pinId: pin.id,
        variantId: variant.id,
        attempt: retry + 1,
        error: outcome.message,
      });
      log(
        `sandbox variant transient failure (${variant.id}), retrying ` +
          `(attempt ${retry + 1}): ${outcome.message}`,
      );
      await sleep(RETRY_BACKOFF_MS[retry - 1] ?? RETRY_BACKOFF_MS.at(-1) ?? 0);
      outcome = await attemptVariantTurn(
        set,
        variant,
        request,
        sourceContext,
        elementSources,
      );
    }

    if (outcome.ok) {
      variant.status = "ready";
      variant.rev += 1;
      variant.error = undefined;
      // Fresh landing → fresh render-auto-fix budget for this variant.
      variant.renderFixes = 0;
      await persist(set);
      // O1: a landed COMPONENT variant registers/refreshes the pin's
      // changeset (projection + redirect table) before the ready event
      // fires, so "Preview in place" is live the moment the row shows it.
      // ELEMENT pins register AFTER the ready event instead — their
      // override artifact is the full-module re-inline turn below (O3),
      // which must not delay the gallery landing.
      let dataWarnings: string[] = [];
      if (pin.kind !== "element") {
        dataWarnings = (await ensureChangesetForPin(set)).warnings;
      }
      emit(set, {
        type: "variant-ready",
        pinId: pin.id,
        variantId: variant.id,
        intent: variant.intent,
        file: variant.file,
        absPath: absPath(set, variant.file),
        wrapperAbsPath: absPath(set, wrapperPath(set.appDir, pin.id)),
        ...(pin.controllerFile
          ? { controllerAbsPath: absPath(set, pin.controllerFile) }
          : {}),
        x: variant.x,
        y: variant.y,
        rev: variant.rev,
      });
      log(`sandbox variant landed: ${variant.file}`);
      // O3: the full-module override artifact (element pins) — one re-inline
      // turn, then the changeset registers with it.
      if (pin.kind === "element") {
        await ensureElementModuleVariant(set, variant);
      }
      // G2 reapply baseline: everything up to here (fan-out turn + element
      // re-inline) IS the generation — later commits are reapplyable edits.
      await recordGeneratedTip(
        homeFor(set.repoRoot, set.appDir),
        changesetIdForPin(pin.id),
        variant.id,
      );
      // G1: data additions + extra modules the turn committed were derived
      // by the projection above; only the warnings remain to surface.
      await surfaceDataWarnings(
        homeFor(set.repoRoot, set.appDir),
        set,
        changesetIdForPin(pin.id),
        dataWarnings,
      );
      return;
    }

    variant.status = "failed";
    variant.error = outcome.message;
    await persist(set);
    emit(set, {
      type: "variant-failed",
      pinId: pin.id,
      variantId: variant.id,
      file: variant.file,
      error: variant.error,
    });
    log(`sandbox variant failed (${variant.id}): ${variant.error}`);
  }

  /**
   * Director step: N distinct directions ONLY (with fallbacks). The context
   * wrapper is NOT the director's job anymore — it is generated in code from
   * the captured snapshot and written unconditionally AFTER the director turn
   * (so nothing a session wrote can shadow the deterministic wrapper).
   */
  async function planVariants(
    set: PinSet,
    count: number,
    request: string,
    sourceContext?: string,
  ): Promise<Array<{ slug: string; intent: string }>> {
    const { pin } = set;
    emit(set, { type: "director-started", pinId: pin.id });
    let directions: Array<{ slug: string; intent: string }> | undefined;
    try {
      // G1: the director reads the changeset worktree (a SCRATCH turn — no
      // commit capture; strays reset after the turn).
      const turn = await runScratchTurn({
        home: homeFor(set.repoRoot, set.appDir),
        changesetId: changesetIdForPin(pin.id),
        conversationId: set.pin.conversationId,
        mode: "director",
        prompt: buildSandboxDirectorPrompt({
          pin,
          appDir: set.appDir,
          count,
          request,
          sourceContext,
        }),
        onActivity: sessionActivity(set, "director"),
      });
      if (turn.errorMessage) {
        log(
          `sandbox director turn failed (${truncateDiagnostic(turn.errorMessage)}); using fallbacks`,
        );
      } else {
        directions = parseDirectorReply(turn.text, count);
        if (!directions) {
          log("sandbox director reply unparseable; using palette fallback");
        }
      }
    } catch (error) {
      log(`sandbox director call failed (${String(error)}); using fallbacks`);
    }
    // The wrapper is load-bearing for rendering: generate it deterministically
    // from the snapshot, overwriting whatever exists (primary path, not a
    // fallback — byte-identical for the same snapshot).
    const wrapperAbs = absPath(set, wrapperPath(set.appDir, pin.id));
    await mkdir(dirname(wrapperAbs), { recursive: true });
    await writeFile(
      wrapperAbs,
      await generateSandboxWrapper({
        repoRoot: set.repoRoot,
        appDir: set.appDir,
        pinId: pin.id,
        contextSnapshot: pin.contextSnapshot,
      }),
      "utf8",
    );
    log(`sandbox wrapper generated: ${wrapperPath(set.appDir, pin.id)}`);
    return directions ?? FALLBACK_DIRECTIONS.slice(0, count);
  }

  /**
   * ELEMENT-pin director step (E1/E2): the deterministic SandboxProviders
   * wrapper is generated FIRST (same codegen as component pins — never
   * model-authored), then ONE director turn extracts the located span into
   * `original.tsx`, authors `controller.tsx` (real hooks + `// from:`
   * mapping), and replies with the directions JSON. The two artifacts are the
   * variants' contract — if they don't land (or the controller misses the
   * mapping), the run FAILS here rather than fanning out doomed variants.
   */
  async function planElementVariants(
    set: PinSet,
    count: number,
    request: string,
    sourceContext?: string,
  ): Promise<
    | { ok: true; directions: Array<{ slug: string; intent: string }> }
    | { ok: false; message: string }
  > {
    const { pin } = set;
    emit(set, { type: "director-started", pinId: pin.id });
    const wrapperAbs = absPath(set, wrapperPath(set.appDir, pin.id));
    await mkdir(dirname(wrapperAbs), { recursive: true });
    await writeFile(
      wrapperAbs,
      await generateSandboxWrapper({
        repoRoot: set.repoRoot,
        appDir: set.appDir,
        pinId: pin.id,
        contextSnapshot: pin.contextSnapshot,
      }),
      "utf8",
    );
    log(`sandbox wrapper generated: ${wrapperPath(set.appDir, pin.id)}`);

    let turn: { text: string; errorMessage?: string };
    // G1: a SCRATCH turn in the changeset worktree — the element director's
    // ARTIFACTS (original/controller) it writes under `.designbook/` are
    // copied back to the real tree; anything else resets with the worktree.
    try {
      turn = await runScratchTurn({
        home: homeFor(set.repoRoot, set.appDir),
        changesetId: changesetIdForPin(pin.id),
        conversationId: set.pin.conversationId,
        mode: "director",
        prompt: buildElementDirectorPrompt({
          pin,
          appDir: set.appDir,
          count,
          request,
          sourceContext,
        }),
        onActivity: sessionActivity(set, "director"),
        seedDirs: [pinDir(set.appDir, pin.id)],
      });
    } catch (error) {
      return {
        ok: false,
        message: `the extraction turn failed: ${truncateDiagnostic(String(error))}`,
      };
    }
    if (turn.errorMessage) {
      return {
        ok: false,
        message: `the extraction turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
      };
    }

    // Artifact gate: both files present, the original exports the convention
    // name, and the controller carries the Replace contract (`// from:`) and
    // actually renders the variant slot.
    const originalRel = originalPath(set.appDir, pin.id);
    const controllerRel = controllerPath(set.appDir, pin.id);
    const originalSource = await readFile(absPath(set, originalRel), "utf8").catch(
      () => undefined,
    );
    const controllerSource = await readFile(
      absPath(set, controllerRel),
      "utf8",
    ).catch(() => undefined);
    if (!originalSource || !moduleExportsName(originalSource, ELEMENT_EXPORT_NAME)) {
      return {
        ok: false,
        message: `the director did not extract ${originalRel} (exporting ${ELEMENT_EXPORT_NAME}).`,
      };
    }
    if (!controllerSource || !moduleExportsName(controllerSource, CONTROLLER_EXPORT_NAME)) {
      return {
        ok: false,
        message: `the director did not author ${controllerRel} (exporting ${CONTROLLER_EXPORT_NAME}).`,
      };
    }
    // The Replace contract: the controller renders the variant slot, and any
    // prop it passes carries a `// from:` mapping comment. A span with NO
    // free variables legitimately yields an EMPTY props object (live-run
    // finding: the badges-container div has zero free variables) — that's a
    // valid controller with nothing to map.
    const rendersVariant = /<V\b/.test(controllerSource);
    const hasMapping = /\/\/\s*from:/.test(controllerSource);
    const emptyProps =
      /<V\s*\/>/.test(controllerSource) || /=\s*\{\s*\}/.test(controllerSource);
    if (!rendersVariant || (!hasMapping && !emptyProps)) {
      return {
        ok: false,
        message: `the controller ${controllerRel} misses the Replace contract (per-prop \`// from:\` comments rendering <V {...props} />).`,
      };
    }
    pin.controllerFile = controllerRel;
    await persist(set);
    log(`sandbox element artifacts landed: ${originalRel}, ${controllerRel}`);

    const directions = parseDirectorReply(turn.text, count);
    if (!directions) {
      log("sandbox element director reply unparseable; using palette fallback");
    }
    return { ok: true, directions: directions ?? FALLBACK_DIRECTIONS.slice(0, count) };
  }

  /**
   * One agent turn on the pin's session — the edit path AND the U3 normal
   * turn (the prompt framing differs, the plumbing doesn't). G1: the turn
   * runs in a changeset WORKTREE and NEVER writes real source.
   *
   *   - A switch is ACTIVE for the pin's component → the turn runs on the
   *     branch serving that selection (edits-follow-resolution — whichever
   *     changeset owns it); a committed change to the target bumps that
   *     variant's rev.
   *   - ORIGINAL is active / no changeset → the turn commits on the PIN's
   *     changeset TRUNK (spec §Refs: edit-only asks commit on trunk). IFF it
   *     changed anything, the changeset registers lazily (variant record
   *     when the target changed + selection = trunk + one batched hot
   *     update). Answer-only turns leave no visible trace.
   *
   * Manual text-tool/adapter-data edits are untouched (different endpoints).
   * Appends the reply to the thread and reports through turn-start/turn-end.
   * Busy discipline is the CALLER's; never throws.
   */
  /**
   * LAND one changeset-bound edit turn's committed work — shared by the pin
   * ask/edit path (executeChangesetTurn) and the conversation-routed
   * selection path (finishSelectionGitTurn): on the FIRST committed work of
   * a fresh changeset the changeset materializes (wrapper codegen, trunk
   * variant card, selection = trunk, activation, one batched projection);
   * later turns re-project the OWNING changeset and bump the owning
   * variant's rev (edits-follow-resolution). Returns whether a trunk card
   * was newly registered.
   */
  async function landChangesetTurn(
    set: PinSet,
    params: {
      home: HomeState;
      csId: string;
      editId: string;
      fresh: boolean;
      resolution: ReturnType<typeof resolveActiveResolution>;
      framing: "judgment" | "edit" | "variation" | "conversation";
      request: string;
      error: string | undefined;
      turnCommitCount: number;
      turnChanges: readonly { path: string }[];
    },
  ): Promise<{ registered: boolean }> {
    const { pin } = set;
    const { home, csId, editId, fresh, resolution, framing, request, error } =
      params;
    const component = componentKey(pin.target.file, pin.target.exportName);
    const changedTarget = params.turnChanges.some(
      (change) => change.path === pin.target.file,
    );
    const changedAny = params.turnChanges.some(
      (change) => !isDesignbookPath(change.path),
    );
    let registered = false;
    if (fresh && changedAny && !error) {
      // First committed work → the changeset materializes: wrapper
      // (deterministic codegen, only if missing — the canvas cell needs
      // the captured context), variant record for the trunk alternative,
      // selection = trunk (edit turns preview immediately), one batched
      // hot update via projection + sync.
      const wrapperAbs = absPath(set, wrapperPath(set.appDir, pin.id));
      if (!(await fileExists(wrapperAbs))) {
        await mkdir(dirname(wrapperAbs), { recursive: true });
        await writeFile(
          wrapperAbs,
          await generateSandboxWrapper({
            repoRoot: set.repoRoot,
            appDir: set.appDir,
            pinId: pin.id,
            contextSnapshot: pin.contextSnapshot,
          }),
          "utf8",
        );
      }
      let variant = pin.variants.find((candidate) => candidate.id === editId);
      if (!variant && changedTarget) {
        registered = true;
        const position = seedVariantPositions(pin.variants.length, 1)[0];
        variant = {
          id: editId,
          intent:
            framing === "variation"
              ? `variation: ${request.slice(0, 80)}`
              : `edit: ${request.slice(0, 80)}`,
          file: moduleAltPath(set.appDir, pin.id, editId, pin.target.file),
          x: position.x,
          y: position.y,
          status: "ready",
          rev: 1,
          request,
          // The trunk alternative IS a full module (the revised real one)
          // — the override artifact and the gallery file coincide.
          moduleFile: moduleAltPath(
            set.appDir,
            pin.id,
            editId,
            pin.target.file,
          ),
        };
        pin.variants.push(variant);
        await persist(set);
        emit(set, {
          type: "variants-planned",
          pinId: pin.id,
          variants: [
            {
              id: variant.id,
              intent: variant.intent,
              file: variant.file,
              x: variant.x,
              y: variant.y,
            },
          ],
        });
      }
      await gitOps.setSelected(set.repoRoot, csId, refTrunk(csId));
      const projected = await ensureChangesetForPin(set);
      // G2 reapply baseline: the first registered edit turn IS the trunk
      // alternative's generation.
      await recordGeneratedTip(home, csId, editId);
      const changeset = home.changesets.find(
        (candidate) => candidate.id === csId,
      );
      if (changeset) {
        changeset.active = true;
        changeset.order = nextOrder(home);
        await persistChangeset(home, changeset);
        await syncOverrides(home);
        emitSwitchState(home, {
          component,
          ...(changedTarget
            ? { selection: { changesetId: csId, variantId: editId } }
            : {}),
        });
        emitChangesets(home);
      }
      await surfaceDataWarnings(home, set, csId, projected.warnings);
      if (variant && changedTarget) {
        emit(set, {
          type: "variant-ready",
          pinId: pin.id,
          variantId: variant.id,
          intent: variant.intent,
          file: variant.file,
          absPath: absPath(set, variant.file),
          wrapperAbsPath: absPath(set, wrapperPath(set.appDir, pin.id)),
          x: variant.x,
          y: variant.y,
          rev: variant.rev,
        });
        log(`sandbox edit-variant registered: ${variant.file}`);
      }
    } else if (!fresh && params.turnCommitCount > 0 && !error) {
      // Edits-follow-resolution: re-project the OWNING changeset (its
      // alternative file refreshes on disk → hot update), surface data
      // warnings, and bump the owning variant's rev (cache-bust + card
      // remount).
      const changeset = home.changesets.find(
        (candidate) => candidate.id === csId,
      );
      if (changeset) {
        const projected = await projectChangeset(home, changeset);
        await syncOverrides(home);
        emitChangesets(home);
        await surfaceDataWarnings(home, set, csId, projected.warnings);
      }
      if (changedTarget && resolution) {
        const editTarget = resolution.file;
        for (const candidate of pins.values()) {
          if (
            candidate.repoRoot !== set.repoRoot ||
            candidate.appDir !== set.appDir
          ) {
            continue;
          }
          const owned = candidate.pin.variants.find(
            (variant) =>
              variant.file === editTarget ||
              variant.moduleFile === editTarget,
          );
          if (!owned) continue;
          owned.rev += 1;
          await persist(candidate);
          emit(set, {
            type: "variant-updated",
            pinId: candidate.pin.id,
            variantId: owned.id,
            absPath: absPath(candidate, owned.file),
            rev: owned.rev,
          });
          break;
        }
      }
    }
    return { registered };
  }

  async function executeChangesetTurn(
    set: PinSet,
    request: string,
    framing: "judgment" | "edit" | "variation",
  ): Promise<void> {
    const { pin } = set;
    const home = homeFor(set.repoRoot, set.appDir);
    await ensureBranch(home);
    const resolution = resolveActiveResolution(home, pin.target.file);
    const fresh = !resolution;
    const csId = resolution
      ? resolution.changesetId
      : changesetIdForPin(pin.id);
    const editId = resolution ? resolution.variantId : trunkAltId(csId);

    emit(set, { type: "turn-start", pinId: pin.id, mode: "edit" });
    try {
      await gitOps.ensureChangesetRefs(set.repoRoot, csId);
      const ref = refForAlt(csId, editId);
      if (!(await gitOps.resolveCommit(set.repoRoot, ref))) {
        // A selection naming a variant whose branch is gone (legacy layer)
        // cannot host a git turn.
        throw new Error(`the selected design has no git branch (${ref}).`);
      }
      const promptText =
        framing === "judgment"
          ? buildSandboxTurnPrompt({ pin, request })
          : buildSandboxEditPrompt({
              pin,
              request,
              ...(framing === "variation" ? { variation: true } : {}),
            });
      const turn = await runGitTurn({
        home,
        changesetId: csId,
        ref,
        conversationId: set.pin.conversationId,
        mode: "edit",
        prompt: promptText,
        ...(pin.kind === "element"
          ? { seedDirs: [pinDir(set.appDir, pin.id)] }
          : {}),
      });
      const error = turn.errorMessage
        ? `The agent turn failed: ${truncateDiagnostic(turn.errorMessage)}`
        : undefined;
      const turnChanges = await gitOps.changedFiles(
        set.repoRoot,
        turn.from,
        turn.to,
      );
      const { registered } = await landChangesetTurn(set, {
        home,
        csId,
        editId,
        fresh,
        resolution,
        framing,
        request,
        error,
        turnCommitCount: turn.commits.length,
        turnChanges,
      });


      pushThread(set, {
        role: "assistant",
        text: error ?? (turn.text || "Done."),
        at: Date.now(),
      });
      if (registered) {
        pushThread(set, {
          role: "assistant",
          text:
            "Applied as a sandbox change, previewing in place — real source " +
            "is untouched until you bake.",
          at: Date.now(),
        });
      }
      await persist(set);
      emit(set, {
        type: "turn-end",
        pinId: set.pin.id,
        mode: "edit",
        ...(error ? { error } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushThread(set, {
        role: "assistant",
        text: `The edit failed: ${truncateDiagnostic(message)}`,
        at: Date.now(),
      });
      await persist(set);
      emit(set, { type: "turn-end", pinId: set.pin.id, mode: "edit", error: message });
    }
  }

  /**
   * The variants pipeline: director step then N parallel variant turns with
   * progressive landing. Busy discipline is the CALLER's.
   */
  async function executeVariants(
    set: PinSet,
    request: string,
    count: number,
  ): Promise<void> {
    // Fix #3: original source + local imports, threaded to director AND
    // every variant session (capped at ~8KB) — kept for QUALITY under L2
    // (saves every session a read round-trip). Stacking: an ACTIVE
    // resolution's content is embedded but LABELED with the real module
    // path — the same view the session's own reads resolve to, no layer
    // paths in the prompt.
    const home = homeFor(set.repoRoot, set.appDir);
    await ensureBranch(home);
    const resolution = resolveActiveResolution(
      home,
      set.pin.target.file,
    );
    const sourceContext = await buildSandboxSourceContext(
      set.repoRoot,
      resolution?.file ?? set.pin.target.file,
      set.pin.target.file,
    );
    let directions: Array<{ slug: string; intent: string }>;
    if (set.pin.kind === "element") {
      // Element pins: extraction + controller are the variants' contract —
      // a failed director step fails the RUN (no doomed fan-out).
      const planned = await planElementVariants(
        set,
        count,
        request,
        sourceContext,
      );
      if (!planned.ok) {
        pushThread(set, {
          role: "assistant",
          text: `Element extraction failed: ${planned.message}`,
          at: Date.now(),
        });
        await persist(set);
        emit(set, {
          type: "turn-end",
          pinId: set.pin.id,
          mode: "variants",
          error: planned.message,
        });
        emit(set, { type: "run-complete", pinId: set.pin.id });
        log(`sandbox element extraction failed (${set.pin.id}): ${planned.message}`);
        return;
      }
      directions = planned.directions;
    } else {
      directions = await planVariants(set, count, request, sourceContext);
    }
    const elementSources = await loadElementSources(set);
    const taken = new Set(set.pin.variants.map((variant) => variant.id));
    const positions = seedVariantPositions(
      set.pin.variants.length,
      directions.length,
    );
    const created: SandboxVariant[] = directions.map(
      (direction, index) => {
        let id = direction.slug;
        let n = 2;
        while (taken.has(id)) id = `${direction.slug}-${n++}`;
        taken.add(id);
        return {
          id,
          intent: direction.intent,
          // COMPONENT variants are full drop-in modules living at the
          // MIRRORED path inside the pin's layer (the gallery imports the
          // same file by absolute path); ELEMENT span variants stay pin-dir
          // gallery artifacts (their layer artifact is the module
          // re-inline, see ensureElementModuleVariant).
          file:
            set.pin.kind === "element"
              ? variantFilePath(set.appDir, set.pin.id, id)
              : moduleAltPath(set.appDir, set.pin.id, id, set.pin.target.file),
          x: positions[index].x,
          y: positions[index].y,
          status: "generating",
          rev: 0,
          request,
        };
      },
    );
    set.pin.variants.push(...created);
    await persist(set);
    emit(set, {
      type: "variants-planned",
      pinId: set.pin.id,
      variants: created.map((variant) => ({
        id: variant.id,
        intent: variant.intent,
        file: variant.file,
        x: variant.x,
        y: variant.y,
      })),
    });
    await Promise.all(
      created.map((variant) =>
        runVariantGeneration(
          set,
          variant,
          request,
          sourceContext,
          elementSources,
        ),
      ),
    );
    const ready = created.filter((v) => v.status === "ready").length;
    pushThread(set, {
      role: "assistant",
      text: `Generated ${ready} of ${created.length} variants: ${created
        .map((variant) => `${variant.id} (${variant.intent})`)
        .join("; ")}.`,
      at: Date.now(),
    });
    await persist(set);
    emit(set, { type: "run-complete", pinId: set.pin.id });
  }

  /**
   * U2 thread titles: ONE cheap turn after the thread's first assistant
   * response, persisted in the index + broadcast. Failures (turn error,
   * empty/garbage reply) keep the client-side fallback (truncated first
   * prompt) — never surfaced as an error.
   */
  async function ensureTitle(set: PinSet): Promise<void> {
    const { pin } = set;
    if (pin.title) return;
    const request = pin.thread.find((m) => m.role === "user")?.text;
    if (!request || !pin.thread.some((m) => m.role === "assistant")) return;
    try {
      const turn = await runScratchTurn({
        home: homeFor(set.repoRoot, set.appDir),
        changesetId: changesetIdForPin(set.pin.id),
        conversationId: set.pin.conversationId,
        mode: "title",
        prompt: buildSandboxTitlePrompt(request),
      });
      if (turn.errorMessage) return;
      const title = sanitizeTitle(turn.text);
      if (!title || pin.title) return;
      pin.title = title;
      await persist(set);
      emit(set, { type: "pin-title", pinId: pin.id, title });
      log(`sandbox pin titled: ${pin.id} -> ${title}`);
    } catch {
      // Keep the fallback title.
    }
  }

  /** Shared entry validation for prompt()/ask(). Undefined = rejected.
   * `repoRoot`/`appDir` scope the pin to the REQUEST's home (a branch page
   * must never operate another root's copy of a shared pin id). */
  function admitRequest(params: {
    pinId: string;
    prompt: string;
    repoRoot?: string;
    appDir?: string;
  }): { set: PinSet; request: string } | { error: string } {
    const set = resolvePin(params);
    if (!set) return { error: "Unknown pin." };
    if (set.busy) return { error: "This pin already has a run in progress." };
    if (set.pin.resolved) return { error: "This pin is resolved." };
    const request = params.prompt.trim();
    if (!request) return { error: "A prompt is required." };
    return { set, request };
  }

  /**
   * Prompt a pin (the MODE-BUTTON surfaces — kept unchanged): `edit` runs one
   * edit-framed turn against the REAL source; `variants` fans out N parallel
   * variant turns behind the director step. Returns synchronously-known
   * errors; the work reports through `sandbox-event`s.
   */
  function prompt(params: {
    pinId: string;
    prompt: string;
    mode: "edit" | "variants";
    count?: number;
    repoRoot?: string;
    appDir?: string;
  }): { error?: string } {
    const admitted = admitRequest(params);
    if ("error" in admitted) return { error: admitted.error };
    const { set, request } = admitted;

    set.busy = true;
    pushThread(set, { role: "user", text: request, at: Date.now() });

    if (params.mode === "edit") {
      void (async () => {
        try {
          // G4: new work while parked cuts an implicit fork first.
          await forkPinChangesetIfParked(set, request);
          // O3: the mode-button edit is an agent edit — through the
          // changeset, never real source.
          await executeChangesetTurn(set, request, "edit");
        } catch (error) {
          log(`sandbox edit run crashed (${set.pin.id}): ${String(error)}`);
        } finally {
          set.busy = false;
        }
      })();
      return {};
    }

    const count = Math.max(
      1,
      Math.min(MAX_VARIANT_COUNT, params.count ?? DEFAULT_VARIANT_COUNT),
    );
    void (async () => {
      try {
        await forkPinChangesetIfParked(set, request);
        await executeVariants(set, request, count);
      } catch (error) {
        // Belt: per-arm failures are handled inside; anything escaping
        // (e.g. the repo vanished mid-run) must not become an unhandled
        // rejection.
        log(`sandbox variants run crashed (${set.pin.id}): ${String(error)}`);
      } finally {
        set.busy = false;
      }
    })();
    return {};
  }

  /**
   * UX v3 single entry (U3 — no modes): ONE classification step decides only
   * "variants requested? {no | yes, n}" on the pin's session. On "yes" the
   * existing variants pipeline runs unchanged; on "no" (questions, edits,
   * anything ambiguous, or a failed classification) a NORMAL agent turn runs
   * — the agent itself decides whether to answer or edit. The routed intent
   * is broadcast (`intent-routed`) so the thread can show "generating N
   * variants…" vs plain turn activity, and the thread's title is generated
   * after its first assistant response lands (U2).
   */
  function ask(params: {
    pinId: string;
    prompt: string;
    repoRoot?: string;
    appDir?: string;
  }): { error?: string } {
    const admitted = admitRequest(params);
    if ("error" in admitted) return { error: admitted.error };
    const { set, request } = admitted;

    set.busy = true;
    pushThread(set, { role: "user", text: request, at: Date.now() });

    void (async () => {
      try {
        // G4: new work while parked cuts an implicit fork first (the intent
        // classifier is a scratch turn — it must already read the fork).
        await forkPinChangesetIfParked(set, request);
        let routed: SandboxRoutedIntent = { intent: "turn" };
        try {
          const turn = await runScratchTurn({
            home: homeFor(set.repoRoot, set.appDir),
            changesetId: changesetIdForPin(set.pin.id),
            conversationId: set.pin.conversationId,
            mode: "intent",
            prompt: buildSandboxIntentPrompt({ pin: set.pin, request }),
          });
          routed = turn.errorMessage
            ? { intent: "turn" }
            : parseIntentReply(turn.text);
        } catch {
          routed = { intent: "turn" }; // The default can never block a request.
        }
        // O3: a SINGLE-variation ask is changeset work too — one edit-variant
        // turn (variation-framed), never the director fan-out and never a
        // real-source edit. The wire intent degrades to "turn" so the thread
        // shows plain turn activity (the flow emits turn events).
        const singleVariation =
          routed.intent === "variants" && routed.n === 1;
        emit(set, {
          type: "intent-routed",
          pinId: set.pin.id,
          intent:
            routed.intent === "variants" && !singleVariation
              ? "variants"
              : "turn",
          ...(routed.intent === "variants" && !singleVariation
            ? { n: routed.n }
            : {}),
        });
        log(
          `sandbox intent routed (${set.pin.id}): ${routed.intent}` +
            (routed.intent === "variants" ? ` n=${routed.n}` : "") +
            (singleVariation ? " (single variation → changeset edit turn)" : ""),
        );
        if (routed.intent === "variants" && !singleVariation) {
          await executeVariants(set, request, routed.n);
        } else if (singleVariation) {
          await executeChangesetTurn(set, request, "variation");
        } else {
          await executeChangesetTurn(set, request, "judgment");
        }
      } catch (error) {
        log(`sandbox ask run crashed (${set.pin.id}): ${String(error)}`);
      } finally {
        set.busy = false;
      }
      // Title AFTER busy releases — a cheap background turn, never blocking
      // the next prompt.
      void ensureTitle(set);
    })();
    return {};
  }

  /** Iterate on ONE landed variant (inline note → ephemeral session). An
   * `element` descriptor (canvas element selection) scopes the note to one
   * element inside the variant's rendered preview. */
  function iterate(params: {
    pinId: string;
    variantId: string;
    repoRoot?: string;
    appDir?: string;
    prompt: string;
    element?: SandboxIterateElement;
  }): { error?: string } {
    const set = resolvePin(params);
    const variant = set?.pin.variants.find(
      (candidate) => candidate.id === params.variantId,
    );
    if (!set || !variant) return { error: "Unknown variant." };
    if (set.busy) return { error: "This pin already has a run in progress." };
    if (variant.status !== "ready") {
      return { error: "Only a ready variant can be iterated on." };
    }
    const request = params.prompt.trim();
    if (!request) return { error: "A note is required." };
    const element = params.element;
    set.busy = true;
    variant.status = "updating";
    pushThread(set, {
      role: "user",
      text: `[${variant.id}${element ? ` · ${element.label}` : ""}] ${request}`,
      at: Date.now(),
    });
    emit(set, { type: "variant-updating", pinId: set.pin.id, variantId: variant.id });
    void (async () => {
      try {
        // G1: the turn runs ON this variant's branch — the agent reads the
        // real module path in the worktree and sees the variant's current
        // design; its commits land right back on the branch.
        const home = homeFor(set.repoRoot, set.appDir);
        await ensureBranch(home);
        const csId = changesetIdForPin(set.pin.id);
        // G4: iterate targets ONE named branch tip — a park preview on the
        // changeset exits first so the cache tracks the tip it advances.
        {
          const parkedCs = home.changesets.find(
            (candidate) => candidate.id === csId,
          );
          if (parkedCs && (await clearParked(home, parkedCs))) {
            await projectChangeset(home, parkedCs);
            await syncOverrides(home);
            emitChangesets(home);
            emitSwitchState(home);
          }
        }
        await gitOps.ensureChangesetRefs(set.repoRoot, csId);
        const ref = refForAlt(csId, variant.id);
        if (!(await gitOps.resolveCommit(set.repoRoot, ref))) {
          await gitOps.cutVariantBranch(set.repoRoot, csId, variant.id);
        }
        const turn = await runGitTurn({
          home,
          changesetId: csId,
          ref,
          conversationId: set.pin.conversationId,
          mode: "variant",
          prompt: buildSandboxIteratePrompt({
            pin: set.pin,
            variant,
            request,
            ...(element ? { element } : {}),
          }),
          ...(set.pin.kind === "element"
            ? { seedDirs: [pinDir(set.appDir, set.pin.id)] }
            : {}),
        });
        if (turn.errorMessage) {
          throw new Error(
            `the agent turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
          );
        }
        // Re-project: the revised alternative file refreshes on disk (hot
        // update if it is the live selection); data additions re-derive.
        const projected = await ensureChangesetForPin(set);
        await surfaceDataWarnings(home, set, csId, projected.warnings);
        if (!(await fileExists(absPath(set, variant.file)))) {
          throw new Error(
            `the variant file ${variant.file} disappeared during the edit`,
          );
        }
        variant.status = "ready";
        variant.rev += 1;
        variant.error = undefined;
        // The designer revised the code — fresh render-auto-fix budget.
        variant.renderFixes = 0;
        await persist(set);
        emit(set, {
          type: "variant-updated",
          pinId: set.pin.id,
          variantId: variant.id,
          absPath: absPath(set, variant.file),
          rev: variant.rev,
        });
        // O3: an ELEMENT variant's full-module override artifact goes stale
        // when its span variant is revised — regenerate (same path; a failed
        // regen keeps the previous, still-valid artifact) before busy
        // releases.
        if (set.pin.kind === "element" && variant.moduleFile !== variant.file) {
          await ensureElementModuleVariant(set, variant);
        }
      } catch (error) {
        variant.status = "failed";
        variant.error = error instanceof Error ? error.message : String(error);
        await persist(set);
        emit(set, {
          type: "variant-failed",
          pinId: set.pin.id,
          variantId: variant.id,
          file: variant.file,
          error: variant.error,
        });
      } finally {
        set.busy = false;
      }
    })();
    return {};
  }

  /**
   * Manual retry of ONE failed variant (fresh turn, same direction + same
   * designer request) — the variations-retry pattern on the pin's busy
   * discipline. Pre-retry records (no stored request) fall back to the last
   * user prompt in the pin thread.
   */
  function retry(params: {
    repoRoot?: string;
    appDir?: string;
    pinId: string;
    variantId: string;
  }): { error?: string } {
    const set = resolvePin(params);
    const variant = set?.pin.variants.find(
      (candidate) => candidate.id === params.variantId,
    );
    if (!set || !variant) return { error: "Unknown variant." };
    if (set.busy) return { error: "This pin already has a run in progress." };
    if (set.pin.resolved) return { error: "This pin is resolved." };
    if (variant.status !== "failed") {
      return { error: "Only a failed variant can be retried." };
    }
    const request =
      variant.request ??
      [...set.pin.thread].reverse().find((message) => message.role === "user")
        ?.text ??
      "";
    set.busy = true;
    variant.status = "generating";
    variant.error = undefined;
    void persist(set);
    emit(set, {
      type: "variant-retrying",
      pinId: set.pin.id,
      variantId: variant.id,
      attempt: 1,
    });
    void (async () => {
      try {
        // O3 stacking parity with executeVariants: a retry against an active
        // resolution reads the resolved file as its "original" too.
        const home = homeFor(set.repoRoot, set.appDir);
        await ensureBranch(home);
        const resolution = resolveActiveResolution(home, set.pin.target.file);
        const sourceContext = await buildSandboxSourceContext(
          set.repoRoot,
          resolution?.file ?? set.pin.target.file,
          set.pin.target.file,
        );
        // Element pins re-embed the persisted contract (artifacts survive on
        // disk across retries and restarts).
        const elementSources = await loadElementSources(set);
        await runVariantGeneration(
          set,
          variant,
          request,
          sourceContext,
          elementSources,
        );
        emit(set, { type: "run-complete", pinId: set.pin.id });
      } catch (error) {
        log(`sandbox retry run crashed (${set.pin.id}): ${String(error)}`);
      } finally {
        set.busy = false;
      }
    })();
    return {};
  }

  /**
   * The render-verify feedback loop ("ready" must mean RENDERS): the canvas
   * cell reports a caught render error / empty render for a READY variant.
   * The variant is marked failed with the render diagnostics, then AUTO-FIXED
   * once — one fix turn on the variant file, flipping back to ready (rev bump
   * remounts the cell). A second render failure stays failed (manual Retry).
   * Budget: MAX_RENDER_AUTOFIXES per variant per generation, persisted.
   */
  function renderFailure(params: {
    pinId: string;
    repoRoot?: string;
    appDir?: string;
    variantId: string;
    error: string;
  }): { error?: string } {
    const set = resolvePin(params);
    const variant = set?.pin.variants.find(
      (candidate) => candidate.id === params.variantId,
    );
    if (!set || !variant) return { error: "Unknown variant." };
    if (set.pin.resolved) return {};
    // Only a READY variant can "fail to render"; anything else is a stale or
    // duplicate report (the same rev can error in several canvas clients).
    if (variant.status !== "ready") return {};
    const diagnostic = truncateDiagnostic(
      String(params.error || "").trim() || "the variant crashed while rendering",
    );
    const fixesUsed = variant.renderFixes ?? 0;
    variant.status = "failed";
    variant.error = `the variant crashed while rendering: ${diagnostic}`;
    void persist(set);
    emit(set, {
      type: "variant-failed",
      pinId: set.pin.id,
      variantId: variant.id,
      file: variant.file,
      error: variant.error,
    });
    log(`sandbox render failure (${variant.id}): ${diagnostic}`);
    if (fixesUsed >= MAX_RENDER_AUTOFIXES) {
      log(
        `sandbox render auto-fix budget exhausted (${variant.id}) — staying failed`,
      );
      return {};
    }
    variant.renderFixes = fixesUsed + 1;
    variant.status = "generating";
    void persist(set);
    emit(set, {
      type: "variant-retrying",
      pinId: set.pin.id,
      variantId: variant.id,
      attempt: 1,
      error: variant.error,
    });
    void (async () => {
      try {
        // G1: same binding as iterate — the fix turn runs on THIS variant's
        // branch and edits the real module path in the worktree.
        const home = homeFor(set.repoRoot, set.appDir);
        await ensureBranch(home);
        const csId = changesetIdForPin(set.pin.id);
        await gitOps.ensureChangesetRefs(set.repoRoot, csId);
        const ref = refForAlt(csId, variant.id);
        if (!(await gitOps.resolveCommit(set.repoRoot, ref))) {
          await gitOps.cutVariantBranch(set.repoRoot, csId, variant.id);
        }
        const turn = await runGitTurn({
          home,
          changesetId: csId,
          ref,
          conversationId: set.pin.conversationId,
          mode: "variant",
          prompt: buildSandboxRenderFixPrompt({
            pin: set.pin,
            variant,
            renderError: diagnostic,
          }),
          ...(set.pin.kind === "element"
            ? { seedDirs: [pinDir(set.appDir, set.pin.id)] }
            : {}),
        });
        if (turn.errorMessage) {
          throw new Error(
            `the auto-fix turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
          );
        }
        const projected = await ensureChangesetForPin(set);
        await surfaceDataWarnings(home, set, csId, projected.warnings);
        if (!(await fileExists(absPath(set, variant.file)))) {
          throw new Error(
            `the variant file ${variant.file} disappeared during the auto-fix`,
          );
        }
        variant.status = "ready";
        variant.rev += 1;
        variant.error = undefined;
        await persist(set);
        emit(set, {
          type: "variant-updated",
          pinId: set.pin.id,
          variantId: variant.id,
          absPath: absPath(set, variant.file),
          rev: variant.rev,
        });
        log(`sandbox render auto-fix landed: ${variant.file} (rev ${variant.rev})`);
        // O3: keep the element full-module artifact in step with the fix.
        if (set.pin.kind === "element" && variant.moduleFile !== variant.file) {
          await ensureElementModuleVariant(set, variant);
        }
        // G2: the auto-fix repairs the GENERATION — move the reapply baseline.
        await recordGeneratedTip(home, csId, variant.id);
      } catch (error) {
        variant.status = "failed";
        variant.error = `${
          error instanceof Error ? error.message : String(error)
        } (render error: ${diagnostic})`;
        await persist(set);
        emit(set, {
          type: "variant-failed",
          pinId: set.pin.id,
          variantId: variant.id,
          file: variant.file,
          error: variant.error,
        });
        log(`sandbox render auto-fix failed (${variant.id}): ${variant.error}`);
      }
    })();
    return {};
  }

  /**
   * Replace the ORIGINAL source with a variant's design (the pre-layer wire
   * surface, kept for the canvas Replace button): under layers this is
   * BAKE-with-this-variant — select the variant's alternative, then run the
   * deterministic bake (copy / 3-way merge; merge-agent turn only on
   * conflict; tsc gate). `force` semantics: the user explicitly chose this
   * design, so drift routes into the 3-way merge rather than a 409. Success
   * marks the pin resolved (kept as history, D3) and dissolves the layer;
   * failure surfaces in the pin thread and leaves the layer active.
   */
  function replace(params: {
    repoRoot?: string;
    appDir?: string;
    pinId: string;
    variantId: string;
  }): { error?: string } {
    const set = resolvePin(params);
    const variant = set?.pin.variants.find(
      (candidate) => candidate.id === params.variantId,
    );
    if (!set || !variant) return { error: "Unknown variant." };
    if (set.busy) return { error: "This pin already has a run in progress." };
    if (set.pin.resolved) return { error: "This pin is already resolved." };
    if (variant.status !== "ready") {
      return { error: "Only a ready variant can replace the original." };
    }
    const targetAbs = containedPath(set.repoRoot, set.pin.target.file);
    if (
      !targetAbs ||
      isSandboxPath(set.pin.target.file, set.appDir) ||
      isChangesetPath(set.pin.target.file, set.appDir)
    ) {
      return { error: "The original source path is invalid." };
    }
    // Busy from the moment the endpoint returns; admitBake re-takes it for
    // the queue's duration (released just before admission below).
    set.busy = true;
    emit(set, { type: "replace-started", pinId: set.pin.id, variantId: variant.id });
    void (async () => {
      const fail = async (message: string) => {
        set.busy = false;
        pushThread(set, {
          role: "assistant",
          text: `Replace failed: ${message}`,
          at: Date.now(),
        });
        await persist(set);
        emit(set, {
          type: "replace-failed",
          pinId: set.pin.id,
          variantId: variant.id,
          error: message,
        });
        log(`sandbox replace failed (${set.pin.id}/${variant.id}): ${message}`);
      };
      try {
        const home = homeFor(set.repoRoot, set.appDir);
        await ensureBranch(home);
        // The variant must be registered as a layer alternative (component
        // pins: always once ready; element pins: after the module re-inline
        // turn landed).
        await ensureChangesetForPin(set);
        const changeset = visibleLayers(home.changesets, home.branch).find(
          (candidate) => candidate.pinId === set.pin.id,
        );
        const override = changeset?.overrides[set.pin.target.file];
        if (
          !changeset ||
          !override ||
          !override.alternatives.includes(variant.id)
        ) {
          await fail(
            "This variant has no layer alternative to apply yet (element pins need the module artifact first).",
          );
          return;
        }
        override.selection = variant.id;
        if (!changeset.active) {
          changeset.active = true;
          changeset.order = nextOrder(home);
        }
        await persistChangeset(home, changeset);
        set.busy = false; // admitBake refuses a busy pin; it re-takes below.
        const admitted = await admitBake({
          home,
          changeset,
          force: true,
          legacyReplace: { variantId: variant.id },
        });
        if (admitted.error) {
          await fail(admitted.error);
          return;
        }
        // Success/failure now streams from the bake queue (`bake-status` +
        // the legacy replaced/replace-failed events).
        log(`sandbox replace queued as bake: ${variant.file} -> ${set.pin.target.file}`);
      } catch (error) {
        await fail(error instanceof Error ? error.message : String(error));
      }
    })();
    return {};
  }

  /**
   * Persist a canvas drag AND/OR a frame resize (D4). No broadcast — the
   * dragging/resizing client owns the truth until its next reload. `w`/`h`:
   * a positive number sets an explicit frame size (auto-size overridden);
   * `null` clears it (double-click handle = reset to auto); `undefined`
   * leaves the current size untouched (a plain move).
   */
  function position(params: {
    pinId: string;
    variantId: string;
    repoRoot?: string;
    appDir?: string;
    x: number;
    y: number;
    w?: number | null;
    h?: number | null;
  }): { error?: string } {
    const set = resolvePin(params);
    const variant = set?.pin.variants.find(
      (candidate) => candidate.id === params.variantId,
    );
    if (!set || !variant) return { error: "Unknown variant." };
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
      return { error: "x and y must be finite numbers." };
    }
    variant.x = Math.round(params.x);
    variant.y = Math.round(params.y);
    if (params.w !== undefined) {
      variant.w = applyFrameDimension(params.w);
    }
    if (params.h !== undefined) {
      variant.h = applyFrameDimension(params.h);
    }
    void persist(set);
    return {};
  }

  /**
   * NON-BLOCKING post-replace crash report (E4): the injected client reports
   * any window error within ~REPLACE_CRASH_WINDOW_MS after a replace landed.
   * Appended to the pin thread as a WARNING marker — resolve is never
   * blocked/undone (HMR + the Changes-tab revert cover recovery).
   */
  function replaceCrash(params: {
    repoRoot?: string;
    appDir?: string;
    pinId: string;
    error: string;
  }): { error?: string } {
    const set = resolvePin(params);
    if (!set) return { error: "Unknown pin." };
    if (!set.pin.resolved) {
      // A crash report only means something after a replace landed.
      return { error: "This pin has no landed replace." };
    }
    const diagnostic = truncateDiagnostic(
      String(params.error || "").trim() || "the app reported a runtime error",
    );
    const text = `Warning: the app reported a runtime error shortly after the replace: ${diagnostic}`;
    // Duplicate reports (several clients hear the same SSE) collapse.
    if (set.pin.thread.at(-1)?.text === text) return {};
    pushThread(set, { role: "assistant", text, at: Date.now() });
    void persist(set);
    emit(set, { type: "replace-crash", pinId: set.pin.id, error: diagnostic });
    log(`sandbox post-replace crash reported (${set.pin.id}): ${diagnostic}`);
    return {};
  }

  /** All pins + changesets/switches for a home (revives the index first).
   * Doubles as the LAZY drift trigger (O2): every status read re-hashes the
   * real modules under active overrides. */
  async function status(
    repoRoot: string,
    rawAppDir: string,
    options: {
      /** Sidecar turn records — conversation grouping unions the changesets
       * a conversation LANDED turns on (reused pins keep their original
       * conversation on the meta; see historyGraph's turnMembers note). */
      turns?: readonly { conversationId?: string; changesetId: string }[];
    } = {},
  ): Promise<{
    pins: Array<ReturnType<typeof serializePin>>;
    changesets: Array<ReturnType<typeof publicChangeset>>;
    conversations: Array<{
      id: string;
      changesetIds: string[];
      pinIds: string[];
    }>;
    switches: SandboxSwitches;
    conflicts: LayerConflict[];
    dataConflicts: DataKeyConflict[];
    /** G2: the live reapply offer (a selection switch full-reloads the app,
     * so the SSE event alone would race the page). */
    reapply?: {
      changesetId: string;
      pinId: string;
      fromRef: string;
      fromAlt: string;
      toRef: string;
      toAlt: string;
      count: number;
    };
  }> {
    const appDir = normalizeAppDir(rawAppDir) ?? "";
    await revive(repoRoot, appDir);
    const home = homeFor(repoRoot, appDir);
    await ensureBranch(home);
    await refreshDriftForHome(home);
    const homePins = [...pins.values()]
      .filter((set) => set.repoRoot === repoRoot && set.appDir === appDir)
      .sort((a, b) => a.pin.createdAt - b.pin.createdAt);
    const visible = visibleLayers(home.changesets, home.branch);
    // L3 grouping summary: every conversation seen on a pin or changeset,
    // with its members (the drawer's conversation → changesets/pins nest).
    const conversations = new Map<
      string,
      { id: string; changesetIds: string[]; pinIds: string[] }
    >();
    const conversationFor = (id: string) => {
      let entry = conversations.get(id);
      if (!entry) {
        entry = { id, changesetIds: [], pinIds: [] };
        conversations.set(id, entry);
      }
      return entry;
    };
    for (const set of homePins) {
      if (set.pin.conversationId) {
        conversationFor(set.pin.conversationId).pinIds.push(set.pin.id);
      }
    }
    const visibleIds = new Set(visible.map((changeset) => changeset.id));
    for (const record of options.turns ?? []) {
      if (!record.conversationId || !visibleIds.has(record.changesetId)) {
        continue;
      }
      const entry = conversationFor(record.conversationId);
      if (!entry.changesetIds.includes(record.changesetId)) {
        entry.changesetIds.push(record.changesetId);
      }
    }
    for (const changeset of visible) {
      if (changeset.conversationId) {
        const entry = conversationFor(changeset.conversationId);
        if (!entry.changesetIds.includes(changeset.id)) {
          entry.changesetIds.push(changeset.id);
        }
      }
      // G4: fork conversations are members of the changeset they were cut
      // onto (the sliced chat's drawer group shows the shared layer).
      for (const fork of Object.values(changeset.forks ?? {})) {
        if (!fork.conversationId) continue;
        const entry = conversationFor(fork.conversationId);
        if (!entry.changesetIds.includes(changeset.id)) {
          entry.changesetIds.push(changeset.id);
        }
      }
    }
    return {
      pins: homePins.map((set) => serializePin(set)),
      // Foreign-branch layers are hidden from every listing (spec §Storage).
      changesets: visible.map((changeset) => publicChangeset(home, changeset)),
      conversations: [...conversations.values()],
      switches: synthSwitches(home),
      conflicts: fileConflicts(home),
      dataConflicts: home.dataConflicts,
      ...(pendingReapply.has(homeKey(repoRoot, appDir))
        ? { reapply: pendingReapply.get(homeKey(repoRoot, appDir))! }
        : {}),
    };
  }

  return {
    activate,
    ask,
    /** Warm one home from disk (pins + layer metas) — the pin-request
     * handlers call it so a restarted server resolves pins without waiting
     * for a status GET. */
    reviveHome: (repoRoot: string, rawAppDir: string) =>
      revive(repoRoot, normalizeAppDir(rawAppDir) ?? ""),
    abandonSelectionGitTurn,
    bake,
    bakeToBranch,
    beginConversationGitTurn,
    beginSelectionGitTurn,
    bindForkConversation,
    buildSelectionTurnMessage,
    classifySelectionIntent,
    compose,
    conversationChangesetId,
    createPin,
    discard,
    ensureChangesetWorkspace,
    ensureConversationWorkspace,
    finishConversationGitTurn,
    finishSelectionGitTurn,
    forkFromPark,
    historyGraph,
    refreshPinCapture,
    renameRef,
    runConversationVariants,
    selectionChangesetId,
    prompt,
    iterate,
    listChangesets,
    park,
    parkState,
    rebase,
    retry,
    renderFailure,
    replace,
    replaceCrash,
    position,
    reapply,
    redirects,
    rollback,
    settle,
    turnDiff,
    stageDirectCodeEdit,
    stageDirectDataEdit,
    status,
    switchSelect,
    switches,
  };
}

export {
  CONTROLLER_EXPORT_NAME,
  DEFAULT_VARIANT_COUNT,
  ELEMENT_EXPORT_NAME,
  LOCATOR_OUTER_HTML_CAP,
  MAX_RENDER_AUTOFIXES,
  MAX_TRANSIENT_RETRIES,
  MAX_VARIANT_COUNT,
  REPLACE_CRASH_WINDOW_MS,
  SANDBOX_DIR,
  SOURCE_CONTEXT_BUDGET,
  applyFrameDimension,
  buildBakeMergePrompt,
  buildComposePrompt,
  buildReapplyConflictPrompt,
  buildRebaseConflictPrompt,
  buildElementDirectorPrompt,
  buildElementModuleVariantPrompt,
  buildElementVariantPrompt,
  buildSandboxSourceContext,
  changesetIdForPin,
  classifySandboxTurnFailure,
  buildSandboxDirectorPrompt,
  buildSandboxEditPrompt,
  buildSandboxIntentPrompt,
  buildSandboxIteratePrompt,
  buildSandboxTitlePrompt,
  buildSandboxTurnPrompt,
  buildSandboxRenderFixPrompt,
  buildSandboxVariantPrompt,
  componentKey,
  controllerPath,
  createSandboxOrchestrator,
  createTurnActivityRelay,
  generateSandboxWrapper,
  isSandboxPath,
  isValidIdSegment,
  legacySandboxIndexFile,
  makePinId,
  moduleAltPath,
  originalPath,
  parseIntentReply,
  parseSandboxIndex,
  pinDir,
  resolveOwnerSource,
  sanitizeTitle,
  renderContextForPrompt,
  sanitizeElementLocator,
  sanitizeIterateElement,
  sandboxDir,
  sandboxIndexFile,
  seedVariantPositions,
  serializeSandboxIndex,
  variantExportName,
  variantFilePath,
  wrapperPath,
};
export type {
  SandboxChangeset,
  SandboxElementLocator,
  SandboxIndex,
  SandboxIterateElement,
  SandboxPin,
  SandboxPinKind,
  SandboxRoutedIntent,
  SandboxRunTurn,
  SandboxSwitchSelection,
  SandboxSwitches,
  SandboxTarget,
  SandboxThreadMessage,
  SandboxTurnActivity,
  SandboxTypecheck,
  SandboxVariant,
  SandboxVariantStatus,
};
