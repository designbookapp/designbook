import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type WorktreeInfo = {
  branch: string;
  path: string;
  port: number;
  running: boolean;
  /** Uncommitted-change count in this worktree, capped at DIRTY_COUNT_CAP. */
  dirtyCount: number;
};

/**
 * Branch worktrees now live NESTED inside the repo — `<repoRoot>/.designbook/
 * worktrees/<branch>` — mirroring Claude Code's `.claude/worktrees`, instead of
 * the old sibling `<repo>-worktrees/` dir. `git worktree list` still surfaces
 * old sibling worktrees, so pre-existing ones keep working; only NEW creations
 * use this path. Shared with the containment guard (sourcePaths.ts) that keeps
 * a nested worktree's files out of the primary root's read/write surface.
 */
const WORKTREES_DIR_REL = ".designbook/worktrees";

/** Upper bound on the per-worktree dirty count so the badge stays compact and
 * the count stays cheap in a huge tree; this value means "CAP or more". */
const DIRTY_COUNT_CAP = 99;

type RunningInstance = {
  branch: string;
  children: ChildProcess[];
};

type Notify = (message: string) => void;

const READY_TIMEOUT_MS = 180_000;

const LOGS_DIR = join(homedir(), ".designbook", "logs");

const runningInstances = new Map<string, RunningInstance>();

/**
 * Branch instances run detached with no terminal, so their output (and the
 * install/setup steps that precede them) is appended to a per-repo, per-branch
 * log file under ~/.designbook/logs/.
 */
function openInstanceLog(repoRoot: string, branch: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  const path = join(
    LOGS_DIR,
    `${slugify(basename(repoRoot))}--${slugify(branch)}.log`,
  );
  const fd = openSync(path, "a");
  writeSync(
    fd,
    `\n===== ${new Date().toISOString()} designbook instance for ${branch} =====\n`,
  );
  return { fd, path };
}

function portForBranch(branch: string) {
  let hash = 0;
  for (const char of branch) {
    hash = (hash * 31 + char.charCodeAt(0)) % 200;
  }
  return 5300 + hash;
}

function slugify(branch: string) {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "--");
}

/** Absolute path a NEW worktree for `branch` gets created at (pure). */
function worktreePathFor(repoRoot: string, branch: string): string {
  return resolve(repoRoot, WORKTREES_DIR_REL, slugify(branch));
}

/** Whether a gitignore-style file body already lists `pattern` (an exact,
 * comment/blank-skipping line match, trailing slash ignored on both sides). */
function patternPresent(content: string, pattern: string): boolean {
  const needle = pattern.replace(/\/+$/, "");
  return content.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return trimmed.replace(/\/+$/, "") === needle;
  });
}

/**
 * The text to append to `.git/info/exclude` to hide the nested worktrees dir,
 * or null if it is already covered (by the exclude file OR the committed
 * `.gitignore`) — the idempotence + "respect an existing .gitignore entry"
 * rule as a pure decision (I/O lives in ensureWorktreesExcluded).
 */
function computeExcludeAddition(
  excludeContent: string,
  gitignoreContent: string,
  pattern: string,
): string | null {
  if (patternPresent(gitignoreContent, pattern)) return null;
  if (patternPresent(excludeContent, pattern)) return null;
  const prefix =
    excludeContent.length && !excludeContent.endsWith("\n") ? "\n" : "";
  return `${prefix}# designbook branch worktrees (nested; not committed)\n${pattern}\n`;
}

/** Line count of `git status --porcelain` output, capped at `cap` (pure). */
function parseDirtyCount(porcelain: string, cap: number): number {
  let count = 0;
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    count += 1;
    if (count >= cap) return cap;
  }
  return count;
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Keep the nested worktrees dir out of the primary repo's `git status` /
 * Changes tab. git surfaces a nested worktree's containing dir as ONE
 * untracked line (`?? .designbook/`) and does not descend into it, but that
 * line still pollutes status — so exclude it once, in `.git/info/exclude`
 * (local, uncommitted). Idempotent and best-effort: a no-op if already covered
 * by the exclude file or the repo's `.gitignore`, and it never fails a worktree
 * creation (a read-only `.git` just leaves the stray line).
 */
async function ensureWorktreesExcluded(repoRoot: string): Promise<void> {
  const pattern = `${WORKTREES_DIR_REL}/`;
  let gitCommonDir: string;
  try {
    gitCommonDir = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
  } catch {
    return; // Not a git repo — nothing to exclude.
  }
  const excludePath = resolve(repoRoot, gitCommonDir, "info", "exclude");
  const [excludeContent, gitignoreContent] = await Promise.all([
    readFileOrEmpty(excludePath),
    readFileOrEmpty(join(repoRoot, ".gitignore")),
  ]);
  const addition = computeExcludeAddition(
    excludeContent,
    gitignoreContent,
    pattern,
  );
  if (addition === null) return;
  try {
    await mkdir(dirname(excludePath), { recursive: true });
    await appendFile(excludePath, addition);
  } catch {
    // Best-effort — see doc comment.
  }
}

