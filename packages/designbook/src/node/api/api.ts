/**
 * The `/api/*` routes: an embedded Pi coding-agent session (chat over SSE),
 * git-worktree branch instances, and locale JSON write-back for the canvas
 * text tool. Ported from the design MVP's standalone server.
 */

import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import {
  ensureInstance,
  getCurrentBranch,
  listWorktrees,
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
import { READ_ONLY_BLOCKED_ROUTES } from "./readOnlyRoutes.ts";
import {
  resolveContainedPath,
  resolveSourceFile as resolveSourceFileIn,
} from "./sourcePaths.ts";
import { createRecentWrites, toRepoRel } from "../sidecar/hmrSuppress.ts";
import { createFigmaBridge } from "../figma/figmaBridge.ts";
import { formatPullPrompt } from "../../config/figmaPullPrompt.ts";
import type { PullRenderContext } from "../../config/figmaRender.ts";
import { createDesignbookResourceLoader } from "./piSkills.ts";

const execFileAsync = promisify(execFile);

/** The SDK's read-class built-in tool names (see createReadOnlyTools in the pinned SDK). */
const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"];

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
};

function createApi(options: ApiOptions) {
  const {
    configPath,
    projectRoot,
    port,
    debug = false,
    readOnly = false,
    trustProject = false,
    onDataWrite,
  } = options;
  const configDir = dirname(configPath);
  const configRelPath = relative(projectRoot, configPath);
  const agentCwd = projectRoot;

  const clients = new Set<ServerResponse>();

  // Short-lived record of repo-relative paths designbook just wrote through a
  // data endpoint. Consumed two ways: host mode passes
  // `onDataWrite` and suppresses the matching hot-update in-process; injected
  // mode runs in a SEPARATE process (the target app's Vite) and polls this
  // record via `GET /api/recent-writes`. Both drop the adapter-managed reload
  // the UI already reflects optimistically.
  const recentWrites = createRecentWrites();
  function noteDataWrite(absPath: string) {
    recentWrites.record(toRepoRel(projectRoot, absPath));
    onDataWrite?.(absPath);
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  let sessionPromise: Promise<AgentSession> | undefined;
  let unsubscribe: (() => void) | undefined;

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

  function sendJson(
    response: ServerResponse,
    status: number,
    payload: unknown,
  ) {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(payload));
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

  // --- Figma bridge ------------------------------------------------------
  //
  // A Figma plugin's UI iframe connects outbound to `/api/figma-bridge`
  // (plugins can't listen on a socket) and executes `figma.*` calls on our
  // behalf. See figmaBridge.ts for the wire protocol.
  const figmaBridge = createFigmaBridge();
  figmaBridge.onEvent((name, data) => {
    broadcast("figma-event", { name, data });
  });
  figmaBridge.onConnectionChange((connected) => {
    log(`figma plugin ${connected ? "connected" : "disconnected"}`);
  });

  type FigmaNodeSummary = {
    id: string;
    name: string;
    type: string;
    width?: number;
    height?: number;
    fills?: unknown;
    characters?: string;
  };

  function summarizeFigmaNodes(nodes: FigmaNodeSummary[]): string {
    if (nodes.length === 0) return "No nodes selected in Figma.";
    const lines = nodes.map((node) => {
      const size =
        node.width !== undefined && node.height !== undefined
          ? ` ${Math.round(node.width)}x${Math.round(node.height)}`
          : "";
      const text = node.characters ? ` "${node.characters}"` : "";
      return `- ${node.name} (${node.type}, id: ${node.id})${size}${text}`;
    });
    return `Selected ${nodes.length} node(s) in Figma:\n${lines.join("\n")}`;
  }

  // Decision #6 (tool registration while no plugin is connected): the Pi SDK
  // only accepts `customTools` at `createAgentSession()` time — there is no
  // `registerTool`/`unregisterTool` on a live `AgentSession` (that API only
  // exists on the extension runtime's `pi` object, which this embedding
  // doesn't use). So instead of a disruptive session reset every time a
  // plugin connects/disconnects, the Figma tools are registered statically
  // and always active; each `execute` just throws a clear, LLM-facing error
  // when `figmaBridge.isConnected()` is false (the SDK catches thrown tool
  // errors, marks the result `isError: true`, and keeps the session alive —
  // see pi-coding-agent/docs/extensions.md "Signaling errors"). `figma_status`
  // lets Pi (and the designer) check connection state without a round trip.
  const figmaTools: ToolDefinition[] = [
    defineTool({
      name: "figma_get_selection",
      label: "Get Figma Selection",
      description:
        "Reads the current selection in the connected Figma file (requires the designbook Figma plugin to be running and connected).",
      parameters: Type.Object({}),
      execute: async () => {
        const nodes = (await figmaBridge.invoke(
          "figma_get_selection",
          {},
        )) as FigmaNodeSummary[];
        return {
          content: [{ type: "text" as const, text: summarizeFigmaNodes(nodes) }],
          details: { nodes },
        };
      },
    }),
    defineTool({
      name: "figma_create_frame",
      label: "Create Figma Frame",
      description:
        "Creates a new frame on the current page of the connected Figma file (requires the designbook Figma plugin to be running and connected).",
      parameters: Type.Object({
        name: Type.String({ description: "Name for the new frame." }),
        width: Type.Number({ description: "Frame width in px." }),
        height: Type.Number({ description: "Frame height in px." }),
        fills: Type.Optional(
          Type.Array(
            Type.Object({
              type: Type.String({ description: 'Paint type, e.g. "SOLID".' }),
              color: Type.Optional(
                Type.Object({
                  r: Type.Number(),
                  g: Type.Number(),
                  b: Type.Number(),
                }),
              ),
              opacity: Type.Optional(Type.Number()),
            }),
            { description: "Fills to apply to the frame." },
          ),
        ),
        text: Type.Optional(
          Type.String({
            description: "Optional text content added as a child text node.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const result = (await figmaBridge.invoke("figma_create_frame", params)) as {
          nodeId: string;
          url: string;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Created frame "${params.name}" in Figma: ${result.url}`,
            },
          ],
          details: result,
        };
      },
    }),
    defineTool({
      name: "figma_get_variables",
      label: "Get Figma Variables",
      description:
        "Reads every local variable collection (modes + variables with their per-mode values) from the connected Figma file (requires the designbook Figma plugin to be running and connected). Structural — no token mapping is applied.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = (await figmaBridge.invoke(
          "figma_get_variables",
          {},
        )) as { collections?: unknown[] };
        const count = Array.isArray(result.collections)
          ? result.collections.length
          : 0;
        return {
          content: [
            {
              type: "text" as const,
              text: `Read ${count} local variable collection(s) from Figma.`,
            },
          ],
          details: result,
        };
      },
    }),
    defineTool({
      name: "figma_set_variables",
      label: "Set Figma Variables",
      description:
        "Creates or updates a local variable collection and its variables in the connected Figma file (requires the designbook Figma plugin to be running and connected). Structural — values are passed through verbatim (COLOR as {r,g,b,a}).",
      parameters: Type.Object({
        collection: Type.String({ description: "Collection name to find or create." }),
        modes: Type.Array(Type.String(), {
          description: "Mode names to ensure exist on the collection.",
        }),
        variables: Type.Array(
          Type.Object({
            name: Type.String(),
            type: Type.Union([
              Type.Literal("COLOR"),
              Type.Literal("FLOAT"),
              Type.Literal("STRING"),
            ]),
            valuesByMode: Type.Record(Type.String(), Type.Any()),
          }),
          { description: "Variables to create/update, with per-mode values." },
        ),
      }),
      execute: async (_toolCallId, params) => {
        const result = (await figmaBridge.invoke(
          "figma_set_variables",
          params,
        )) as { collectionId: string; created: number; updated: number };
        return {
          content: [
            {
              type: "text" as const,
              text: `Synced Figma collection "${params.collection}": ${result.created} created, ${result.updated} updated.`,
            },
          ],
          details: result,
        };
      },
    }),
    defineTool({
      name: "figma_pull_component",
      label: "Pull Figma Component",
      description:
        "Reads a designbook component out of the connected Figma file as an annotated HTML target (the declarative render the designer authored), and returns a prompt asking you to rewrite the component so it renders that output. Handles both edits and brand-new components. Follow the figma-pull skill for the annotation format (data-slot/data-i18n/data-token-*/data-component/data-list) and reconciliation rules. Requires the designbook Figma plugin running and a prior push of the component. Read the component's source before editing.",
      parameters: Type.Object({
        componentId: Type.String({
          description:
            'designbook registry id of the component, e.g. "product.ProductCard".',
        }),
      }),
      execute: async (_toolCallId, params) => {
        const { html, render } = await pullComponentHtml(params.componentId);
        const text = formatPullPrompt({
          componentId: params.componentId,
          html,
          render,
        });
        return {
          content: [{ type: "text" as const, text }],
          details: { componentId: params.componentId, html, render },
        };
      },
    }),
    defineTool({
      name: "figma_status",
      label: "Figma Connection Status",
      description:
        "Reports whether the designbook Figma plugin is currently connected, and which file/page it's connected to. Does not require a connection.",
      parameters: Type.Object({}),
      execute: async () => {
        const connected = figmaBridge.isConnected();
        const info = figmaBridge.getInfo();
        const text = connected
          ? `Figma plugin connected (file: ${info?.fileName ?? "unknown"}, page: ${info?.page ?? "unknown"}).`
          : "No Figma plugin connected. Open the designbook plugin in Figma to connect.";
        return {
          content: [{ type: "text" as const, text }],
          details: { connected, info },
        };
      },
    }),
  ];

  async function getSession() {
    sessionPromise ??= createSession().catch((error: unknown) => {
      sessionPromise = undefined;
      throw error;
    });
    return sessionPromise;
  }

  /** git dirty-tree warning (backlog #7): non-fatal, best-effort, once per session. */
  async function checkDirtyWorkingTree(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--porcelain"],
        { cwd: projectRoot },
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
  function notifyUntrustedProjectIfNeeded(): void {
    if (trustProject) return;
    if (!existsSync(resolve(projectRoot, ".pi"))) return;
    broadcast("server-notice", {
      message:
        "Project is untrusted: .pi/ extensions and settings are not loaded. Pass --trust-project to load them.",
    });
  }

  async function createSession() {
    const settingsManager = SettingsManager.create(agentCwd, undefined, {
      projectTrusted: trustProject,
    });
    // designbook's shipped skills (figma-pull): loaded via additionalSkillPaths
    // on the same DefaultResourceLoader the SDK would build itself — package
    // asset, so trust-INDEPENDENT; repo .pi/ resources stay gated by
    // projectTrusted exactly as before (see piSkills.ts).
    const resourceLoader = await createDesignbookResourceLoader({
      packageRoot,
      cwd: agentCwd,
      settingsManager,
    });
    if (!resourceLoader) {
      log("packaged skills dir not found; figma-pull skill not loaded");
    }
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: agentCwd,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.create(agentCwd),
      settingsManager,
      ...(resourceLoader ? { resourceLoader } : {}),
      customTools: figmaTools,
      ...(readOnly ? { tools: READ_ONLY_TOOL_NAMES } : {}),
    });

    if (modelFallbackMessage) {
      log(`model fallback: ${modelFallbackMessage}`);
      broadcast("server-notice", { message: modelFallbackMessage });
    }

    void checkDirtyWorkingTree();
    notifyUntrustedProjectIfNeeded();

    unsubscribe?.();
    unsubscribe = session.subscribe((event) => {
      logPiEvent(event);
      broadcast("pi-event", event);
    });

    log(
      `pi session ${session.sessionId} created (model: ${session.model?.id ?? "none"}, cwd: ${agentCwd})`,
    );
    return session;
  }

  async function resetSession() {
    const previous = sessionPromise;
    // Clear the memoized promise up front so any concurrent getSession() call
    // builds a fresh session instead of reusing the one we're tearing down.
    sessionPromise = undefined;

    let previousModel: Parameters<AgentSession["setModel"]>[0] | undefined;

    if (previous) {
      try {
        const session = await previous;
        previousModel = session.model;
        await session.abort().catch(() => {});
        unsubscribe?.();
        unsubscribe = undefined;
        session.dispose();
      } catch {
        // The previous session never started successfully; nothing to dispose.
      }
    }

    const session = await getSession();

    // Carry the previously selected model into the new conversation.
    if (previousModel && session.model?.id !== previousModel.id) {
      await session.setModel(previousModel).catch(() => {});
    }

    return session;
  }

  function serializeSession(session: AgentSession) {
    return {
      cwd: agentCwd,
      isStreaming: session.isStreaming,
      messages: session.messages,
      model: session.model,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      thinkingLevel: session.thinkingLevel,
    };
  }

  async function readJsonBody<T>(
    request: IncomingMessage,
    maxBytes = 1024 * 1024,
  ): Promise<T> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;

      if (totalBytes > maxBytes) {
        throw new Error("Request body is too large.");
      }

      chunks.push(buffer);
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(rawBody || "{}") as T;
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

  async function handleListWorktrees(response: ServerResponse) {
    try {
      const currentBranch = await getCurrentBranch(agentCwd);
      const worktrees = await listWorktrees(agentCwd, currentBranch, port);
      sendJson(response, 200, { currentBranch, worktrees });
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

    const currentBranch = await getCurrentBranch(agentCwd);
    const instance = await ensureInstance({
      repoRoot: agentCwd,
      branch,
      currentBranch,
      configRelPath,
      hubPort: port,
      notify: (message) => broadcast("server-notice", { message }),
    });
    sendJson(response, 200, instance);
  }

  async function handleNewSession(response: ServerResponse) {
    const session = await resetSession();
    const nextState = serializeSession(session);
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

    const session = await getSession();
    await session.setModel(model);
    const nextState = serializeSession(session);
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
    const session = await getSession();
    sendSse(response, "state", serializeSession(session));

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

  function resolveLocaleFile(relPath: string): string | undefined {
    const localeFile = resolve(configDir, relPath);
    const insideProject = relative(projectRoot, localeFile);
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

    const relPath = typeof payload.path === "string" ? payload.path : "";
    const localeFile = relPath ? resolveLocaleFile(relPath) : undefined;
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
      noteDataWrite(localeFile);
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
  function resolvePoFile(relPath: string): string | undefined {
    const poFile = resolve(configDir, relPath);
    const insideProject = relative(projectRoot, poFile);
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

    const relPath = typeof payload.path === "string" ? payload.path : "";
    const poFile = relPath ? resolvePoFile(relPath) : undefined;
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

      noteDataWrite(poFile);
      await writeFile(poFile, updated, "utf8");
      log(`wrote po: ${relPath} (${payload.msgid.slice(0, 40)})`);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  }

  /** Resolves a repo-relative source path, or undefined if it escapes the project or has a disallowed extension. */
  function resolveSourceFile(relPath: string): string | undefined {
    return resolveSourceFileIn(projectRoot, relPath);
  }

  async function handleGetFile(url: URL, response: ServerResponse) {
    const relPath = url.searchParams.get("path") ?? "";
    const sourceFile = relPath ? resolveSourceFile(relPath) : undefined;

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

    const sourceFile = resolveSourceFile(payload.path);
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
    sendJson(response, 200, await listChanges(projectRoot));
  }

  async function handleFileDiff(url: URL, response: ServerResponse) {
    const relPath = url.searchParams.get("path") ?? "";
    const absPath = relPath
      ? resolveContainedPath(projectRoot, relPath)
      : undefined;
    if (!absPath) {
      sendJson(response, 400, {
        error: "A file path inside the project is required.",
      });
      return;
    }
    sendJson(response, 200, await fileDiff(projectRoot, relPath, absPath));
  }

  type DiscardPayload = { path?: unknown };

  async function handleDiscardChange(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const payload = await readJsonBody<DiscardPayload>(request);
    const relPath = typeof payload.path === "string" ? payload.path : "";
    const absPath = relPath
      ? resolveContainedPath(projectRoot, relPath)
      : undefined;
    if (!absPath) {
      sendJson(response, 400, {
        error: "A file path inside the project is required.",
      });
      return;
    }

    try {
      const result = await discardChange(projectRoot, relPath, absPath);
      for (const touched of result.touchedPaths) {
        // Treat the restore like any designbook write so HMR-suppress drops
        // the echo the Changes tab already reflects.
        noteDataWrite(resolve(projectRoot, touched));
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

    const sourceFile = resolveSourceFile(payload.path);
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

    noteDataWrite(sourceFile);
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

    const sourceFile = resolveSourceFile(payload.path);
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

    noteDataWrite(sourceFile);
    await writeFile(sourceFile, updated, "utf8");
    log(`wrote style: ${payload.path} ${payload.selector} --${payload.prop}`);
    sendJson(response, 200, { ok: true });
  }

  // --- Figma variable REST proxies (browser Sync UI) --------------------
  //
  // The browser does all token↔variable mapping (see config/figmaTokens.ts);
  // these endpoints are thin structural proxies over the plugin bridge. When
  // no plugin is connected they answer 409 so the UI can gray out the buttons
  // / show a clear message instead of a generic 500.

  function handleFigmaStatus(response: ServerResponse) {
    sendJson(response, 200, {
      connected: figmaBridge.isConnected(),
      info: figmaBridge.getInfo() ?? null,
    });
  }

  async function handleFigmaGetVariables(response: ServerResponse) {
    if (!figmaBridge.isConnected()) {
      sendJson(response, 409, { error: "no plugin" });
      return;
    }
    const result = await figmaBridge.invoke("figma_get_variables", {});
    sendJson(response, 200, result);
  }

  async function handleFigmaSetVariables(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (!figmaBridge.isConnected()) {
      sendJson(response, 409, { error: "no plugin" });
      return;
    }
    const body = await readJsonBody<{
      name?: unknown;
      modes?: unknown;
      variables?: unknown;
    }>(request);
    const result = await figmaBridge.invoke("figma_set_variables", {
      collection: body.name,
      modes: body.modes,
      variables: body.variables,
    });
    sendJson(response, 200, result);
  }

  /** Serialized component pushes carry inline images — allow up to 25MB. */
  const FIGMA_PUSH_MAX_BODY_BYTES = 25 * 1024 * 1024;

  /** Error with the HTTP status the REST pull handler should answer with. */
  type PullError = Error & { status: number };

  function pullError(status: number, message: string): PullError {
    const error = new Error(message) as PullError;
    error.status = status;
    return error;
  }

  /**
   * Pull flow shared by `POST /api/figma/pull` and the Pi
   * `figma_pull_component` tool: read the selected component back out of Figma
   * as the annotated HTML target (see figma-plugin/readHtml.ts). Declarative —
   * no baseline, no diff, no cursor. Throws `PullError` (409 disconnected, 404
   * no pushed frame).
   */
  async function pullComponentHtml(
    componentId: string,
  ): Promise<{ componentId: string; html: string; render?: PullRenderContext }> {
    if (!figmaBridge.isConnected()) {
      throw pullError(
        409,
        "No Figma plugin connected. Open the designbook plugin in Figma.",
      );
    }

    let result: { html: string; render?: PullRenderContext };
    try {
      result = (await figmaBridge.invoke(
        "figma_read_html",
        { componentId },
        60_000,
      )) as { html: string; render?: PullRenderContext };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The bridge only relays error messages; the plugin prefixes its
      // missing-root error with this marker (see figma-plugin/readHtml.ts).
      if (message.includes("[not-found]")) {
        throw pullError(404, message.replace("[not-found] ", ""));
      }
      throw error;
    }

    log(`figma pull: ${componentId} -> ${result.html.length} html char(s)`);
    return { componentId, html: result.html, render: result.render };
  }

  async function handleFigmaPull(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const body = await readJsonBody<{ componentId?: unknown }>(request);
    const componentId =
      typeof body.componentId === "string" ? body.componentId.trim() : "";
    if (!componentId) {
      sendJson(response, 400, { error: "componentId is required." });
      return;
    }

    try {
      sendJson(response, 200, await pullComponentHtml(componentId));
    } catch (error) {
      const status = (error as Partial<PullError>).status;
      if (typeof status === "number") {
        sendJson(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
  }

  async function handleFigmaPush(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (!figmaBridge.isConnected()) {
      sendJson(response, 409, { error: "no plugin" });
      return;
    }

    const body = await readJsonBody<{ tree?: unknown }>(
      request,
      FIGMA_PUSH_MAX_BODY_BYTES,
    );
    const tree = body.tree as { componentId?: unknown } | undefined;
    if (!tree || typeof tree.componentId !== "string" || !tree.componentId) {
      sendJson(response, 400, {
        error: "A serialized render tree (with componentId) is required.",
      });
      return;
    }

    const result = (await figmaBridge.invoke(
      "figma_render_nodes",
      { tree },
      60_000,
    )) as { nodeId?: string; warnings?: string[] };

    log(`figma push: ${tree.componentId} -> ${result?.nodeId ?? "unknown"}`);
    sendJson(response, 200, result);
  }

  /** Debug: raw annotated HTML for a pushed component (same read as pull). */
  async function handleFigmaHtml(url: URL, response: ServerResponse) {
    if (!figmaBridge.isConnected()) {
      sendJson(response, 409, { error: "no plugin" });
      return;
    }
    const componentId = (url.searchParams.get("componentId") ?? "").trim();
    if (!componentId) {
      sendJson(response, 400, { error: "componentId is required." });
      return;
    }
    try {
      sendJson(response, 200, await pullComponentHtml(componentId));
    } catch (error) {
      const status = (error as Partial<PullError>).status;
      if (typeof status === "number") {
        sendJson(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    logDebug(`${request.method} ${url.pathname}`);
    if (
      readOnly &&
      READ_ONLY_BLOCKED_ROUTES.has(`${request.method} ${url.pathname}`)
    ) {
      sendJson(response, 403, {
        error: "designbook is running in --read-only mode; writes are disabled.",
      });
      return;
    }
    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        const session = await getSession();
        sendJson(response, 200, serializeSession(session));
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

      if (url.pathname === "/api/figma/status" && request.method === "GET") {
        handleFigmaStatus(response);
        return;
      }

      if (url.pathname === "/api/figma/push" && request.method === "POST") {
        await handleFigmaPush(request, response);
        return;
      }

      if (url.pathname === "/api/figma/pull" && request.method === "POST") {
        await handleFigmaPull(request, response);
        return;
      }

      if (url.pathname === "/api/figma/html" && request.method === "GET") {
        await handleFigmaHtml(url, response);
        return;
      }

      if (
        url.pathname === "/api/figma/variables" &&
        request.method === "POST"
      ) {
        await handleFigmaGetVariables(response);
        return;
      }

      if (
        url.pathname === "/api/figma/variables" &&
        request.method === "PUT"
      ) {
        await handleFigmaSetVariables(request, response);
        return;
      }

      if (url.pathname === "/api/figma/variables" && request.method === "GET") {
        // GET is the disconnected-probe path the E2E gate exercises; behaves
        // like POST (read variables) but is safe to call without a body.
        await handleFigmaGetVariables(response);
        return;
      }

      if (url.pathname === "/api/figma-hello" && request.method === "GET") {
        // The Figma plugin UI iframe runs from a data: URL (origin "null"),
        // so its discovery fetch is a cross-origin request. Allow it.
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

  function handleFigmaUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    figmaBridge.handleUpgrade(request, socket, head);
  }

  async function shutdown() {
    stopAllInstances();
    unsubscribe?.();
    if (sessionPromise) {
      const session = await sessionPromise.catch(() => undefined);
      session?.dispose();
    }
  }

  return { handle, handleFigmaUpgrade, shutdown };
}

export { createApi };
export type { ApiOptions };
