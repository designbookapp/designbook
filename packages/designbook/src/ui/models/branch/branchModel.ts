/**
 * The `branch` model — the workbench's worktree/branch state.
 *
 * A design server can expose the repo's worktrees (one running app instance per
 * branch); the branch selector lists them, shows the current one, and switches
 * by preparing + navigating to the target instance. That live state and its
 * switch/retry behavior are owned by the `useWorktrees` stateful hook, which —
 * per the confirmed altitude (Michael 2026-07-07) — STAYS in the composition
 * root (`Workbench`): this pass injects its state + actions onto the provider
 * context, it does NOT absorb the hook.
 *
 * `createBranchModel` is a pure factory (no React, no globals): live use feeds
 * it the hook's `data` + bound `switchBranch`/`retry` actions; fixture/cell/test
 * use feeds canonical `data` and the actions default to no-ops. The no-git
 * degrade the selector relies on (a target app without a git repo has no
 * worktrees at all) is exposed as the derived `showSelector` flag, mirroring
 * `Workbench`'s gate exactly so the selector is hidden rather than stuck
 * "preparing".
 */

import type { WorktreeSummary } from "./useWorktrees";

/** The branch/worktree state slice (live from `useWorktrees`, or a fixture). */
type BranchData = {
  /** The branch of the instance the workbench is currently attached to. */
  currentBranch?: string;
  worktrees: WorktreeSummary[];
  /** True once the worktree list has been fetched (even if empty / no-git). */
  loaded: boolean;
  /** A branch switch is in flight (a full-page navigation is imminent). */
  switching: boolean;
  /** Last switch/load error, shown inline with a retry affordance. */
  error?: string;
};

/** Prepare + navigate to a branch's instance. Injected already bound to the
 * current canvas route (nodeIds/flowId) so the selector only passes a branch. */
type BranchSwitch = (branch: string) => void;

/** The branch model surface exposed on context and returned by the factory. */
type BranchModel = BranchData & {
  /** Switch to a branch (bound to the current route). No-op in fixture mode. */
  switchBranch: BranchSwitch;
  /** Retry the last failed switch. No-op in fixture mode. */
  retry: () => void;
  /**
   * Whether the branch selector should render at all: hidden only once the list
   * has loaded AND there is no current branch AND no worktrees — i.e. the target
   * app has no git repo. Mirrors `Workbench`'s gate so the no-git degrade is
   * behavior-identical.
   */
  showSelector: boolean;
};

type CreateBranchModelOptions = {
  /** The branch state slice; omitted defaults to an empty, not-yet-loaded set. */
  data?: BranchData;
  /** Live bound switch action; omitted in fixture/cell mode (no-op). */
  switchBranch?: BranchSwitch;
  /** Live retry action; omitted in fixture/cell mode (no-op). */
  retry?: () => void;
};

const EMPTY_DATA: BranchData = {
  currentBranch: undefined,
  worktrees: [],
  loaded: false,
  switching: false,
  error: undefined,
};

const noop = () => {};

/**
 * Build a branch model. Pure — no React, no globals. See the module doc for the
 * live (hook-fed) vs. fixture split.
 */
function createBranchModel(options: CreateBranchModelOptions = {}): BranchModel {
  const data = options.data ?? EMPTY_DATA;
  return {
    ...data,
    switchBranch: options.switchBranch ?? noop,
    retry: options.retry ?? noop,
    showSelector:
      !data.loaded || Boolean(data.currentBranch) || data.worktrees.length > 0,
  };
}

export { createBranchModel };
export type {
  BranchData,
  BranchModel,
  BranchSwitch,
  CreateBranchModelOptions,
  WorktreeSummary,
};
