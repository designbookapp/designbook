/**
 * React binding for the `branch` model.
 *
 * `BranchProvider` builds a `BranchModel` (see branchModel.ts) and puts it on
 * context so the branch selector reads the worktree state + switch/retry actions
 * declaratively:
 *   - live use: `Workbench` calls `useWorktrees()` (the stateful hook stays in
 *     the composition root — confirmed altitude) and feeds its state as `data`
 *     plus a route-bound `switchBranch` and `retry`;
 *   - tests / cells: pass `data` (fixture worktrees); the actions default to
 *     no-ops.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createBranchModel,
  type BranchData,
  type BranchModel,
  type BranchSwitch,
} from "./branchModel";

const BranchModelContext = createContext<BranchModel | null>(null);

type BranchProviderProps = {
  /** Live/fixture branch state; omitted defaults to an empty, unloaded set. */
  data?: BranchData;
  /** Route-bound switch action (live); omitted in fixture/cell mode. */
  switchBranch?: BranchSwitch;
  /** Retry the last failed switch (live); omitted in fixture/cell mode. */
  retry?: () => void;
  children: ReactNode;
};

function BranchProvider({
  data,
  switchBranch,
  retry,
  children,
}: BranchProviderProps) {
  const model = useMemo(
    () => createBranchModel({ data, switchBranch, retry }),
    [data, switchBranch, retry],
  );
  return (
    <BranchModelContext.Provider value={model}>
      {children}
    </BranchModelContext.Provider>
  );
}

/** Read the branch model from context; throws if used outside a provider. */
function useBranchModel(): BranchModel {
  const model = useContext(BranchModelContext);
  if (!model) {
    throw new Error("useBranchModel must be used within a <BranchProvider>.");
  }
  return model;
}

export { BranchProvider, useBranchModel, BranchModelContext };
export type { BranchProviderProps };
