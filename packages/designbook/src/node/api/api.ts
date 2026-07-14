/**
 * The `/api/*` routes: an embedded Pi coding-agent session (chat over SSE),
 * git-worktree branch instances, and locale JSON write-back for the canvas
 * text tool. Ported from the design MVP's standalone server.
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ensureInstance,
  getCurrentBranch,
  instanceNavigationUrl,
  listWorktrees,
  listWorktreesForProxy,
  stopAllInstances,
} from "../lib/worktrees.ts";
import {
  jsonKeyExists,
  replaceJsonStringValue,
  replaceJsonValue,
  setJsonValue,
} from "./jsonEdit.ts";
import { replacePoMsgstr } from "./poEdit.ts";
import { replaceCssVar } from "./cssVarEdit.ts";
import { createPropsSchema } from "./propsSchema.ts";
import { editJsxAttribute, type JsxAttrValue } from "./jsxAttrEdit.ts";
import { discardChange, fileDiff, listChanges } from "./gitChanges.ts";
import { rebaseConfigDir, resolveActiveRepoRoot } from "./activeRepoRoot.ts";
import { READ_ONLY_BLOCKED_ROUTES } from "./readOnlyRoutes.ts";
import {
  resolveContainedPath,
  resolveSourceFile as resolveSourceFileIn,
} from "./sourcePaths.ts";
import { createRecentWrites, toRepoRel } from "../sidecar/hmrSuppress.ts";
import {
  createSessionRegistry,
  PRIMARY_SESSION_KEY,
  resolveActiveSessionKey,
  resolveSandboxWireBranch,
} from "./sessionRegistry.ts";
import {
  createConversationGate,
  ROOT_WORKSPACE,
} from "./conversationGate.ts";
import { parseTurnSummary, SUMMARY_PROMPT_INSTRUCTION } from "./turnSummary.ts";
import { forkSliceLeaf } from "./sessionFork.ts";
import { createDeviceBridge } from "../bridge/deviceBridge.ts";
import {
  createDesignbookResourceLoader,
  designbookCoreSkillsDir,
} from "./piSkills.ts";
import {
  createVariationsOrchestrator,
  extractAssistantText,
  extractTurnErrorMessage,
} from "./variations.ts";
import {
  createSandboxOrchestrator,
  createTurnActivityRelay,
  resolveOwnerSource,
  sanitizeIterateElement,
  type SandboxTarget,
  type SandboxTurnActivity,
} from "./sandbox.ts";
import {
  EPHEMERAL_SESSION_SUBDIR,
  listChatThreads,
  readChatTranscript,
} from "./sandboxThreads.ts";
import {
  makeConversationId,
  readConversationStore,
  recordConversationFork,
  recordConversationTag,
  recordTurnRange,
} from "./conversations.ts";
import type { TurnGitCapture } from "../overrides/gitChangesets.ts";
import { readJsonBody, sendJson } from "../integration/http.ts";
import {
  createIntegrationRegistry,
  type NodeIntegration,
} from "../integration/registry.ts";
import { parseDisabledIntegrations } from "../integration/configToggles.ts";
import { builtinNodeIntegrations } from "../integrations/builtins.ts";

const execFileAsync = promisify(execFile);

/** The SDK's read-class built-in tool names (see createReadOnlyTools in the pinned SDK). */
const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"];

/** Ephemeral variation sessions: read + write/edit, NO bash — generation is
 * confined to writing the one assigned file (design-variations spec, D1). */
const VARIANT_TOOL_NAMES = [...READ_ONLY_TOOL_NAMES, "write", "edit"];

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const packageVersion = (
  JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  ) as { version?: string }
).version ?? "0.0.0";

type ApiOptions = {
  configPath: string;
  projectRoot: string;
  port: number;
  /** Verbose logging: every API request and Pi agent event. */
  debug?: boolean;
  /**
   * Restrict the Pi agent to read-only built-in tools (read/grep/find/ls — no
   * bash/edit/write) and 403 the file-write data endpoints
   * (/api/file POST, /api/json, /api/style, /api/i18n, /api/po).
   */
  readOnly?: boolean;
  /**
   * Trust the project's `.pi/` directory (extensions/*.ts, settings.json,
   * SYSTEM.md/APPEND_SYSTEM.md), matching Pi's own CLI trust gate. Default
   * false: a repo you just opened/cloned should not auto-execute arbitrary
   * TypeScript from `.pi/extensions`. Opt in with `--trust-project` for repos
   * you actually trust.
   */
  trustProject?: boolean;
  /**
   * Called with the absolute path of a file designbook is about to write via a
   * data endpoint (e.g. a flag edit), so the dev server can skip the HMR reload
   * for adapter-managed writes the UI already reflects optimistically.
   */
  onDataWrite?: (absPath: string) => void;
  /**
   * Proxy-topology branch switching (the sidecar provides this; host mode
   * leaves it unset). When present, `POST /api/worktrees` retargets the
   * proxied dev server to the branch's worktree instead of spawning a
   * designbook instance, and the response's `url` keeps the browser on the
   * stable proxy origin (C3.2: "the user's URL never changes").
   */
  worktreeProxy?: WorktreeProxy;
  /**
   * ModuleOverrideHost push seam (sandbox overrides O1): called with the full
   * redirect table whenever it changes. Host mode wires this into its vite
   * override host in-process; the injected topology polls
   * GET /api/sandbox/redirects instead and leaves it unset.
   */
  onSandboxOverridesChanged?: (
    redirects: Record<string, string>,
    stamps: Record<string, number>,
  ) => void;
};

type WorktreeProxy = {
  /** Branch whose worktree the proxy currently serves (undefined = primary). */
  activeBranch: () => string | undefined;
  /**
   * Absolute worktree root of the active branch (undefined = primary
   * checkout). The per-branch agent session's cwd (per-branch-sessions spec).
   */
  activeWorktreeRoot?: () => string | undefined;
  /** Prepare the branch's worktree and retarget the proxied dev server to it. */
  switchTo: (
    branch: string,
    notify: (message: string) => void,
  ) => Promise<void>;
  /** Stop the branch's warm dev server (worktree removed — reconcile). */
  stopBranch?: (branch: string) => void;
};

/**
 * The navigation target `POST /api/worktrees` returns in proxy topology: the
 * deep-link bootstrap on the SAME origin — it re-expands the workbench after
 * the reload while the proxy (recovery page included, while the new dev
 * server boots) keeps serving the stable URL.
 */
const PROXY_SWITCH_URL = "/__designbook";

