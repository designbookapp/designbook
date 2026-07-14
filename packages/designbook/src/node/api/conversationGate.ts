/**
 * L3 CONVERSATION GATE (G2 restore + conversation-routed asks —
 * docs/specs/changesets-on-git.md §Conversation-routed asks):
 *
 * A main-chat session's cwd is resolved PER TURN as a WORKSPACE identity:
 *
 *   - "root" — no active conversation (drawer closed) or read-only: repo
 *     root, REAL writes, no capture (unchanged);
 *   - a changeset workspace — while a conversation is ACTIVE: the
 *     conversation's direct-edits changeset worktree for a plain prompt, or
 *     the SELECTED pin's changeset worktree for a selection-scoped prompt
 *     (the per-turn binding at the heart of conversation-routed asks).
 *
 * A Pi session's cwd is FIXED at creation, so a workspace change REBUILDS
 * the session in the new cwd, resuming the same transcript. Consecutive
 * turns hitting the SAME workspace never rebuild (identity compare), and
 * flips that arrive mid-turn defer to the turn's end — a streaming session
 * is never torn down.
 *
 * Pure of the SDK: api.ts injects the session-facing seams; tests drive the
 * gate with fakes.
 */

/** The root (real-writes) workspace identity. */
const ROOT_WORKSPACE = "root";

/** Legacy binary mode (the factory still reports worktree-vs-root). */
type GateMode = "worktree" | "root";

/** The cwd mode a session SHOULD run in (kept for the factory's gate-open
 * check; the gate itself compares full workspace identities). */
function desiredGateMode(params: {
  active: boolean;
  readOnly: boolean;
}): GateMode {
  return params.active && !params.readOnly ? "worktree" : "root";
}

type ConversationGateDeps = {
  readOnly: boolean;
  /** The workspace the key's NEXT turn should run in: ROOT_WORKSPACE or a
   * changeset workspace id (`cs:<changesetId>`). Must be sync — async
   * resolution (pin → changeset) happens BEFORE reconcile is called. */
  desiredWorkspace: (key: string) => string;
  /** The workspace the key's LIVE session was built in (undefined = no
   * session yet — the factory consults the gate at creation, nothing to
   * rebuild). */
  workspaceOf: (key: string) => string | undefined;
  /** Is the key's session mid-turn (streaming / an open turn window)? */
  isBusy: (key: string) => boolean;
  /** Tear down + recreate the key's session with the new cwd, resuming
   * its transcript. Only ever called while idle. */
  rebuild: (key: string) => Promise<void>;
  log?: (message: string) => void;
};

function createConversationGate(deps: ConversationGateDeps) {
  const log = deps.log ?? (() => {});
  /** Keys whose flip arrived mid-turn — applied at the turn's end. */
  const pending = new Set<string>();

  function desired(key: string): string {
    return deps.readOnly ? ROOT_WORKSPACE : deps.desiredWorkspace(key);
  }

  /** Align the key's session with the gate (rebuild when the workspace
   * identity differs; defer while busy). Safe to call redundantly —
   * same-workspace turns never rebuild. */
  async function reconcile(key: string): Promise<void> {
    const current = deps.workspaceOf(key);
    if (current === undefined || current === desired(key)) {
      pending.delete(key);
      return;
    }
    if (deps.isBusy(key)) {
      pending.add(key);
      return;
    }
    pending.delete(key);
    try {
      await deps.rebuild(key);
      log(`conversation gate: session ${key} rebuilt (${desired(key)})`);
    } catch (error) {
      log(`conversation gate rebuild failed (${key}): ${String(error)}`);
    }
  }

  /** Turn boundary: apply a deferred flip. */
  function onTurnEnd(key: string): void {
    if (pending.has(key)) void reconcile(key);
  }

  /**
   * May this turn open the per-write COMMIT capture? Only when the desired
   * workspace is a changeset worktree AND the live session actually runs in
   * exactly that workspace — a root-mode session's writes are REAL by
   * definition, and a session still in ANOTHER changeset's worktree
   * (deferred flip) must not capture against the wrong branch.
   */
  function captureAllowed(key: string): boolean {
    const want = desired(key);
    return want !== ROOT_WORKSPACE && deps.workspaceOf(key) === want;
  }

  /** Test/introspection surface. */
  function isPending(key: string): boolean {
    return pending.has(key);
  }

  return { captureAllowed, isPending, onTurnEnd, reconcile };
}

export { createConversationGate, desiredGateMode, ROOT_WORKSPACE };
export type { ConversationGateDeps, GateMode };