/** Uncommitted-change count in `worktreePath`, capped (0 if not a git repo). */
async function countDirtyFiles(worktreePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    });
    return parseDirtyCount(stdout, DIRTY_COUNT_CAP);
  } catch {
    return 0;
  }
}

async function git(repoRoot: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
  return stdout.trim();
}

async function getCurrentBranch(repoRoot: string) {
  return git(repoRoot, ["branch", "--show-current"]);
}

async function listGitWorktrees(repoRoot: string) {
  const output = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (line.startsWith("branch refs/heads/") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }

  return entries.filter(
    (entry): entry is { path: string; branch: string } =>
      typeof entry.branch === "string",
  );
}

async function isInstanceUp(port: number) {
  try {
    const response = await fetch(`http://localhost:${port}/api/state`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function listWorktrees(
  repoRoot: string,
  currentBranch: string,
  hubPort: number,
): Promise<WorktreeInfo[]> {
  const entries = await listGitWorktrees(repoRoot);

  return Promise.all(
    entries.map(async (entry) => {
      const isCurrent = entry.branch === currentBranch;
      const port = isCurrent ? hubPort : portForBranch(entry.branch);

      return {
        branch: entry.branch,
        path: entry.path,
        port,
        running: isCurrent || (await isInstanceUp(port)),
        dirtyCount: await countDirtyFiles(entry.path),
      };
    }),
  );
}

/**
 * Worktree list for the proxy topology (`designbook dev`): there are no
 * per-branch designbook instances (and therefore no per-branch ports to
 * probe) — exactly one branch is live, the one whose dev server the proxy
 * currently targets. `running` marks that active branch; `port` is the stable
 * proxy port for every entry (the user never leaves it).
 */
async function listWorktreesForProxy(
  repoRoot: string,
  activeBranch: string,
  stablePort: number,
): Promise<WorktreeInfo[]> {
  const entries = await listGitWorktrees(repoRoot);
  return Promise.all(
    entries.map(async (entry) => ({
      branch: entry.branch,
      path: entry.path,
      port: stablePort,
      running: entry.branch === activeBranch,
      dirtyCount: await countDirtyFiles(entry.path),
    })),
  );
}

function runStep(
  command: string,
  args: string[],
  cwd: string,
  logFd?: number,
) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", logFd ?? "ignore", "pipe"],
    });

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
      if (logFd !== undefined) {
        try {
          writeSync(logFd, chunk);
        } catch {
          // The log file is best-effort; never fail a step over it.
        }
      }
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        const detail = stderrTail.trim().split("\n").slice(-6).join("\n");
        rejectPromise(
          new Error(
            `${command} ${args.join(" ")} exited ${code}${detail ? `:\n${detail}` : ""}`,
          ),
        );
      }
    });
  });
}

function spawnLongRunning(
  branch: string,
  command: string,
  args: string[],
  cwd: string,
  logFd: number,
) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  const instance = runningInstances.get(branch) ?? { branch, children: [] };
  instance.children.push(child);
  runningInstances.set(branch, instance);
  return child;
}

async function waitForInstance(port: number, logPath: string) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isInstanceUp(port)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(
    `designbook instance on port ${port} did not become ready. Logs: ${logPath}`,
  );
}

