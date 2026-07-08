/**
 * Changes-tab backend (Changes tab MVP spec): the working tree vs HEAD is the
 * ONE sound source of truth for "what changed in this worktree" — it captures
 * Pi edits, designbook data-endpoint writes, and the user's own IDE edits
 * uniformly.
 *
 * Pure pieces (porcelain `-z` parsing, staged/unstaged status collapse, repo
 * prefix mapping) are exported for unit tests; the async entry points
 * (`listChanges` / `fileDiff` / `discardChange`) shell out to git via
 * `execFile` array args only — no shell, and every path argument follows a
 * `--` separator so it can never be parsed as an option. Callers are expected
 * to have containment-checked paths via `resolveContainedPath` first.
 *
 * No-git projects degrade to `{ git: false, changes: [] }`, mirroring
 * `handleListWorktrees`.
 */

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { isSupportedSourcePath } from "./sourcePaths.ts";

const execFileAsync = promisify(execFile);

/** Porcelain `git status` output can be large on messy trees. */
const STATUS_MAX_BUFFER = 16 * 1024 * 1024;

/** Collapsed per-file status (designers don't have an index mental model). */
type ChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

type FileChange = {
  /** projectRoot-relative path (composes with `/api/file` + registry sourcePath). */
  path: string;
  status: ChangeStatus;
  /** The pre-rename path, for `renamed` entries; null otherwise. */
  origPath: string | null;
};

type RawPorcelainEntry = {
  x: string;
  y: string;
  /** Repo-root-relative path (the rename TARGET for rename/copy entries). */
  path: string;
  /** Repo-root-relative origin path for rename/copy entries. */
  origPath?: string;
};

/**
 * Parse `git status --porcelain=v1 -z` output. `-z` gives NUL-separated,
 * unquoted paths; a rename/copy entry is `XY <newpath>NUL<origpath>NUL`
 * (target first, origin second).
 */
