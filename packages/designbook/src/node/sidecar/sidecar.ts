/**
 * Sidecar mode + proxy front — the runtime behind `designbook dev`.
 *
 * Unlike host mode (`startDesignbook`, server.ts), the sidecar embeds NO
 * workbench Vite server. It serves `/api/*` (the Pi agent, worktrees, figma
 * bridge, data writes — all of `createApi`) on ONE stable port and proxies
 * everything else to the target app's OWN dev server (which loads the injected
 * `designbookPlugin`). The user only ever sees the stable port, regardless of
 * which worktree's dev server is live behind the proxy.
 *
 * Layout of the stable port:
 *   - `/api/target/retarget` (POST)  → respawn the target dev cmd in a new cwd
 *   - `/__designbook/ping`           → target health probe (recovery poll)
 *   - `/__designbook[/component/id]` → deep-link bootstrap html
 *   - `/api/*`                       → createApi (same-origin: no CORS needed)
 *   - everything else                → HTTP proxy to the target dev server,
 *                                      or the recovery page when it's down
 *   - WS upgrades: namespaced integration bridge paths
 *     (`/__designbook/api/bridge/<name>` + legacy aliases) stay local; all
 *     others (their HMR socket) are spliced through to the target.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import type { Duplex } from "node:stream";
import {
  isCrossOriginExemptApiPath,
  rejectCrossOriginApiRequest,
} from "../plugin/apiOrigin.ts";
import { createApi } from "../api/api.ts";
import { prepareWorktree } from "../lib/worktrees.ts";
import { openBrowser } from "./openBrowser.ts";
import { createTargetManager } from "./targetManager.ts";
import {
  classifyDirectApiPath,
  classifyProxyPath,
  deepLinkBootstrapHtml,
  recoveryPageHtml,
  stripDesignbookNamespace,
  worktreeTargetCwd,
} from "./sidecarSupport.ts";

type SidecarOptions = {
  /** Absolute path to the user's designbook config file. */
  configPath: string;
  /** Absolute path to the repo the agent works in (git root above the config). */
  projectRoot: string;
  /** Stable port the user connects to (proxy + API). */
  port: number;
  host: string;
  /** Open (or refocus) the workbench in a browser once listening. */
  open: boolean;
  debug?: boolean;
  /** Attach to an already-running target dev server instead of spawning one. */
  targetUrl?: string;
  /** Command to spawn the target dev server (default: its package.json `dev`). */
  targetCmd?: string;
  /**
   * Directory to spawn the target dev command in (where the app's package.json
   * scripts live). Defaults to `projectRoot`, but in a monorepo the CLI passes
   * the app package dir (nearest package.json above the config).
   */
  targetCwd?: string;
  /** Known/forced target port (skips log-parsing when spawning). */
  targetPort?: number;
  /**
   * Direct api port (the sidecar's own origin where plain `/api/*` is
   * designbook's, unproxied). Defaults to `port + 1`. Cross-origin injected
   * clients and compat tooling can hit it directly.
   */
  apiPort?: number;
  /** Restrict the Pi agent to read-only tools and 403 the file-write data endpoints. */
  readOnly?: boolean;
  /** Trust the project's `.pi/` directory (extensions/settings/SYSTEM.md). Default false. */
  trustProject?: boolean;
};

