import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type WorktreeInfo = {
  branch: string;
  path: string;
  port: number;
  running: boolean;
};

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
      };
    }),
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
    const worktreesDir = resolve(
      repoRoot,
      "..",
      `${basename(repoRoot)}-worktrees`,
    );
    await mkdir(worktreesDir, { recursive: true });
    worktreePath = join(worktreesDir, slugify(branch));

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

export { ensureInstance, getCurrentBranch, listWorktrees, stopAllInstances };
export type { WorktreeInfo };
