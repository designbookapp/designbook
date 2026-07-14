/**
 * Changesets ON GIT (docs/specs/changesets-on-git.md, G1) — the git core.
 *
 * Git is the TRUTH plane: every changeset lives in HIDDEN refs
 *
 *     refs/designbook/changesets/<id>/base       # baseCommit at creation
 *     refs/designbook/changesets/<id>/trunk      # the changeset branch
 *     refs/designbook/changesets/<id>/v/<altId>  # variant branches OFF trunk
 *     refs/designbook/changesets/<id>/selected   # symref → trunk|v/<altId>
 *
 * — never under refs/heads (invisible to `git branch`/GUIs), never pushed.
 * Agent turns run in REAL worktrees at `.designbook/worktrees/<changesetId>`
 * (gitignored, node_modules symlinked from the main tree, lazily created,
 * reused across turns, pruned after idle) with HEAD symref'd onto the
 * changeset's branch, so plain `git commit` advances the hidden ref.
 *
 * The existing `.designbook/changesets/<id>/` layer dir becomes a DERIVED
 * projection of these refs (see projectChangeset in sandbox.ts) — this module
 * knows only git.
 *
 * Everything shells out through an INJECTABLE exec seam and takes an
 * injectable clock (idle pruning) — tests run against real tmp repos,
 * timer-free.
 */

import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Namespace of every changeset ref (NEVER refs/heads; never pushed). */
const CHANGESET_REF_PREFIX = "refs/designbook/changesets";

/** Repo-root-relative home of changeset worktrees (shared with the branch
 * worktrees dir — both are excluded via .git/info/exclude and sit in
 * HMR_WATCH_IGNORED as `**\/.designbook/worktrees/**`). */
const WORKTREES_DIR_REL = ".designbook/worktrees";

/** Commit identity for designbook-authored commits (hidden refs only — the
 * user's own git identity/config must not be required or polluted). */
const COMMIT_IDENT = [
  "-c",
  "user.name=designbook",
  "-c",
  "user.email=designbook@localhost",
];

/** Idle worktree prune threshold (30 min without a turn). */
const WORKTREE_IDLE_MS = 30 * 60 * 1000;

/** Max files named in a per-write commit subject line. */
const COMMIT_FILES_CAP = 4;

type GitExecResult = { stdout: string; stderr: string };

