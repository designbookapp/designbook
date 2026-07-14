/**
 * Per-branch agent-session registry (docs/specs/per-branch-sessions.md).
 *
 * The sidecar keeps ONE in-process Pi session per branch: cwd = that branch's
 * worktree root (primary → projectRoot), created lazily on first use, kept
 * alive across branch switches (that's the point — a turn started on branch A
 * keeps streaming while you explore branch B), disposed when the branch's
 * worktree disappears (reconcile) or on shutdown.
 *
 * The registry is generic over the session object with an injected `create`
 * factory, so lifecycle tests run against fakes — no Pi SDK, no auth. All the
 * designbook-specific session assembly (SettingsManager, resourceLoader,
 * event tagging/broadcast) stays in api.ts's factory.
 */

import { resolve } from "node:path";

/** Internal key for the primary checkout's session. NEVER on the wire — the
 * wire encoding for primary is an ABSENT `branch` field. */
const PRIMARY_SESSION_KEY = "@primary";

/**
 * The session key API handlers operate on, from the proxy's active-branch
 * state. Primary when: no proxy (host mode), before the first switch, after a
 * raw-cwd retarget (branch unknown), and when the "active branch" is the
 * primary checkout itself — switching back to it must land on the SAME
 * session that ran there before any switch.
 */
function resolveActiveSessionKey(params: {
  activeBranch: string | undefined;
  activeWorktreeRoot: string | undefined;
  projectRoot: string;
}): string {
  const { activeBranch, activeWorktreeRoot, projectRoot } = params;
  if (!activeBranch) return PRIMARY_SESSION_KEY;
  if (
    !activeWorktreeRoot ||
    resolve(activeWorktreeRoot) === resolve(projectRoot)
  ) {
    return PRIMARY_SESSION_KEY;
  }
  return activeBranch;
}

/**
 * The wire `branch` tag of a sandbox event, from the event's OWN home
 * (docs/specs/changesets-on-git.md branch topology): the primary checkout's
 * home is untagged (absent = primary, wire compat); a branch worktree's home
 * is tagged with its checked-out branch — which IS the session key, since
 * branch worktrees are per-branch. `homeBranch` comes from the orchestrator's
 * per-home git probe; when it hasn't resolved yet, `activeWireBranch`
 * (the pre-fix emit-time behavior) is the fallback.
 */
function resolveSandboxWireBranch(params: {
  homeRepoRoot: string;
  homeBranch: string | undefined;
  projectRoot: string;
  activeWireBranch: string | undefined;
}): string | undefined {
  const { homeRepoRoot, homeBranch, projectRoot, activeWireBranch } = params;
  if (resolve(homeRepoRoot) === resolve(projectRoot)) return undefined;
  return homeBranch || activeWireBranch;
}

/** What the registry needs from a session to manage its lifecycle. */
type SessionLike = {
  abort: () => Promise<void>;
  dispose: () => void;
};

/** Per-branch agent activity, driving the branch-switcher badges:
 * "working" while a turn streams, "done" once it ends (cleared when the
 * branch's thread is next viewed). */
type AgentStatus = "idle" | "working" | "done";

type SessionEntry<S extends SessionLike> = {
  key: string;
  cwd: string;
  promise: Promise<S>;
  /** Unsubscribe from the session's event stream (set by the factory). */
  unsubscribe?: () => void;
  status: AgentStatus;
  /** Display branch name (for primary: the checkout's git branch). */
  branchName?: string;
};

type CreatedSession<S extends SessionLike> = {
  session: S;
  /** Event-stream unsubscribe, owned by the registry from here on. */
  unsubscribe?: () => void;
  /** Display branch name (git branch of the session's cwd). */
  branchName?: string;
};

