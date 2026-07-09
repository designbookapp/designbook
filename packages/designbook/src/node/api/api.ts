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
  replaceJsonStringValue,
  replaceJsonValue,
  setJsonValue,
} from "./jsonEdit.ts";
import { replacePoMsgstr } from "./poEdit.ts";
import { replaceCssVar } from "./cssVarEdit.ts";
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
} from "./sessionRegistry.ts";
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
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd,
      authStorage,
      modelRegistry,
      // The SDK is cwd-scoped, so transcripts persist per branch.
      sessionManager: SessionManager.create(cwd),
      settingsManager,
      ...(resourceLoader ? { resourceLoader } : {}),
      customTools: integrationRegistry.piTools(),
      ...(readOnly ? { tools: READ_ONLY_TOOL_NAMES } : {}),
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

  function serializeSession(session: AgentSession, key: string) {
    const entry = sessions.peek(key);
    return {
      // Scoping key: ABSENT for primary (wire compat); the chat binds its
      // thread to this and drops other branches' pi-events.
      branch: wireBranch(key),
      // Display: the session's git branch (primary included).
      branchName: entry?.branchName,
      cwd: entry?.cwd ?? projectRoot,
      isStreaming: session.isStreaming,
      messages: session.messages,
      model: session.model,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
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
  };

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

    const session = await getSession();
    const requestedStreamingBehavior =
      payload.streamingBehavior === "steer" ||
      payload.streamingBehavior === "followUp"
        ? payload.streamingBehavior
        : undefined;

    const streamingBehavior = session.isStreaming
      ? (requestedStreamingBehavior ?? "followUp")
      : undefined;

    logDebug(
      `prompt accepted (${message.length} chars${streamingBehavior ? `, ${streamingBehavior}` : ""})`,
    );
    void session
      .prompt(message, { streamingBehavior })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`prompt failed: ${message}`);
        broadcast("server-error", { message });
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
    const session = await resetSession();
    const nextState = serializeSession(session, activeSessionKey());
    broadcast("state", nextState);
    sendJson(response, 200, nextState);
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

    const raw = await readFile(sourceFile, "utf8");
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
    log(`wrote json: ${payload.path} ${payload.keyPath}`);
    sendJson(response, 200, { ok: true });
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