/** The injectable exec seam: run one git invocation. */
type GitExec = (
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => Promise<GitExecResult>;

type ChangedFile = { path: string; status: string };

type GitChangesetsDeps = {
  exec?: GitExec;
  /** Injectable clock (idle pruning). */
  now?: () => number;
  /** Idle threshold override (tests). */
  worktreeIdleMs?: number;
  log?: (message: string) => void;
};

/** Thrown when a repo-required operation runs outside a git repository —
 * callers surface `message` verbatim through the API. */
class GitRequiredError extends Error {
  constructor(repoRoot: string) {
    super(
      "designbook changesets require a git repository — " +
        `${repoRoot} is not inside one (run \`git init\` first).`,
    );
    this.name = "GitRequiredError";
  }
}

function refTrunk(changesetId: string): string {
  return `${CHANGESET_REF_PREFIX}/${changesetId}/trunk`;
}

function refBase(changesetId: string): string {
  return `${CHANGESET_REF_PREFIX}/${changesetId}/base`;
}

function refVariant(changesetId: string, altId: string): string {
  return `${CHANGESET_REF_PREFIX}/${changesetId}/v/${altId}`;
}

function refSelected(changesetId: string): string {
  return `${CHANGESET_REF_PREFIX}/${changesetId}/selected`;
}

/** The altId a variant ref encodes, or undefined for non-variant refs. */
function altIdOfRef(changesetId: string, ref: string): string | undefined {
  const prefix = `${CHANGESET_REF_PREFIX}/${changesetId}/v/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

/** Absolute path of a changeset's worktree. */
function worktreePathFor(repoRoot: string, changesetId: string): string {
  return join(repoRoot, WORKTREES_DIR_REL, changesetId);
}

/** One turn's per-write commit capture: `noteToolEnd` enqueues a commit of
 * whatever the tool just wrote (serialized); `finish` commits any remaining
 * dirty state, stamps the turn trailers on the final commit, and reports the
 * turn's commit range. */
type TurnGitCapture = {
  /** Fire-and-forget from the event seam (returns the queue tail so tests
   * can await commit granularity deterministically). */
  noteToolEnd(info: { toolCallId?: string; toolName?: string }): Promise<void>;
  finish(meta: {
    conversationId?: string;
    sessionId?: string;
    turnIndex?: number;
    /** Agent-supplied turn summary — becomes the CATCH-ALL (turn-end)
     * commit's subject when residual writes exist. Per-write commits keep
     * their tool subjects. */
    summary?: string;
  }): Promise<{ from: string; to: string; commits: string[] }>;
};

/** Tools whose execution can have written files (worth a commit attempt). */
const WRITE_CLASS_TOOLS = new Set(["write", "edit", "bash"]);

function createGitChangesets(deps: GitChangesetsDeps = {}) {
  const exec: GitExec =
    deps.exec ??
    (async (args, opts) => {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: opts.cwd,
        maxBuffer: 64 * 1024 * 1024,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      });
      return { stdout, stderr };
    });
  const now = deps.now ?? Date.now;
  const idleMs = deps.worktreeIdleMs ?? WORKTREE_IDLE_MS;
  const log = deps.log ?? (() => {});

  async function git(cwd: string, args: string[], env?: Record<string, string>) {
    return exec(args, { cwd, ...(env ? { env } : {}) });
  }

  /** Last-turn timestamps per worktree abs path (idle pruning). */
  const worktreeLastUsed = new Map<string, number>();
  /** Repos whose exclude file already covers the worktrees dir. */
  const worktreesExcluded = new Set<string>();

  async function isRepo(repoRoot: string): Promise<boolean> {
    try {
      await git(repoRoot, ["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  async function requireRepo(repoRoot: string): Promise<void> {
    if (!(await isRepo(repoRoot))) throw new GitRequiredError(repoRoot);
  }

  async function resolveCommit(
    repoRoot: string,
    ref: string,
  ): Promise<string | undefined> {
    try {
      const { stdout } = await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async function updateRef(
    repoRoot: string,
    ref: string,
    commit: string,
  ): Promise<void> {
    await git(repoRoot, ["update-ref", ref, commit]);
  }

  /** All refs of one changeset (or all changesets): [refname, commit]. */
  async function listRefs(
    repoRoot: string,
    changesetId?: string,
  ): Promise<Array<{ ref: string; commit: string }>> {
    const scope = changesetId
      ? `${CHANGESET_REF_PREFIX}/${changesetId}`
      : CHANGESET_REF_PREFIX;
    try {
      const { stdout } = await git(repoRoot, [
        "for-each-ref",
        scope,
        "--format=%(refname) %(objectname)",
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [ref, commit] = line.split(" ");
          return { ref, commit };
        });
    } catch {
      return [];
    }
  }

  /**
   * Ensure a changeset's base + trunk refs exist (creation captures
   * baseCommit = the repo's HEAD). Throws GitRequiredError outside a repo.
   */
  async function ensureChangesetRefs(
    repoRoot: string,
    changesetId: string,
  ): Promise<{ baseCommit: string; trunkTip: string; created: boolean }> {
    await requireRepo(repoRoot);
    const existingBase = await resolveCommit(repoRoot, refBase(changesetId));
    if (existingBase) {
      const trunkTip =
        (await resolveCommit(repoRoot, refTrunk(changesetId))) ?? existingBase;
      return { baseCommit: existingBase, trunkTip, created: false };
    }
    const head = await resolveCommit(repoRoot, "HEAD");
    if (!head) {
      throw new Error(
        "designbook changesets require at least one commit in the repository.",
      );
    }
    await updateRef(repoRoot, refBase(changesetId), head);
    await updateRef(repoRoot, refTrunk(changesetId), head);
    return { baseCommit: head, trunkTip: head, created: true };
  }

  /** Cut (or re-cut) a variant branch at the current trunk tip. */
  async function cutVariantBranch(
    repoRoot: string,
    changesetId: string,
    altId: string,
  ): Promise<string> {
    const trunkTip = await resolveCommit(repoRoot, refTrunk(changesetId));
    if (!trunkTip) {
      throw new Error(`changeset ${changesetId} has no trunk ref.`);
    }
    await updateRef(repoRoot, refVariant(changesetId, altId), trunkTip);
    return trunkTip;
  }

  /** Selection pointer: symref → trunk / v/<altId>; null clears. */
  async function setSelected(
    repoRoot: string,
    changesetId: string,
    targetRef: string | null,
  ): Promise<void> {
    if (targetRef) {
      await git(repoRoot, ["symbolic-ref", refSelected(changesetId), targetRef]);
      return;
    }
    await git(repoRoot, ["symbolic-ref", "-d", refSelected(changesetId)]).catch(
      () => {},
    );
  }

  async function getSelected(
    repoRoot: string,
    changesetId: string,
  ): Promise<string | undefined> {
    try {
      const { stdout } = await git(repoRoot, [
        "symbolic-ref",
        refSelected(changesetId),
      ]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Delete every ref of a changeset (symrefs first — deleting a symref's
   * target through it would delete the target instead). */
  async function deleteChangesetRefs(
    repoRoot: string,
    changesetId: string,
  ): Promise<void> {
    await git(repoRoot, ["symbolic-ref", "-d", refSelected(changesetId)]).catch(
      () => {},
    );
    for (const { ref } of await listRefs(repoRoot, changesetId)) {
      await git(repoRoot, ["update-ref", "-d", ref]).catch(() => {});
    }
  }

  /** Changed files between two commits (name-status, NUL-safe). Renames are
   * reported as delete+add (`--no-renames`) so the projection stays a plain
   * per-path map. */
  async function changedFiles(
    repoRoot: string,
    from: string,
    to: string,
  ): Promise<ChangedFile[]> {
    const { stdout } = await git(repoRoot, [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      from,
      to,
    ]);
    const parts = stdout.split("\0").filter(Boolean);
    const out: ChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      out.push({ status: parts[i], path: parts[i + 1] });
    }
    return out;
  }

  /** One blob's content at a commit (undefined = path absent there). */
  async function readBlob(
    repoRoot: string,
    commit: string,
    path: string,
  ): Promise<string | undefined> {
    try {
      const { stdout } = await git(repoRoot, ["show", `${commit}:${path}`]);
      return stdout;
    } catch {
      return undefined;
    }
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  async function isAncestor(
    repoRoot: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    try {
      await git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  /** Keep the worktrees dir OUT of source control (the same local
   * `.git/info/exclude` mechanism the branch worktrees + changesets dirs
   * use). Idempotent + best-effort. */
  async function ensureWorktreesExcluded(repoRoot: string): Promise<void> {
    if (worktreesExcluded.has(repoRoot)) return;
    worktreesExcluded.add(repoRoot);
    const pattern = "**/.designbook/worktrees/";
    try {
      const { stdout } = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
      // `--git-common-dir` is RELATIVE from the primary checkout but
      // ABSOLUTE from a linked worktree — resolve handles both.
      const excludeAbs = resolve(repoRoot, stdout.trim(), "info", "exclude");
      const covered = (content: string) =>
        content
          .split("\n")
          .some(
            (line) =>
              line.trim().replace(/\/+$/, "") === pattern.replace(/\/+$/, ""),
          );
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
        `${excludeContent}${prefix}# designbook changeset worktrees (agent workspaces; pruned when idle)\n${pattern}\n`,
        "utf8",
      );
    } catch {
      // Best-effort only.
    }
  }

  /** Symlink node_modules from the main tree into a fresh worktree (deps and
   * lockfiles are real-only by spec, so sharing is sound). `relDirs` are the
   * repo-relative dirs to cover ("" = repo root, plus the app-dir chain). */
  async function linkNodeModules(
    repoRoot: string,
    worktreeAbs: string,
    relDirs: readonly string[],
  ): Promise<void> {
    for (const rel of new Set(relDirs)) {
      const source = join(repoRoot, rel, "node_modules");
      const target = join(worktreeAbs, rel, "node_modules");
      if (!existsSync(source) || existsSync(target)) continue;
      try {
        await mkdir(dirname(target), { recursive: true });
        await symlink(source, target);
      } catch {
        // Best-effort — a missing symlink only costs the agent tooling speed.
      }
    }
  }

  /** The app-dir ancestor chain ("" → "examples" → "examples/demo"). */
  function appDirChain(appDir: string): string[] {
    const dirs = [""];
    if (appDir) {
      const segments = appDir.split("/");
      for (let i = 1; i <= segments.length; i += 1) {
        dirs.push(segments.slice(0, i).join("/"));
      }
    }
    return dirs;
  }

  /** Attach a worktree's HEAD to `ref` (selection = checkout). Discards any
   * uncommitted state — safe by construction: every turn ends committed. */
  async function attachWorktree(worktreeAbs: string, ref: string): Promise<void> {
    const current = await git(worktreeAbs, ["symbolic-ref", "-q", "HEAD"])
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (current !== ref) {
      await git(worktreeAbs, ["symbolic-ref", "HEAD", ref]);
    }
    await git(worktreeAbs, ["reset", "-q", "--hard", ref]);
    // `-e node_modules`: the shared-deps symlinks are untracked (dir-only
    // ignore patterns skip symlinks) and must survive the sweep.
    await git(worktreeAbs, ["clean", "-qfd", "-e", "node_modules"]);
  }

  /**
   * Ensure the changeset's shared worktree exists and is attached to `ref`.
   * Lazily created (serving never waits on one), reused across turns.
   */
  async function ensureWorktree(params: {
    repoRoot: string;
    changesetId: string;
    ref: string;
    appDir: string;
  }): Promise<string> {
    const { repoRoot, changesetId, ref, appDir } = params;
    await requireRepo(repoRoot);
    await ensureWorktreesExcluded(repoRoot);
    const worktreeAbs = worktreePathFor(repoRoot, changesetId);
    const commit = await resolveCommit(repoRoot, ref);
    if (!commit) throw new Error(`unknown changeset ref: ${ref}`);
    const usable =
      existsSync(worktreeAbs) &&
      (await git(worktreeAbs, ["rev-parse", "--git-dir"]).then(
        () => true,
        () => false,
      ));
    if (!usable) {
      await rm(worktreeAbs, { recursive: true, force: true }).catch(() => {});
      await git(repoRoot, ["worktree", "prune"]).catch(() => {});
      await mkdir(dirname(worktreeAbs), { recursive: true });
      await git(repoRoot, [
        "worktree",
        "add",
        "--detach",
        worktreeAbs,
        commit,
      ]);
      await linkNodeModules(repoRoot, worktreeAbs, appDirChain(appDir));
      log(`changeset worktree created: ${worktreeAbs}`);
    }
    await attachWorktree(worktreeAbs, ref);
    worktreeLastUsed.set(worktreeAbs, now());
    return worktreeAbs;
  }

  /** A TEMP worktree for one fan-out arm (parallel variant turns must not
   * share the changeset worktree). Caller removes it via removeTempWorktree. */
  async function createTempWorktree(params: {
    repoRoot: string;
    ref: string;
    appDir: string;
  }): Promise<string> {
    const { repoRoot, ref, appDir } = params;
    const commit = await resolveCommit(repoRoot, ref);
    if (!commit) throw new Error(`unknown changeset ref: ${ref}`);
    const worktreeAbs = await mkdtemp(join(tmpdir(), "designbook-wt-"));
    await git(repoRoot, [
      "worktree",
      "add",
      "--force",
      "--detach",
      worktreeAbs,
      commit,
    ]);
    await linkNodeModules(repoRoot, worktreeAbs, appDirChain(appDir));
    await git(worktreeAbs, ["symbolic-ref", "HEAD", ref]);
    await git(worktreeAbs, ["reset", "-q", "--hard", ref]);
    return worktreeAbs;
  }

  async function removeTempWorktree(
    repoRoot: string,
    worktreeAbs: string,
  ): Promise<void> {
    await git(repoRoot, ["worktree", "remove", "--force", worktreeAbs]).catch(
      () => {},
    );
    await rm(worktreeAbs, { recursive: true, force: true }).catch(() => {});
  }

  /** Remove a changeset's shared worktree + its admin record (discard /
   * dissolve — "mess is temporary": no visible traces remain). */
  async function removeWorktree(
    repoRoot: string,
    changesetId: string,
  ): Promise<void> {
    const worktreeAbs = worktreePathFor(repoRoot, changesetId);
    worktreeLastUsed.delete(worktreeAbs);
    if (existsSync(worktreeAbs)) {
      await git(repoRoot, ["worktree", "remove", "--force", worktreeAbs]).catch(
        () => {},
      );
      await rm(worktreeAbs, { recursive: true, force: true }).catch(() => {});
    }
    await git(repoRoot, ["worktree", "prune"]).catch(() => {});
  }

  /** Prune shared worktrees idle past the threshold (injectable clock).
   * Called opportunistically after turns — no timers here. */
  async function pruneIdleWorktrees(repoRoot: string): Promise<string[]> {
    const pruned: string[] = [];
    const cutoff = now() - idleMs;
    for (const [worktreeAbs, lastUsed] of [...worktreeLastUsed]) {
      // DIRECT children only: a BRANCH worktree lives under the primary
      // root's worktrees dir and hosts its OWN nested changeset worktrees
      // (<primary>/.designbook/worktrees/<branch>/.designbook/worktrees/…) —
      // a prefix match would let a primary-side prune remove the branch's
      // changeset worktrees across roots.
      if (dirname(worktreeAbs) !== join(repoRoot, WORKTREES_DIR_REL)) continue;
      if (lastUsed > cutoff) continue;
      worktreeLastUsed.delete(worktreeAbs);
      await git(repoRoot, ["worktree", "remove", "--force", worktreeAbs]).catch(
        () => {},
      );
      await rm(worktreeAbs, { recursive: true, force: true }).catch(() => {});
      pruned.push(worktreeAbs);
      log(`changeset worktree pruned (idle): ${worktreeAbs}`);
    }
    if (pruned.length > 0) {
      await git(repoRoot, ["worktree", "prune"]).catch(() => {});
    }
    return pruned;
  }

  /** node_modules SYMLINKS (linkNodeModules) evade dir-only gitignore
   * patterns (`node_modules/` matches directories, not symlinks) — they are
   * infrastructure, never turn content. */
  function isNodeModulesPath(rel: string): boolean {
    return rel.split("/").includes("node_modules");
  }

  /** Dirty paths in a worktree (porcelain, NUL-safe; node_modules links
   * excluded — see isNodeModulesPath). */
  async function dirtyPaths(worktreeAbs: string): Promise<string[]> {
    const { stdout } = await git(worktreeAbs, ["status", "--porcelain", "-z"]);
    return stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .filter((rel) => !isNodeModulesPath(rel));
  }

  /** Reset a worktree to its HEAD ref, dropping uncommitted strays (the
   * scratch-turn sweep: director/intent/title turns must not commit). */
  async function cleanWorktree(worktreeAbs: string): Promise<void> {
    await git(worktreeAbs, ["reset", "-q", "--hard", "HEAD"]);
    await git(worktreeAbs, ["clean", "-qfd", "-e", "node_modules"]);
  }

  /** Commit ALL current changes in a worktree (message + trailers). Returns
   * the new commit sha, or undefined when the tree was clean.
   * `preferUserIdent` (bake-to-branch: the commit is USER-VISIBLE) tries the
   * user's own git identity first, falling back to the designbook one. */
  async function commitAll(
    worktreeAbs: string,
    message: string,
    trailers: readonly string[] = [],
    opts: { preferUserIdent?: boolean } = {},
  ): Promise<string | undefined> {
    const dirty = await dirtyPaths(worktreeAbs);
    if (dirty.length === 0) return undefined;
    // Stage exactly the (filtered) dirty paths — an exclude pathspec errors
    // whenever the node_modules symlink is ALSO gitignore-covered.
    await git(worktreeAbs, ["add", "-A", "--", ...dirty]);
    // `add -A` may stage nothing when every dirty path is ignored.
    const staged = await git(worktreeAbs, ["diff", "--cached", "--quiet"]).then(
      () => false,
      () => true,
    );
    if (!staged) return undefined;
    const body = [message, "", ...trailers].join("\n").trimEnd();
    const args = ["commit", "-q", "--no-verify", "-m", body];
    if (opts.preferUserIdent) {
      try {
        await git(worktreeAbs, args);
        return await resolveCommit(worktreeAbs, "HEAD");
      } catch {
        // No user identity configured — the designbook one below.
      }
    }
    await git(worktreeAbs, [...COMMIT_IDENT, ...args]);
    return resolveCommit(worktreeAbs, "HEAD");
  }

  /** Does this message paragraph read as a git trailer block? */
  function isTrailerBlock(paragraph: string): boolean {
    const lines = paragraph.split("\n").filter(Boolean);
    return (
      lines.length > 0 &&
      lines.every((line) => /^[A-Za-z][A-Za-z0-9-]*:\s/.test(line))
    );
  }

  /** Append trailers to the LAST commit's message (turn-end boundary mark).
   * Extends an existing trailer block in place — a fresh block after a
   * per-write `Designbook-Tool-Call` trailer would demote it to body text. */
  async function amendTrailers(
    worktreeAbs: string,
    trailers: readonly string[],
  ): Promise<void> {
    if (trailers.length === 0) return;
    const { stdout } = await git(worktreeAbs, ["log", "-1", "--format=%B"]);
    const message = stdout.trimEnd();
    const paragraphs = message.split(/\n\n+/);
    const joiner = isTrailerBlock(paragraphs.at(-1) ?? "") ? "\n" : "\n\n";
    const body = `${message}${joiner}${trailers.join("\n")}\n`;
    await git(worktreeAbs, [
      ...COMMIT_IDENT,
      "commit",
      "-q",
      "--amend",
      "--no-verify",
      "-m",
      body,
    ]);
  }

  /** The commits from..to on one ref (oldest first). */
  async function commitsInRange(
    repoRoot: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    if (from === to) return [];
    const { stdout } = await git(repoRoot, [
      "rev-list",
      "--reverse",
      `${from}..${to}`,
    ]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** Unified diff of a commit range (G2 turn-diff rows), size-capped: a diff
   * past `maxBytes` is cut at the last complete line and flagged truncated —
   * the endpoint must never ship megabytes into a thread row. */
  async function diffRange(
    repoRoot: string,
    from: string,
    to: string,
    opts: { maxBytes?: number } = {},
  ): Promise<{ diff: string; truncated: boolean }> {
    const maxBytes = opts.maxBytes ?? 256 * 1024;
    if (from === to) return { diff: "", truncated: false };
    const { stdout } = await git(repoRoot, [
      "diff",
      "--no-color",
      "--no-renames",
      from,
      to,
    ]);
    if (Buffer.byteLength(stdout, "utf8") <= maxBytes) {
      return { diff: stdout, truncated: false };
    }
    const cut = Buffer.from(stdout, "utf8").subarray(0, maxBytes).toString("utf8");
    const lastNewline = cut.lastIndexOf("\n");
    return {
      diff: lastNewline === -1 ? cut : cut.slice(0, lastNewline + 1),
      truncated: true,
    };
  }

  /** Is a cherry-pick paused mid-sequence in this worktree? */
  async function cherryPickInProgress(worktreeAbs: string): Promise<boolean> {
    try {
      const { stdout } = await git(worktreeAbs, [
        "rev-parse",
        "--git-path",
        "CHERRY_PICK_HEAD",
      ]);
      return existsSync(resolve(worktreeAbs, stdout.trim()));
    } catch {
      return false;
    }
  }

  /**
   * Cherry-pick `from..to` onto the worktree's current branch (the reapply
   * flow, spec §Selection). `clean` = every commit landed (redundant ones
   * kept as empties so the sequence never stalls — old gits lack --empty);
   * `conflict` = the sequence PAUSED with
   * conflict markers in the tree (caller runs the merge turn, then
   * continueCherryPick / abortCherryPick); `error` = git refused outright
   * (state already aborted).
   */
  async function cherryPickRange(
    worktreeAbs: string,
    from: string,
    to: string,
  ): Promise<
    | { status: "clean" }
    | { status: "conflict"; message: string }
    | { status: "error"; message: string }
  > {
    try {
      await git(worktreeAbs, [
        ...COMMIT_IDENT,
        "cherry-pick",
        "--allow-empty-message",
        "--keep-redundant-commits",
        `${from}..${to}`,
      ]);
      return { status: "clean" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (await cherryPickInProgress(worktreeAbs)) {
        return { status: "conflict", message };
      }
      await abortCherryPick(worktreeAbs);
      return { status: "error", message };
    }
  }

  /** Try to finish a paused cherry-pick (post-merge-turn: the agent wrote a
   * resolution but may not have staged/continued the sequence itself).
   * REFUSES while any unmerged path still carries conflict markers or is
   * missing — an unresolved conflict must never be committed as content. */
  async function continueCherryPick(worktreeAbs: string): Promise<boolean> {
    try {
      const { stdout } = await git(worktreeAbs, [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ]);
      for (const rel of stdout.split("\0").filter(Boolean)) {
        const content = await readFile(join(worktreeAbs, rel), "utf8").catch(
          () => undefined,
        );
        if (content === undefined || /^<{7}(\s|$)/m.test(content)) {
          return false;
        }
      }
      // Stage the (verified-resolved) tree, then continue with the stock
      // commit message (no editor in a server process).
      await git(worktreeAbs, ["add", "-A"]);
      await git(
        worktreeAbs,
        [...COMMIT_IDENT, "-c", "core.editor=true", "cherry-pick", "--continue"],
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Abort any in-flight cherry-pick and restore the worktree to HEAD. */
  async function abortCherryPick(worktreeAbs: string): Promise<void> {
    await git(worktreeAbs, ["cherry-pick", "--abort"]).catch(() => {});
    await git(worktreeAbs, ["reset", "-q", "--hard", "HEAD"]).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // G3 — the git-native lifecycle seams (drift→rebase, bake via merge,
  // bake-to-branch). docs/specs/changesets-on-git.md §Drift / bake.
  // ---------------------------------------------------------------------------

  /** Tree sha of a commit. */
  async function treeOf(repoRoot: string, commit: string): Promise<string> {
    const { stdout } = await git(repoRoot, ["rev-parse", `${commit}^{tree}`]);
    return stdout.trim();
  }

  /**
   * Snapshot the CURRENT source as a rebase base: HEAD's tree with the
   * ON-DISK content of `paths` swapped in (temp-index plumbing — the user's
   * index/tree are never touched). Returns HEAD itself when nothing differs;
   * otherwise a synthetic commit with parent HEAD, so changeset ancestry
   * checks keep holding after the base ref moves.
   */
  async function snapshotBaseCommit(
    repoRoot: string,
    paths: readonly string[],
  ): Promise<string> {
    const head = await resolveCommit(repoRoot, "HEAD");
    if (!head) throw new Error("the repository has no commits.");
    const indexFile = join(
      await mkdtemp(join(tmpdir(), "designbook-snap-")),
      "index",
    );
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await git(repoRoot, ["read-tree", head], env);
      for (const path of paths) {
        const abs = join(repoRoot, path);
        if (!existsSync(abs)) {
          await git(
            repoRoot,
            ["update-index", "--force-remove", "--", path],
            env,
          ).catch(() => {});
          continue;
        }
        const { stdout } = await git(
          repoRoot,
          ["hash-object", "-w", "--", abs],
          env,
        );
        await git(
          repoRoot,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${stdout.trim()},${path}`,
          ],
          env,
        );
      }
      const { stdout: treeOut } = await git(repoRoot, ["write-tree"], env);
      const tree = treeOut.trim();
      if (tree === (await treeOf(repoRoot, head))) return head;
      const { stdout: commitOut } = await git(
        repoRoot,
        [
          ...COMMIT_IDENT,
          "commit-tree",
          tree,
          "-p",
          head,
          "-m",
          "designbook: current-source snapshot (rebase base)",
        ],
        env,
      );
      return commitOut.trim();
    } finally {
      await rm(dirname(indexFile), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }

  /** Is a rebase paused mid-sequence in this worktree? */
  async function rebaseInProgress(worktreeAbs: string): Promise<boolean> {
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      try {
        const { stdout } = await git(worktreeAbs, [
          "rev-parse",
          "--git-path",
          dir,
        ]);
        if (existsSync(resolve(worktreeAbs, stdout.trim()))) return true;
      } catch {
        // Fall through.
      }
    }
    return false;
  }

  /**
   * Rebase `upstream..tip` onto `onto`, DETACHED, in a worktree (the caller
   * moves the branch ref to the reported tip on success — no dependency on
   * symref-HEAD rebase semantics). `--empty=keep` preserves the commit count
   * so distance-based baselines (generatedTips) remap as `newTip~N`.
   * `conflict` = the rebase PAUSED with markers (caller runs the merge turn,
   * then continueRebase / abortRebase); `error` = git refused outright
   * (state already aborted).
   */
  async function rebaseOnto(
    worktreeAbs: string,
    params: { onto: string; upstream: string; tip: string },
  ): Promise<
    | { status: "clean"; newTip: string }
    | { status: "conflict"; message: string }
    | { status: "error"; message: string }
  > {
    try {
      await git(worktreeAbs, [
        ...COMMIT_IDENT,
        "rebase",
        "--empty=keep",
        "--no-autostash",
        "--onto",
        params.onto,
        params.upstream,
        params.tip,
      ]);
      const newTip = (await resolveCommit(worktreeAbs, "HEAD"))!;
      return { status: "clean", newTip };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (await rebaseInProgress(worktreeAbs)) {
        return { status: "conflict", message };
      }
      await abortRebase(worktreeAbs);
      return { status: "error", message };
    }
  }

  /** Try to finish a paused rebase (post-merge-turn: the agent resolved but
   * may not have staged/continued). REFUSES while any unmerged path still
   * carries conflict markers or is missing; a follow-up commit conflicting
   * again also returns false (ONE merge turn per branch — the caller aborts).
   * Returns true once the rebase fully completed. */
  async function continueRebase(worktreeAbs: string): Promise<boolean> {
    for (let round = 0; round < 100; round += 1) {
      if (!(await rebaseInProgress(worktreeAbs))) return true;
      try {
        const { stdout } = await git(worktreeAbs, [
          "diff",
          "--name-only",
          "--diff-filter=U",
          "-z",
        ]);
        for (const rel of stdout.split("\0").filter(Boolean)) {
          const content = await readFile(join(worktreeAbs, rel), "utf8").catch(
            () => undefined,
          );
          if (content === undefined || /^<{7}(\s|$)/m.test(content)) {
            return false;
          }
        }
        await git(worktreeAbs, ["add", "-A"]);
        await git(worktreeAbs, [
          ...COMMIT_IDENT,
          "-c",
          "core.editor=true",
          "rebase",
          "--continue",
        ]);
      } catch {
        // A NEW conflict paused the sequence again — the next round's marker
        // check decides (unresolved markers = false, the caller aborts).
        if (!(await rebaseInProgress(worktreeAbs))) return true;
        const { stdout } = await git(worktreeAbs, [
          "diff",
          "--name-only",
          "--diff-filter=U",
          "-z",
        ]).catch(() => ({ stdout: "" }));
        if (stdout.split("\0").filter(Boolean).length === 0) return false;
      }
    }
    return false;
  }

  /** Abort any in-flight rebase and restore the worktree to a clean HEAD. */
  async function abortRebase(worktreeAbs: string): Promise<void> {
    await git(worktreeAbs, ["rebase", "--abort"]).catch(() => {});
    await git(worktreeAbs, ["reset", "-q", "--hard", "HEAD"]).catch(() => {});
  }

  /** merge-base of two commits (variant fork-point discovery). */
  async function mergeBase(
    repoRoot: string,
    a: string,
    b: string,
  ): Promise<string | undefined> {
    try {
      const { stdout } = await git(repoRoot, ["merge-base", a, b]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** The squashed patch of from..to, optionally limited to `paths`
   * (`--full-index --binary` so `git apply --3way` can reconstruct every
   * blob from the local odb). Empty string = no changes. */
  async function diffPatch(
    repoRoot: string,
    from: string,
    to: string,
    paths?: readonly string[],
  ): Promise<string> {
    const { stdout } = await git(repoRoot, [
      "diff",
      "--full-index",
      "--binary",
      "--no-color",
      "--no-renames",
      from,
      to,
      ...(paths && paths.length > 0 ? ["--", ...paths] : []),
    ]);
    return stdout;
  }

  /**
   * Apply a squashed patch onto a working tree with 3-way fallback (the G3
   * bake mechanics): a TEMP index seeded from HEAD + the ON-DISK content of
   * `paths` stands in for the real one, so the user's index is never
   * touched and "ours" is exactly what the user sees on disk. Clean = files
   * written; conflict = markers left in the named files (temp index records
   * the unmerged stages); error = nothing applied.
   */
  async function applyPatch3Way(
    treeRoot: string,
    patch: string,
    paths: readonly string[],
  ): Promise<
    | { status: "clean" }
    | { status: "conflict"; files: string[]; message: string }
    | { status: "error"; message: string }
  > {
    if (!patch.trim()) return { status: "clean" };
    const scratch = await mkdtemp(join(tmpdir(), "designbook-apply-"));
    const indexFile = join(scratch, "index");
    const patchFile = join(scratch, "patch.diff");
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await writeFile(patchFile, patch, "utf8");
      const head = await resolveCommit(treeRoot, "HEAD");
      if (!head) return { status: "error", message: "no HEAD commit." };
      await git(treeRoot, ["read-tree", head], env);
      for (const path of paths) {
        if (!existsSync(join(treeRoot, path))) continue;
        // `update-index --add` (not --cacheinfo): the entry must carry REAL
        // stat info or `apply --3way` refuses with "does not match index".
        await git(treeRoot, ["update-index", "--add", "--", path], env);
      }
      try {
        await git(
          treeRoot,
          ["apply", "--3way", "--whitespace=nowarn", patchFile],
          env,
        );
        return { status: "clean" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { stdout } = await git(
          treeRoot,
          ["ls-files", "--unmerged", "-z"],
          env,
        ).catch(() => ({ stdout: "" }));
        const files = [
          ...new Set(
            stdout
              .split("\0")
              .filter(Boolean)
              .map((line) => line.split("\t")[1])
              .filter((rel): rel is string => Boolean(rel)),
          ),
        ];
        if (files.length > 0) return { status: "conflict", files, message };
        return { status: "error", message };
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Repo-relative dirs (depth ≤ 2) that carry a node_modules — a MONOREPO's
   * sibling packages need their deps symlinked too or a tsc gate in a temp
   * worktree fails on cross-package imports (live-run finding). */
  async function nodeModulesDirs(repoRoot: string): Promise<string[]> {
    const found = [""];
    const skip = new Set([".git", "node_modules", ".designbook", "dist"]);
    const scan = async (rel: string, depth: number) => {
      const abs = rel ? join(repoRoot, rel) : repoRoot;
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || skip.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (existsSync(join(repoRoot, childRel, "node_modules"))) {
          found.push(childRel);
        }
        if (depth < 2) await scan(childRel, depth + 1);
      }
    };
    await scan("", 1);
    return found;
  }

  /** Create a TEMP worktree DETACHED at a commit (bake-to-branch
   * materialization + gate — no hidden-ref attach). Links EVERY
   * node_modules dir (shallow scan), not just the app-dir chain: the tsc
   * gate resolves cross-package imports here. Caller removes it via
   * removeTempWorktree. */
  async function createDetachedTempWorktree(params: {
    repoRoot: string;
    commit: string;
    appDir: string;
  }): Promise<string> {
    const { repoRoot, commit, appDir } = params;
    const worktreeAbs = await mkdtemp(join(tmpdir(), "designbook-wt-"));
    await git(repoRoot, [
      "worktree",
      "add",
      "--force",
      "--detach",
      worktreeAbs,
      commit,
    ]);
    const packageDirs = await nodeModulesDirs(repoRoot).catch(
      () => [] as string[],
    );
    await linkNodeModules(repoRoot, worktreeAbs, [
      ...appDirChain(appDir),
      ...packageDirs,
    ]);
    // Workspace packages' BUILD OUTPUTS are gitignored (absent from the
    // checkout) but the gate's module resolution needs them (self-name
    // exports → dist) — symlink them like deps (real-only by construction).
    for (const rel of packageDirs) {
      const source = join(repoRoot, rel, "dist");
      const target = join(worktreeAbs, rel, "dist");
      if (!existsSync(source) || existsSync(target)) continue;
      try {
        await mkdir(dirname(target), { recursive: true });
        await symlink(source, target);
      } catch {
        // Best-effort — a missing link only risks a skipped/failed gate.
      }
    }
    return worktreeAbs;
  }

  /** Build a commit from an existing TREE onto `parent` (re-bake to an
   * existing branch: same materialized tree, new parent). Falls back to the
   * designbook identity when the user's git identity is unconfigured. */
  async function commitTreeOnto(params: {
    repoRoot: string;
    tree: string;
    parent: string;
    message: string;
  }): Promise<string> {
    const args = ["commit-tree", params.tree, "-p", params.parent, "-m", params.message];
    try {
      const { stdout } = await git(params.repoRoot, args);
      return stdout.trim();
    } catch {
      const { stdout } = await git(params.repoRoot, [...COMMIT_IDENT, ...args]);
      return stdout.trim();
    }
  }

  /** Is `name` a well-formed branch name? */
  async function isValidBranchName(
    repoRoot: string,
    name: string,
  ): Promise<boolean> {
    if (!name || name.includes("..") || name.startsWith("-")) return false;
    try {
      await git(repoRoot, ["check-ref-format", "--branch", name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Per-tool-write commit capture for ONE turn running in `worktreeAbs` on
   * `ref`. `noteToolEnd` (called from the session's tool_execution_end seam)
   * enqueues a commit of whatever the tool wrote — message = tool + files
   * summary, trailer `Designbook-Tool-Call: <id>`. `finish` flushes the
   * queue, commits any remaining dirty state, stamps the final commit with
   * the turn trailers, and reports the range.
   */
  function createTurnCapture(params: {
    repoRoot: string;
    worktreeAbs: string;
    ref: string;
    startTip: string;
  }): TurnGitCapture {
    const { repoRoot, worktreeAbs, ref, startTip } = params;
    let queue: Promise<void> = Promise.resolve();
    let committed = false;

    function enqueue(work: () => Promise<void>): Promise<void> {
      queue = queue.then(work).catch((error: unknown) => {
        log(`turn commit failed: ${String(error)}`);
      });
      return queue;
    }

    async function commitDirty(
      subjectPrefix: string,
      trailers: readonly string[],
      /** Use `subjectPrefix` verbatim as the whole subject (agent-supplied
       * turn summaries on the catch-all commit). */
      fullSubject = false,
    ): Promise<void> {
      const dirty = await dirtyPaths(worktreeAbs);
      if (dirty.length === 0) return;
      const shown = dirty.slice(0, COMMIT_FILES_CAP).join(", ");
      const extra =
        dirty.length > COMMIT_FILES_CAP
          ? ` (+${dirty.length - COMMIT_FILES_CAP} more)`
          : "";
      const sha = await commitAll(
        worktreeAbs,
        fullSubject ? subjectPrefix : `${subjectPrefix}: ${shown}${extra}`,
        trailers,
      );
      if (sha) committed = true;
    }

    return {
      noteToolEnd(info) {
        const name = (info.toolName ?? "").toLowerCase();
        if (!WRITE_CLASS_TOOLS.has(name)) return Promise.resolve();
        return enqueue(() =>
          commitDirty(
            name,
            info.toolCallId ? [`Designbook-Tool-Call: ${info.toolCallId}`] : [],
          ),
        );
      },
      async finish(meta) {
        enqueue(() =>
          meta.summary
            ? commitDirty(meta.summary, [], true)
            : commitDirty("turn writes", []),
        );
        await queue;
        if (committed) {
          const trailers = [
            ...(meta.conversationId
              ? [`Designbook-Conversation: ${meta.conversationId}`]
              : []),
            ...(meta.sessionId
              ? [
                  `Designbook-Turn: ${meta.sessionId}/${meta.turnIndex ?? 1}`,
                ]
              : []),
          ];
          await amendTrailers(worktreeAbs, trailers).catch((error: unknown) => {
            log(`turn trailer amend failed: ${String(error)}`);
          });
        }
        const to = (await resolveCommit(repoRoot, ref)) ?? startTip;
        return {
          from: startTip,
          to,
          commits: await commitsInRange(repoRoot, startTip, to),
        };
      },
    };
  }

  /**
   * Commit ONE file's new content onto a ref WITHOUT a worktree (manual
   * direct data edits): temp-index plumbing — read-tree tip, swap the blob,
   * write-tree, commit-tree, update-ref.
   */
  async function commitFileChange(params: {
    repoRoot: string;
    ref: string;
    path: string;
    content: string;
    message: string;
    trailers?: readonly string[];
  }): Promise<string> {
    const { repoRoot, ref, path, content, message } = params;
    const tip = await resolveCommit(repoRoot, ref);
    if (!tip) throw new Error(`unknown changeset ref: ${ref}`);
    const indexFile = join(
      await mkdtemp(join(tmpdir(), "designbook-idx-")),
      "index",
    );
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await git(repoRoot, ["read-tree", tip], env);
      // hash-object from a temp FILE (the exec seam has no stdin pipe).
      const tmpFile = join(dirname(indexFile), "content");
      await writeFile(tmpFile, content, "utf8");
      const { stdout: blobOut } = await git(
        repoRoot,
        ["hash-object", "-w", tmpFile],
        env,
      );
      const blobSha = blobOut.trim();
      await git(
        repoRoot,
        ["update-index", "--add", "--cacheinfo", `100644,${blobSha},${path}`],
        env,
      );
      const { stdout: treeOut } = await git(repoRoot, ["write-tree"], env);
      const body = [message, "", ...(params.trailers ?? [])]
        .join("\n")
        .trimEnd();
      const { stdout: commitOut } = await git(
        repoRoot,
        [...COMMIT_IDENT, "commit-tree", treeOut.trim(), "-p", tip, "-m", body],
        env,
      );
      const commit = commitOut.trim();
      await updateRef(repoRoot, ref, commit);
      return commit;
    } finally {
      await rm(dirname(indexFile), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }

  /** One commit's subject + trailers (rollback UI / sidecar linkage). The
   * trailer block is parsed from the raw message (last paragraph), so it
   * stays exact regardless of the host git's pretty-format support. */
  async function commitInfo(
    repoRoot: string,
    commit: string,
  ): Promise<{ subject: string; trailers: Record<string, string> }> {
    const { stdout } = await git(repoRoot, ["log", "-1", "--format=%B", commit]);
    const message = stdout.trimEnd();
    const subject = message.split("\n")[0] ?? "";
    const trailers: Record<string, string> = {};
    const last = message.split(/\n\n+/).at(-1) ?? "";
    if (isTrailerBlock(last)) {
      for (const line of last.split("\n")) {
        const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
        if (match) trailers[match[1]] = match[2];
      }
    }
    return { subject, trailers };
  }

  return {
    abortCherryPick,
    abortRebase,
    amendTrailers,
    applyPatch3Way,
    attachWorktree,
    changedFiles,
    cherryPickInProgress,
    cherryPickRange,
    cleanWorktree,
    commitAll,
    commitFileChange,
    commitInfo,
    commitsInRange,
    commitTreeOnto,
    continueCherryPick,
    continueRebase,
    createDetachedTempWorktree,
    createTempWorktree,
    createTurnCapture,
    cutVariantBranch,
    diffPatch,
    diffRange,
    deleteChangesetRefs,
    dirtyPaths,
    ensureChangesetRefs,
    ensureWorktree,
    ensureWorktreesExcluded,
    getSelected,
    isAncestor,
    isRepo,
    isValidBranchName,
    listRefs,
    mergeBase,
    pruneIdleWorktrees,
    readBlob,
    rebaseInProgress,
    rebaseOnto,
    removeTempWorktree,
    removeWorktree,
    resolveCommit,
    setSelected,
    snapshotBaseCommit,
    treeOf,
    updateRef,
  };
}

type GitChangesets = ReturnType<typeof createGitChangesets>;

export {
  CHANGESET_REF_PREFIX,
  GitRequiredError,
  WORKTREES_DIR_REL,
  altIdOfRef,
  createGitChangesets,
  refBase,
  refSelected,
  refTrunk,
  refVariant,
  worktreePathFor,
};
export type { GitChangesets, GitExec, TurnGitCapture };
