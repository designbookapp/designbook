/**
 * React binding for the `changes` slice of the branch model (Changes tab
 * MVP), cloned from the `BranchProvider` pattern:
 *   - live use: `Workbench` calls `useChanges()` (the stateful hook stays in
 *     the composition root) and feeds its state as `data` plus the bound
 *     `refresh`/`discard` actions and a workbench-level `openDiff` (which
 *     owns the RHS Code-tab diff override);
 *   - tests / cells: pass fixture `data`; the actions default to no-ops.
 *
 * `useChangesModelIfPresent` exists for the canvas-badge atoms: canvas cards
 * render inside cells/tests that may not mount the provider, and a missing
 * badge is the correct degrade there (never a throw).
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createChangesModel,
  type ChangesData,
  type ChangesModel,
} from "./changesModel";

const ChangesModelContext = createContext<ChangesModel | null>(null);

type ChangesProviderProps = {
  /** Live/fixture changes state; omitted defaults to an empty, unloaded set. */
  data?: ChangesData;
  /** Refetch action (live); omitted in fixture/cell mode. */
  refresh?: () => void;
  /** Discard/delete-one-file action (live); omitted in fixture/cell mode. */
  discard?: (path: string) => Promise<void>;
  /** Open a file's diff in the RHS Code tab (live); omitted in fixtures. */
  openDiff?: (path: string) => void;
  children: ReactNode;
};

function ChangesProvider({
  data,
  refresh,
  discard,
  openDiff,
  children,
}: ChangesProviderProps) {
  const model = useMemo(
    () => createChangesModel({ data, refresh, discard, openDiff }),
    [data, refresh, discard, openDiff],
  );
  return (
    <ChangesModelContext.Provider value={model}>
      {children}
    </ChangesModelContext.Provider>
  );
}

/** Read the changes model from context; throws if used outside a provider. */
function useChangesModel(): ChangesModel {
  const model = useContext(ChangesModelContext);
  if (!model) {
    throw new Error("useChangesModel must be used within a <ChangesProvider>.");
  }
  return model;
}

/** Soft variant for atoms rendered where the provider may be absent. */
function useChangesModelIfPresent(): ChangesModel | null {
  return useContext(ChangesModelContext);
}

export {
  ChangesModelContext,
  ChangesProvider,
  useChangesModel,
  useChangesModelIfPresent,
};
export type { ChangesProviderProps };