function createApi(options: ApiOptions) {
  const {
    configPath,
    projectRoot,
    port,
    debug = false,
    readOnly = false,
    trustProject = false,
    onDataWrite,
    worktreeProxy,
  } = options;
  const configDir = dirname(configPath);
  const configRelPath = relative(projectRoot, configPath);

  const clients = new Set<ServerResponse>();

  /**
   * The ONE repo root this request's file operation resolves against: the
   * active branch's worktree in proxy topology after a switch, the primary
   * checkout otherwise (host mode / pre-switch — byte-identical to before).
   * Every per-request file handler calls this ONCE and threads the result
   * through containment + read/write + recent-writes bookkeeping; mixing
   * roots within a request is a path-traversal hazard (enforced by the
   * source scan in activeRepoRoot.test.ts).
   */
  function activeRepoRoot(): string {
    return resolveActiveRepoRoot({
      activeWorktreeRoot: worktreeProxy?.activeWorktreeRoot?.(),
      projectRoot,
    });
  }

  /** The config file's directory inside the request's resolved root (see rebaseConfigDir). */
  function activeConfigDirFor(repoRoot: string): string {
    return rebaseConfigDir({ configDir, projectRoot, repoRoot });
  }

  /**
   * The variations home's owner for a request: the config dir, repo-root-
   * relative posix ("" = config at repo root). MONOREPO RULE (design-
   * variations spec §A): the APP owns `.designbook/variations` — in a
   * monorepo it lives under the config dir, never at the git root.
   */
  function activeAppDir(repoRoot: string): string {
    return relative(repoRoot, activeConfigDirFor(repoRoot))
      .replaceAll("\\", "/");
  }

  // Short-lived record of repo-relative paths designbook just wrote through a
  // data endpoint. Consumed two ways: host mode passes
  // `onDataWrite` and suppresses the matching hot-update in-process; injected
  // mode runs in a SEPARATE process (the target app's Vite) and polls this
  // record via `GET /api/recent-writes`. Both drop the adapter-managed reload
  // the UI already reflects optimistically.
  //
  // `repoRoot` is the caller's resolved active root: the repo-rel key must be
  // computed against the SAME root the write landed under, so whichever dev
  // server is active (primary's or the branch worktree's — both poll
  // `/api/recent-writes`) sees the plain repo-rel path it expects, never a
  // `../<worktree>/…` mongrel.
  const recentWrites = createRecentWrites();
  function noteDataWrite(absPath: string, repoRoot: string) {
    recentWrites.record(toRepoRel(repoRoot, absPath));
    onDataWrite?.(absPath);
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  function log(message: string) {
    console.log(`[designbook] ${new Date().toISOString()} ${message}`);
  }

  function logDebug(message: string) {
    if (debug) log(message);
  }

  /** Errors always reach the terminal; full event stream only with --debug. */
  function logPiEvent(event: unknown) {
    const piEvent = event as {
      type?: string;
      message?: { role?: string; stopReason?: string; errorMessage?: string };
      willRetry?: boolean;
    };

    if (
      piEvent.type === "message_end" &&
      piEvent.message?.stopReason === "error"
    ) {
      log(
        `pi turn failed: ${piEvent.message.errorMessage ?? "unknown error"}`,
      );
      return;
    }

    logDebug(`pi event: ${piEvent.type ?? "unknown"}`);
  }

  function sendSse(
    response: ServerResponse,
    eventName: string,
    payload: unknown,
  ) {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcast(eventName: string, payload: unknown) {
    for (const client of clients) {
      sendSse(client, eventName, payload);
    }
  }

  // --- Integration registration (B1: static builtins, no discovery) -------
  //
  // Built-in integrations (figma) register their node halves through the
  // public PluginNodeSpec seam (see src/plugins/figma/node). Opt-out (D1): a
  // literal `integrations: { <name>: false }` in the config source disables
  // one node-side (routes, bridge, tools, skills, events).
  const disabledIntegrations = (() => {
    try {
      return parseDisabledIntegrations(readFileSync(configPath, "utf8"));
    } catch {
      return new Set<string>();
    }
  })();
  const nodeIntegrations: NodeIntegration[] = builtinNodeIntegrations().filter(
    (integration) => !disabledIntegrations.has(integration.name),
  );
  const integrationRegistry = createIntegrationRegistry({
    integrations: nodeIntegrations,
    createBridge: createDeviceBridge,
    log,
  });
  integrationRegistry.initEvents(broadcast);

  // --- Per-branch session registry (per-branch-sessions spec) --------------
  //
  // One in-process Pi session per branch, keyed by branch name (primary
  // checkout → PRIMARY_SESSION_KEY): cwd = the branch's worktree root, lazily
  // created on first use, KEPT ALIVE across branch switches, disposed when
  // the worktree disappears (reconcile in handleListWorktrees) or on
  // shutdown. Host mode has no worktreeProxy, so everything resolves to the
  // primary session — unchanged single-session behavior.
  const sessions = createSessionRegistry<AgentSession>({
    primaryCwd: projectRoot,
    resolveCwd: (key) =>
      worktreeProxy?.activeBranch() === key
        ? worktreeProxy.activeWorktreeRoot?.()
        : undefined,
    log,
    create: createSessionFor,
  });

  /** The session key API handlers operate on (see resolveActiveSessionKey). */
  function activeSessionKey(): string {
    return resolveActiveSessionKey({
      activeBranch: worktreeProxy?.activeBranch(),
      activeWorktreeRoot: worktreeProxy?.activeWorktreeRoot?.(),
      projectRoot,
    });
  }

  /** The wire encoding of a session key: absent = primary (compat). */
  function wireBranch(key: string): string | undefined {
    return key === PRIMARY_SESSION_KEY ? undefined : key;
  }

  async function getSession() {
    return sessions.get(activeSessionKey());
  }

  // --- Conversations (changeset layers L3, §Sessions & conversations) ------
  //
  // Each per-branch live session IS one conversation: its conversationId is
  // minted at session creation and persisted next to the transcripts
  // (conversations.ts), so "New conversation" (resetSession) retires the old
  // one into a history row that keeps its linkage. The ACTIVE conversation —
  // the one manual edits route into and whose turns get the overlay + bash
  // capture — is DRAWER state, reported by the client via
  // POST /api/sandbox/active-conversation (see the spec's active-conversation
  // definition).

  /** Session key → the live session's conversation id. */
  const conversationIds = new Map<string, string>();
  /** Session key → the DRAWER-active conversation id (absent = none).
   * Gates manual data-edit routing AND (G2, the restored L3 gate) whether
   * the session runs in its changeset worktree at all — see
   * conversationGate.ts. */
  const activeConversations = new Map<string, string>();
  /** Session key → the WORKSPACE identity its LIVE session was built in:
   * ROOT_WORKSPACE or `cs:<changesetId>` (the gate compares identities —
   * consecutive turns on the same changeset never rebuild). */
  const sessionWorkspaces = new Map<string, string>();
  /** Session key → the workspace the NEXT turn should run in (per-turn
   * resolution: the selected pin's changeset for a selection-scoped prompt,
   * the conversation's direct-edits changeset otherwise). Resolved async in
   * the prompt/handshake handlers BEFORE the gate reconciles. */
  const turnWorkspaces = new Map<string, string>();
  /** Session key → the selection ask the NEXT turn window binds to
   * (consumed by beginConversationTurn). */
  const pendingSelectionAsks = new Map<
    string,
    { pinId: string; request: string }
  >();
  /** Session key → identity to RESUME on a gate rebuild (same transcript +
   * conversation id, the other cwd). Consumed by the factory. */
  const resumeSessions = new Map<
    string,
    { conversationId: string; sessionFile?: string }
  >();
  /** Session key → the live session's per-turn commit capture binding (the
   * session-wide subscriber feeds tool_execution_end into it; absent
   * between turns). */
  const conversationCaptures = new Map<
    string,
    { capture?: Pick<TurnGitCapture, "noteToolEnd"> }
  >();
  /** Session key → count of prompt turns (the Designbook-Turn index). */
  const sessionTurnCounts = new Map<string, number>();
  /** Session key → in-flight conversation-turn bookkeeping (re-entrant:
   * queued/steered prompts share the outermost window). */
  const conversationTurns = new Map<
    string,
    {
      depth: number;
      conversationId?: string;
      handle?: Awaited<
        ReturnType<(typeof sandbox)["beginConversationGitTurn"]>
      >;
      /** Selection-scoped turn (conversation-routed asks): the pin the
       * turn's workspace/commits bind to, with the SELECTION handle. */
      selection?: {
        pinId: string;
        request: string;
        handle?: Extract<
          Awaited<ReturnType<(typeof sandbox)["beginSelectionGitTurn"]>>,
          { handle: unknown }
        >["handle"];
      };
      repoRoot: string;
      appDir: string;
      turnIndex: number;
      /** First line of the driving user prompt (turn-label fallback). */
      prompt?: string;
    }
  >();

  /** The live session's conversation id for a key (undefined = no session
   * yet — callers treat that as "no conversation"). */
  function conversationIdFor(key: string): string | undefined {
    return conversationIds.get(key);
  }

  /** The workspace the key's NEXT turn should run in (gate identity):
   * root while no conversation is active; otherwise the per-turn resolved
   * changeset workspace (selection → pin changeset, plain → direct-edits),
   * falling back to the session's current changeset workspace so an
   * unresolved gap never flaps a rebuild. */
  function desiredWorkspaceFor(key: string): string {
    if (readOnly || !activeConversations.has(key)) return ROOT_WORKSPACE;
    const turn = turnWorkspaces.get(key);
    if (turn) return turn;
    const current = sessionWorkspaces.get(key);
    return current && current !== ROOT_WORKSPACE ? current : ROOT_WORKSPACE;
  }

  // G2 + conversation-routed asks — the conversation gate: a changeset
  // WORKTREE cwd only while a conversation is ACTIVE, resolved PER TURN
  // (selection-scoped prompts bind the session to the selected pin's
  // changeset worktree; plain prompts to the direct-edits one); repo root
  // (REAL writes, no capture) otherwise. A workspace change rebuilds the
  // session in the new cwd, resuming its transcript; same-workspace turns
  // never rebuild; mid-turn flips defer to the turn's end.
  const conversationGate = createConversationGate({
    readOnly,
    desiredWorkspace: desiredWorkspaceFor,
    workspaceOf: (key) =>
      sessions.peek(key) ? sessionWorkspaces.get(key) : undefined,
    isBusy: (key) =>
      conversationTurns.has(key) || sessions.peek(key)?.status === "working",
    rebuild: async (key) => {
      const entry = sessions.peek(key);
      if (!entry) return;
      let previous: AgentSession | undefined;
      try {
        previous = await entry.promise;
      } catch {
        return; // The session never started — nothing to rebuild.
      }
      const conversationId = conversationIdFor(key);
      if (!conversationId) return;
      resumeSessions.set(key, {
        conversationId,
        ...(previous.sessionFile ? { sessionFile: previous.sessionFile } : {}),
      });
      const previousModel = previous.model;
      await sessions.dispose(key);
      const session = await sessions.get(key);
      // Carry the selected model across the rebuild (resetSession parity).
      if (previousModel && session.model?.id !== previousModel.id) {
        await session.setModel(previousModel).catch(() => {});
      }
      broadcast("state", serializeSession(session, key));
    },
    log,
  });

  /** The session store dir of a cwd (where the conversation map lives). */
  function sessionStoreDir(cwd: string): string {
    return SessionManager.create(cwd).getSessionDir();
  }

  function broadcastBranchStatus() {
    broadcast("branch-status", { statuses: sessions.statuses() });
  }

  /** Fold agent start/end into the per-branch status the switcher badges show. */
  function trackAgentStatus(key: string, event: unknown) {
    const type = (event as { type?: string }).type;
    if (type !== "agent_start" && type !== "agent_end") return;
    sessions.setStatus(key, type === "agent_start" ? "working" : "done");
    broadcastBranchStatus();
  }

  /** git dirty-tree warning (backlog #7): non-fatal, best-effort, once per session. */
  async function checkDirtyWorkingTree(cwd: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--porcelain"],
        { cwd },
      );
      if (stdout.trim()) {
        broadcast("server-notice", {
          message:
            "The working tree has uncommitted changes — Pi's edits will mix with them. Consider committing or stashing first.",
        });
      }
    } catch {
      // Not a git repo (or git unavailable) — degrade silently, same as
      // handleListWorktrees.
    }
  }

  /**
   * Project-trust notice (backlog #4, launch-minimal): projects are untrusted
   * by default (see `trustProject` on ApiOptions), so a repo's `.pi/`
   * extensions/settings/SYSTEM.md silently don't load. Surface that once per
   * session so it doesn't read as "designbook is broken." Degrades silently
   * if the repo has no `.pi/` at all.
   */
  function notifyUntrustedProjectIfNeeded(cwd: string): void {
    if (trustProject) return;
    if (!existsSync(resolve(cwd, ".pi"))) return;
    broadcast("server-notice", {
      message:
        "Project is untrusted: .pi/ extensions and settings are not loaded. Pass --trust-project to load them.",
    });
  }

  /** The registry's session factory: one Pi session per branch, cwd-scoped. */
  async function createSessionFor(context: {
    key: string;
    cwd: string;
    isPrimary: boolean;
  }) {
    const { key, cwd, isPrimary } = context;
    // Re-read ~/.pi/agent/auth.json so credentials written AFTER the server
    // started (e.g. `npx designbook login` → /login) are picked up — this is what makes the
    // chat's no-model "Retry" (POST /api/new-session) work without a restart.
    authStorage.reload();
    const settingsManager = SettingsManager.create(cwd, undefined, {
      projectTrusted: trustProject,
    });
    // designbook's shipped skills (figma-pull): loaded via additionalSkillPaths
    // on the same DefaultResourceLoader the SDK would build itself — package
    // asset, so trust-INDEPENDENT; repo .pi/ resources stay gated by
    // projectTrusted exactly as before (see piSkills.ts).
    const resourceLoader = await createDesignbookResourceLoader({
      skillPaths: packagedSkillPaths(),
      cwd,
      settingsManager,
    });
    if (!resourceLoader && nodeIntegrations.length > 0) {
      log("packaged skills dir not found; integration skills not loaded");
    }
    // This session IS a conversation — mint (or resume) its identity FIRST.
    // G2 (the restored L3 gate): cwd = the conversation's direct-edits
    // changeset WORKTREE only while a conversation is ACTIVE (drawer open —
    // POST /api/sandbox/active-conversation); otherwise the repo root, where
    // tool writes are REAL (no capture, no commits). A gate flip rebuilds
    // the session in the other cwd, resuming the same transcript (`resume`).
    // A non-git repo degrades to the branch root (changesets error at
    // creation).
    const resume = resumeSessions.get(key);
    resumeSessions.delete(key);
    const conversationId = resume?.conversationId ?? makeConversationId();
    const gateOpen = !readOnly && activeConversations.has(key);
    // Per-turn workspace binding (conversation-routed asks): when the next
    // turn resolved a specific changeset workspace (`cs:<id>` — the
    // selected pin's changeset, or the direct-edits one), build the session
    // IN that changeset's worktree; otherwise fall back to the
    // conversation's direct-edits workspace.
    const turnTarget = gateOpen ? turnWorkspaces.get(key) : undefined;
    const targetChangesetId = turnTarget?.startsWith("cs:")
      ? turnTarget.slice(3)
      : undefined;
    const workspace = gateOpen
      ? targetChangesetId
        ? await sandbox.ensureChangesetWorkspace({
            repoRoot: cwd,
            appDir: activeAppDir(cwd),
            changesetId: targetChangesetId,
          })
        : await sandbox.ensureConversationWorkspace({
            repoRoot: cwd,
            appDir: activeAppDir(cwd),
            conversationId,
          })
      : undefined;
    const sessionCwd = workspace?.worktreeAbs ?? cwd;
    sessionWorkspaces.set(
      key,
      workspace ? `cs:${workspace.changesetId}` : ROOT_WORKSPACE,
    );
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: sessionCwd,
      authStorage,
      modelRegistry,
      // Transcripts stay in the BRANCH root's store (stable across
      // conversation worktrees), keyed per branch as before. A gate rebuild
      // reopens the SAME transcript file so the thread survives the flip.
      sessionManager: resume?.sessionFile
        ? SessionManager.open(
            resume.sessionFile,
            sessionStoreDir(cwd),
            sessionCwd,
          )
        : SessionManager.create(sessionCwd, sessionStoreDir(cwd)),
      settingsManager,
      ...(resourceLoader ? { resourceLoader } : {}),
      customTools: [...integrationRegistry.piTools()],
      ...(readOnly ? { tools: READ_ONLY_TOOL_NAMES } : {}),
    });

    // Persist the conversation identity so the transcript's history row
    // keeps the linkage after a reset.
    conversationIds.set(key, conversationId);
    conversationCaptures.set(key, {});
    sessionTurnCounts.set(key, 0);
    if (workspace) {
      // Agent-supplied turn summaries (turnSummary.ts, replaces the async
      // label turn): ONE hidden session-scoped instruction — the working
      // turn labels itself via a trailing `Summary:` (+ optional `Title:`)
      // metadata line, parsed at turn end and stripped from display.
      void session
        .sendCustomMessage(
          {
            customType: "designbook-turn-metadata",
            content: SUMMARY_PROMPT_INSTRUCTION,
            display: false,
          },
          { triggerTurn: false },
        )
        .catch(() => {});
    }
    void recordConversationTag({
      sessionDir: sessionStoreDir(cwd),
      sessionId: session.sessionId ?? "",
      conversationId,
    });

    if (modelFallbackMessage) {
      log(`model fallback: ${modelFallbackMessage}`);
      broadcast("server-notice", { message: modelFallbackMessage });
    }

    void checkDirtyWorkingTree(cwd);
    notifyUntrustedProjectIfNeeded(cwd);

    // Display branch name: for primary the checkout's git branch; non-primary
    // keys ARE branch names.
    const branchName = isPrimary
      ? await getCurrentBranch(cwd).catch(() => undefined)
      : key;

    // Branch-scoped events: non-primary payloads gain a `branch` field;
    // primary payloads stay byte-identical (absent branch = primary).
    const branch = wireBranch(key);
    const unsubscribe = session.subscribe((event) => {
      logPiEvent(event);
      trackAgentStatus(key, event);
      // G1 per-tool-write commits: the tool_execution_end seam feeds the
      // in-flight turn's git capture (absent between turns = no-op).
      const piEvent = event as {
        type?: string;
        toolCallId?: string;
        toolName?: string;
      };
      if (piEvent.type === "tool_execution_end") {
        void conversationCaptures.get(key)?.capture?.noteToolEnd({
          ...(piEvent.toolCallId ? { toolCallId: piEvent.toolCallId } : {}),
          ...(piEvent.toolName ? { toolName: piEvent.toolName } : {}),
        });
      }
      broadcast(
        "pi-event",
        branch ? { ...(event as object), branch } : event,
      );
    });

    log(
      `pi session ${session.sessionId} created (model: ${session.model?.id ?? "none"}, cwd: ${cwd}, branch: ${branchName ?? "?"})`,
    );
    return { session, unsubscribe, branchName };
  }

  /** All packaged skill dirs: integration skills + designbook's core skills
   * (the `variations` skill). Used by branch sessions AND ephemeral ones. */
  function packagedSkillPaths(): string[] {
    const core = designbookCoreSkillsDir();
    return [...integrationRegistry.skillsDirs(), ...(core ? [core] : [])];
  }

  // --- Design variations (docs/specs/design-variations.md, DECIDED) --------
  //
  // N parallel EPHEMERAL Pi sessions each write one candidate into
  // `.designbook/variations/`; the orchestrator (variations.ts) owns the
  // director step, landing verification, the durable index, and resolve
  // semantics. Sessions here are DISPOSABLE: created per turn, restricted
  // tools (director: read-only; variant: read+write/edit, no bash), disposed
  // at turn end — and their pi-events are LOG-ONLY, never broadcast, so the
  // main chat thread stays untouched (main chat free by design).
  /**
   * The ACTIVE branch session's selected model, if that session already
   * exists (peek — never spawn a session just to read its model). Ephemeral
   * variation turns inherit it (director + variants), mirroring
   * resetSession's carry-over; absent → the SDK default.
   */
  async function activeSelectedModel(): Promise<
    Parameters<AgentSession["setModel"]>[0] | undefined
  > {
    const entry = sessions.peek(activeSessionKey());
    if (!entry) return undefined;
    try {
      return (await entry.promise).model ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function runVariationTurn(params: {
    cwd: string;
    prompt: string;
    mode: "director" | "variant";
  }): Promise<{ text: string }> {
    authStorage.reload();
    const inheritedModel = await activeSelectedModel();
    const settingsManager = SettingsManager.create(params.cwd, undefined, {
      projectTrusted: trustProject,
    });
    const resourceLoader = await createDesignbookResourceLoader({
      skillPaths: packagedSkillPaths(),
      cwd: params.cwd,
      settingsManager,
    });
    const { session } = await createAgentSession({
      cwd: params.cwd,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.create(params.cwd),
      settingsManager,
      ...(resourceLoader ? { resourceLoader } : {}),
      tools:
        params.mode === "director" ? READ_ONLY_TOOL_NAMES : VARIANT_TOOL_NAMES,
    });
    // Inherit the chat's selected model (default only when none selected).
    if (inheritedModel && session.model?.id !== inheritedModel.id) {
      await session.setModel(inheritedModel).catch(() => {});
    }
    const unsubscribe = session.subscribe(logPiEvent);
    try {
      await session.prompt(params.prompt);
      // `prompt()` RESOLVES on provider errors (quota/auth/4xx) — the failure
      // only exists on the transcript. Surface it, or the orchestrator can
      // just report "no file written" with the real cause invisible.
      const messages = session.messages as unknown[];
      const errorMessage = extractTurnErrorMessage(messages);
      return {
        text: extractAssistantText(messages),
        ...(errorMessage ? { errorMessage } : {}),
      };
    } finally {
      unsubscribe();
      session.dispose();
    }
  }

  const variations = createVariationsOrchestrator({
    broadcast,
    log,
    runTurn: runVariationTurn,
  });

  async function handleVariationsStatus(response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    sendJson(
      response,
      200,
      await variations.status(repoRoot, activeAppDir(repoRoot)),
    );
  }

  async function handleVariationsGenerate(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      baseEntryId?: unknown;
      baseSourcePath?: unknown;
      count?: unknown;
      direction?: unknown;
      context?: unknown;
    }>(request);
    const result = variations.generate({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      baseEntryId:
        typeof payload.baseEntryId === "string" ? payload.baseEntryId : "",
      baseSourcePath:
        typeof payload.baseSourcePath === "string"
          ? payload.baseSourcePath
          : "",
      count: typeof payload.count === "number" ? payload.count : undefined,
      direction:
        typeof payload.direction === "string" ? payload.direction : undefined,
      context:
        typeof payload.context === "string" ? payload.context : undefined,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  async function handleVariationsIterate(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      base?: unknown;
      slug?: unknown;
      note?: unknown;
    }>(request);
    const result = variations.iterate({
      repoRoot,
      base: typeof payload.base === "string" ? payload.base : "",
      slug: typeof payload.slug === "string" ? payload.slug : "",
      note: typeof payload.note === "string" ? payload.note : "",
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  async function handleVariationsRetry(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{ base?: unknown; slug?: unknown }>(
      request,
    );
    const result = variations.retry({
      base: typeof payload.base === "string" ? payload.base : "",
      slug: typeof payload.slug === "string" ? payload.slug : "",
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  async function handleVariationsResolve(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      base?: unknown;
      action?: unknown;
      slug?: unknown;
      newName?: unknown;
    }>(request);
    const action = payload.action;
    if (
      action !== "keep" &&
      action !== "keepAs" &&
      action !== "discard" &&
      action !== "abandon"
    ) {
      sendJson(response, 400, { error: "Unknown resolve action." });
      return;
    }
    const result = await variations.resolve({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      base: typeof payload.base === "string" ? payload.base : "",
      action,
      slug: typeof payload.slug === "string" ? payload.slug : undefined,
      newName:
        typeof payload.newName === "string" ? payload.newName : undefined,
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { resolved: true });
  }

  // --- Sandbox (docs/specs/sandbox.md, DECIDED 2026-07-10) ------------------
  //
  // App-mode pins: each pin gets its OWN ephemeral Pi session per turn (D6),
  // inheriting the chat-selected model exactly like variation turns. Pin
  // sessions are DISPOSABLE and their pi-events are LOG-ONLY — never
  // broadcast, so the main chat thread stays untouched. `sandbox-event`
  // payloads are branch-tagged like pi-events (absent branch = primary).
  function broadcastSandboxEvent(eventName: string, payload: unknown) {
    // The orchestrator names each event's HOME explicitly (emit scope in
    // sandbox.ts): derive the wire `branch` tag from THAT — the event's own
    // home — never from whichever branch is active at emit time (a turn
    // finishing after a branch switch, or a background home's drift/bake
    // events, must stay tagged for the branch they belong to). `__home` is
    // internal plumbing and never reaches the wire.
    const scoped = payload as {
      __home?: { repoRoot?: unknown; branch?: unknown };
    };
    if (
      scoped !== null &&
      typeof scoped === "object" &&
      scoped.__home &&
      typeof scoped.__home.repoRoot === "string"
    ) {
      const { __home, ...rest } = scoped as Record<string, unknown> & {
        __home: { repoRoot: string; branch?: unknown };
      };
      const branch = resolveSandboxWireBranch({
        homeRepoRoot: __home.repoRoot,
        homeBranch:
          typeof __home.branch === "string" ? __home.branch : undefined,
        projectRoot,
        // Fallback only — a home whose branch probe hasn't run yet.
        activeWireBranch: wireBranch(activeSessionKey()),
      });
      broadcast(eventName, branch ? { ...rest, branch } : rest);
      return;
    }
    // Legacy/scope-less emits keep the pre-fix behavior (active session).
    const branch = wireBranch(activeSessionKey());
    broadcast(
      eventName,
      branch ? { ...(payload as object), branch } : payload,
    );
  }

  /**
   * Ephemeral sandbox-turn transcripts persist into a `designbook-ephemeral`
   * SUBDIR of the default session store, so the drawer's chat-history
   * listing (sandboxThreads.ts — non-recursive) never shows machine turns.
   */
  function ephemeralSandboxSessionDir(cwd: string): string {
    return resolve(
      SessionManager.create(cwd).getSessionDir(),
      EPHEMERAL_SESSION_SUBDIR,
    );
  }

  async function runSandboxTurn(params: {
    /** The turn's working directory — a changeset WORKTREE for git-backed
     * turns (G1), the repo root for bake merge turns. */
    cwd: string;
    prompt: string;
    mode: "director" | "variant" | "edit" | "replace" | "intent" | "title";
    /** G1 per-tool-write commit seam: fed from this session's
     * tool_execution_end events (the capture commits whatever the tool
     * wrote onto the turn's hidden ref). Absent = no commit capture. */
    capture?: Pick<TurnGitCapture, "noteToolEnd">;
    /** U4 transparency: relay this session's thinking/tool activity as
     * coalesced deltas (the orchestrator broadcasts them as branch-tagged
     * `sandbox-event`s — pi-events stay LOG-ONLY, the chat stream untouched). */
    onActivity?: (entry: SandboxTurnActivity) => void;
    /** L3: the parent conversation — the ephemeral session's transcript
     * identity is tagged with it (conversations.ts). */
    conversationId?: string | undefined;
  }): Promise<{ text: string; errorMessage?: string; sessionId?: string }> {
    authStorage.reload();
    const inheritedModel = await activeSelectedModel();
    const settingsManager = SettingsManager.create(params.cwd, undefined, {
      projectTrusted: trustProject,
    });
    const resourceLoader = await createDesignbookResourceLoader({
      skillPaths: packagedSkillPaths(),
      cwd: params.cwd,
      settingsManager,
    });
    // File-writing sandbox modes get read + write/edit, no bash. The UX-v3
    // cheap turns (intent classification, thread titles) are
    // constrained-output only — the read-only tool set.
    const cheapTurn = params.mode === "intent" || params.mode === "title";
    // Ephemeral transcripts stay under the PRIMARY root's hidden store even
    // when the turn's cwd is a changeset worktree (worktrees are pruned;
    // transcripts must survive them).
    const repoRoot = activeRepoRoot();
    const { session } = await createAgentSession({
      cwd: params.cwd,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.create(
        params.cwd,
        ephemeralSandboxSessionDir(repoRoot),
      ),
      settingsManager,
      ...(resourceLoader ? { resourceLoader } : {}),
      tools: cheapTurn ? READ_ONLY_TOOL_NAMES : VARIANT_TOOL_NAMES,
    });
    // L3: sub-turns are tagged with their parent conversation (bookkeeping
    // in the same sidecar map the live sessions use).
    if (params.conversationId) {
      void recordConversationTag({
        sessionDir: sessionStoreDir(repoRoot),
        sessionId: session.sessionId ?? "",
        conversationId: params.conversationId,
      });
    }
    if (inheritedModel && session.model?.id !== inheritedModel.id) {
      await session.setModel(inheritedModel).catch(() => {});
    }
    // U4: director/variant turns relay thinking/tool activity as coalesced
    // deltas; every session's pi-events stay log-only regardless.
    const relay = params.onActivity
      ? createTurnActivityRelay(params.onActivity)
      : undefined;
    const unsubscribe = session.subscribe((event) => {
      logPiEvent(event);
      relay?.handle(event);
      // G1: every tool-write becomes a commit, driven from the event seam.
      const piEvent = event as {
        type?: string;
        toolCallId?: string;
        toolName?: string;
      };
      if (params.capture && piEvent.type === "tool_execution_end") {
        void params.capture.noteToolEnd({
          ...(piEvent.toolCallId ? { toolCallId: piEvent.toolCallId } : {}),
          ...(piEvent.toolName ? { toolName: piEvent.toolName } : {}),
        });
      }
    });
    try {
      await session.prompt(params.prompt);
      const messages = session.messages as unknown[];
      const errorMessage = extractTurnErrorMessage(messages);
      return {
        text: extractAssistantText(messages),
        ...(errorMessage ? { errorMessage } : {}),
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      };
    } finally {
      relay?.flush();
      unsubscribe();
      session.dispose();
    }
  }

  /**
   * The Replace gate: `tsc --noEmit` in the active repo root. A repo without
   * a resolvable tsc (or without a tsconfig) skips the gate rather than
   * bricking Replace — the orchestrator logs the skip.
   */
  async function runSandboxTypecheck(
    repoRoot: string,
    appDir: string,
  ): Promise<{ ok: boolean; output?: string; skipped?: boolean }> {
    // The APP owns the tsconfig (monorepo rule) — run in the config dir, with
    // ITS TypeScript. `npx tsc` is banned here: it happily resolves the npm
    // placeholder package named "tsc" ("not the tsc command you are looking
    // for" — live-run finding), silently skipping the gate.
    const gateCwd = appDir ? resolve(repoRoot, appDir) : repoRoot;
    let tscBin: string | undefined;
    try {
      tscBin = createRequire(resolve(gateCwd, "package.json")).resolve(
        "typescript/bin/tsc",
      );
    } catch {
      // TypeScript not installed for the app — gate unavailable.
    }
    if (!tscBin) {
      log("sandbox typecheck unavailable (no typescript in the app dir); gate skipped");
      return { ok: true, skipped: true };
    }
    try {
      await execFileAsync(process.execPath, [tscBin, "--noEmit"], {
        cwd: gateCwd,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
      // Exit code with TS diagnostics = a real gate failure; anything else
      // (no tsconfig, spawn error) = gate unavailable.
      if (typeof failure.code === "number" && /error TS\d+/.test(output)) {
        return { ok: false, output };
      }
      log(`sandbox typecheck unavailable (${truncateForLog(output || String(error))}); gate skipped`);
      return { ok: true, skipped: true };
    }
  }

  /** One-line bound for typecheck-skip logging. */
  function truncateForLog(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
  }

  const sandbox = createSandboxOrchestrator({
    broadcast: broadcastSandboxEvent,
    log,
    runTurn: runSandboxTurn,
    runTypecheck: runSandboxTypecheck,
    // G1 sidecar linkage: every git-backed turn's commit range lands next
    // to the conversation map (message→commits + commit→message offline).
    recordTurn: (entry) => {
      const record = {
        turn: `${entry.sessionId ?? "unknown"}/1`,
        ...(entry.conversationId
          ? { conversationId: entry.conversationId }
          : {}),
        changesetId: entry.changesetId,
        ref: entry.ref,
        from: entry.from,
        to: entry.to,
        at: entry.at,
        // Agent-supplied label (the turn's own `Summary:` line) — lands
        // synchronously with the record; no async label turn anymore.
        ...(entry.label ? { label: entry.label } : {}),
      };
      return recordTurnRange({
        sessionDir: sessionStoreDir(entry.repoRoot),
        record,
      });
    },
    // Drift watch: periodic re-hash of real modules under active layer
    // overrides (out-of-band edits flag `drifted` without waiting for a
    // status read; merged data artifacts re-sync on the same cadence).
    driftWatchMs: 2000,
    ...(options.onSandboxOverridesChanged
      ? { onOverridesChanged: options.onSandboxOverridesChanged }
      : {}),
  });

  // Props panel typed-schema extractor (docs/specs/props-panel.md): lazy,
  // mtime-cached, resolved off the app's own typescript. Cold cost is paid on
  // first extraction per file; the endpoint is async and independent.
  const propsSchema = createPropsSchema({ log });

  async function handlePropsSchema(url: URL, response: ServerResponse) {
    const file = url.searchParams.get("file") ?? "";
    const exportName = url.searchParams.get("export") ?? undefined;
    if (!file) {
      sendJson(response, 400, { error: "file is required." });
      return;
    }
    const repoRoot = activeRepoRoot();
    const absFile = resolveSourceFile(file, repoRoot);
    if (!absFile || !/\.(tsx|ts|jsx|js)$/.test(absFile)) {
      sendJson(response, 200, {
        unavailable: "not a resolvable source file.",
      });
      return;
    }
    const appDir = activeAppDir(repoRoot);
    const gateCwd = appDir ? resolve(repoRoot, appDir) : repoRoot;
    const result = await propsSchema.getSchema({
      absFile,
      gateCwd,
      ...(exportName ? { exportName } : {}),
    });
    sendJson(response, 200, result);
  }

  type PropsEditPayload = {
    /** Repo-relative owner file (the selection's codeTarget.file). */
    file?: unknown;
    /** Owner component export name (codeTarget.ownerExportName). */
    ownerExportName?: unknown;
    /** The JSX name of the selected instance (codeTarget.name / exportName). */
    elementName?: unknown;
    /** codeTarget.className — disambiguates repeats. */
    className?: unknown;
    /** 1-based usage line hint (code-panel highlight). */
    usageLine?: unknown;
    /** The attribute to write. */
    prop?: unknown;
    /** Control kind (shapes the emitted attribute). */
    kind?: unknown;
    /** New value (absent when `reset`). */
    value?: unknown;
    /** Remove the attribute (reset-to-default). */
    reset?: unknown;
  };

  /** Build the typed JSX value from the payload kind + value. */
  function jsxValueFromPayload(
    kind: string,
    value: unknown,
  ): JsxAttrValue | undefined {
    switch (kind) {
      case "boolean":
        return { kind: "boolean", value: Boolean(value) };
      case "number": {
        const n = typeof value === "number" ? value : Number(value);
        return Number.isFinite(n) ? { kind: "number", value: n } : undefined;
      }
      case "string":
      case "enum":
        return { kind: "string", value: String(value ?? "") };
      case "expression":
        return { kind: "expression", value: String(value ?? "") };
      default:
        return undefined;
    }
  }

  /**
   * Props-panel usage-site write (docs/specs/props-panel.md): set / replace /
   * remove ONE JSX attribute at the selected instance's usage site. Routes
   * like the manual data edits (r2): active conversation → a commit on its
   * direct-edits changeset (+ a sidecar timeline record); otherwise the real
   * file. Spread-props / unresolvable usage sites come back read-only.
   */
  async function handlePropsEdit(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<PropsEditPayload>(request);
    const file = typeof payload.file === "string" ? payload.file : "";
    const elementName =
      typeof payload.elementName === "string" ? payload.elementName : "";
    const prop = typeof payload.prop === "string" ? payload.prop : "";
    if (!file || !elementName || !prop) {
      sendJson(response, 400, {
        error: "file, elementName, and prop are required.",
      });
      return;
    }
    const reset = payload.reset === true;
    const kind = typeof payload.kind === "string" ? payload.kind : "string";
    let value: JsxAttrValue | undefined;
    if (!reset) {
      value = jsxValueFromPayload(kind, payload.value);
      if (!value) {
        sendJson(response, 400, { error: `Unsupported value for kind ${kind}.` });
        return;
      }
    }

    const repoRoot = activeRepoRoot();
    const sourceFile = resolveSourceFile(file, repoRoot);
    if (!sourceFile || !/\.(tsx|jsx)$/.test(sourceFile)) {
      sendJson(response, 400, {
        error: "A JSX source file inside the project is required.",
      });
      return;
    }
    const fileStat = await stat(sourceFile).catch(() => undefined);
    if (!fileStat?.isFile()) {
      sendJson(response, 404, { error: `File not found: ${file}` });
      return;
    }

    const ownerExportName =
      typeof payload.ownerExportName === "string"
        ? payload.ownerExportName
        : undefined;
    const className =
      typeof payload.className === "string" ? payload.className : undefined;
    const usageLine =
      typeof payload.usageLine === "number" ? payload.usageLine : undefined;
    const editInput = {
      ...(ownerExportName ? { ownerExportName } : {}),
      elementName,
      ...(className ? { className } : {}),
      ...(usageLine ? { usageLine } : {}),
      prop,
      edit: (reset
        ? { type: "remove" as const }
        : { type: "set" as const, value: value! }),
    };
    const apply = (current: string) => {
      const result = editJsxAttribute({ source: current, ...editInput });
      if ("unresolvable" in result) return { unresolvable: result.unresolvable };
      return { updated: result.updated };
    };
    const label = `${reset ? "Reset" : "Set"} ${prop} on ${elementName}`;

    // L3: active conversation → the direct-edits changeset (mirrors the manual
    // data edits). No active conversation → the real file.
    const conversationId = activeConversations.get(activeSessionKey());
    if (conversationId) {
      const staged = await sandbox.stageDirectCodeEdit({
        repoRoot,
        appDir: activeAppDir(repoRoot),
        conversationId,
        rel: toRepoRel(repoRoot, sourceFile),
        apply,
      });
      if (staged.unresolvable) {
        sendJson(response, 200, { ok: false, unresolvable: staged.unresolvable });
        return;
      }
      if (staged.error) {
        sendJson(response, staged.status ?? 400, { error: staged.error });
        return;
      }
      // Record a sidecar turn so the edit shows in the timeline (label +
      // range) and the live chat grows a row — mirrors a conversation turn.
      if (staged.to && staged.from && staged.changesetId && staged.ref) {
        try {
          const record = {
            turn: `manual/${Date.now()}`,
            conversationId,
            changesetId: staged.changesetId,
            ref: staged.ref,
            from: staged.from,
            to: staged.to,
            at: Date.now(),
            label,
          };
          await recordTurnRange({
            sessionDir: sessionStoreDir(repoRoot),
            record,
          });
          const turnBranch = wireBranch(activeSessionKey());
          broadcast("sandbox-event", {
            type: "conversation-turn",
            ...record,
            files: [toRepoRel(repoRoot, sourceFile)],
            ...(turnBranch ? { branch: turnBranch } : {}),
          });
        } catch (error) {
          log(`props-edit sidecar record failed: ${String(error)}`);
        }
      }
      log(`staged props edit: ${label} (${file})`);
      sendJson(response, 200, {
        ok: true,
        staged: true,
        ...(staged.changesetId ? { changesetId: staged.changesetId } : {}),
      });
      return;
    }

    // Real-file write (no active conversation) — exactly like manual edits.
    const raw = await readFile(sourceFile, "utf8");
    const result = editJsxAttribute({ source: raw, ...editInput });
    if ("unresolvable" in result) {
      sendJson(response, 200, { ok: false, unresolvable: result.unresolvable });
      return;
    }
    if (result.updated === raw) {
      sendJson(response, 200, { ok: true, unchanged: true });
      return;
    }
    noteDataWrite(sourceFile, repoRoot);
    await writeFile(sourceFile, result.updated, "utf8");
    log(`wrote props edit: ${label} (${file})`);
    sendJson(response, 200, { ok: true });
  }

  async function handleSandboxStatus(response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    // Conversation grouping unions the changesets each conversation LANDED
    // turns on (sidecar records) — reused pins keep their original
    // conversation on the layer meta (see sandbox.status).
    const turns = await readConversationStore(sessionStoreDir(repoRoot))
      .then((store) => store.turns)
      .catch(
        () => [] as { conversationId?: string; changesetId: string }[],
      );
    sendJson(
      response,
      200,
      await sandbox.status(repoRoot, activeAppDir(repoRoot), { turns }),
    );
  }

  /** Per-component switch state (the generated runtime bootstraps from it). */
  async function handleSandboxSwitches(response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    sendJson(
      response,
      200,
      await sandbox.switches(repoRoot, activeAppDir(repoRoot)),
    );
  }

  /** Flip one component's switch (O1: server-persisted, SSE-broadcast). */
  async function handleSandboxSwitch(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      component?: unknown;
      selection?: unknown;
    }>(request);
    const rawSelection = payload.selection as {
      changesetId?: unknown;
      variantId?: unknown;
    } | null;
    const selection =
      rawSelection &&
      typeof rawSelection === "object" &&
      typeof rawSelection.changesetId === "string" &&
      typeof rawSelection.variantId === "string"
        ? {
            changesetId: rawSelection.changesetId,
            variantId: rawSelection.variantId,
          }
        : null;
    const result = await sandbox.switchSelect({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      component: typeof payload.component === "string" ? payload.component : "",
      selection,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true });
  }

  /** Activate/deactivate a WHOLE changeset layer (changeset layers L1):
   * the file-level conflict "choose" action + the tray toggle. */
  async function handleSandboxActivate(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      changesetId?: unknown;
      active?: unknown;
    }>(request);
    const result = await sandbox.activate({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId:
        typeof payload.changesetId === "string" ? payload.changesetId : "",
      active: payload.active === true,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true });
  }

  /** Bake a changeset: queue admission — statuses stream as `bake-status`
   * SSE events (queued/running/gated/done/failed). A DRIFTED changeset
   * refuses without `force: true` (409 — explicit confirm). */
  async function handleSandboxBake(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      changesetId?: unknown;
      force?: unknown;
    }>(request);
    const result = await sandbox.bake({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId:
        typeof payload.changesetId === "string" ? payload.changesetId : "",
      force: payload.force === true,
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  /** Discard a changeset (O2): state + switches dissolve, shims/redirects
   * regenerate, unreferenced dataAdditions GC. Pin/thread kept as history. */
  async function handleSandboxDiscard(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{ changesetId?: unknown }>(request);
    const result = await sandbox.discard({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId:
        typeof payload.changesetId === "string" ? payload.changesetId : "",
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true });
  }

  /**
   * G3 drift→rebase: POST /api/sandbox/rebase {changesetId} — rebase the
   * changeset's branches onto the current source (merge turn only on
   * conflict; abort restores every pre-rebase tip). Progress streams as
   * `rebase-status` events.
   */
  async function handleSandboxRebase(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{ changesetId?: unknown }>(request);
    const result = await sandbox.rebase({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId:
        typeof payload.changesetId === "string" ? payload.changesetId : "",
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, rebased: result.rebased === true });
  }

  /**
   * G3 bake-to-branch (B1): POST /api/sandbox/bake-to-branch
   * {changesetId, name?, skipGate?, force?} — queue a branch-materialization
   * bake. Default name designbook/<changeset-slug>; statuses stream as
   * `bake-status`, the result as `baked-to-branch`. Nothing is pushed.
   */
  async function handleSandboxBakeToBranch(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      changesetId?: unknown;
      name?: unknown;
      skipGate?: unknown;
      force?: unknown;
    }>(request);
    const result = await sandbox.bakeToBranch({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId:
        typeof payload.changesetId === "string" ? payload.changesetId : "",
      ...(typeof payload.name === "string" && payload.name.trim()
        ? { name: payload.name }
        : {}),
      skipGate: payload.skipGate === true,
      force: payload.force === true,
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true, branch: result.branch });
  }

  /**
   * ROLLBACK (G1, server-side): move a changeset branch back to a commit —
   * body {changesetId, commit} for a tool-write boundary, or
   * {changesetId, turn: "<sessionId>/<n>"} to rewind to BEFORE that turn
   * (the sidecar's recorded range resolves it). Re-projects + hot-updates;
   * rolled-off commits stay reflog-recoverable until gc.
   */
  async function handleSandboxRollback(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      changesetId?: unknown;
      commit?: unknown;
      turn?: unknown;
    }>(request);
    const changesetId =
      typeof payload.changesetId === "string" ? payload.changesetId : "";
    if (!changesetId) {
      sendJson(response, 400, { error: "changesetId is required." });
      return;
    }
    let commit = typeof payload.commit === "string" ? payload.commit : "";
    let ref: string | undefined;
    if (!commit && typeof payload.turn === "string" && payload.turn) {
      const store = await readConversationStore(sessionStoreDir(repoRoot));
      const record = [...store.turns]
        .reverse()
        .find(
          (candidate) =>
            candidate.turn === payload.turn &&
            candidate.changesetId === changesetId,
        );
      if (!record) {
        sendJson(response, 400, { error: "Unknown turn for this changeset." });
        return;
      }
      commit = record.from;
      ref = record.ref;
    }
    if (!commit) {
      sendJson(response, 400, { error: "commit or turn is required." });
      return;
    }
    const result = await sandbox.rollback({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId,
      commit,
      ...(ref ? { ref } : {}),
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, ref: result.ref, commit });
  }

  // ---------------------------------------------------------------------
  // TURN LABELS are agent-supplied (turnSummary.ts): the working turn ends
  // its reply with a `Summary:` metadata line, parsed at turn end into the
  // sidecar record's `label` (and the catch-all commit subject). The old
  // async title-mode label turn + lazy backfill are DELETED.
  // ---------------------------------------------------------------------

  /** First non-empty line of a prompt, capped (turn-label fallback). */
  function firstPromptLine(text?: string): string | undefined {
    const line = (text ?? "")
      .split("\n")
      .map((candidate) => candidate.trim())
      .find(Boolean);
    if (!line) return undefined;
    return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }


  /**
   * G2 history rows (read-only): the sidecar's per-turn commit ranges,
   * filtered by conversation and/or changeset — the thread panel matches
   * them to its turn rows by `turn` (`<sessionId>/<n>`) and `at`.
   */
  async function handleSandboxTurns(url: URL, response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const changesetId = url.searchParams.get("changesetId") ?? "";
    if (!conversationId && !changesetId) {
      sendJson(response, 400, {
        error: "conversationId or changesetId is required.",
      });
      return;
    }
    const store = await readConversationStore(sessionStoreDir(repoRoot));
    const turns = store.turns.filter(
      (record) =>
        (!conversationId || record.conversationId === conversationId) &&
        (!changesetId || record.changesetId === changesetId),
    );
    sendJson(response, 200, { turns });
  }

  /**
   * G2 per-turn diff (read-only): GET /api/sandbox/turn-diff?changesetId&turn
   * → the turn's commit-range unified diff (size-capped) + its per-tool-write
   * commits (sha, subject, Designbook-Tool-Call) for the finer restore list.
   */
  async function handleSandboxTurnDiff(url: URL, response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    const changesetId = url.searchParams.get("changesetId") ?? "";
    const turn = url.searchParams.get("turn") ?? "";
    if (!changesetId || !turn) {
      sendJson(response, 400, { error: "changesetId and turn are required." });
      return;
    }
    const store = await readConversationStore(sessionStoreDir(repoRoot));
    const record = [...store.turns]
      .reverse()
      .find(
        (candidate) =>
          candidate.turn === turn && candidate.changesetId === changesetId,
      );
    if (!record) {
      sendJson(response, 404, { error: "Unknown turn for this changeset." });
      return;
    }
    const result = await sandbox.turnDiff({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId,
      from: record.from,
      to: record.to,
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, {
      turn: record.turn,
      ref: record.ref,
      from: record.from,
      to: record.to,
      at: record.at,
      diff: result.diff,
      truncated: result.truncated,
      commits: result.commits,
    });
  }

  /**
   * G4 PARK (history explorer): POST /api/sandbox/park
   * {changesetId, commit|turn|null} — project a mid-history commit's state
   * into the cache WITHOUT moving any ref (a reversible preview). `turn`
   * resolves through the sidecar's turn records; null/absent exits.
   */
  /**
   * USER RENAME of a ref's display title (double-click a tip pill):
   * POST /api/sandbox/ref-title {changesetId, altId, title}. User names are
   * LOCKED — later agent `Title:` lines are ignored for the ref.
   */
  async function handleSandboxRefTitle(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      changesetId?: unknown;
      altId?: unknown;
      title?: unknown;
    }>(request);
    const result = await sandbox.renameRef({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId:
        typeof payload.changesetId === "string" ? payload.changesetId : "",
      altId: typeof payload.altId === "string" ? payload.altId : "",
      title: typeof payload.title === "string" ? payload.title : "",
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true });
  }

  async function handleSandboxPark(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      changesetId?: unknown;
      commit?: unknown;
      turn?: unknown;
    }>(request);
    const changesetId =
      typeof payload.changesetId === "string" ? payload.changesetId : "";
    if (!changesetId) {
      sendJson(response, 400, { error: "changesetId is required." });
      return;
    }
    let commit = typeof payload.commit === "string" ? payload.commit : "";
    let ref: string | undefined;
    let turnLabel: string | undefined;
    const wantsTurn = typeof payload.turn === "string" && payload.turn;
    if (commit || wantsTurn) {
      const store = await readConversationStore(sessionStoreDir(repoRoot));
      if (!commit && wantsTurn) {
        const record = [...store.turns]
          .reverse()
          .find(
            (candidate) =>
              candidate.turn === payload.turn &&
              candidate.changesetId === changesetId,
          );
        if (!record) {
          sendJson(response, 400, {
            error: "Unknown turn for this changeset.",
          });
          return;
        }
        commit = record.to;
        ref = record.ref;
        turnLabel = record.turn;
      } else if (commit) {
        // A raw commit still gets its turn label/ref when a record matches
        // (banner copy + branch narrowing).
        const record = [...store.turns]
          .reverse()
          .find(
            (candidate) =>
              candidate.changesetId === changesetId &&
              (candidate.to === commit || candidate.to.startsWith(commit)),
          );
        if (record) {
          ref = record.ref;
          turnLabel = record.turn;
        }
      }
    }
    const result = await sandbox.park({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId,
      commit: commit || null,
      ...(ref ? { ref } : {}),
      ...(turnLabel ? { turn: turnLabel } : {}),
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      ...(result.parked ? { parked: result.parked } : {}),
    });
  }

  /**
   * G4 HISTORY GRAPH: GET /api/sandbox/history-graph?conversationId (or
   * ?changesetId) → the conversation's full DAG in one shot — refs with
   * titles, per-turn nodes, fork topology, selection, park — plus the
   * conversation's own fork lineage (parent linkage).
   */
  async function handleSandboxHistoryGraph(url: URL, response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const changesetId = url.searchParams.get("changesetId") ?? "";
    if (!conversationId && !changesetId) {
      sendJson(response, 400, {
        error: "conversationId or changesetId is required.",
      });
      return;
    }
    const store = await readConversationStore(sessionStoreDir(repoRoot));
    const result = await sandbox.historyGraph({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      ...(conversationId ? { conversationId } : {}),
      ...(changesetId ? { changesetId } : {}),
      turns: store.turns,
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    const lineage = conversationId
      ? store.forks.find((fork) => fork.conversationId === conversationId)
      : undefined;
    sendJson(response, 200, {
      ...(result.conversationId
        ? { conversationId: result.conversationId }
        : {}),
      changesets: result.changesets ?? [],
      ...(lineage
        ? {
            parent: {
              conversationId: lineage.parentConversationId,
              ...(lineage.atTurn ? { atTurn: lineage.atTurn } : {}),
            },
          }
        : {}),
    });
  }

  /**
   * G2 reapply (spec §Selection): POST /api/sandbox/reapply
   * {changesetId, fromRef, toRef?} — cherry-pick the previous selection's
   * post-selection edits onto the (newly) selected branch. Conflicts get ONE
   * merge turn; total failure aborts and the edits stay on the old branch.
   */
  async function handleSandboxReapply(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      changesetId?: unknown;
      fromRef?: unknown;
      toRef?: unknown;
      dismiss?: unknown;
    }>(request);
    const result = await sandbox.reapply({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      changesetId:
        typeof payload.changesetId === "string" ? payload.changesetId : "",
      fromRef: typeof payload.fromRef === "string" ? payload.fromRef : "",
      ...(typeof payload.toRef === "string" && payload.toRef
        ? { toRef: payload.toRef }
        : {}),
      // Decline: clears the server-held offer only (the edits stay put).
      ...(payload.dismiss === true ? { dismiss: true } : {}),
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, applied: result.applied });
  }

  /** Compose two ACTIVE changesets over one export (O3): ONE merge-agent
   * turn producing a NEW changeset based on both parents. Returns the new
   * thread's pin id; progress streams as ordinary `sandbox-event`s. */
  async function handleSandboxCompose(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      component?: unknown;
      changesetIds?: unknown;
    }>(request);
    const result = await sandbox.compose({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      component:
        typeof payload.component === "string" ? payload.component : "",
      ...(Array.isArray(payload.changesetIds)
        ? {
            changesetIds: payload.changesetIds.filter(
              (id): id is string => typeof id === "string",
            ),
          }
        : {}),
    });
    if (result.error) {
      sendJson(response, result.status ?? 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true, id: result.id });
  }

  /** The module→shim redirect table (the injected vite plugin polls this;
   * version-gated). Dev-only by construction: only dev serves consume it. */
  async function handleSandboxRedirects(response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    sendJson(
      response,
      200,
      await sandbox.redirects(repoRoot, activeAppDir(repoRoot)),
    );
  }

  async function handleSandboxPin(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const repoRoot = activeRepoRoot();
    const payload = await readJsonBody<{
      target?: unknown;
      contextSnapshot?: unknown;
      kind?: unknown;
      locator?: unknown;
      ownerNames?: unknown;
    }>(request);
    const result = await sandbox.createPin({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      target: (payload.target ?? {}) as SandboxTarget,
      contextSnapshot: payload.contextSnapshot,
      // L3: pins are born INTO the live conversation (grouping key on the
      // pin + its changeset). No live session yet = legacy/ungrouped.
      conversationId: conversationIdFor(activeSessionKey()),
      // Element pins (docs/specs/sandbox.md v2): additive — absent = component.
      kind: payload.kind === "element" ? "element" : "component",
      locator: payload.locator,
      // Source-owner fallback (unregistered authoring component): the server
      // resolves target.file from this chain when the client sent "".
      ownerNames: payload.ownerNames,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { id: result.id });
  }

  /**
   * Read-only owning-file lookup for a source-owner fallback selection (an
   * element outside every registered component, e.g. a page shell): resolve
   * the named-owner chain to a repo-relative file via the SAME bounded export
   * scan element pins use — no pin is created. Feeds the proto full-view's
   * code panel. 200 `{}` when nothing on the chain resolves.
   */
  async function handleSandboxSourceOwner(url: URL, response: ServerResponse) {
    const names = (url.searchParams.get("names") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length === 0) {
      sendJson(response, 400, { error: "names is required." });
      return;
    }
    const repoRoot = activeRepoRoot();
    const { resolved } = await resolveOwnerSource({
      repoRoot,
      appDir: activeAppDir(repoRoot),
      names,
    });
    sendJson(response, 200, resolved ?? {});
  }

  async function handleSandboxPrompt(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      prompt?: unknown;
      mode?: unknown;
      n?: unknown;
    }>(request);
    if (payload.mode !== "edit" && payload.mode !== "variants") {
      sendJson(response, 400, { error: 'mode must be "edit" or "variants".' });
      return;
    }
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.prompt({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      mode: payload.mode,
      count: typeof payload.n === "number" ? payload.n : undefined,
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  /** UX v3 single entry (U3): the orchestrator classifies "variants
   * requested?" on the pin's session and routes — no mode from the client. */
  async function handleSandboxAsk(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      prompt?: unknown;
    }>(request);
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.ask({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  /** UX v3 threads (U2): chat-history sessions for the active cwd, with the
   * live session tagged `current` (the drawer routes it to the live chat). */
  async function handleSandboxThreads(response: ServerResponse) {
    const entry = sessions.peek(activeSessionKey());
    let currentSessionFile: string | undefined;
    if (entry) {
      try {
        currentSessionFile = (await entry.promise).sessionFile ?? undefined;
      } catch {
        // The session never started — no current transcript.
      }
    }
    try {
      // BRANCH-SCOPED (round-2 fix): the viewed HOME's root, never the live
      // session's cwd — the old peek-with-primary-fallback leaked the
      // PRIMARY checkout's threads onto any fresh branch that had no live
      // session yet (session stores are keyed per cwd; a new branch worktree
      // root legitimately starts empty).
      const cwd = activeRepoRoot();
      const store = await readConversationStore(sessionStoreDir(cwd));
      const threads = await listChatThreads({
        cwd,
        currentSessionFile,
        // L3: history rows keep their conversation linkage (sidecar map).
        conversationTags: store.sessions,
      });
      // G4: fork lineage — a sliced conversation's row links to its parent
      // (the thread list nests/badges it).
      const parents = new Map(
        store.forks.map((fork) => [
          fork.conversationId,
          fork.parentConversationId,
        ]),
      );
      sendJson(response, 200, {
        threads: threads.map((thread) =>
          thread.conversationId && parents.has(thread.conversationId)
            ? {
                ...thread,
                parentConversationId: parents.get(thread.conversationId),
              }
            : thread,
        ),
      });
    } catch (error) {
      sendJson(response, 500, { error: String(error) });
    }
  }

  /** UX v3 threads (U2): one transcript, READ-ONLY (rendered client-side via
   * the chat's own messagesToThreadItems fold). */
  async function handleSandboxThreadTranscript(
    response: ServerResponse,
    url: URL,
  ) {
    const result = readChatTranscript({
      // Branch-scoped like handleSandboxThreads: transcripts of the VIEWED
      // home only.
      cwd: activeRepoRoot(),
      path: url.searchParams.get("path") ?? "",
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { messages: result.messages ?? [] });
  }

  async function handleSandboxIterate(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      variantId?: unknown;
      prompt?: unknown;
      element?: unknown;
    }>(request);
    // Canvas element selection: descriptor of the element picked INSIDE the
    // variant's rendered preview. Sanitized (caps/shape) — a bad descriptor
    // degrades to a plain frame-level iterate, never a failed request.
    const element = sanitizeIterateElement(payload.element);
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.iterate({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      variantId: typeof payload.variantId === "string" ? payload.variantId : "",
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      ...(element ? { element } : {}),
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  async function handleSandboxRetry(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      variantId?: unknown;
    }>(request);
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.retry({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      variantId: typeof payload.variantId === "string" ? payload.variantId : "",
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  /** Render-verify feedback (canvas → orchestrator): a READY variant crashed
   * or rendered empty on the canvas. Marks it failed + auto-fixes once. */
  async function handleSandboxRenderFailure(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      variantId?: unknown;
      error?: unknown;
    }>(request);
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.renderFailure({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      variantId: typeof payload.variantId === "string" ? payload.variantId : "",
      error: typeof payload.error === "string" ? payload.error : "",
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  async function handleSandboxReplace(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      variantId?: unknown;
    }>(request);
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.replace({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      variantId: typeof payload.variantId === "string" ? payload.variantId : "",
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  /** NON-blocking post-replace crash report (element replace safety, E4):
   * appended to the pin thread as a warning; resolve is never blocked. */
  async function handleSandboxReplaceCrash(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      error?: unknown;
    }>(request);
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.replaceCrash({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      error: typeof payload.error === "string" ? payload.error : "",
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 202, { accepted: true });
  }

  async function handleSandboxPosition(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{
      pinId?: unknown;
      variantId?: unknown;
      x?: unknown;
      y?: unknown;
      w?: unknown;
      h?: unknown;
    }>(request);
    // w/h: a number sets an explicit frame size, `null` resets to auto-size,
    // absent leaves it untouched (a plain move) — mirror those three states.
    const sizeDimension = (value: unknown): number | null | undefined =>
      typeof value === "number" ? value : value === null ? null : undefined;
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    await sandbox.reviveHome(repoRoot, appDir);
    const result = sandbox.position({
      pinId: typeof payload.pinId === "string" ? payload.pinId : "",
      variantId: typeof payload.variantId === "string" ? payload.variantId : "",
      x: typeof payload.x === "number" ? payload.x : NaN,
      y: typeof payload.y === "number" ? payload.y : NaN,
      w: sizeDimension(payload.w),
      h: sizeDimension(payload.h),
      repoRoot,
      appDir,
    });
    if (result.error) {
      sendJson(response, 400, { error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true });
  }

  /** New-conversation reset for the ACTIVE branch's session only. */
  async function resetSession() {
    const key = activeSessionKey();
    const previous = sessions.peek(key);

    let previousModel: Parameters<AgentSession["setModel"]>[0] | undefined;
    if (previous) {
      try {
        previousModel = (await previous.promise).model;
      } catch {
        // The previous session never started successfully.
      }
    }

    // dispose() clears the registry entry up front, so any concurrent
    // getSession() builds a fresh session instead of the one torn down.
    await sessions.dispose(key);
    const session = await sessions.get(key);

    // Carry the previously selected model into the new conversation.
    if (previousModel && session.model?.id !== previousModel.id) {
      await session.setModel(previousModel).catch(() => {});
    }

    return session;
  }

  // Debug aid: DESIGNBOOK_TIMINGS=1 shows elapsed-ms chips on chat messages
  // and thinking/tool entries. Read once — a dev-server env, not a live toggle.
  const showTimings =
    process.env.DESIGNBOOK_TIMINGS === "1" ||
    process.env.DESIGNBOOK_TIMINGS === "true";

  function serializeSession(session: AgentSession, key: string) {
    const entry = sessions.peek(key);
    return {
      // Scoping key: ABSENT for primary (wire compat); the chat binds its
      // thread to this and drops other branches' pi-events.
      branch: wireBranch(key),
      // L3: the live session's conversation identity (drawer grouping +
      // the active-conversation handshake).
      conversationId: conversationIdFor(key),
      // Display: the session's git branch (primary included).
      branchName: entry?.branchName,
      cwd: entry?.cwd ?? projectRoot,
      isStreaming: session.isStreaming,
      messages: session.messages,
      model: session.model,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      showTimings,
      thinkingLevel: session.thinkingLevel,
    };
  }

  /** The active session + its serialized state (the common handler tail). */
  async function activeSessionState() {
    const key = activeSessionKey();
    const session = await sessions.get(key);
    return { key, session, state: serializeSession(session, key) };
  }

  type PromptPayload = {
    message?: unknown;
    streamingBehavior?: unknown;
    /** Selection-scoped prompt (conversation-routed asks): the anchor pin +
     * a FRESH send-time capture snapshot. */
    selection?: unknown;
  };

  /**
   * BEGIN one conversation-bound turn window (G1 + conversation-routed
   * asks): opens the per-tool-write COMMIT capture on the workspace the
   * turn resolved — the SELECTED pin's changeset branch for a
   * selection-scoped prompt (pendingSelectionAsks), the conversation's
   * direct-edits branch otherwise. Re-entrant — queued/steered prompts
   * share the outermost window.
   */
  async function beginConversationTurn(
    key: string,
    promptText?: string,
  ): Promise<void> {
    const existing = conversationTurns.get(key);
    if (existing) {
      existing.depth += 1;
      pendingSelectionAsks.delete(key); // Steer rides the open window.
      return;
    }
    const selectionAsk = pendingSelectionAsks.get(key);
    pendingSelectionAsks.delete(key);
    const repoRoot = sessions.peek(key)?.cwd ?? activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    const conversationId = conversationIdFor(key);
    const turnIndex = (sessionTurnCounts.get(key) ?? 0) + 1;
    sessionTurnCounts.set(key, turnIndex);
    const promptLine = firstPromptLine(promptText);
    const state: NonNullable<ReturnType<(typeof conversationTurns)["get"]>> = {
      depth: 1,
      repoRoot,
      appDir,
      turnIndex,
      ...(promptLine ? { prompt: promptLine } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(selectionAsk ? { selection: selectionAsk } : {}),
    };
    conversationTurns.set(key, state);
    if (!conversationId || readOnly) return;
    // The gate: with NO active conversation the session runs at the repo
    // root and its tool writes are REAL — no capture, no commits
    // (non-design work stays real). A session still in ANOTHER changeset's
    // workspace (deferred flip) must not capture either.
    if (!conversationGate.captureAllowed(key)) return;
    try {
      if (state.selection) {
        const begun = await sandbox.beginSelectionGitTurn({
          repoRoot,
          appDir,
          pinId: state.selection.pinId,
          conversationId,
          promptText: state.selection.request,
        });
        if ("error" in begun) {
          // Degraded: the turn still runs (the session answers/edits in its
          // worktree) but nothing commits this turn — the next captured
          // turn's catch-all commit sweeps any writes.
          log(`selection turn capture unavailable: ${begun.error}`);
        } else {
          state.selection.handle = begun.handle;
          const binding = conversationCaptures.get(key);
          if (binding) binding.capture = begun.handle.capture;
        }
        return;
      }
      state.handle = await sandbox.beginConversationGitTurn({
        repoRoot,
        appDir,
        conversationId,
      });
      const binding = conversationCaptures.get(key);
      if (binding && state.handle) binding.capture = state.handle.capture;
    } catch (error) {
      log(`conversation turn setup failed: ${String(error)}`);
    }
  }

  /** END the turn window: flush + trailer-stamp the turn's commits, record
   * the range in the sidecar, re-project the direct-edits changeset, and
   * surface what landed as a server-notice. */
  async function endConversationTurn(key: string): Promise<void> {
    const state = conversationTurns.get(key);
    if (!state) return;
    state.depth -= 1;
    if (state.depth > 0) return;
    conversationTurns.delete(key);
    const binding = conversationCaptures.get(key);
    if (binding) binding.capture = undefined;
    const { conversationId, handle, repoRoot, appDir } = state;
    const selectionHandle = state.selection?.handle;
    if (!conversationId || (!handle && !selectionHandle)) {
      // A gate flip that arrived mid-turn applies now (conversationGate.ts).
      conversationGate.onTurnEnd(key);
      return;
    }
    const notice = (message: string) =>
      broadcast("server-notice", { message });
    try {
      let sessionId: string | undefined;
      let sessionFile: string | undefined;
      let replyText: string | undefined;
      try {
        const live = await sessions.peek(key)!.promise;
        sessionId = live.sessionId ?? undefined;
        sessionFile = live.sessionFile ?? undefined;
        // The turn's final assistant reply — Summary/Title metadata parse
        // (agent-supplied labels, turnSummary.ts).
        replyText = extractAssistantText(live.messages as unknown[]);
      } catch {
        // Session gone — the range still records without a session id.
      }
      // UNIQUE turn index (round-2 live finding): the in-memory counter
      // resets when a conversation-gate flip rebuilds the session, so two
      // turns of ONE session could both record as `<sid>/1` — colliding
      // turn ids collapse UI rows and dedupe label runs. Bump past the
      // sidecar's highest recorded index for this session.
      let turnIndex = state.turnIndex;
      if (sessionId) {
        try {
          const store = await readConversationStore(sessionStoreDir(repoRoot));
          const prefix = `${sessionId}/`;
          let maxIndex = 0;
          for (const recorded of store.turns) {
            if (!recorded.turn.startsWith(prefix)) continue;
            const index = Number(recorded.turn.slice(prefix.length));
            if (Number.isFinite(index) && index > maxIndex) maxIndex = index;
          }
          if (maxIndex >= turnIndex) {
            turnIndex = maxIndex + 1;
            sessionTurnCounts.set(key, turnIndex);
          }
        } catch {
          // Best-effort — a collision only costs row dedupe.
        }
      }
      const parsedMeta = parseTurnSummary(replyText ?? "");
      const finished = selectionHandle
        ? await sandbox.finishSelectionGitTurn({
            repoRoot,
            appDir,
            conversationId,
            handle: selectionHandle,
            ...(sessionId ? { sessionId } : {}),
            turnIndex,
            ...(state.selection?.request
              ? { request: state.selection.request }
              : {}),
            ...(replyText ? { replyText } : {}),
          })
        : await sandbox.finishConversationGitTurn({
            repoRoot,
            appDir,
            conversationId,
            handle: handle!,
            ...(sessionId ? { sessionId } : {}),
            turnIndex,
            ...(parsedMeta.summary ? { summary: parsedMeta.summary } : {}),
            ...(parsedMeta.title ? { title: parsedMeta.title } : {}),
          });
      const label = selectionHandle
        ? (finished as { label?: string }).label
        : parsedMeta.summary;
      if (finished.commits.length > 0) {
        // G4: the transcript boundary at this turn's END — the exact entry a
        // park-fork slices the chat at (best-effort; fork falls back to
        // counting user prompts on pre-G4 records).
        let leaf: string | undefined;
        if (sessionFile) {
          try {
            leaf = SessionManager.open(sessionFile).getLeafId() ?? undefined;
          } catch {
            // Unreadable transcript — the record stays leaf-less.
          }
        }
        const record = {
          turn: `${sessionId ?? "unknown"}/${turnIndex}`,
          conversationId,
          changesetId: finished.changesetId,
          ref: finished.ref,
          from: finished.from,
          to: finished.to,
          at: Date.now(),
          ...(leaf ? { leaf } : {}),
          ...(state.prompt ? { prompt: state.prompt } : {}),
          // Agent-supplied label (the turn's own `Summary:` line) — lands
          // WITH the record; no async label turn anymore.
          ...(label ? { label } : {}),
        };
        await recordTurnRange({
          sessionDir: sessionStoreDir(repoRoot),
          record,
        });
        // G2 history rows: announce the landed turn range so the live chat
        // can grow its diff/restore row without a refetch. Tagged with the
        // TURN's session key (this function knows it exactly) — never the
        // branch active at completion time.
        const turnBranch = wireBranch(key);
        broadcast("sandbox-event", {
          type: "conversation-turn",
          ...record,
          files: finished.files,
          ...(turnBranch ? { branch: turnBranch } : {}),
        });
        if (finished.files.length > 0) {
          notice(
            `designbook committed ${finished.files.join(", ")} to this ` +
              "conversation's changeset (real files untouched until you bake).",
          );
        }
        for (const warning of finished.warnings) {
          notice(`designbook: ${warning}`);
        }
      }
    } catch (error) {
      log(`conversation turn capture failed: ${String(error)}`);
    }
    // A gate flip that arrived mid-turn applies now (conversationGate.ts).
    conversationGate.onTurnEnd(key);
  }

  /**
   * G4 — implicit fork on the conversation ask path: a prompt submitted
   * while the conversation's changeset is PARKED cuts a new ref at the
   * parked commit (selection moves onto it) and FORKS THE CHAT — the parent
   * transcript sliced at the parked turn's boundary becomes a NEW
   * session/conversation, and the live session rebuilds onto it (the same
   * resume machinery the G2 conversation-gate flip uses). The graph growing
   * a new rail is what makes the implicit cut safe.
   */
  async function maybeForkParkedConversation(
    key: string,
    promptText?: string,
  ): Promise<void> {
    if (readOnly) return;
    const conversationId = conversationIdFor(key);
    if (!conversationId) return;
    if (!conversationGate.captureAllowed(key)) return;
    const entry = sessions.peek(key);
    if (!entry) return;
    let live: AgentSession;
    try {
      live = await entry.promise;
    } catch {
      return;
    }
    if (live.isStreaming) return; // Steer/follow-up rides the current turn.
    const repoRoot = entry.cwd ?? activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    const changesetId = await sandbox.conversationChangesetId({
      repoRoot,
      appDir,
      conversationId,
    });
    const parked = await sandbox.parkState({ repoRoot, appDir, changesetId });
    if (!parked) return;

    // 1. Cut the fork ref at the parked commit (clears the park, selects
    //    it). The prompt names the fork (first 10 chars — naming rules).
    const forked = await sandbox.forkFromPark({
      repoRoot,
      appDir,
      changesetId,
      ...(promptText ? { promptText } : {}),
    });
    if (!forked.altId || !forked.ref || !forked.commit) {
      if (forked.error) log(`park fork failed: ${forked.error}`);
      return;
    }
    broadcast("server-notice", {
      message:
        "Forked a new branch from the viewed point — this prompt (and the " +
        "conversation from here) continues on the fork.",
    });

    // 2. Fork the chat: slice the parent transcript at the parked turn's
    //    message boundary into a NEW session and rebuild the live session
    //    on it. Best-effort — a failure leaves the SAME conversation
    //    continuing on the fork ref (the ref fork stands either way).
    try {
      const parentFile = live.sessionFile;
      if (!parentFile) return;
      const sessionDir = sessionStoreDir(repoRoot);
      const store = await readConversationStore(sessionDir);
      const manager = SessionManager.open(parentFile);
      const leafId = forkSliceLeaf(manager, parked.turn, store.turns);
      if (!leafId) return;
      const newFile = manager.createBranchedSession(leafId);
      if (!newFile) return;
      const newConversationId = makeConversationId();
      const newSessionId = SessionManager.open(newFile).getSessionId();
      await recordConversationTag({
        sessionDir,
        sessionId: newSessionId,
        conversationId: newConversationId,
      });
      await recordConversationFork({
        sessionDir,
        record: {
          conversationId: newConversationId,
          parentConversationId: conversationId,
          changesetId,
          ref: forked.ref,
          ...(parked.turn ? { atTurn: parked.turn } : {}),
          at: Date.now(),
        },
      });
      await sandbox.bindForkConversation({
        repoRoot,
        appDir,
        changesetId,
        altId: forked.altId,
        conversationId: newConversationId,
      });
      resumeSessions.set(key, {
        conversationId: newConversationId,
        sessionFile: newFile,
      });
      if (activeConversations.get(key) === conversationId) {
        activeConversations.set(key, newConversationId);
      }
      const previousModel = live.model;
      await sessions.dispose(key);
      const session = await sessions.get(key);
      if (previousModel && session.model?.id !== previousModel.id) {
        await session.setModel(previousModel).catch(() => {});
      }
      broadcast("state", serializeSession(session, key));
      log(
        `conversation forked at park: ${conversationId} -> ` +
          `${newConversationId} (${forked.ref})`,
      );
    } catch (error) {
      log(`conversation chat fork failed: ${String(error)} (ref fork stands)`);
    }
  }

  /** The validated selection field of a prompt payload. */
  function parsePromptSelection(raw: unknown):
    | { pinId: string; label?: string; contextSnapshot?: unknown }
    | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const selection = raw as {
      pinId?: unknown;
      label?: unknown;
      contextSnapshot?: unknown;
    };
    if (typeof selection.pinId !== "string" || !selection.pinId) {
      return undefined;
    }
    return {
      pinId: selection.pinId,
      ...(typeof selection.label === "string" && selection.label
        ? { label: selection.label }
        : {}),
      ...(selection.contextSnapshot !== undefined
        ? { contextSnapshot: selection.contextSnapshot }
        : {}),
    };
  }

  /**
   * VARIANTS from a conversation-routed selection ask: the existing
   * director/fan-out pipeline runs on the pin (unchanged), while the
   * CONVERSATION thread anchors the ask + the result — two custom
   * transcript messages (kept in LLM context, so later turns can reference
   * the variant names from memory) that the client renders as the pin-chip
   * message and the variant-cards row.
   */
  async function runConversationVariantsFlow(params: {
    key: string;
    repoRoot: string;
    appDir: string;
    pinId: string;
    label: string;
    request: string;
    n: number;
  }): Promise<void> {
    const { key } = params;
    const session = await sessions.get(key);
    const announce = async (
      customType: string,
      content: string,
      details?: unknown,
    ) => {
      await session
        .sendCustomMessage(
          {
            customType,
            content,
            display: true,
            ...(details !== undefined ? { details } : {}),
          },
          { triggerTurn: false },
        )
        .catch((error: unknown) => {
          log(`conversation variants note failed: ${String(error)}`);
        });
      broadcast("state", serializeSession(session, key));
    };
    await announce(
      "designbook-selection-ask",
      `[Selection: ${params.label}] (pin ${params.pinId})\n${params.request}`,
      { pinId: params.pinId, label: params.label, variants: true },
    );
    const result = await sandbox.runConversationVariants({
      repoRoot: params.repoRoot,
      appDir: params.appDir,
      pinId: params.pinId,
      prompt: params.request,
      n: params.n,
    });
    if (result.error) {
      await announce(
        "designbook-variants-result",
        `designbook: the variants run for "${params.label}" failed: ${result.error}`,
        { pinId: params.pinId, error: result.error },
      );
      return;
    }
    const variants = result.variants ?? [];
    const names = variants
      .map(
        (variant) =>
          `- ${variant.id}: ${variant.intent}${
            variant.status === "ready" ? "" : ` (${variant.status})`
          }`,
      )
      .join("\n");
    // System-visible note (spec: later turns can reference the fan-out
    // result) + the client's variant-cards anchor.
    await announce(
      "designbook-variants-result",
      `designbook generated ${variants.length} design variants for the ` +
        `selection "${params.label}" (pin ${params.pinId}):\n${names}\n` +
        "They preview as cards on this selection; the designer can flip, " +
        "iterate on, or bake any of them.",
      { pinId: params.pinId, label: params.label, variants },
    );
  }

  async function handlePrompt(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<PromptPayload>(request);
    const message =
      typeof payload.message === "string" ? payload.message.trim() : "";

    if (!message) {
      sendJson(response, 400, { error: "Message is required." });
      return;
    }

    const key = activeSessionKey();
    const selection = parsePromptSelection(payload.selection);
    const repoRoot = activeRepoRoot();
    const appDir = activeAppDir(repoRoot);
    const gateOpen = !readOnly && activeConversations.has(key);

    // Fresh capture per message (conversation-routed asks): the client
    // re-captured the selection at send — refresh the pin's snapshot before
    // anything reads it.
    if (selection?.contextSnapshot !== undefined) {
      const refreshed = await sandbox
        .refreshPinCapture({
          repoRoot,
          appDir,
          pinId: selection.pinId,
          contextSnapshot: selection.contextSnapshot,
        })
        .catch(() => ({ error: "capture refresh failed" }));
      if (refreshed.error) log(`pin capture refresh: ${refreshed.error}`);
    }

    // Selection-scoped INTENT pre-step (kept from the pin pipeline): only
    // VARIANTS need the cheap classifier — answer/edit is the conversation
    // turn's own judgment. Variants fan out on the pin (unchanged pipeline)
    // and anchor their results in the conversation thread; no session turn.
    if (selection && gateOpen) {
      const routed = await sandbox.classifySelectionIntent({
        repoRoot,
        appDir,
        pinId: selection.pinId,
        prompt: message,
      });
      if (routed.intent === "variants") {
        const composed = sandbox.buildSelectionTurnMessage({
          repoRoot,
          appDir,
          pinId: selection.pinId,
          request: message,
        });
        const label = selection.label ?? composed.label ?? "selection";
        logDebug(`selection ask routed to variants (n=${routed.n})`);
        void runConversationVariantsFlow({
          key,
          repoRoot,
          appDir,
          pinId: selection.pinId,
          label,
          request: message,
          n: routed.n,
        }).catch((error: unknown) => {
          log(`conversation variants flow failed: ${String(error)}`);
        });
        sendJson(response, 202, { accepted: true, routed: "variants" });
        return;
      }
    }

    // G4: new work while parked = implicit fork (ref + sliced chat) — MUST
    // resolve before the session is fetched (the fork rebuilds it).
    try {
      await maybeForkParkedConversation(key, message);
    } catch (error) {
      log(`park fork check failed: ${String(error)}`);
    }

    // PER-TURN WORKSPACE RESOLUTION (the heart of conversation-routed
    // asks): a selection-scoped turn binds the session to the selected
    // pin's changeset worktree; a plain turn to the conversation's
    // direct-edits one. Same-workspace turns never rebuild; a differing
    // one rebuilds the session on the same transcript (gate machinery).
    if (gateOpen) {
      try {
        if (selection) {
          const resolved = await sandbox.selectionChangesetId({
            repoRoot,
            appDir,
            pinId: selection.pinId,
          });
          if (resolved.changesetId) {
            turnWorkspaces.set(key, `cs:${resolved.changesetId}`);
          } else if (resolved.error) {
            log(`selection workspace resolution: ${resolved.error}`);
          }
        } else {
          const conversationId = conversationIdFor(key);
          if (conversationId) {
            const changesetId = await sandbox.conversationChangesetId({
              repoRoot,
              appDir,
              conversationId,
            });
            turnWorkspaces.set(key, `cs:${changesetId}`);
          }
        }
        await conversationGate.reconcile(key);
      } catch (error) {
        log(`turn workspace resolution failed: ${String(error)}`);
      }
    }

    const session = await getSession();
    const requestedStreamingBehavior =
      payload.streamingBehavior === "steer" ||
      payload.streamingBehavior === "followUp"
        ? payload.streamingBehavior
        : undefined;

    const streamingBehavior = session.isStreaming
      ? (requestedStreamingBehavior ?? "followUp")
      : undefined;

    // A selection-scoped turn sends the pin-context-framed message (the
    // `[Selection: …]` first line is the client's chip anchor). Composed
    // AFTER the capture refresh so the context is the fresh snapshot. With
    // the gate closed the same framing runs against the REAL tree
    // (no-conversation-active real-write mode, unchanged semantics).
    let outgoing = message;
    if (selection) {
      const composed = sandbox.buildSelectionTurnMessage({
        repoRoot,
        appDir,
        pinId: selection.pinId,
        request: message,
      });
      if (composed.message) outgoing = composed.message;
      else if (composed.error) {
        sendJson(response, 400, { error: composed.error });
        return;
      }
    }

    logDebug(
      `prompt accepted (${message.length} chars${
        streamingBehavior ? `, ${streamingBehavior}` : ""
      }${selection ? `, selection ${selection.pinId}` : ""})`,
    );
    if (selection && gateOpen) {
      pendingSelectionAsks.set(key, {
        pinId: selection.pinId,
        request: message,
      });
    }
    await beginConversationTurn(key, message);
    void session
      .prompt(outgoing, { streamingBehavior })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`prompt failed: ${message}`);
        broadcast("server-error", { message });
      })
      .finally(() => {
        void endConversationTurn(key);
      });

    sendJson(response, 202, { accepted: true });
  }

  async function handleAbort(response: ServerResponse) {
    const session = await getSession();
    await session.abort();
    sendJson(response, 200, { aborted: true });
  }

  /**
   * The worktree-removal path (per-branch-sessions spec): there is no
   * explicit "remove worktree" endpoint, so every worktree LIST reconciles
   * the session registry against the live branches — a removed worktree's
   * session is disposed (aborting any in-flight turn) and its warm dev
   * server stopped.
   */
  function reconcileSessions(liveBranches: string[]) {
    const removed = sessions.reconcile(new Set(liveBranches));
    for (const branch of removed) {
      worktreeProxy?.stopBranch?.(branch);
    }
    if (removed.length > 0) broadcastBranchStatus();
  }

  async function handleListWorktrees(response: ServerResponse) {
    try {
      const gitBranch = await getCurrentBranch(projectRoot);
      if (worktreeProxy) {
        // Proxy topology: the "current" branch is whichever worktree the
        // proxy serves right now, not the repo checkout the agent works in.
        const activeBranch = worktreeProxy.activeBranch() ?? gitBranch;
        const worktrees = await listWorktreesForProxy(
          projectRoot,
          activeBranch,
          port,
        );
        reconcileSessions(worktrees.map((worktree) => worktree.branch));
        sendJson(response, 200, { currentBranch: activeBranch, worktrees });
        return;
      }
      const worktrees = await listWorktrees(projectRoot, gitBranch, port);
      reconcileSessions(worktrees.map((worktree) => worktree.branch));
      sendJson(response, 200, { currentBranch: gitBranch, worktrees });
    } catch {
      // Not a git repo (fresh `npm create vite` app before `git init`) — branch
      // instances just aren't available; the UI hides the selector.
      sendJson(response, 200, { currentBranch: null, worktrees: [] });
    }
  }

  type WorktreePayload = {
    branch?: unknown;
  };

  async function handleEnsureWorktree(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<WorktreePayload>(request);
    const branch =
      typeof payload.branch === "string" ? payload.branch.trim() : "";

    if (!branch) {
      sendJson(response, 400, { error: "Branch name is required." });
      return;
    }

    const notify = (message: string) =>
      broadcast("server-notice", { message });

    // The UI navigates to the returned `url` verbatim (plus its own route
    // hash) — it never assembles host:port URLs itself.
    if (worktreeProxy) {
      // Proxy topology: retarget the proxied dev server to the branch's
      // worktree; the browser stays on the stable origin. While the new dev
      // server boots, the proxy's recovery page covers the gap.
      await worktreeProxy.switchTo(branch, notify);
      sendJson(response, 200, { branch, url: PROXY_SWITCH_URL });
      return;
    }

    // Host topology: each branch gets its own designbook instance; switching
    // legitimately navigates the browser to that instance's origin.
    const currentBranch = await getCurrentBranch(projectRoot);
    const instance = await ensureInstance({
      repoRoot: projectRoot,
      branch,
      currentBranch,
      configRelPath,
      hubPort: port,
      notify,
    });
    sendJson(response, 200, {
      ...instance,
      url: instanceNavigationUrl(request.headers.host, instance.port),
    });
  }

  async function handleNewSession(response: ServerResponse) {
    const key = activeSessionKey();
    const retired = conversationIdFor(key);
    // The fresh conversation gets its own direct-edits workspace — drop the
    // retired conversation's per-turn binding before the factory runs.
    turnWorkspaces.delete(key);
    const session = await resetSession();
    // L3: a drawer that was active on the RETIRED conversation follows the
    // reset onto the fresh one (the client re-reports on its next render;
    // this keeps the server consistent in the gap).
    if (retired && activeConversations.get(key) === retired) {
      const fresh = conversationIdFor(key);
      if (fresh) activeConversations.set(key, fresh);
      else activeConversations.delete(key);
    }
    const nextState = serializeSession(session, key);
    broadcast("state", nextState);
    sendJson(response, 200, nextState);
  }

  /**
   * L3 active-conversation handshake: the DRAWER reports which conversation
   * it is open on (see the spec's active-conversation definition — the
   * drawer's chat view or a pin thread of that conversation). `null` clears.
   * Manual data edits route into the active conversation's direct-edits
   * changeset; conversation turns get the overlay + bash capture.
   */
  async function handleSandboxActiveConversation(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<{ conversationId?: unknown }>(request);
    const key = activeSessionKey();
    const raw = payload.conversationId;
    if (raw === null || raw === undefined || raw === "") {
      activeConversations.delete(key);
      turnWorkspaces.delete(key);
      // G2 gate: no active conversation → the session belongs at the repo
      // root with REAL writes (rebuilt when idle; deferred mid-turn).
      await conversationGate.reconcile(key);
      sendJson(response, 200, { ok: true, active: null });
      return;
    }
    if (typeof raw !== "string" || !/^[a-z0-9-]{1,128}$/.test(raw)) {
      sendJson(response, 400, { error: "Invalid conversation id." });
      return;
    }
    activeConversations.set(key, raw);
    // Conversation active → the session belongs in a changeset worktree.
    // Resolve the DEFAULT (direct-edits) workspace here; a selection-scoped
    // prompt re-resolves per turn (conversation-routed asks).
    if (!readOnly) {
      try {
        const repoRoot = activeRepoRoot();
        const changesetId = await sandbox.conversationChangesetId({
          repoRoot,
          appDir: activeAppDir(repoRoot),
          conversationId: raw,
        });
        turnWorkspaces.set(key, `cs:${changesetId}`);
      } catch (error) {
        log(`active-conversation workspace resolution failed: ${String(error)}`);
      }
    }
    await conversationGate.reconcile(key);
    sendJson(response, 200, { ok: true, active: raw });
  }

  /** L3 branch-filtering surface: read-only changeset listing;
   * `?allBranches=1` includes foreign-branch layers tagged, never resolved. */
  async function handleSandboxChangesets(url: URL, response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    sendJson(
      response,
      200,
      await sandbox.listChangesets({
        repoRoot,
        appDir: activeAppDir(repoRoot),
        allBranches: url.searchParams.get("allBranches") === "1",
      }),
    );
  }

  type SetModelPayload = {
    provider?: unknown;
    modelId?: unknown;
  };

  async function handleModels(response: ServerResponse) {
    const models = await modelRegistry.getAvailable();
    sendJson(response, 200, {
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
      })),
    });
  }

  async function handleSetModel(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<SetModelPayload>(request);

    if (
      typeof payload.provider !== "string" ||
      typeof payload.modelId !== "string"
    ) {
      sendJson(response, 400, { error: "Provider and model id are required." });
      return;
    }

    const models = await modelRegistry.getAvailable();
    const model = models.find(
      (availableModel) =>
        availableModel.provider === payload.provider &&
        availableModel.id === payload.modelId,
    );

    if (!model) {
      sendJson(response, 404, { error: "Model is not available." });
      return;
    }

    const { key, session } = await activeSessionState();
    await session.setModel(model);
    const nextState = serializeSession(session, key);
    broadcast("state", nextState);
    sendJson(response, 200, nextState);
  }

  async function handleEvents(response: ServerResponse) {
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });

    clients.add(response);
    const { key, state } = await activeSessionState();
    sendSse(response, "state", state);
    // Badge hydration for the fresh client (a branch switch reloads the
    // page), then clear the active branch's "agent finished" badge — its
    // finished thread was just served.
    sendSse(response, "branch-status", { statuses: sessions.statuses() });
    if (sessions.peek(key)?.status === "done") {
      sessions.setStatus(key, "idle");
      broadcastBranchStatus();
    }

    const keepAlive = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, 25_000);

    response.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(response);
    });
  }

  const MARKER_CHARS = new Set(["⁡", "⁢", "​", "‌", "‍", "⁤"]);

  function containsMarkerChars(text: string): boolean {
    for (const ch of text) {
      if (MARKER_CHARS.has(ch)) return true;
    }
    return false;
  }

  type I18nPayload = {
    /** Locale file path relative to the config file, e.g. "./locales/en-US/app.json". */
    path?: unknown;
    entries?: unknown;
  };

  function resolveLocaleFile(
    relPath: string,
    repoRoot: string,
  ): string | undefined {
    const localeFile = resolve(activeConfigDirFor(repoRoot), relPath);
    const insideProject = relative(repoRoot, localeFile);
    if (insideProject.startsWith("..") || insideProject.startsWith("/")) {
      return undefined;
    }
    if (!localeFile.endsWith(".json")) {
      return undefined;
    }
    return localeFile;
  }

  async function handleI18nUpdate(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<I18nPayload>(request);

    const repoRoot = activeRepoRoot();
    const relPath = typeof payload.path === "string" ? payload.path : "";
    const localeFile = relPath
      ? resolveLocaleFile(relPath, repoRoot)
      : undefined;
    if (!localeFile) {
      sendJson(response, 400, {
        error: "A locale JSON path inside the project is required.",
      });
      return;
    }

    if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
      sendJson(response, 400, { error: "Entries array is required." });
      return;
    }

    const entries: Array<{ key: string; value: string }> = [];
    for (const raw of payload.entries) {
      const entry = raw as { key?: unknown; value?: unknown };
      if (typeof entry.key !== "string" || typeof entry.value !== "string") {
        sendJson(response, 400, {
          error: "Each entry must have key and value.",
        });
        return;
      }
      if (containsMarkerChars(entry.value)) {
        sendJson(response, 400, {
          error: "Value contains invisible marker characters.",
        });
        return;
      }
      if (/\{\{[^}]*\{\{|\}\}[^{]*\}\}/.test(entry.value)) {
        sendJson(response, 400, {
          error: "Value contains malformed placeholder syntax.",
        });
        return;
      }
      entries.push({ key: entry.key, value: entry.value });
    }

    // L3: with an ACTIVE conversation the text-tool edit routes into its
    // direct-edits changeset (real file untouched, served merged); without
    // one it writes the real layer exactly as before.
    const i18nConversation = activeConversations.get(activeSessionKey());
    if (i18nConversation) {
      const staged = await sandbox.stageDirectDataEdit({
        repoRoot,
        appDir: activeAppDir(repoRoot),
        conversationId: i18nConversation,
        rel: toRepoRel(repoRoot, localeFile),
        apply: (current) => {
          let raw = current;
          for (const entry of entries) {
            if (entry.key.startsWith("@")) {
              return { error: "Cannot modify metadata keys." };
            }
            const updated = replaceJsonStringValue(raw, entry.key, entry.value);
            if (updated === undefined) {
              return { error: `Key not found or not a string: ${entry.key}` };
            }
            raw = updated;
          }
          try {
            JSON.parse(raw);
          } catch {
            return { error: "Result is not valid JSON.", status: 500 };
          }
          return { updated: raw };
        },
      });
      if (staged.error) {
        sendJson(response, staged.status ?? 400, { error: staged.error });
        return;
      }
      if (staged.staged) {
        sendJson(response, 200, { ok: true, staged: true });
        return;
      }
      // Unrepresentable as key changes — fall through to the real write.
    }

    try {
      const fileStat = await stat(localeFile).catch(() => undefined);
      if (!fileStat?.isFile()) {
        sendJson(response, 404, { error: `Locale file not found: ${relPath}` });
        return;
      }

      let raw = await readFile(localeFile, "utf8");

      for (const entry of entries) {
        if (entry.key.startsWith("@")) {
          sendJson(response, 400, {
            error: "Cannot modify metadata keys.",
          });
          return;
        }
        const updated = replaceJsonStringValue(raw, entry.key, entry.value);
        if (updated === undefined) {
          sendJson(response, 400, {
            error: `Key not found or not a string: ${entry.key}`,
          });
          return;
        }
        raw = updated;
      }

      JSON.parse(raw);
      // Locale files sit in `watch.ignored`, so this record isn't for HMR
      // suppression — it's how the injected plugin learns to invalidate the
      // stale transform-cache entry for the compiled locale module.
      noteDataWrite(localeFile, repoRoot);
      await writeFile(localeFile, raw, "utf8");
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  }

  type PoPayload = {
    /** Catalog file path relative to the config file, e.g. "packages/lib/translations/en/web.po". */
    path?: unknown;
    /** Lingui message id (the gettext `msgid`; for source catalogs, the English text). */
    msgid?: unknown;
    /** New translation to write into the entry's `msgstr`. */
    msgstr?: unknown;
  };

  /** Resolves a `.po` catalog path (config-relative), or undefined if it escapes the project. */
  function resolvePoFile(
    relPath: string,
    repoRoot: string,
  ): string | undefined {
    const poFile = resolve(activeConfigDirFor(repoRoot), relPath);
    const insideProject = relative(repoRoot, poFile);
    if (insideProject.startsWith("..") || insideProject.startsWith("/")) {
      return undefined;
    }
    if (!poFile.endsWith(".po")) {
      return undefined;
    }
    return poFile;
  }

  async function handlePoUpdate(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<PoPayload>(request);

    const repoRoot = activeRepoRoot();
    const relPath = typeof payload.path === "string" ? payload.path : "";
    const poFile = relPath ? resolvePoFile(relPath, repoRoot) : undefined;
    if (!poFile) {
      sendJson(response, 400, {
        error: "A .po catalog path inside the project is required.",
      });
      return;
    }
    if (typeof payload.msgid !== "string" || typeof payload.msgstr !== "string") {
      sendJson(response, 400, { error: "msgid and msgstr are required." });
      return;
    }
    if (containsMarkerChars(payload.msgstr)) {
      sendJson(response, 400, {
        error: "Value contains invisible marker characters.",
      });
      return;
    }

    // L3: active conversation → direct-edits changeset (see handleI18nUpdate).
    const poConversation = activeConversations.get(activeSessionKey());
    if (poConversation) {
      const msgid = payload.msgid;
      const msgstr = payload.msgstr;
      const staged = await sandbox.stageDirectDataEdit({
        repoRoot,
        appDir: activeAppDir(repoRoot),
        conversationId: poConversation,
        rel: toRepoRel(repoRoot, poFile),
        apply: (current) => {
          const updated = replacePoMsgstr(current, msgid, msgstr);
          return updated === undefined
            ? { error: `Message id not found in catalog: ${msgid}` }
            : { updated };
        },
      });
      if (staged.error) {
        sendJson(response, staged.status ?? 400, { error: staged.error });
        return;
      }
      if (staged.staged) {
        log(`staged po: ${relPath} (${payload.msgid.slice(0, 40)})`);
        sendJson(response, 200, { ok: true, staged: true });
        return;
      }
    }

    try {
      const fileStat = await stat(poFile).catch(() => undefined);
      if (!fileStat?.isFile()) {
        sendJson(response, 404, { error: `Catalog not found: ${relPath}` });
        return;
      }

      const raw = await readFile(poFile, "utf8");
      const updated = replacePoMsgstr(raw, payload.msgid, payload.msgstr);
      if (updated === undefined) {
        sendJson(response, 400, {
          error: `Message id not found in catalog: ${payload.msgid}`,
        });
        return;
      }

      noteDataWrite(poFile, repoRoot);
      await writeFile(poFile, updated, "utf8");
      log(`wrote po: ${relPath} (${payload.msgid.slice(0, 40)})`);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  }

  /** Resolves a repo-relative source path against the ACTIVE root, or undefined if it escapes it or has a disallowed extension. */
  function resolveSourceFile(
    relPath: string,
    repoRoot: string,
  ): string | undefined {
    return resolveSourceFileIn(repoRoot, relPath);
  }

  async function handleGetFile(url: URL, response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    const relPath = url.searchParams.get("path") ?? "";
    const sourceFile = relPath
      ? resolveSourceFile(relPath, repoRoot)
      : undefined;

    if (!sourceFile) {
      sendJson(response, 400, {
        error:
          "A source file path inside the project with a supported extension is required.",
      });
      return;
    }

    const fileStat = await stat(sourceFile).catch(() => undefined);
    if (!fileStat?.isFile()) {
      sendJson(response, 404, { error: `File not found: ${relPath}` });
      return;
    }

    const content = await readFile(sourceFile, "utf8");
    sendJson(response, 200, { path: relPath, content });
  }

  type WriteFilePayload = {
    path?: unknown;
    content?: unknown;
  };

  async function handleWriteFile(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<WriteFilePayload>(request);

    if (
      typeof payload.path !== "string" ||
      typeof payload.content !== "string"
    ) {
      sendJson(response, 400, { error: "path and content are required." });
      return;
    }

    const sourceFile = resolveSourceFile(payload.path, activeRepoRoot());
    if (!sourceFile) {
      sendJson(response, 400, {
        error:
          "A source file path inside the project with a supported extension is required.",
      });
      return;
    }

    const fileStat = await stat(sourceFile).catch(() => undefined);
    if (!fileStat?.isFile()) {
      sendJson(response, 404, { error: `File not found: ${payload.path}` });
      return;
    }

    await writeFile(sourceFile, payload.content, "utf8");
    log(`wrote file: ${payload.path}`);
    sendJson(response, 200, { ok: true });
  }

  // --- Changes tab (git working tree vs HEAD) -----------------------------

  async function handleListChanges(response: ServerResponse) {
    sendJson(response, 200, await listChanges(activeRepoRoot()));
  }

  async function handleFileDiff(url: URL, response: ServerResponse) {
    const repoRoot = activeRepoRoot();
    const relPath = url.searchParams.get("path") ?? "";
    const absPath = relPath
      ? resolveContainedPath(repoRoot, relPath)
      : undefined;
    if (!absPath) {
      sendJson(response, 400, {
        error: "A file path inside the project is required.",
      });
      return;
    }
    sendJson(response, 200, await fileDiff(repoRoot, relPath, absPath));
  }

  type DiscardPayload = { path?: unknown };

  async function handleDiscardChange(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<DiscardPayload>(request);
    const repoRoot = activeRepoRoot();
    const relPath = typeof payload.path === "string" ? payload.path : "";
    const absPath = relPath
      ? resolveContainedPath(repoRoot, relPath)
      : undefined;
    if (!absPath) {
      sendJson(response, 400, {
        error: "A file path inside the project is required.",
      });
      return;
    }

    try {
      const result = await discardChange(repoRoot, relPath, absPath);
      for (const touched of result.touchedPaths) {
        // Treat the restore like any designbook write so HMR-suppress drops
        // the echo the Changes tab already reflects.
        noteDataWrite(resolve(repoRoot, touched), repoRoot);
      }
      log(`discarded changes: ${relPath}`);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const status = (error as Partial<{ status: number }>).status;
      if (typeof status === "number") {
        sendJson(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
  }

  type JsonWritePayload = {
    /** Repo-relative `.json` path, e.g. "src/flags/tenants.json". */
    path?: unknown;
    /** Dot-separated key path, e.g. "acme.newCheckout". */
    keyPath?: unknown;
    /** New value (bool/number/enum/string). */
    value?: unknown;
    /** Create the key (and any missing parents) if absent, instead of 400. */
    create?: unknown;
  };

  async function handleJsonWrite(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<JsonWritePayload>(request);

    if (
      typeof payload.path !== "string" ||
      typeof payload.keyPath !== "string"
    ) {
      sendJson(response, 400, { error: "path and keyPath are required." });
      return;
    }

    const repoRoot = activeRepoRoot();
    const sourceFile = resolveSourceFile(payload.path, repoRoot);
    if (!sourceFile || !sourceFile.endsWith(".json")) {
      sendJson(response, 400, {
        error: "A JSON file path inside the project is required.",
      });
      return;
    }

    const fileStat = await stat(sourceFile).catch(() => undefined);
    if (!fileStat?.isFile()) {
      sendJson(response, 404, { error: `File not found: ${payload.path}` });
      return;
    }

    // L3: active conversation → direct-edits changeset (see handleI18nUpdate).
    const jsonConversation = activeConversations.get(activeSessionKey());
    if (jsonConversation) {
      const keyPath = payload.keyPath;
      const create = payload.create === true;
      let stagedMode: "mutate" | "add" = "add";
      const staged = await sandbox.stageDirectDataEdit({
        repoRoot,
        appDir: activeAppDir(repoRoot),
        conversationId: jsonConversation,
        rel: toRepoRel(repoRoot, sourceFile),
        apply: (current) => {
          stagedMode = jsonKeyExists(current, keyPath) ? "mutate" : "add";
          const updated = create
            ? setJsonValue(current, keyPath, payload.value)
            : replaceJsonValue(current, keyPath, payload.value);
          if (updated === undefined) {
            return {
              error: create
                ? `Cannot set key path (a segment is not an object): ${keyPath}`
                : `Key path not found: ${keyPath}`,
            };
          }
          try {
            JSON.parse(updated);
          } catch {
            return { error: "Result is not valid JSON.", status: 500 };
          }
          return { updated };
        },
      });
      if (staged.error) {
        sendJson(response, staged.status ?? 400, { error: staged.error });
        return;
      }
      if (staged.staged) {
        log(`staged json: ${payload.path} ${keyPath} (${stagedMode})`);
        sendJson(response, 200, { ok: true, mode: stagedMode, staged: true });
        return;
      }
    }

    const raw = await readFile(sourceFile, "utf8");
    // Add-vs-mutate is decided mechanically here (an existing key path = a
    // mutate, absent = an add). This is a MANUAL real-layer write (text tool /
    // adapter UI) — unrestricted by design; the classification is surfaced
    // (logged + returned) but never enforced. Additive-only enforcement lives
    // on the SANDBOX-turn path (post-turn classification), whose writes go
    // through agent tools, not this endpoint.
    const mode = jsonKeyExists(raw, payload.keyPath) ? "mutate" : "add";
    const updated =
      payload.create === true
        ? setJsonValue(raw, payload.keyPath, payload.value)
        : replaceJsonValue(raw, payload.keyPath, payload.value);
    if (updated === undefined) {
      sendJson(response, 400, {
        error: payload.create
          ? `Cannot set key path (a segment is not an object): ${payload.keyPath}`
          : `Key path not found: ${payload.keyPath}`,
      });
      return;
    }

    try {
      JSON.parse(updated);
    } catch {
      sendJson(response, 500, { error: "Result is not valid JSON." });
      return;
    }

    noteDataWrite(sourceFile, repoRoot);
    await writeFile(sourceFile, updated, "utf8");
    log(`wrote json: ${payload.path} ${payload.keyPath} (${mode})`);
    sendJson(response, 200, { ok: true, mode });
  }

  type StyleWritePayload = {
    /** Repo-relative `.css` path, e.g. "examples/demo/src/index.css". */
    path?: unknown;
    /** Selector whose block holds the var, e.g. ":root" or ".dark". */
    selector?: unknown;
    /** Custom-property name without the leading `--`, e.g. "primary". */
    prop?: unknown;
    /** New value (may contain spaces/parens, e.g. an oklch() color). */
    value?: unknown;
  };

  async function handleStyleWrite(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<StyleWritePayload>(request);

    if (
      typeof payload.path !== "string" ||
      typeof payload.selector !== "string" ||
      typeof payload.prop !== "string" ||
      typeof payload.value !== "string"
    ) {
      sendJson(response, 400, {
        error: "path, selector, prop, and value are required.",
      });
      return;
    }

    const repoRoot = activeRepoRoot();
    const sourceFile = resolveSourceFile(payload.path, repoRoot);
    if (!sourceFile || !sourceFile.endsWith(".css")) {
      sendJson(response, 400, {
        error: "A CSS file path inside the project is required.",
      });
      return;
    }

    const fileStat = await stat(sourceFile).catch(() => undefined);
    if (!fileStat?.isFile()) {
      sendJson(response, 404, { error: `File not found: ${payload.path}` });
      return;
    }

    // L3: active conversation → direct-edits changeset (see handleI18nUpdate).
    const styleConversation = activeConversations.get(activeSessionKey());
    if (styleConversation) {
      const { selector, prop, value } = payload;
      const staged = await sandbox.stageDirectDataEdit({
        repoRoot,
        appDir: activeAppDir(repoRoot),
        conversationId: styleConversation,
        rel: toRepoRel(repoRoot, sourceFile),
        apply: (current) => {
          const updated = replaceCssVar(current, selector, prop, value);
          return updated === undefined
            ? { error: `Selector or property not found: ${selector} --${prop}` }
            : { updated };
        },
      });
      if (staged.error) {
        sendJson(response, staged.status ?? 400, { error: staged.error });
        return;
      }
      if (staged.staged) {
        log(`staged style: ${payload.path} ${selector} --${prop}`);
        sendJson(response, 200, { ok: true, staged: true });
        return;
      }
    }

    const raw = await readFile(sourceFile, "utf8");
    const updated = replaceCssVar(
      raw,
      payload.selector,
      payload.prop,
      payload.value,
    );
    if (updated === undefined) {
      sendJson(response, 400, {
        error: `Selector or property not found: ${payload.selector} --${payload.prop}`,
      });
      return;
    }

    noteDataWrite(sourceFile, repoRoot);
    await writeFile(sourceFile, updated, "utf8");
    log(`wrote style: ${payload.path} ${payload.selector} --${payload.prop}`);
    sendJson(response, 200, { ok: true });
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    logDebug(`${request.method} ${url.pathname}`);
    const requestKey = `${request.method} ${url.pathname}`;
    if (
      readOnly &&
      (READ_ONLY_BLOCKED_ROUTES.has(requestKey) ||
        integrationRegistry.writeRouteKeys().has(requestKey))
    ) {
      sendJson(response, 403, {
        error: "designbook is running in --read-only mode; writes are disabled.",
      });
      return;
    }
    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        const { state } = await activeSessionState();
        sendJson(response, 200, state);
        return;
      }

      if (url.pathname === "/api/recent-writes" && request.method === "GET") {
        // Cross-process write-suppression: the injected plugin polls this to learn
        // which paths designbook just wrote, so it can drop the matching hot
        // update in the target app's separate Vite process.
        sendJson(response, 200, { writes: recentWrites.list() });
        return;
      }

      if (url.pathname === "/api/models" && request.method === "GET") {
        await handleModels(response);
        return;
      }

      if (url.pathname === "/api/model" && request.method === "POST") {
        await handleSetModel(request, response);
        return;
      }

      if (url.pathname === "/api/events" && request.method === "GET") {
        await handleEvents(response);
        return;
      }

      if (url.pathname === "/api/prompt" && request.method === "POST") {
        await handlePrompt(request, response);
        return;
      }

      if (url.pathname === "/api/abort" && request.method === "POST") {
        await handleAbort(response);
        return;
      }

      if (url.pathname === "/api/variations" && request.method === "GET") {
        await handleVariationsStatus(response);
        return;
      }

      if (
        url.pathname === "/api/variations/generate" &&
        request.method === "POST"
      ) {
        await handleVariationsGenerate(request, response);
        return;
      }

      if (
        url.pathname === "/api/variations/iterate" &&
        request.method === "POST"
      ) {
        await handleVariationsIterate(request, response);
        return;
      }

      if (
        url.pathname === "/api/variations/retry" &&
        request.method === "POST"
      ) {
        await handleVariationsRetry(request, response);
        return;
      }

      if (
        url.pathname === "/api/variations/resolve" &&
        request.method === "POST"
      ) {
        await handleVariationsResolve(request, response);
        return;
      }

      if (url.pathname === "/api/sandbox" && request.method === "GET") {
        await handleSandboxStatus(response);
        return;
      }

      if (url.pathname === "/api/sandbox/pin" && request.method === "POST") {
        await handleSandboxPin(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/source-owner" &&
        request.method === "GET"
      ) {
        await handleSandboxSourceOwner(url, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/prompt" &&
        request.method === "POST"
      ) {
        await handleSandboxPrompt(request, response);
        return;
      }

      if (url.pathname === "/api/props-schema" && request.method === "GET") {
        await handlePropsSchema(url, response);
        return;
      }

      if (url.pathname === "/api/props-edit" && request.method === "POST") {
        await handlePropsEdit(request, response);
        return;
      }

      if (url.pathname === "/api/sandbox/ask" && request.method === "POST") {
        await handleSandboxAsk(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/threads" &&
        request.method === "GET"
      ) {
        await handleSandboxThreads(response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/thread" &&
        request.method === "GET"
      ) {
        await handleSandboxThreadTranscript(response, url);
        return;
      }

      if (
        url.pathname === "/api/sandbox/iterate" &&
        request.method === "POST"
      ) {
        await handleSandboxIterate(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/retry" &&
        request.method === "POST"
      ) {
        await handleSandboxRetry(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/render-failure" &&
        request.method === "POST"
      ) {
        await handleSandboxRenderFailure(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/replace" &&
        request.method === "POST"
      ) {
        await handleSandboxReplace(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/replace-crash" &&
        request.method === "POST"
      ) {
        await handleSandboxReplaceCrash(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/position" &&
        request.method === "POST"
      ) {
        await handleSandboxPosition(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/switches" &&
        request.method === "GET"
      ) {
        await handleSandboxSwitches(response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/switch" &&
        request.method === "POST"
      ) {
        await handleSandboxSwitch(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/redirects" &&
        request.method === "GET"
      ) {
        await handleSandboxRedirects(response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/activate" &&
        request.method === "POST"
      ) {
        await handleSandboxActivate(request, response);
        return;
      }

      if (url.pathname === "/api/sandbox/bake" && request.method === "POST") {
        await handleSandboxBake(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/discard" &&
        request.method === "POST"
      ) {
        await handleSandboxDiscard(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/rollback" &&
        request.method === "POST"
      ) {
        await handleSandboxRollback(request, response);
        return;
      }

      if (url.pathname === "/api/sandbox/rebase" && request.method === "POST") {
        await handleSandboxRebase(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/bake-to-branch" &&
        request.method === "POST"
      ) {
        await handleSandboxBakeToBranch(request, response);
        return;
      }

      if (url.pathname === "/api/sandbox/turns" && request.method === "GET") {
        await handleSandboxTurns(url, response);
        return;
      }

      if (url.pathname === "/api/sandbox/park" && request.method === "POST") {
        await handleSandboxPark(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/ref-title" &&
        request.method === "POST"
      ) {
        await handleSandboxRefTitle(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/history-graph" &&
        request.method === "GET"
      ) {
        await handleSandboxHistoryGraph(url, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/turn-diff" &&
        request.method === "GET"
      ) {
        await handleSandboxTurnDiff(url, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/reapply" &&
        request.method === "POST"
      ) {
        await handleSandboxReapply(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/compose" &&
        request.method === "POST"
      ) {
        await handleSandboxCompose(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/active-conversation" &&
        request.method === "POST"
      ) {
        await handleSandboxActiveConversation(request, response);
        return;
      }

      if (
        url.pathname === "/api/sandbox/changesets" &&
        request.method === "GET"
      ) {
        await handleSandboxChangesets(url, response);
        return;
      }

      if (url.pathname === "/api/new-session" && request.method === "POST") {
        await handleNewSession(response);
        return;
      }

      if (url.pathname === "/api/worktrees" && request.method === "GET") {
        await handleListWorktrees(response);
        return;
      }

      if (url.pathname === "/api/worktrees" && request.method === "POST") {
        await handleEnsureWorktree(request, response);
        return;
      }

      if (url.pathname === "/api/i18n" && request.method === "POST") {
        await handleI18nUpdate(request, response);
        return;
      }

      if (url.pathname === "/api/po" && request.method === "POST") {
        await handlePoUpdate(request, response);
        return;
      }

      if (url.pathname === "/api/changes" && request.method === "GET") {
        await handleListChanges(response);
        return;
      }

      if (url.pathname === "/api/file-diff" && request.method === "GET") {
        await handleFileDiff(url, response);
        return;
      }

      if (
        url.pathname === "/api/changes/discard" &&
        request.method === "POST"
      ) {
        await handleDiscardChange(request, response);
        return;
      }

      if (url.pathname === "/api/file" && request.method === "GET") {
        await handleGetFile(url, response);
        return;
      }

      if (url.pathname === "/api/file" && request.method === "POST") {
        await handleWriteFile(request, response);
        return;
      }

      if (url.pathname === "/api/json" && request.method === "POST") {
        await handleJsonWrite(request, response);
        return;
      }

      if (url.pathname === "/api/style" && request.method === "POST") {
        await handleStyleWrite(request, response);
        return;
      }

      // Integration routes (canonical /api/x/<name>/… + legacy aliases), all
      // same-origin-gated by the callers like every other /api route.
      const integrationRoute = integrationRegistry.match(
        request.method ?? "GET",
        url.pathname,
      );
      if (integrationRoute) {
        await integrationRoute.route.handler(
          request,
          response,
          url,
          integrationRoute.ctx,
        );
        return;
      }

      if (
        (url.pathname === "/api/hello" ||
          url.pathname === "/api/figma-hello") &&
        request.method === "GET"
      ) {
        // Generic tool-discovery probe (E1): public identity info only
        // ({app, version, port}). Device plugins run from opaque origins (the
        // Figma plugin's UI iframe is a data: URL, origin "null"), so this is
        // deliberately the ONLY cross-origin-exempt route — ACAO:* here,
        // exempted from the same-origin gate in apiOrigin.ts. Integrations
        // cannot declare their own exemptions. `/api/figma-hello` is the
        // legacy alias the shipped Figma plugin probes.
        response.setHeader("Access-Control-Allow-Origin", "*");
        sendJson(response, 200, {
          app: "designbook",
          version: packageVersion,
          port,
        });
        return;
      }

      sendJson(response, 404, { error: "Unknown API route." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`api error on ${url.pathname}: ${message}`);
      sendJson(response, 500, { error: message });
    }
  }

  /**
   * Route a WS upgrade to an integration's core device bridge. Only
   * `/api/bridge/<name>` (plus declared legacy aliases like
   * `/api/figma-bridge`) upgrade; returns false when `pathname` is not a
   * bridge path so the caller can proxy/ignore it.
   */
  function handleBridgeUpgrade(
    pathname: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    const bridge = integrationRegistry.bridgeForUpgradePath(pathname);
    if (!bridge) return false;
    bridge.handleUpgrade(request, socket, head);
    return true;
  }

  async function shutdown() {
    stopAllInstances();
    // Reap every branch's session (aborts in-flight turns).
    await sessions.disposeAll();
  }

  return { handle, handleBridgeUpgrade, shutdown };
}

export { createApi };
export type { ApiOptions, WorktreeProxy };