function parsePorcelainZ(stdout: string): RawPorcelainEntry[] {
  const tokens = stdout.split("\0");
  const entries: RawPorcelainEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    // Trailing empty token (output ends with NUL) or malformed fragment.
    if (token.length < 4 || token[2] !== " ") continue;
    const entry: RawPorcelainEntry = {
      x: token[0],
      y: token[1],
      path: token.slice(3),
    };
    if (
      entry.x === "R" ||
      entry.x === "C" ||
      entry.y === "R" ||
      entry.y === "C"
    ) {
      entry.origPath = tokens[index];
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Collapse the X (index) / Y (worktree) porcelain columns to one designer-
 * facing status. Conflicts first (any `U`, plus the `AA`/`DD` both-sides
 * cases), then untracked, rename, added, deleted; anything else is a plain
 * modification. Ignored entries (`!!`) collapse to undefined (dropped).
 */
function collapseStatus(x: string, y: string): ChangeStatus | undefined {
  const xy = x + y;
  if (xy === "!!") return undefined;
  if (xy === "??") return "untracked";
  if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "conflicted";
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

/**
 * Map repo-root-relative porcelain entries to projectRoot-relative changes:
 * drop entries outside the project prefix (`git rev-parse --show-prefix`),
 * strip the prefix, collapse statuses, sort by path.
 */
function toProjectChanges(
  entries: RawPorcelainEntry[],
  prefix: string,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const entry of entries) {
    const status = collapseStatus(entry.x, entry.y);
    if (!status) continue;
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const origPath =
      entry.origPath === undefined
        ? null
        : prefix && entry.origPath.startsWith(prefix)
          ? entry.origPath.slice(prefix.length)
          : entry.origPath;
    changes.push({
      path: prefix ? entry.path.slice(prefix.length) : entry.path,
      status,
      origPath,
    });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** projectRoot's path relative to the repo root ("" when it IS the root). */
async function readGitPrefix(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-prefix"],
    { cwd: projectRoot },
  );
  return stdout.trim();
}

async function statusEntries(
  projectRoot: string,
  pathspec: string,
): Promise<{ entries: RawPorcelainEntry[]; prefix: string }> {
  const [{ stdout }, prefix] = await Promise.all([
    execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--", pathspec],
      { cwd: projectRoot, maxBuffer: STATUS_MAX_BUFFER },
    ),
    readGitPrefix(projectRoot),
  ]);
  return { entries: parsePorcelainZ(stdout), prefix };
}

type ChangesResult = { git: boolean; changes: FileChange[] };

/**
 * `GET /api/changes` core: the collapsed per-file change list, scoped to (and
 * relative to) projectRoot. Not a repo / git missing → `{ git: false, … }`.
 */
async function listChanges(projectRoot: string): Promise<ChangesResult> {
  try {
    const { entries, prefix } = await statusEntries(projectRoot, ".");
    return { git: true, changes: toProjectChanges(entries, prefix) };
  } catch {
    // Not a git repo (or git unavailable) — degrade like handleListWorktrees.
    return { git: false, changes: [] };
  }
}

/** The single change entry for one projectRoot-relative path, if any. */
async function changeForPath(
  projectRoot: string,
  relPath: string,
): Promise<FileChange | undefined> {
  const { entries, prefix } = await statusEntries(projectRoot, relPath);
  return toProjectChanges(entries, prefix).find(
    (change) => change.path === relPath,
  );
}

type FileDiff = {
  path: string;
  status: ChangeStatus | "unmodified";
  /** Content at HEAD, or null (untracked/added file, or no git). */
  head: string | null;
  /** Current working content, or null (deleted file). */
  working: string | null;
  /** Set when the extension is off the readable allowlist (no content). */
  unsupported?: true;
};

/**
 * `GET /api/file-diff` core: both sides of the change, for the client-side
 * unified diff (`@codemirror/merge` takes raw originals — no patch parsing).
 * `absPath` must already be containment-checked.
 */
async function fileDiff(
  projectRoot: string,
  relPath: string,
  absPath: string,
): Promise<FileDiff> {
  if (!isSupportedSourcePath(relPath)) {
    return {
      path: relPath,
      status: "unmodified",
      head: null,
      working: null,
      unsupported: true,
    };
  }

  const [change, head, working] = await Promise.all([
    changeForPath(projectRoot, relPath).catch(() => undefined),
    readGitPrefix(projectRoot)
      .then(async (prefix) => {
        const { stdout } = await execFileAsync(
          "git",
          ["show", `HEAD:${prefix}${relPath}`],
          { cwd: projectRoot, maxBuffer: STATUS_MAX_BUFFER },
        );
        return stdout;
      })
      .catch(() => null),
    readFile(absPath, "utf8").catch(() => null),
  ]);

  return {
    path: relPath,
    status: change?.status ?? "unmodified",
    head,
    working,
  };
}

/** Error carrying the HTTP status the discard route should answer with. */
type DiscardError = Error & { status: number };

function discardError(status: number, message: string): DiscardError {
  const error = new Error(message) as DiscardError;
  error.status = status;
  return error;
}

type DiscardResult = {
  ok: true;
  /** projectRoot-relative paths whose on-disk state was touched. */
  touchedPaths: string[];
};

/**
 * `POST /api/changes/discard` core. Tracked files are restored to HEAD
 * (`git checkout HEAD -- <path>`); untracked/added files are deleted (the
 * client's "Delete file" confirm — the status distinction is re-derived
 * server-side, so a mislabeled request still does the right thing).
 * Conflicted files are refused. `absPath` must be containment-checked.
 */
async function discardChange(
  projectRoot: string,
  relPath: string,
  absPath: string,
): Promise<DiscardResult> {
  let change: FileChange | undefined;
  try {
    change = await changeForPath(projectRoot, relPath);
  } catch {
    throw discardError(409, "Not a git repository — nothing to discard.");
  }

  if (!change) {
    throw discardError(404, "No changes to discard for this file.");
  }

  switch (change.status) {
    case "conflicted":
      throw discardError(
        409,
        "This file has a merge conflict — resolve it in your editor first.",
      );
    case "untracked":
      await unlink(absPath);
      return { ok: true, touchedPaths: [relPath] };
    case "added":
      // Staged-new: drop it from the index, then delete the file itself.
      await execFileAsync(
        "git",
        ["rm", "--cached", "--force", "--quiet", "--", relPath],
        { cwd: projectRoot },
      ).catch(() => undefined);
      await unlink(absPath);
      return { ok: true, touchedPaths: [relPath] };
    case "renamed": {
      // Undo both halves: remove the new path (index + worktree), restore the
      // original from HEAD.
      await execFileAsync(
        "git",
        ["rm", "--cached", "--force", "--quiet", "--", relPath],
        { cwd: projectRoot },
      ).catch(() => undefined);
      await unlink(absPath).catch(() => undefined);
      const touched = [relPath];
      if (change.origPath) {
        await execFileAsync(
          "git",
          ["checkout", "HEAD", "--", change.origPath],
          { cwd: projectRoot },
        );
        touched.push(change.origPath);
      }
      return { ok: true, touchedPaths: touched };
    }
    default:
      // modified / deleted: restore index + worktree from HEAD.
      await execFileAsync("git", ["checkout", "HEAD", "--", relPath], {
        cwd: projectRoot,
      });
      return { ok: true, touchedPaths: [relPath] };
  }
}

export {
  collapseStatus,
  discardChange,
  fileDiff,
  listChanges,
  parsePorcelainZ,
  toProjectChanges,
};
export type { ChangeStatus, FileChange, FileDiff };
