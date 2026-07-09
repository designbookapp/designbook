/**
 * Shared path guards for the source-file API routes (`/api/file`,
 * `/api/file-diff`, `/api/changes/discard`, …).
 *
 * Two independent checks, because the routes need them separately:
 *   - containment (`resolveContainedPath`): the path must resolve INSIDE the
 *     project root — absolute paths and `..` escapes are rejected. Every route
 *     that takes a path input applies this.
 *   - extension allowlist (`isSupportedSourcePath`): only text-ish source
 *     files get their CONTENT served/edited. The changes list + discard work
 *     on any contained file (git owns those), but `/api/file` and
 *     `/api/file-diff` refuse to read unsupported/binary types.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { WORKTREES_DIR_REL } from "../lib/worktrees.ts";

/**
 * A relative path reaching into a NESTED branch worktree
 * (`.designbook/worktrees/<branch>/…`). Branch worktrees now live inside the
 * repo, so such a path resolves INSIDE the primary root and would otherwise
 * pass containment — a cross-branch read/write from the primary. Rejected
 * regardless of the active root: when the active root already IS a worktree,
 * its own repo-relative paths never carry this prefix (no worktree nests
 * another), so this only ever blocks the cross-root case.
 */
function reachesIntoWorktree(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return norm === WORKTREES_DIR_REL || norm.startsWith(`${WORKTREES_DIR_REL}/`);
}

const SOURCE_FILE_EXTENSIONS = [
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".css",
  ".json",
  ".md",
];

/** Whether the path's extension is on the readable/writable allowlist. */
function isSupportedSourcePath(relPath: string): boolean {
  return SOURCE_FILE_EXTENSIONS.some((ext) => relPath.endsWith(ext));
}

/**
 * Resolve a project-relative path to an absolute one, or undefined if it is
 * absolute, empty, or escapes the project root. No extension check — see
 * module doc.
 */
function resolveContainedPath(
  projectRoot: string,
  relPath: string,
): string | undefined {
  if (!relPath || relPath.includes("\0") || isAbsolute(relPath)) {
    return undefined;
  }
  const absPath = resolve(projectRoot, relPath);
  const insideProject = relative(projectRoot, absPath);
  if (
    !insideProject ||
    insideProject.startsWith("..") ||
    isAbsolute(insideProject) ||
    reachesIntoWorktree(insideProject)
  ) {
    return undefined;
  }
  return absPath;
}

/** Containment + extension allowlist in one step (the `/api/file` gate). */
function resolveSourceFile(
  projectRoot: string,
  relPath: string,
): string | undefined {
  const absPath = resolveContainedPath(projectRoot, relPath);
  if (!absPath || !isSupportedSourcePath(relPath)) return undefined;
  return absPath;
}

export {
  SOURCE_FILE_EXTENSIONS,
  isSupportedSourcePath,
  resolveContainedPath,
  resolveSourceFile,
};
