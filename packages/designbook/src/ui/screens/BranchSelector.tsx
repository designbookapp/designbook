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
  branchesLabel: "Worktrees",
  createBranch: "Create new branch…",
  createBranchPlaceholder: "design/my-exploration",
  createBranchSubmit: "Create",
  currentBadge: "current",
  loadingBranch: "Preparing worktree…",
  runningBadge: "running",
};

function BranchSelector() {
  const { currentBranch, worktrees, switching, switchBranch } =
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
