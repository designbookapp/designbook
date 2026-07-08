/**
 * `branch` model atoms: the small, declarative pieces the branch
 * selector or a cell composes over the worktree state. Thin — the branch
 * model's substance is the injected switch/retry actions + the no-git
 * `showSelector` gate (branchModel.ts) — so these exist only so a cell can label
 * a worktree without reaching into the selector, and so that labeling has ONE
 * home.
 *
 * `useBranchModel` (re-exported from BranchProvider) is the context hook the
 * selector uses to reach the state + actions.
 */

import { Badge } from "@designbook-ui/components/ui/badge";
import type { WorktreeSummary } from "./branchModel";
import { useBranchModel } from "./BranchProvider";
import {
  splitPath,
  statusBadgeVariant,
  statusLabel,
  type ChangeStatus,
  type FileChange,
} from "./changesModel";
import { useChangesModelIfPresent } from "./ChangesProvider";

/** A worktree's branch name (the selector's primary label). */
function WorktreeBranch({ worktree }: { worktree: WorktreeSummary }) {
  return <>{worktree.branch}</>;
}

/** Whether a worktree is the one the workbench is currently attached to. */
function isCurrentWorktree(
  worktree: WorktreeSummary,
  currentBranch: string | undefined,
): boolean {
  return worktree.branch === currentBranch;
}

/** The worktrees currently on the provider (empty in the no-git degrade). */
function useWorktreeList(): WorktreeSummary[] {
  return useBranchModel().worktrees;
}

// --- changes atoms (Changes tab MVP) --------------------------------------

const EMPTY_PATHS = new Set<string>();

/** Designer-facing status badge for a change ("Edited" / "New" / …). */
function ChangeStatusBadge({ status }: { status: ChangeStatus }) {
  return <Badge variant={statusBadgeVariant(status)}>{statusLabel(status)}</Badge>;
}

/** basename (medium) + dirname (muted, truncating) row label. */
function ChangePathLabel({ change }: { change: FileChange }) {
  const { base, dir } = splitPath(change.path);
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-xs font-medium">{base}</span>
      {dir ? (
        <span
          className="min-w-0 truncate text-xs text-muted-foreground"
          style={{ direction: "rtl" }}
          title={dir}
        >
          {dir}
        </span>
      ) : null}
    </span>
  );
}

/** Changed projectRoot-relative paths; empty when no provider is mounted. */
function useChangedPaths(): Set<string> {
  return useChangesModelIfPresent()?.changedPaths ?? EMPTY_PATHS;
}

/**
 * Canvas-card change badge: shows the file's status label when `sourcePath`
 * is among the changed files, and clicking it goes STRAIGHT to the diff
 * (RHS Code tab), not to the Changes tab. Renders nothing when the file is
 * unchanged or no provider is mounted (cells/tests degrade silently).
 */
function ChangedFileBadge({ sourcePath }: { sourcePath?: string }) {
  const model = useChangesModelIfPresent();
  if (!model || !sourcePath) return null;
  const change = model.sortedChanges.find((c) => c.path === sourcePath);
  if (!change) return null;
  return (
    <Badge
      asChild
      variant={statusBadgeVariant(change.status)}
      className="cursor-pointer"
    >
      <button
        type="button"
        title={`View the diff for ${sourcePath}`}
        onClick={(event) => {
          event.stopPropagation();
          model.openDiff(change.path);
        }}
      >
        {statusLabel(change.status)}
      </button>
    </Badge>
  );
}

export {
  ChangedFileBadge,
  ChangePathLabel,
  ChangeStatusBadge,
  WorktreeBranch,
  isCurrentWorktree,
  useChangedPaths,
  useWorktreeList,
  useBranchModel,
};
