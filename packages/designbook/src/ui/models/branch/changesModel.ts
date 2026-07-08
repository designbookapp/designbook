/**
 * The `changes` slice of the `branch` model (Changes tab MVP): pure parsing/
 * labeling/derivation over the `/api/changes` payload. No React, no fetches —
 * the stateful lifecycle lives in `useChanges` (hook, composition-root
 * altitude, like `useWorktrees`) and the context binding in
 * `ChangesProvider`.
 *
 * Designer-facing vocabulary: statuses collapse to "Edited / New / Deleted /
 * Renamed / Conflict" — never git's letter salad. Untracked and staged-new
 * files are both just "New", and their destructive row action is "Delete
 * file" (discarding a file that didn't exist before IS deleting it).
 */

/** Collapsed per-file status, as reported by `GET /api/changes`. */
type ChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

type FileChange = {
  /** projectRoot-relative path (same space as RegistryEntry.sourcePath). */
  path: string;
  status: ChangeStatus;
  /** Pre-rename path for `renamed` entries; null otherwise. */
  origPath: string | null;
};

/** The changes state slice (live from `useChanges`, or a fixture). */
type ChangesData = {
  /** False when the project has no git repo (change tracking is off). */
  git: boolean;
  changes: FileChange[];
  /** True once the first fetch resolved (even if empty / no-git). */
  loaded: boolean;
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** Designer-facing status label (badge copy). */
function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "New";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "conflicted":
      return "Conflict";
    default:
      return "Edited";
  }
}

/** Which existing Badge variant colors a status. */
function statusBadgeVariant(status: ChangeStatus): BadgeVariant {
  switch (status) {
    case "added":
    case "untracked":
      return "default";
    case "deleted":
    case "conflicted":
      return "destructive";
    case "renamed":
      return "outline";
    default:
      return "secondary";
  }
}

/** basename + dirname split for the row label (dirname muted, truncating). */
function splitPath(path: string): { base: string; dir: string } {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { base: path, dir: "" };
  return { base: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/** Stable path sort (the server sorts too; fixtures/tests may not). */
function sortChanges(changes: FileChange[]): FileChange[] {
  return [...changes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** The changed projectRoot-relative paths, for registry ∩ canvas badges. */
function changedPathSet(changes: FileChange[]): Set<string> {
  return new Set(changes.map((change) => change.path));
}

/**
 * Registry entries whose sourcePath is in the changed set → entry ids that
 * get an "Edited" badge on their canvas cards (P1 stretch, pulled into MVP).
 */
function changedEntryIds(
  entries: Array<{ id: string; sourcePath: string }>,
  changedPaths: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.sourcePath && changedPaths.has(entry.sourcePath)) {
      ids.add(entry.id);
    }
  }
  return ids;
}

type DiscardAction = {
  /** Server semantics: restore from HEAD vs delete a new file. */
  kind: "discard" | "delete";
  /** Row action label. */
  label: string;
  /** Copy for the explicit confirm step (destructive — always gated). */
  confirmMessage: string;
  /** The confirm button's label. */
  confirmLabel: string;
};

/**
 * The destructive row action for a change, or undefined when none is offered
 * (conflicts are listed diff-only; resolve them in an editor). This is the
 * confirm seam: the UI must show `confirmMessage` and only call the model's
 * `discard` after an explicit second click.
 */
function discardAction(change: FileChange): DiscardAction | undefined {
  const { base } = splitPath(change.path);
  switch (change.status) {
    case "conflicted":
      return undefined;
    case "untracked":
    case "added":
      return {
        kind: "delete",
        label: "Delete file",
        confirmMessage: `Delete ${base}? This can't be undone.`,
        confirmLabel: "Delete",
      };
    default:
      return {
        kind: "discard",
        label: "Discard changes",
        confirmMessage: `Discard changes to ${base}? This can't be undone.`,
        confirmLabel: "Discard",
      };
  }
}

/** The changes model surface exposed on context. */
type ChangesModel = ChangesData & {
  /** Sorted for display (defensive re-sort of the data slice). */
  sortedChanges: FileChange[];
  changedPaths: Set<string>;
  /** Refetch now. No-op in fixture mode. */
  refresh: () => void;
  /**
   * Discard/delete one file's changes. Destructive — callers must have shown
   * the `discardAction` confirm step first. No-op in fixture mode.
   */
  discard: (path: string) => Promise<void>;
  /** Open the file's diff in the RHS Code tab. No-op in fixture mode. */
  openDiff: (path: string) => void;
};

type CreateChangesModelOptions = {
  data?: ChangesData;
  refresh?: () => void;
  discard?: (path: string) => Promise<void>;
  openDiff?: (path: string) => void;
};

const EMPTY_DATA: ChangesData = { git: true, changes: [], loaded: false };

const noop = () => {};
const asyncNoop = async () => {};

/** Build a changes model. Pure — live use injects the hook-bound actions. */
function createChangesModel(
  options: CreateChangesModelOptions = {},
): ChangesModel {
  const data = options.data ?? EMPTY_DATA;
  return {
    ...data,
    sortedChanges: sortChanges(data.changes),
    changedPaths: changedPathSet(data.changes),
    refresh: options.refresh ?? noop,
    discard: options.discard ?? asyncNoop,
    openDiff: options.openDiff ?? noop,
  };
}

export {
  changedEntryIds,
  changedPathSet,
  createChangesModel,
  discardAction,
  sortChanges,
  splitPath,
  statusBadgeVariant,
  statusLabel,
};
export type {
  BadgeVariant,
  ChangeStatus,
  ChangesData,
  ChangesModel,
  CreateChangesModelOptions,
  DiscardAction,
  FileChange,
};
