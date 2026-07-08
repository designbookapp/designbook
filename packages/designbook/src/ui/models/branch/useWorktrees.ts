import { useEffect, useState } from "react";
import { buildHash } from "@designbook-ui/models/catalog/useCanvasRoute";
import { apiUrl } from "@designbook-ui/designbook";

type WorktreeSummary = {
  branch: string;
  path: string;
  port: number;
  running: boolean;
};

type WorktreesState = {
  currentBranch: string | undefined;
  worktrees: WorktreeSummary[];
};

/**
 * Loads the real worktree list from the design server and handles branch
 * switching: ensures the target branch has a running instance, then performs
 * a full-page navigation to that instance's origin, carrying the canvas path
 * in the hash.
 */
function useWorktrees() {
  const [state, setState] = useState<WorktreesState>({
    currentBranch: undefined,
    worktrees: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string>();
  const [lastAttempt, setLastAttempt] = useState<{
    branch: string;
    nodeIds: string[];
    flowId?: string;
  }>();

  useEffect(() => {
    let cancelled = false;

    void fetch(apiUrl("/api/worktrees"))
      .then((response) => response.json() as Promise<Partial<WorktreesState>>)
      .then((payload) => {
        if (cancelled) return;
        // Defensive: an error-shaped or legacy payload must not crash the
        // selector (a target app without a git repo has no worktrees at all).
        setState({
          currentBranch:
            typeof payload.currentBranch === "string"
              ? payload.currentBranch
              : undefined,
          worktrees: Array.isArray(payload.worktrees) ? payload.worktrees : [],
        });
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load worktrees.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function switchBranch(
    branch: string,
    nodeIds: string[],
    flowId?: string,
  ) {
    if (!branch || branch === state.currentBranch || switching) return;

    setSwitching(true);
    setError(undefined);
    setLastAttempt({ branch, nodeIds, flowId });

    try {
      const response = await fetch(apiUrl("/api/worktrees"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Unable to prepare the worktree.");
      }

      const { port } = (await response.json()) as { port: number };
      window.location.href = `http://${window.location.hostname}:${port}/#${buildHash(branch, nodeIds, flowId)}`;
    } catch (switchError) {
      setError(
        switchError instanceof Error
          ? switchError.message
          : String(switchError),
      );
      setSwitching(false);
    }
  }

  function retry() {
    if (!lastAttempt) return;
    void switchBranch(
      lastAttempt.branch,
      lastAttempt.nodeIds,
      lastAttempt.flowId,
    );
  }

  return {
    currentBranch: state.currentBranch,
    error,
    /** True once the worktree list has been fetched (even if empty/no-git). */
    loaded,
    retry,
    switchBranch,
    switching,
    worktrees: state.worktrees,
  };
}

export { useWorktrees };
export type { WorktreeSummary };