function detectPackageManager(worktreePath: string): string {
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(worktreePath, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Finds the designbook bin the worktree's own install provides, walking up
 * from the config file's directory Node-resolution style — in a monorepo the
 * bin lives next to the package that depends on designbook (e.g.
 * examples/demo/node_modules/.bin), not at the repo root.
 */
function findDesignbookBin(
  worktreePath: string,
  configRelPath: string,
): string | undefined {
  let dir = resolve(worktreePath, dirname(configRelPath));
  const root = resolve(worktreePath);

  for (;;) {
    const bin = join(dir, "node_modules", ".bin", "designbook");
    if (existsSync(bin)) return bin;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Repos that build designbook from source (like this monorepo in dev) need a
 * build step before the worktree's bin is runnable. Convention: a
 * `designbook:setup` script in the worktree root's package.json runs after
 * install.
 */
async function runSetupScript(
  worktreePath: string,
  packageManager: string,
  notify: Notify,
  logFd: number,
) {
  let scripts: Record<string, string> | undefined;
  try {
    const raw = await readFile(join(worktreePath, "package.json"), "utf8");
    scripts = (JSON.parse(raw) as { scripts?: Record<string, string> })
      .scripts;
  } catch {
    return;
  }

  if (!scripts?.["designbook:setup"]) return;

  notify("Running designbook:setup…");
  await runStep(
    packageManager,
    ["run", "designbook:setup"],
    worktreePath,
    logFd,
  );
}

async function ensureWorktree(
  repoRoot: string,
  branch: string,
  notify: Notify,
  logFd: number,
) {
  const existing = (await listGitWorktrees(repoRoot)).find(
    (entry) => entry.branch === branch,
  );

  let worktreePath = existing?.path;

  if (!worktreePath) {
    worktreePath = worktreePathFor(repoRoot, branch);
    await mkdir(dirname(worktreePath), { recursive: true });
    // Hide the nested worktrees dir from the primary repo's status BEFORE the
    // checkout lands, so its files never flash into `git status`.
    await ensureWorktreesExcluded(repoRoot);

    notify(`Creating worktree for ${branch}…`);
    const branches = await git(repoRoot, ["branch", "--list", branch]);
    if (branches) {
      await git(repoRoot, ["worktree", "add", worktreePath, branch]);
    } else {
      await git(repoRoot, ["worktree", "add", worktreePath, "-b", branch]);
    }
  }

  // Always (re)install: a previous attempt may have failed mid-install (e.g.
  // expired registry auth), and an up-to-date install is a fast no-op.
  notify(`Installing dependencies for ${branch} (this can take a minute)…`);
  const packageManager = detectPackageManager(worktreePath);
  await runStep(packageManager, ["install"], worktreePath, logFd);
  await runSetupScript(worktreePath, packageManager, notify, logFd);

  return worktreePath;
}

/**
 * Ensures the branch has a checked-out, installed worktree and returns its
 * path — the proxy-topology half of a branch switch (the sidecar then
 * retargets its proxied dev server into the worktree; no designbook instance
 * is spawned). Install output goes to the same per-branch log file the
 * instance flow uses.
 */
async function prepareWorktree(
  repoRoot: string,
  branch: string,
  notify: Notify,
): Promise<string> {
  const { fd: logFd } = openInstanceLog(repoRoot, branch);
  try {
    return await ensureWorktree(repoRoot, branch, notify, logFd);
  } finally {
    closeSync(logFd);
  }
}

/**
 * The navigation URL the workbench should load after a host-mode branch
 * switch: the branch instance's origin, on whatever hostname the user reached
 * the hub with (from the request's Host header; handles `[::1]:8787`-style
 * bracketed IPv6 hosts). The server builds this so the UI never assembles
 * `localhost:<port>` URLs itself.
 */
function instanceNavigationUrl(
  hostHeader: string | undefined,
  port: number,
): string {
  let hostname = "localhost";
  if (hostHeader) {
    try {
      // WHATWG hostname keeps IPv6 brackets ("[::1]"), so it re-embeds as-is.
      hostname = new URL(`http://${hostHeader}`).hostname || hostname;
    } catch {
      // Malformed Host header — keep the localhost fallback.
    }
  }
  return `http://${hostname}:${port}/`;
}

/**
 * Ensures the branch has a worktree with a running designbook instance on its
 * deterministic port, creating whatever is missing. Resolves once the
 * instance responds on its API.
 */
async function ensureInstance(options: {
  repoRoot: string;
  branch: string;
  currentBranch: string;
  /** Config file path relative to the repo root, reused inside the worktree. */
  configRelPath: string;
  hubPort: number;
  notify: Notify;
}): Promise<{ branch: string; port: number }> {
  const { repoRoot, branch, currentBranch, configRelPath, hubPort, notify } =
    options;

  if (branch === currentBranch) {
    return { branch, port: hubPort };
  }

  const port = portForBranch(branch);

  if (await isInstanceUp(port)) {
    return { branch, port };
  }

  const { fd: logFd, path: logPath } = openInstanceLog(repoRoot, branch);

  try {
    const worktreePath = await ensureWorktree(repoRoot, branch, notify, logFd);
    const bin = findDesignbookBin(worktreePath, configRelPath);
    if (!bin) {
      throw new Error(
        `designbook is not installed in the ${branch} worktree (${worktreePath}). ` +
          `Looked for node_modules/.bin/designbook from ${dirname(configRelPath)} up to the root — ` +
          `add designbook to the repo's devDependencies.`,
      );
    }

    notify(`Starting designbook for ${branch}… (logs: ${logPath})`);
    spawnLongRunning(
      branch,
      bin,
      [configRelPath, "--port", String(port), "--no-open"],
      worktreePath,
      logFd,
    );

    await waitForInstance(port, logPath);
    notify(`designbook for ${branch} is ready on port ${port}.`);
    return { branch, port };
  } finally {
    // The detached child holds its own copy of the fd; release the parent's.
    closeSync(logFd);
  }
}

function stopAllInstances() {
  for (const instance of runningInstances.values()) {
    for (const child of instance.children) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }
  }
  runningInstances.clear();
}

export {
  computeExcludeAddition,
  DIRTY_COUNT_CAP,
  ensureInstance,
  getCurrentBranch,
  instanceNavigationUrl,
  listWorktrees,
  listWorktreesForProxy,
  parseDirtyCount,
  patternPresent,
  prepareWorktree,
  stopAllInstances,
  WORKTREES_DIR_REL,
  worktreePathFor,
};
export type { WorktreeInfo };
