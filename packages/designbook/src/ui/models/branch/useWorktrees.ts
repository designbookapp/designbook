import { useEffect, useState } from "react";
import { buildHash } from "@designbook-ui/models/catalog/useCanvasRoute";
import { apiUrl, routing } from "@designbook-ui/designbook";

type WorktreeSummary = {
  branch: string;
  path: string;
  port: number;
  running: boolean;
  /** Uncommitted-change count in this worktree (capped server-side at 99).
   * Additive/optional so a legacy or no-git payload still renders. */
  dirtyCount?: number;
};

/**
 * Where the browser goes after the server prepared the branch. The server
 * decides the destination (`url`): host mode returns the branch instance's
 * origin; proxy mode ("designbook dev") returns a same-origin path so the
 * browser NEVER leaves the stable proxy URL. The UI only appends its route
 * hash (hash-routing hosts only — injected/memory routing restores the route
 * from sessionStorage), never assembles host:port URLs itself.
 */
function switchNavigationTarget(
  url: string,
  hash: string,
  routingMode: "hash" | "memory",
): string {
  return routingMode === "hash" ? `${url}#${hash}` : url;
}

/**
 * Whether the workbench should ask the server to switch to the ROUTE's branch
 * because it differs from the server's active one. Hash (host) mode only:
 * there `#/b/<branch>/…` is an explicit, user-visible deep link. In memory
 * (injected/proxy) routing the route's branch comes from the reload-persist
 * blob, which is exactly one switch STALE right after a proxy branch switch —
 * the blob is flushed on pagehide, before the reload lands on the new branch.
 * Auto-switching on it would silently revert the switch the user just made
 * (the "switched back to main" bug): the server retargets to the new branch,
 * the page reloads, and the restored route immediately switches it back. In
 * memory mode the server is the source of truth and the route reconciles TO
 * it instead (reconcileRouteBranch in useCanvasRoute).
 */
function shouldAutoSwitchBranch(
  routingMode: "hash" | "memory",
  urlBranch: string | undefined,
  currentBranch: string | undefined,
): boolean {
  return (
    routingMode === "hash" &&
    Boolean(urlBranch) &&
    Boolean(currentBranch) &&
    urlBranch !== currentBranch
  );
}

type WorktreesState = {
  currentBranch: string | undefined;
  worktrees: WorktreeSummary[];
};

/** Per-branch agent activity for the switcher badges: "working" while a turn
 * streams on that branch's session, "done" once it finished (cleared by the
 * server when that branch's thread is next viewed). */
type BranchAgentStatus = "working" | "done";

type BranchStatusPayload = {
  statuses?: Array<{ branch?: unknown; status?: unknown }>;
};

/** Fold a `branch-status` SSE payload into the badge map (defensive). */
function toAgentStatuses(
  payload: BranchStatusPayload,
): Record<string, BranchAgentStatus> {
  const statuses: Record<string, BranchAgentStatus> = {};
  for (const entry of payload.statuses ?? []) {
    if (
      typeof entry.branch === "string" &&
      (entry.status === "working" || entry.status === "done")
    ) {
      statuses[entry.branch] = entry.status;
    }
  }
  return statuses;
}

/**
 * Loads the real worktree list from the design server and handles branch
 * switching: asks the server to prepare the branch (host mode: spawn its
 * designbook instance; proxy mode: retarget the proxied dev server), then
 * performs a full-page navigation to the URL the server returned.
 */
function useWorktrees() {
  const [state, setState] = useState<WorktreesState>({
    currentBranch: undefined,
    worktrees: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string>();
  const [agentStatuses, setAgentStatuses] = useState<
    Record<string, BranchAgentStatus>
  >({});
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

  // Per-branch agent badges (per-branch-sessions spec): `branch-status`
  // events on the shared SSE stream — a full snapshot each time, sent on
  // connect (hydration after the reload a switch performs) and on every
  // agent start/end anywhere. Events from INACTIVE branches surface ONLY
  // here; the chat drops them from its thread.
  useEffect(() => {
    const eventSource = new EventSource(apiUrl("/api/events"));
    eventSource.addEventListener("branch-status", (messageEvent) => {
      try {
        setAgentStatuses(
          toAgentStatuses(
            JSON.parse(
              (messageEvent as MessageEvent).data as string,
            ) as BranchStatusPayload,
          ),
        );
      } catch {
        // Malformed payload — keep the previous badges.
      }
    });
    return () => {
      eventSource.close();
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

      const { url } = (await response.json()) as { url?: string };
      if (typeof url !== "string" || !url) {
        throw new Error("The server did not return a navigation URL.");
      }
      window.location.href = switchNavigationTarget(
        url,
        buildHash(branch, nodeIds, flowId),
        routing,
      );
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
    /** Per-branch agent activity (branch name → working/done). */
    agentStatuses,
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

export {
  shouldAutoSwitchBranch,
  switchNavigationTarget,
  toAgentStatuses,
  useWorktrees,
};
export type { BranchAgentStatus, WorktreeSummary };
