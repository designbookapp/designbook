/**
 * Canonical `branch` model fixtures.
 *
 * ONE hardcoded dataset — a current branch plus two other worktrees (one
 * running, one idle) — used by the model's unit tests AND (later) by cells that
 * render the branch selector without a live design server. `createBranchFixture`
 * returns a fresh dataset each call whose `switchBranch`/`retry` append to a
 * shared `switches` log so a consumer can assert routing.
 *
 * `createEmptyBranchFixture` is the no-git degrade case — loaded, but no current
 * branch and no worktrees, so `showSelector` is false.
 */

import type { BranchData, WorktreeSummary } from "./branchModel";
import type { ChangesData, FileChange } from "./changesModel";

type BranchFixture = {
  /** Feed straight into `<BranchProvider data={...}>` or `createBranchModel`. */
  data: BranchData;
  /** Every switch attempt, in order. */
  switches: string[];
  /** Count of retry() calls. */
  retries: number;
  switchBranch: (branch: string) => void;
  retry: () => void;
};

const WORKTREES: WorktreeSummary[] = [
  { branch: "main", path: "/repo", port: 8840, running: true, dirtyCount: 0 },
  {
    branch: "design/hero",
    path: "/repo/.designbook/worktrees/hero",
    port: 8841,
    running: true,
    dirtyCount: 3,
  },
  {
    branch: "design/pricing",
    path: "/repo/.designbook/worktrees/pricing",
    port: 0,
    running: false,
    dirtyCount: 0,
  },
];

function createBranchFixture(): BranchFixture {
  const switches: string[] = [];
  const fixture: BranchFixture = {
    data: {
      currentBranch: "main",
      worktrees: WORKTREES.map((worktree) => ({ ...worktree })),
      loaded: true,
      switching: false,
      error: undefined,
    },
    switches,
    retries: 0,
    switchBranch: (branch) => switches.push(branch),
    retry: () => {
      fixture.retries += 1;
    },
  };
  return fixture;
}

/** The no-git degrade fixture: loaded, but nothing to switch to. */
function createEmptyBranchFixture(): BranchFixture {
  const fixture = createBranchFixture();
  fixture.data = {
    currentBranch: undefined,
    worktrees: [],
    loaded: true,
    switching: false,
    error: undefined,
  };
  return fixture;
}

// --- changes fixtures (Changes tab MVP) ------------------------------------

type ChangesFixture = {
  /** Feed straight into `<ChangesProvider data={...}>` or the model factory. */
  data: ChangesData;
  /** Every discard attempt, in order. */
  discards: string[];
  /** Every diff-open request, in order. */
  diffOpens: string[];
  refreshes: number;
  refresh: () => void;
  discard: (path: string) => Promise<void>;
  openDiff: (path: string) => void;
};

/** One of each status the UI renders (deliberately unsorted). */
const CHANGES: FileChange[] = [
  {
    path: "src/composite/product/variants/Card.tsx",
    status: "modified",
    origPath: null,
  },
  { path: "src/badges/NewBadge.tsx", status: "untracked", origPath: null },
  { path: "src/legacy/OldPanel.tsx", status: "deleted", origPath: null },
  {
    path: "src/hero/HeroSlim.tsx",
    status: "renamed",
    origPath: "src/hero/HeroSmall.tsx",
  },
];

function createChangesFixture(): ChangesFixture {
  const fixture: ChangesFixture = {
    data: {
      git: true,
      changes: CHANGES.map((change) => ({ ...change })),
      loaded: true,
    },
    discards: [],
    diffOpens: [],
    refreshes: 0,
    refresh: () => {
      fixture.refreshes += 1;
    },
    discard: async (path) => {
      fixture.discards.push(path);
    },
    openDiff: (path) => {
      fixture.diffOpens.push(path);
    },
  };
  return fixture;
}

/** The no-git degrade fixture: loaded, tracking off, nothing listed. */
function createNoGitChangesFixture(): ChangesFixture {
  const fixture = createChangesFixture();
  fixture.data = { git: false, changes: [], loaded: true };
  return fixture;
}

export {
  createBranchFixture,
  createChangesFixture,
  createEmptyBranchFixture,
  createNoGitChangesFixture,
};
export type { BranchFixture, ChangesFixture };
