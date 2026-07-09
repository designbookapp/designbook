/**
 * Per-request repo-root resolution for the branch-scoped data endpoints.
 *
 * The per-branch-sessions work scoped the Pi SESSION to the active worktree,
 * but every repo-FILE endpoint (`/api/changes`, `/api/file`, `/api/json`,
 * `/api/style`, `/api/i18n`, `/api/po`, …) kept resolving against the PRIMARY
 * checkout — so with the proxy retargeted to a branch, the Changes tab showed
 * primary's (empty) status, the code panel served primary's file content, and
 * write-back endpoints landed edits in the primary tree (cross-branch
 * writes). These helpers resolve the ONE root a request operates on.
 *
 * Invariants:
 *   - `activeWorktreeRoot` undefined (host mode, proxy before the first
 *     switch) → `projectRoot`, byte-identical to the old behavior.
 *   - A handler must resolve the root ONCE per request and thread it through
 *     containment, read/write, and recent-writes bookkeeping — mixing roots
 *     within a request would reopen the path-traversal gap the containment
 *     check exists to close (checked against one root, written under
 *     another). Enforced by the source scan in activeRepoRoot.test.ts.
 */

import { relative, resolve } from "node:path";

/**
 * The repo root a data-endpoint request reads/writes: the active branch's
 * worktree when the proxy has switched, the primary checkout otherwise.
 */
function resolveActiveRepoRoot(params: {
  /** `worktreeProxy.activeWorktreeRoot()` — undefined = primary/host mode. */
  activeWorktreeRoot: string | undefined;
  projectRoot: string;
}): string {
  return params.activeWorktreeRoot ?? params.projectRoot;
}

/**
 * The config file's directory, rebased into the active root. Locale/`.po`
 * paths arrive CONFIG-relative; the config file sits at the same
 * repo-relative path in every worktree, so rebasing the primary `configDir`
 * keeps those paths resolving inside the SAME root the containment check
 * (and the read/write) uses.
 */
function rebaseConfigDir(params: {
  /** Absolute config dir in the PRIMARY checkout (dirname of configPath). */
  configDir: string;
  projectRoot: string;
  /** The resolved active root (see resolveActiveRepoRoot). */
  repoRoot: string;
}): string {
  const { configDir, projectRoot, repoRoot } = params;
  if (resolve(repoRoot) === resolve(projectRoot)) return configDir;
  return resolve(repoRoot, relative(projectRoot, configDir));
}

export { rebaseConfigDir, resolveActiveRepoRoot };
