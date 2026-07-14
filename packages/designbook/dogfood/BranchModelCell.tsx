/**
 * Dogfood cell for `models/branch` (R spec item 4). Wraps `BranchProvider` in
 * fixture mode (current branch + two other worktrees, one running) and renders
 * the `WorktreeBranch` atom over each — the same piece the branch selector
 * composes, with no live worktree scan.
 */
import { useMemo } from "react";
import {
  isCurrentWorktree,
  useBranchModel,
  useWorktreeList,
  WorktreeBranch,
} from "@designbook-ui/models/branch/atoms";
import { BranchProvider } from "@designbook-ui/models/branch/BranchProvider";
import { createBranchFixture } from "@designbook-ui/models/branch/fixtures";
import { Badge } from "@designbook-ui/components/ui/badge";
import { ModelCellFrame } from "./ModelCellFrame";

function BranchCellBody() {
  const worktrees = useWorktreeList();
  const { currentBranch } = useBranchModel();
  return (
    <ul className="space-y-1.5 text-sm">
      {worktrees.map((worktree) => (
        <li key={worktree.branch} className="flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <WorktreeBranch worktree={worktree} />
            {isCurrentWorktree(worktree, currentBranch) ? (
              <span className="text-xs text-muted-foreground">(current)</span>
            ) : null}
          </span>
          <Badge variant={worktree.running ? "default" : "outline"}>
            {worktree.running ? "running" : "idle"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function BranchModelCell() {
  const fixture = useMemo(() => createBranchFixture(), []);
  return (
    <BranchProvider
      data={fixture.data}
      switchBranch={fixture.switchBranch}
      retry={fixture.retry}
    >
      <ModelCellFrame title="Worktrees" model="models/branch">
        <BranchCellBody />
      </ModelCellFrame>
    </BranchProvider>
  );
}

export default BranchModelCell;
