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
 *   - WS upgrades: `/api/figma-bridge` stays local; all others (their HMR
 *     socket) are spliced through to the target.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";
import {
  isCrossOriginExemptApiPath,
  rejectCrossOriginApiRequest,
} from "../plugin/apiOrigin.ts";
import { createApi } from "../api/api.ts";
import { openBrowser } from "./openBrowser.ts";
import {
  classifyDirectApiPath,
  classifyProxyPath,
  deepLinkBootstrapHtml,
  FAILURE_SUMMARY_THRESHOLD,
  parseTargetPort,
  recoveryPageHtml,
  RESTART_BACKOFF_MS,
  restartDelayMs,
  stripDesignbookNamespace,
} from "./sidecarSupport.ts";

const execFileAsync = promisify(execFile);

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

const RING_BUFFER_LINES = 200;

/**
 * Kill a `shell: true`, `detached: true` child AND its descendants. The child's
 * `.pid` is a process-group leader (its own session), so signalling `-pid`
 * reaches the grandchild (the actual Vite process) — a plain `child.kill()`
 * would only reap the wrapping shell and orphan Vite (leaking the port).
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Owns the target dev server: either an attached URL, or a spawned child that
 * it keeps alive (restart-on-exit with backoff), whose port it discovers from
 * stdout, and whose last output it rings-buffers for the recovery page.
 */
