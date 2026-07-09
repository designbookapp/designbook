/**
 * The sidecar's target dev-server pool (per-branch-sessions spec).
 *
 * Owns the target dev servers behind the proxy: either an attached URL
 * (never spawns), or a POOL of spawned children keyed by cwd — one per viewed
 * branch worktree. Dev servers spawn lazily on first view (retarget), stay
 * warm when the user switches away (switching back is instant), and are
 * LRU-stopped beyond MAX_WARM_TARGET_SERVERS (never the currently-viewed
 * one). Each entry keeps its own port discovery (from its stdout), restart
 * backoff, and ring-buffered output for the recovery page. With a forced
 * `--target-port` the pool degrades to a single server (cap 1), since N
 * servers cannot share one port.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  FAILURE_SUMMARY_THRESHOLD,
  MAX_WARM_TARGET_SERVERS,
  parseTargetPort,
  RESTART_BACKOFF_MS,
  restartDelayMs,
  selectTargetEvictions,
  spawnImmediatelyOnRetarget,
} from "./sidecarSupport.ts";

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

/** One pooled dev server: its child, discovered port, logs, backoff state. */
type TargetEntry = {
  cwd: string;
  /** Branch label when the retarget came from a branch switch (drives
   * stopBranch on worktree removal). */
  branch?: string;
  child?: ChildProcess;
  port?: number;
  ring: string[];
  restartCount: number;
  failureSummaryLogged: boolean;
  lastStderrLine: string;
  restartTimer?: ReturnType<typeof setTimeout>;
  lastExitReason?: string;
  /** LRU clock: last time this entry was the viewed target. */
  lastUsedAt: number;
};

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
  // Attach mode: fixed URL, never spawn (no pool).
  const attached = Boolean(targetUrl);
  let attachedPort: number | undefined = options.targetPort;
  if (targetUrl) {
    try {
      const u = new URL(targetUrl);
      host = u.hostname;
      attachedPort = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    } catch {
      throw new Error(`[designbook dev] invalid --target-url: ${targetUrl}`);
    }
  }

  const entries = new Map<string, TargetEntry>();
  // Spawn dir of the ACTIVE target: the app package (where `dev`/`design`
  // scripts live), which in a monorepo is NOT the git root.
  let activeCwd = options.targetCwd ?? projectRoot;
  let shuttingDown = false;
  let lruClock = 0;

  /** A forced --target-port can only back ONE server at a time. */
  const warmCap =
    options.targetPort !== undefined ? 1 : MAX_WARM_TARGET_SERVERS;

  function entryFor(cwd: string): TargetEntry {
    let entry = entries.get(cwd);
    if (!entry) {
      entry = {
        cwd,
        ring: [],
        restartCount: 0,
        failureSummaryLogged: false,
        lastStderrLine: "",
        lastUsedAt: ++lruClock,
      };
      entries.set(cwd, entry);
    }
    return entry;
  }

  function pushLog(
    entry: TargetEntry,
    chunk: Buffer,
    sink: NodeJS.WriteStream,
    isStderr = false,
  ) {
    const text = chunk.toString();
    sink.write(text);
    for (const line of text.split("\n")) {
      if (line.trim()) {
        entry.ring.push(line);
        if (isStderr) entry.lastStderrLine = line.trim();
      }
    }
    while (entry.ring.length > RING_BUFFER_LINES) entry.ring.shift();
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

  function spawnChild(entry: TargetEntry) {
    if (attached || shuttingDown) return;
    // Evicted while a restart was pending — don't resurrect.
    if (entries.get(entry.cwd) !== entry) return;
    const cmd = options.targetCmd ?? defaultCmd(entry.cwd);
    log(`spawning target: ${cmd} (cwd: ${entry.cwd})`);
    // A shell so `pnpm`/`yarn`/`npm` resolve like the user's terminal.
    // `detached` puts the child in its own process group so `killTree` can
    // signal the whole tree (the shell + the real dev-server grandchild).
    const child = spawn(cmd, {
      cwd: entry.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    entry.child = child;
    if (options.targetPort !== undefined) entry.port = options.targetPort;

    child.stdout?.on("data", (chunk: Buffer) => {
      pushLog(entry, chunk, process.stdout);
      // A printed "Local: http://…:<port>/" line means the dev server booted
      // cleanly. Use it to (a) discover THIS entry's port when it wasn't
      // forced (each pool member gets its own port — Vite auto-increments),
      // and (b) reset the failure backoff + summary.
      for (const line of chunk.toString().split("\n")) {
        const found = parseTargetPort(line);
        if (!found) continue;
        if (options.targetPort === undefined) {
          if (entry.port !== found) {
            log(`discovered target port ${found} (cwd: ${entry.cwd})`);
          }
          entry.port = found;
        }
        entry.restartCount = 0;
        entry.failureSummaryLogged = false;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) =>
      pushLog(entry, chunk, process.stderr, true),
    );

    child.on("exit", (code, signal) => {
      entry.lastExitReason = `target dev server exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
      entry.child = undefined;
      if (shuttingDown) return;
      // Evicted/stopped entries are out of the map — no auto-restart.
      if (entries.get(entry.cwd) !== entry) return;
      const delay = restartDelayMs(entry.restartCount);
      entry.restartCount += 1;
      // Escalating noise control: after N consecutive failures with no clean
      // boot in between, collapse to a single summary line; keep retrying
      // forever (the client explicitly valued auto-recovery).
      if (entry.restartCount >= FAILURE_SUMMARY_THRESHOLD) {
        if (!entry.failureSummaryLogged) {
          entry.failureSummaryLogged = true;
          log(
            `target failing repeatedly: ${entry.lastStderrLine || entry.lastExitReason} — retrying every ${Math.round(RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1] / 1000)}s`,
          );
        }
      } else {
        log(entry.lastExitReason);
      }
      entry.restartTimer = setTimeout(() => spawnChild(entry), delay);
    });

    child.on("error", (err) => {
      entry.lastExitReason = `failed to spawn target: ${err.message}`;
      log(entry.lastExitReason);
    });
  }

  /** Stop an entry's tree and forget it. `onExit` fires once it is fully
   * gone (or immediately if it already was). */
  function stopEntry(entry: TargetEntry, onExit?: () => void) {
    entries.delete(entry.cwd);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    const dying = entry.child;
    entry.child = undefined;
    if (!dying?.pid) {
      onExit?.();
      return;
    }
    dying.removeAllListeners("exit");
    if (onExit) dying.once("exit", onExit);
    killTree(dying, "SIGTERM");
    setTimeout(() => {
      if (dying.exitCode === null && dying.signalCode === null) {
        killTree(dying, "SIGKILL");
      }
    }, 4000);
  }

  /** Enforce the warm cap: LRU-stop pool members, never the active one. */
  function evictBeyondCap(onActiveFreed?: () => void) {
    const evict = selectTargetEvictions(
      [...entries.values()].map((entry) => ({
        key: entry.cwd,
        lastUsedAt: entry.lastUsedAt,
      })),
      activeCwd,
      warmCap,
    );
    for (const cwd of evict) {
      const entry = entries.get(cwd);
      if (!entry) continue;
      log(`stopping warm target (LRU, cap ${warmCap}): ${cwd}`);
      // With a forced port the evictee holds the ONE port the new active
      // server needs — delay that spawn until the tree is fully gone.
      stopEntry(
        entry,
        options.targetPort !== undefined ? onActiveFreed : undefined,
      );
    }
    return evict.length;
  }

  function start() {
    if (attached) return;
    const entry = entryFor(activeCwd);
    spawnChild(entry);
  }

  /**
   * Make `nextCwd` the viewed target (worktree retarget). Warm pool member →
   * instant switch, nothing respawns; unknown cwd → lazy spawn. `branch`
   * labels the entry when the switch came from a branch (drives stopBranch).
   */
  function retarget(nextCwd: string, branch?: string) {
    if (attached) {
      throw new Error(
        "[designbook dev] cannot retarget in --target-url (attach) mode.",
      );
    }
    log(`retargeting to ${nextCwd}`);
    activeCwd = nextCwd;
    const existing = entries.get(nextCwd);
    if (existing) {
      existing.lastUsedAt = ++lruClock;
      if (branch) existing.branch = branch;
      evictBeyondCap();
      return;
    }

    const entry = entryFor(nextCwd);
    entry.branch = branch;
    // Forced-port mode (cap 1): the previous server owns the port; spawn the
    // new one only after eviction fully freed it (stop-then-spawn — see
    // spawnImmediatelyOnRetarget). Otherwise spawn now.
    const evicted = evictBeyondCap(() => spawnChild(entry));
    if (spawnImmediatelyOnRetarget(options.targetPort !== undefined, evicted)) {
      spawnChild(entry);
    }
  }

  /** Stop (and forget) the branch's warm dev server — worktree removed. */
  function stopBranch(branch: string) {
    for (const entry of entries.values()) {
      if (entry.branch === branch) {
        log(`stopping target for removed worktree branch: ${branch}`);
        stopEntry(entry);
      }
    }
  }

  function activeEntry(): TargetEntry | undefined {
    return entries.get(activeCwd);
  }

  function getTarget(): { host: string; port: number } | undefined {
    if (attached) {
      return attachedPort ? { host, port: attachedPort } : undefined;
    }
    const port = activeEntry()?.port;
    return port ? { host, port } : undefined;
  }

  /** Best-effort HTTP probe: resolves true if the ACTIVE target answers. */
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

  /** Reap the whole pool. */
  function shutdown() {
    shuttingDown = true;
    for (const entry of [...entries.values()]) {
      stopEntry(entry);
    }
  }

  return {
    start,
    retarget,
    stopBranch,
    getTarget,
    probe,
    shutdown,
    get logLines() {
      return activeEntry()?.ring.slice(-40) ?? [];
    },
    get lastExitReason() {
      return activeEntry()?.lastExitReason;
    },
    get isAttached() {
      return attached;
    },
    /** Warm pool cwds (introspection/tests). */
    get warmCwds() {
      return [...entries.keys()];
    },
  };
}

export { createTargetManager, killTree };