type CreateSessionRegistryOptions<S extends SessionLike> = {
  /** Build a session for a key. `isPrimary` keys get `cwd = primaryCwd`. */
  create: (context: {
    key: string;
    cwd: string;
    isPrimary: boolean;
  }) => Promise<CreatedSession<S>>;
  /** Worktree root for a non-primary key (undefined → fall back to primary
   * cwd; happens only if the sidecar seam reports no active root). */
  resolveCwd: (key: string) => string | undefined;
  primaryCwd: string;
  log?: (message: string) => void;
};

function createSessionRegistry<S extends SessionLike>(
  options: CreateSessionRegistryOptions<S>,
) {
  const { create, resolveCwd, primaryCwd, log = () => {} } = options;
  const entries = new Map<string, SessionEntry<S>>();

  function cwdFor(key: string): string {
    if (key === PRIMARY_SESSION_KEY) return primaryCwd;
    return resolveCwd(key) ?? primaryCwd;
  }

  /** The entry if it exists (no create). */
  function peek(key: string): SessionEntry<S> | undefined {
    return entries.get(key);
  }

  /** Lazily create (or return) the key's session. A failed create clears the
   * entry so the next call retries (the /login-then-Retry path). */
  function get(key: string): Promise<S> {
    let entry = entries.get(key);
    if (!entry) {
      const cwd = cwdFor(key);
      const created: SessionEntry<S> = {
        key,
        cwd,
        status: "idle",
        promise: undefined as unknown as Promise<S>,
      };
      created.promise = create({
        key,
        cwd,
        isPrimary: key === PRIMARY_SESSION_KEY,
      }).then(
        (result) => {
          created.unsubscribe = result.unsubscribe;
          created.branchName = result.branchName;
          return result.session;
        },
        (error: unknown) => {
          if (entries.get(key) === created) entries.delete(key);
          throw error;
        },
      );
      entries.set(key, created);
      entry = created;
    }
    return entry.promise;
  }

  /** Abort any in-flight turn, unsubscribe, dispose, forget. Safe on a
   * missing key and on a session whose create failed. */
  async function dispose(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    try {
      const session = await entry.promise;
      await session.abort().catch(() => {});
      entry.unsubscribe?.();
      session.dispose();
    } catch {
      // The session never started; nothing to dispose.
    }
  }

  /**
   * Dispose sessions whose branch no longer has a worktree (the "worktree
   * removal path" — there is no explicit removal endpoint, so GET
   * /api/worktrees reconciles). Primary is never reconciled away. Returns the
   * disposed branch keys so the caller can also stop their dev servers.
   */
  function reconcile(liveBranches: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const key of entries.keys()) {
      if (key === PRIMARY_SESSION_KEY) continue;
      if (!liveBranches.has(key)) removed.push(key);
    }
    for (const key of removed) {
      log(`disposing session for removed worktree: ${key}`);
      void dispose(key);
    }
    return removed;
  }

  async function disposeAll(): Promise<void> {
    await Promise.all([...entries.keys()].map((key) => dispose(key)));
  }

  function setStatus(key: string, status: AgentStatus): void {
    const entry = entries.get(key);
    if (entry) entry.status = status;
  }

  /** Live per-branch agent statuses (display branch names, non-idle only). */
  function statuses(): Array<{ branch: string; status: AgentStatus }> {
    const result: Array<{ branch: string; status: AgentStatus }> = [];
    for (const entry of entries.values()) {
      if (entry.status === "idle") continue;
      const branch =
        entry.key === PRIMARY_SESSION_KEY ? entry.branchName : entry.key;
      if (!branch) continue;
      result.push({ branch, status: entry.status });
    }
    return result;
  }

  function keys(): string[] {
    return [...entries.keys()];
  }

  return {
    dispose,
    disposeAll,
    get,
    keys,
    peek,
    reconcile,
    setStatus,
    statuses,
  };
}

export {
  createSessionRegistry,
  PRIMARY_SESSION_KEY,
  resolveActiveSessionKey,
  resolveSandboxWireBranch,
};
export type { AgentStatus, CreatedSession, SessionEntry, SessionLike };