const LOCALHOST_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/** Same CORS policy as host mode, for direct (non-proxied) sidecar access. */
function applyApiCors(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = request.headers.origin;
  if (typeof origin === "string" && LOCALHOST_ORIGIN.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    const requestedHeaders = request.headers["access-control-request-headers"];
    response.setHeader(
      "Access-Control-Allow-Headers",
      typeof requestedHeaders === "string" && requestedHeaders
        ? requestedHeaders
        : "content-type",
    );
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
}

/**
 * The URL `api.handle` should see, with any leading `/__designbook` namespace
 * stripped so the pathname is `/api/...`. Query string is preserved.
 */
function strippedApiUrl(request: IncomingMessage): URL {
  return new URL(
    stripDesignbookNamespace(request.url ?? "/"),
    `http://${request.headers.host ?? "localhost"}`,
  );
}

/** The URL `api.handle` should see for a plain (already `/api/...`) request. */
function directApiUrl(request: IncomingMessage): URL {
  return new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
}

async function startSidecar(options: SidecarOptions) {
  const { configPath, projectRoot, port, host, open, debug } = options;

  const log = (msg: string) =>
    console.log(`[designbook dev] ${new Date().toISOString()} ${msg}`);

  const target = createTargetManager({
    projectRoot,
    targetCwd: options.targetCwd,
    targetUrl: options.targetUrl,
    targetCmd: options.targetCmd,
    targetPort: options.targetPort,
    log,
  });

  // --- Worktree switching (the C3.2 branch seam) ----------------------------
  // One branch is VIEWED at a time: the proxy serves that branch's dev server
  // and the browser never leaves the stable origin. Other branches' dev
  // servers stay warm in the target pool (LRU-capped) and their agent
  // sessions keep running (per-branch-sessions spec). `activeBranch` is
  // undefined until the first switch (= the projectRoot checkout's branch).
  const baseTargetCwd = options.targetCwd ?? projectRoot;
  let activeBranch: string | undefined;
  // Worktree ROOT of the active branch (undefined = primary checkout) — the
  // per-branch agent session's cwd. Distinct from the target cwd, which in a
  // monorepo is the app package INSIDE the worktree.
  let activeWorktreeRoot: string | undefined;

  /**
   * Ensure the branch's worktree exists + is installed, then respawn the
   * target dev command in the matching app dir inside it. Switching back to
   * the primary branch resolves to the primary checkout and respawns there.
   * Returns the new target cwd.
   */
  async function switchToBranch(
    branch: string,
    notify: (message: string) => void,
  ): Promise<string> {
    if (target.isAttached) {
      throw new Error(
        "designbook dev is attached to --target-url, so it cannot switch worktrees. Run without --target-url to let it spawn (and retarget) the dev server.",
      );
    }
    const worktreePath = await prepareWorktree(projectRoot, branch, notify);
    const nextCwd = worktreeTargetCwd(projectRoot, baseTargetCwd, worktreePath);
    target.retarget(nextCwd, branch);
    activeBranch = branch;
    activeWorktreeRoot = worktreePath;
    return nextCwd;
  }

  const api = createApi({
    configPath,
    projectRoot,
    port,
    debug,
    readOnly: options.readOnly,
    trustProject: options.trustProject,
    worktreeProxy: {
      activeBranch: () => activeBranch,
      activeWorktreeRoot: () => activeWorktreeRoot,
      switchTo: async (branch, notify) => {
        await switchToBranch(branch, notify);
      },
      // Worktree removed (reconcile): its warm dev server goes too. The
      // session dispose happens api-side; the figma bridge stays global.
      stopBranch: (branch) => {
        target.stopBranch(branch);
      },
    },
  });

  // The direct api origin: plain `/api/*` is designbook's here (unproxied), for
  // cross-origin injected clients / compat tooling. Default `port + 1`.
  const apiPort = options.apiPort ?? port + 1;

  const server = createServer();

  // --- HTTP proxy to the live target dev server -----------------------------
  function proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    tgt: { host: string; port: number },
  ) {
    const headers = { ...request.headers, host: `${tgt.host}:${tgt.port}` };
    const proxyReq = httpRequest(
      {
        host: tgt.host,
        port: tgt.port,
        method: request.method,
        path: request.url,
        headers,
      },
      (proxyRes) => {
        response.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(response);
      },
    );
    proxyReq.on("error", () => serveUnavailable(request, response));
    request.pipe(proxyReq);
  }

  function serveUnavailable(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (response.headersSent) {
      response.end();
      return;
    }
    const accept = request.headers.accept ?? "";
    if (request.method === "GET" && accept.includes("text/html")) {
      const body = recoveryPageHtml({
        error:
          target.lastExitReason ??
          "The target dev server is not responding yet.",
        logLines: target.logLines,
      });
      response.writeHead(503, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("designbook: target dev server unavailable");
  }

  async function handleRetarget(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    let body = "";
    for await (const chunk of request) body += chunk;
    let payload: { cwd?: unknown; branch?: unknown } = {};
    try {
      payload = JSON.parse(body || "{}") as typeof payload;
    } catch {
      /* empty body ok */
    }
    try {
      let nextCwd: string | undefined;
      if (typeof payload.cwd === "string" && payload.cwd) {
        if (!existsSync(payload.cwd)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: `cwd does not exist: ${payload.cwd}` }),
          );
          return;
        }
        target.retarget(payload.cwd);
        // A raw-cwd retarget bypasses branch tracking — active branch
        // unknown, so the agent resolves to the PRIMARY session (documented
        // degrade; the {branch} form is the supported path).
        activeBranch = undefined;
        activeWorktreeRoot = undefined;
        nextCwd = payload.cwd;
      } else if (typeof payload.branch === "string" && payload.branch) {
        // Same seam as POST /api/worktrees: create + install the worktree
        // (a fresh one can't boot its dev server without an install), then
        // retarget into its app dir.
        nextCwd = await switchToBranch(payload.branch, log);
      }
      if (!nextCwd) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "cwd or branch is required." }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, cwd: nextCwd }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: message }));
    }
  }

  // Deep-link bootstrap: stash intent + redirect to `/` (served by proxy too,
  // mirroring the plugin's in-server route so the stable URL works).
  function serveDeepLink(pathname: string, response: ServerResponse) {
    const entryId = pathname.startsWith("/__designbook/component/")
      ? decodeURIComponent(pathname.slice("/__designbook/component/".length))
      : undefined;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(deepLinkBootstrapHtml(entryId));
  }

  /**
   * Serve designbook's OWN api. `apiUrl` has already had any `/__designbook`
   * prefix stripped, so its pathname is `/api/...`. Retarget is a sidecar-only
   * route (not an `api.handle` route), so it's dispatched here explicitly.
   */
  function serveDesignbookApi(
    request: IncomingMessage,
    response: ServerResponse,
    apiUrl: URL,
    boundPort: number,
  ) {
    if (applyApiCors(request, response)) return;
    if (
      !isCrossOriginExemptApiPath(apiUrl.pathname) &&
      rejectCrossOriginApiRequest(request, response, host, boundPort)
    )
      return;
    if (
      apiUrl.pathname === "/api/target/retarget" &&
      request.method === "POST"
    ) {
      void handleRetarget(request, response);
      return;
    }
    void api.handle(request, response, apiUrl);
  }

  server.on("request", (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    switch (classifyProxyPath(url.pathname)) {
      case "ping":
        // Health probe for the recovery page's auto-reload poll.
        void target.probe().then((up) => {
          response.writeHead(up ? 200 : 503, { "cache-control": "no-store" });
          response.end();
        });
        return;
      case "db-api":
        // designbook's own api on the proxy origin — namespaced under
        // /__designbook (incl. the retarget hook). The plain `/api/*` path
        // belongs to the TARGET app now (the /api collision fix).
        serveDesignbookApi(request, response, strippedApiUrl(request), port);
        return;
      case "deeplink":
        serveDeepLink(url.pathname, response);
        return;
      case "forward": {
        // Everything else — INCLUDING the app's own same-origin `/api/*` — is
        // forwarded to the target.
        const tgt = target.getTarget();
        if (!tgt) {
          serveUnavailable(request, response);
          return;
        }
        proxyHttp(request, response, tgt);
        return;
      }
    }
  });

  // --- WebSocket upgrades ----------------------------------------------------
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    // Ours are namespaced on the proxy origin (/__designbook/api/bridge/<name>
    // or a legacy alias like /__designbook/api/figma-bridge), routed through
    // the integration registry; every other upgrade — their HMR socket, app
    // websockets, even a plain /api/bridge/* the TARGET app might serve — is
    // proxied.
    if (
      url.pathname.startsWith("/__designbook/") &&
      api.handleBridgeUpgrade(
        stripDesignbookNamespace(url.pathname),
        request,
        socket,
        head,
      )
    ) {
      return;
    }

    const tgt = target.getTarget();
    if (!tgt) {
      socket.destroy();
      return;
    }
    proxyUpgrade(request, socket, head, tgt);
  });

  // --- Direct api origin (port + 1): plain `/api/*` is designbook's here ------
  // Unproxied — the "unchanged" direct behavior injected clients can point
  // `serverUrl` at cross-origin, plus it also accepts the namespaced form.
  const apiServer = createServer((request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    switch (classifyDirectApiPath(url.pathname)) {
      case "db-api-stripped":
        serveDesignbookApi(request, response, strippedApiUrl(request), apiPort);
        return;
      case "db-api":
        serveDesignbookApi(request, response, directApiUrl(request), apiPort);
        return;
      case "not-found":
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "designbook direct api port: unknown route.",
          }),
        );
        return;
    }
  });
  apiServer.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    // Plain and namespaced bridge paths are both designbook's on the direct
    // api origin (it proxies nothing).
    if (
      api.handleBridgeUpgrade(
        stripDesignbookNamespace(url.pathname),
        request,
        socket,
        head,
      )
    ) {
      return;
    }
    socket.destroy();
  });

  function proxyUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    tgt: { host: string; port: number },
  ) {
    const proxyReq = httpRequest({
      host: tgt.host,
      port: tgt.port,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `${tgt.host}:${tgt.port}` },
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) lines.push(`${key}: ${v}`);
        } else if (value !== undefined) {
          lines.push(`${key}: ${value}`);
        }
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
    });
    proxyReq.on("error", () => socket.destroy());
    if (head && head.length) proxyReq.write(head);
    proxyReq.end();
  }

  target.start();

  // Friendly EADDRINUSE on the stable port (no stack trace). This is the port
  // the user actually connects to, so a clash means another designbook (or any
  // server) is already there.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `designbook dev: port ${port} in use — another designbook running? Use --port to change.`,
      );
      process.exit(1);
    }
    throw error;
  });

  // The direct api port is a compat convenience; if it clashes, warn and carry
  // on — the namespaced /__designbook/api on the proxy port still works.
  apiServer.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.warn(
        `designbook dev: direct api port ${apiPort} in use — skipping it (the proxy's /__designbook/api still works; pass --api-port to change).`,
      );
      return;
    }
    throw error;
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`designbook dev running at ${url}`);
    console.log(`  config:  ${configPath}`);
    console.log(`  project: ${projectRoot}`);
    console.log(`  api:     http://${host}:${apiPort} (direct)`);
    console.log(
      target.isAttached
        ? `  target:  ${options.targetUrl} (attached)`
        : `  target:  spawning (${options.targetCmd ?? "package.json dev script"})`,
    );
    if (open) void openBrowser(url);
  });
  apiServer.listen(apiPort, host);

  async function shutdown() {
    target.shutdown();
    await api.shutdown();
    server.close();
    apiServer.close();
  }

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  return { server, shutdown, target };
}

export { startSidecar };
export type { SidecarOptions };
