import { useState, type FormEvent } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  PlusIcon,
} from "lucide-react";
import { Badge } from "@designbook-ui/components/ui/badge";
import { Button } from "@designbook-ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@designbook-ui/components/ui/dropdown-menu";
import { Input } from "@designbook-ui/components/ui/input";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import { useBranchModel } from "@designbook-ui/models/branch/BranchProvider";

const copy = {
  agentDoneBadge: "agent finished",
  agentWorkingBadge: "agent working",
  branchesLabel: "Worktrees",
  createBranch: "Create new branch…",
  createBranchPlaceholder: "design/my-exploration",
  createBranchSubmit: "Create",
  currentBadge: "current",
  dirtyTitle: "uncommitted changes",
  loadingBranch: "Preparing worktree…",
  runningBadge: "running",
};

/** Compact uncommitted-change label for a worktree: "3", "99+", or "" when
 * clean/unknown (the server caps the count at 99). */
function dirtyLabel(dirtyCount: number | undefined): string {
  if (!dirtyCount || dirtyCount <= 0) return "";
  return dirtyCount >= 99 ? "99+" : String(dirtyCount);
}

function BranchSelector() {
  const { agentStatuses, currentBranch, worktrees, switching, switchBranch } =
    useBranchModel();
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");

  function submitNewBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const branch = newBranchName.trim();
    if (!branch) return;
    setCreating(false);
    setNewBranchName("");
    switchBranch(branch);
  }

  return (
    <div className="grid gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={switching}
            className="w-full justify-start gap-2 px-2"
          >
            {switching ? (
              <Spinner className="shrink-0" />
            ) : (
              <GitBranchIcon className="shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">
              {switching
                ? copy.loadingBranch
                : (currentBranch ?? copy.loadingBranch)}
            </span>
            <ChevronDownIcon className="shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel>{copy.branchesLabel}</DropdownMenuLabel>
          {worktrees.map((worktree) => (
            <DropdownMenuItem
              key={worktree.branch}
              onSelect={() => switchBranch(worktree.branch)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {worktree.branch}
              </span>
              {dirtyLabel(worktree.dirtyCount) ? (
                // Uncommitted-change count per worktree branch (additive
                // `dirtyCount` from GET /api/worktrees): a dot + compact count.
                <Badge
                  variant="outline"
                  title={`${dirtyLabel(worktree.dirtyCount)} ${copy.dirtyTitle}`}
                >
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-amber-500"
                  />
                  {dirtyLabel(worktree.dirtyCount)}
                </Badge>
              ) : null}
              {worktree.branch !== currentBranch ? (
                // Background agent activity on an INACTIVE branch's session
                // (per-branch-sessions spec): "agent working" while its turn
                // streams, "agent finished" once it ended.
                agentStatuses[worktree.branch] === "working" ? (
                  <Badge variant="outline">
                    <Spinner data-icon="inline-start" />
                    {copy.agentWorkingBadge}
                  </Badge>
                ) : agentStatuses[worktree.branch] === "done" ? (
                  <Badge variant="secondary">{copy.agentDoneBadge}</Badge>
                ) : null
              ) : null}
              {worktree.branch === currentBranch ? (
                <>
                  <Badge variant="secondary">{copy.currentBadge}</Badge>
                  <CheckIcon />
                </>
              ) : worktree.running ? (
                <Badge variant="outline">{copy.runningBadge}</Badge>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon />
            {copy.createBranch}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating ? (
        <form onSubmit={submitNewBranch} className="flex gap-2 px-1">
          <Input
            autoFocus
            value={newBranchName}
            placeholder={copy.createBranchPlaceholder}
            onChange={(event) => setNewBranchName(event.target.value)}
            className="h-8 font-mono text-xs"
          />
          <Button type="submit" size="sm" disabled={!newBranchName.trim()}>
            {copy.createBranchSubmit}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export { BranchSelector };