function createTargetManager(options: {
  projectRoot: string;
  targetCwd?: string;
  targetUrl?: string;
  targetCmd?: string;
  targetPort?: number;
  log: (msg: string) => void;
}) {
  const { projectRoot, targetUrl, log } = options;

  let host = "localhost";
  let port: number | undefined = options.targetPort;
  // Spawn dir: the app package (where `dev`/`design` scripts live), which in a
  // monorepo is NOT the git root. Falls back to projectRoot.
  let cwd = options.targetCwd ?? projectRoot;
  let child: ChildProcess | undefined;
  // Consecutive failures since the last successful boot (drives backoff AND the
  // "failing repeatedly" summary). Reset to 0 when a port is discovered.
  let restartCount = 0;
  let failureSummaryLogged = false;
  let lastStderrLine = "";
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  let lastExitReason: string | undefined;
  const ring: string[] = [];

  // Attach mode: fixed URL, never spawn.
  const attached = Boolean(targetUrl);
  if (targetUrl) {
    try {
      const u = new URL(targetUrl);
      host = u.hostname;
      port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    } catch {
      throw new Error(`[designbook dev] invalid --target-url: ${targetUrl}`);
    }
  }

  function pushLog(chunk: Buffer, sink: NodeJS.WriteStream, isStderr = false) {
    const text = chunk.toString();
    sink.write(text);
    for (const line of text.split("\n")) {
      if (line.trim()) {
        ring.push(line);
        if (isStderr) lastStderrLine = line.trim();
      }
    }
    while (ring.length > RING_BUFFER_LINES) ring.shift();
  }

  function detectPackageManager(dir: string): string {
    if (existsSync(`${dir}/pnpm-lock.yaml`)) return "pnpm";
    if (existsSync(`${dir}/yarn.lock`)) return "yarn";
    return "npm";
  }

  /** The default spawn command: run the target package's `dev` script. */
  function defaultCmd(dir: string): string {
    const pm = detectPackageManager(dir);
    return `${pm} run dev`;
  }

  function spawnChild() {
    if (attached || shuttingDown) return;
    const cmd = options.targetCmd ?? defaultCmd(cwd);
    log(`spawning target: ${cmd} (cwd: ${cwd})`);
    // A shell so `pnpm`/`yarn`/`npm` resolve like the user's terminal.
    // `detached` puts the child in its own process group so `killTree` can
    // signal the whole tree (the shell + the real dev-server grandchild).
    child = spawn(cmd, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      pushLog(chunk, process.stdout);
      // A printed "Local: http://…:<port>/" line means the dev server booted
      // cleanly. Use it to (a) discover the port when it wasn't forced, and
      // (b) reset the failure backoff + summary — regardless of whether the
      // port was forced (`--target-port`), so a clean boot always restarts the
      // backoff sequence, not just when we're sniffing the port.
      for (const line of chunk.toString().split("\n")) {
        const found = parseTargetPort(line);
        if (!found) continue;
        if (options.targetPort === undefined) {
          if (port !== found) log(`discovered target port ${found}`);
          port = found;
        }
        restartCount = 0;
        failureSummaryLogged = false;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) =>
      pushLog(chunk, process.stderr, true),
    );

    child.on("exit", (code, signal) => {
      lastExitReason = `target dev server exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
      child = undefined;
      if (shuttingDown) return;
      const delay = restartDelayMs(restartCount);
      restartCount += 1;
      // Escalating noise control: after N consecutive failures with no clean
      // boot in between, collapse to a single summary line; keep retrying
      // forever (the client explicitly valued auto-recovery).
      if (restartCount >= FAILURE_SUMMARY_THRESHOLD) {
        if (!failureSummaryLogged) {
          failureSummaryLogged = true;
          log(
            `target failing repeatedly: ${lastStderrLine || lastExitReason} — retrying every ${Math.round(RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1] / 1000)}s`,
          );
        }
      } else {
        log(lastExitReason);
      }
      restartTimer = setTimeout(spawnChild, delay);
    });

    child.on("error", (err) => {
      lastExitReason = `failed to spawn target: ${err.message}`;
      log(lastExitReason);
    });
  }

  function start() {
    if (!attached) spawnChild();
  }

  /** Respawn the target dev cmd in a new directory (worktree retarget). */
  function retarget(nextCwd: string) {
    if (attached) {
      throw new Error(
        "[designbook dev] cannot retarget in --target-url (attach) mode.",
      );
    }
    log(`retargeting to ${nextCwd}`);
    cwd = nextCwd;
    restartCount = 0;
    failureSummaryLogged = false;
    if (options.targetPort !== undefined) port = options.targetPort;
    if (restartTimer) clearTimeout(restartTimer);
    if (child?.pid) {
      const dying = child;
      child = undefined;
      // Respawn once the old tree is fully gone (freeing the port), so the new
      // dev server can bind it. The auto-restart exit handler is removed first.
      dying.removeAllListeners("exit");
      dying.once("exit", () => spawnChild());
      killTree(dying, "SIGTERM");
      setTimeout(() => {
        if (dying.exitCode === null && dying.signalCode === null) {
          killTree(dying, "SIGKILL");
        }
      }, 4000);
    } else {
      spawnChild();
    }
  }

  function getTarget(): { host: string; port: number } | undefined {
    return port ? { host, port } : undefined;
  }

  /** Best-effort HTTP probe: resolves true if the target answers at all. */
  function probe(): Promise<boolean> {
    const target = getTarget();
    if (!target) return Promise.resolve(false);
    return new Promise((resolvePromise) => {
      const req = httpRequest(
        {
          host: target.host,
          port: target.port,
          method: "HEAD",
          path: "/",
          timeout: 1500,
        },
        (res) => {
          res.resume();
          resolvePromise(true);
        },
      );
      req.on("error", () => resolvePromise(false));
      req.on("timeout", () => {
        req.destroy();
        resolvePromise(false);
      });
      req.end();
    });
  }

  function shutdown() {
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    const dying = child;
    if (dying?.pid) {
      killTree(dying, "SIGTERM");
      setTimeout(() => {
        if (dying.exitCode === null && dying.signalCode === null) {
          killTree(dying, "SIGKILL");
        }
      }, 4000);
    }
  }

  return {
    start,
    retarget,
    getTarget,
    probe,
    shutdown,
    get logLines() {
      return ring.slice(-40);
    },
    get lastExitReason() {
      return lastExitReason;
    },
    get isAttached() {
      return attached;
    },
  };
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
  return stdout.trim();
}

/** Resolve (creating if needed) a worktree dir for a branch — proxy retarget. */
async function resolveWorktreePath(
  repoRoot: string,
  branch: string,
): Promise<string> {
  const listing = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  let current: { path: string; branch?: string } | undefined;
  const entries: Array<{ path: string; branch?: string }> = [];
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (line.startsWith("branch refs/heads/") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  const existing = entries.find((e) => e.branch === branch);
  if (existing) return existing.path;

  const base = repoRoot.replace(/\/+$/, "");
  const name = base.slice(base.lastIndexOf("/") + 1);
  const dir = `${base.slice(0, base.lastIndexOf("/"))}/${name}-worktrees/${branch.replace(/[^a-zA-Z0-9._-]+/g, "--")}`;
  const branches = await git(repoRoot, ["branch", "--list", branch]);
  await git(
    repoRoot,
    branches
      ? ["worktree", "add", dir, branch]
      : ["worktree", "add", dir, "-b", branch],
  );
  return dir;
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

  const api = createApi({
    configPath,
    projectRoot,
    port,
    debug,
    readOnly: options.readOnly,
    trustProject: options.trustProject,
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
        nextCwd = payload.cwd;
      } else if (typeof payload.branch === "string" && payload.branch) {
        nextCwd = await resolveWorktreePath(projectRoot, payload.branch);
      }
      if (!nextCwd || !existsSync(nextCwd)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "cwd or branch is required." }));
        return;
      }
      target.retarget(nextCwd);
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

    // Ours is namespaced on the proxy origin (/__designbook/api/figma-bridge);
    // every other upgrade — their HMR socket, app websockets — is proxied.
    if (url.pathname === "/__designbook/api/figma-bridge") {
      api.handleFigmaUpgrade(request, socket, head);
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
    if (
      url.pathname === "/api/figma-bridge" ||
      url.pathname === "/__designbook/api/figma-bridge"
    ) {
      api.handleFigmaUpgrade(request, socket, head);
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
