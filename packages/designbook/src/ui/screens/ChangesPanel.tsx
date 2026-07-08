/**
 * The "changes" left-rail tab (Changes tab MVP): a flat, VS-Code-style list
 * of the worktree's changed files vs HEAD, fed by `ChangesProvider`.
 *
 * Rows open the file's diff in the RHS Code tab (`model.openDiff`). The
 * per-row destructive action ("Discard changes" for tracked files, "Delete
 * file" for new ones) is confirm-gated: the first click arms an inline
 * confirm strip; only its explicit second click calls `model.discard`.
 * Conflicted files list diff-only (no destructive action).
 */

import { RefreshCwIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@designbook-ui/components/ui/button";
import {
  ChangePathLabel,
  ChangeStatusBadge,
} from "@designbook-ui/models/branch/atoms";
import {
  discardAction,
  type FileChange,
} from "@designbook-ui/models/branch/changesModel";
import { useChangesModel } from "@designbook-ui/models/branch/ChangesProvider";
import { PanelSection } from "./panels";

const copy = {
  cancelButton: "Cancel",
  discardError: "Unable to discard the changes.",
  emptyHint: "Edits made in this worktree will show up here.",
  loading: "Checking for changes…",
  noGitHint: "Not a git repo — change tracking is off.",
  refreshLabel: "Refresh changes",
  renamedFrom: "was",
  title: "Changes in this worktree",
};

function ChangeRow({
  change,
  confirming,
  busy,
  onOpenDiff,
  onArmDiscard,
  onCancelDiscard,
  onConfirmDiscard,
}: {
  change: FileChange;
  confirming: boolean;
  busy: boolean;
  onOpenDiff: () => void;
  onArmDiscard: () => void;
  onCancelDiscard: () => void;
  onConfirmDiscard: () => void;
}) {
  const action = discardAction(change);

  return (
    <div className="grid gap-1">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open the diff for ${change.path}`}
        onClick={onOpenDiff}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenDiff();
          }
        }}
        className="group flex cursor-pointer items-center gap-2 rounded-md border p-2 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <div className="grid min-w-0 flex-1 gap-0.5">
          <ChangePathLabel change={change} />
          {change.status === "renamed" && change.origPath ? (
            <span className="truncate text-xs text-muted-foreground">
              {copy.renamedFrom} {change.origPath}
            </span>
          ) : null}
        </div>
        <ChangeStatusBadge status={change.status} />
        {action ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={action.label}
            title={action.label}
            className="size-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onArmDiscard();
            }}
          >
            {action.kind === "delete" ? <Trash2Icon /> : <RotateCcwIcon />}
          </Button>
        ) : null}
      </div>
      {confirming && action ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2">
          <p className="min-w-0 text-xs">{action.confirmMessage}</p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={onConfirmDiscard}
            >
              {action.confirmLabel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onCancelDiscard}
            >
              {copy.cancelButton}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChangesPanel() {
  const model = useChangesModel();
  const [confirmPath, setConfirmPath] = useState<string>();
  const [busyPath, setBusyPath] = useState<string>();
  const [error, setError] = useState<string>();

  function confirmDiscard(path: string) {
    setBusyPath(path);
    setError(undefined);
    void model
      .discard(path)
      .then(() => setConfirmPath(undefined))
      .catch((discardErr: unknown) => {
        setError(
          discardErr instanceof Error ? discardErr.message : copy.discardError,
        );
      })
      .finally(() => setBusyPath(undefined));
  }

  const changes = model.sortedChanges;

  return (
    <PanelSection title={copy.title}>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {!model.loaded
              ? copy.loading
              : `${changes.length} ${changes.length === 1 ? "file" : "files"}`}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.refreshLabel}
            title={copy.refreshLabel}
            className="size-7 shrink-0"
            onClick={() => model.refresh()}
          >
            <RefreshCwIcon />
          </Button>
        </div>
        {model.loaded && changes.length === 0 ? (
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">{copy.emptyHint}</p>
            {!model.git ? (
              <p className="text-xs text-muted-foreground">{copy.noGitHint}</p>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-2">
            {changes.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                confirming={confirmPath === change.path}
                busy={busyPath === change.path}
                onOpenDiff={() => model.openDiff(change.path)}
                onArmDiscard={() => {
                  setError(undefined);
                  setConfirmPath(change.path);
                }}
                onCancelDiscard={() => setConfirmPath(undefined)}
                onConfirmDiscard={() => confirmDiscard(change.path)}
              />
            ))}
          </div>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </PanelSection>
  );
}

export { ChangesPanel };
