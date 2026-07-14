# Per-branch agent sessions + dev servers (proxy is purely proxy)

**Status:** SHIPPED (this branch)
**Decision (Michael, locked):** the sidecar proxy is purely a proxy; the agent
session and the dev server live *on each branch*. Driving workflow: kick off an
agent turn on branch A, switch to explore branch B, come back later and see
that A's turn finished — sessions keep running in the background across
switches.

Builds on the C3.2 proxy topology (`c3-designbook-plugin.md`) and the branch
retarget seam (`/api/target/retarget`, `worktreeProxy`, `prepareWorktree`).

## Problem

After the C3.2 branch fix, switching branches retargets the proxied dev server
so you SEE the worktree's app — but the Pi `AgentSession` was a memoized
singleton with `cwd` pinned to the primary checkout. The agent EDITED the
primary checkout no matter which branch you were viewing. Also: one dev server
at a time meant every switch killed and respawned, and events had no branch
identity.

## Design

### 1. Session registry (`src/node/api/sessionRegistry.ts`)

Sessions are in-process objects in the sidecar/API process — NOT new
processes. The memoized `sessionPromise` singleton in `createApi` is replaced
by a registry keyed by branch:

- **Key:** the branch name; the primary checkout uses the internal sentinel
  `PRIMARY_SESSION_KEY` (`"@primary"`). The sentinel never appears on the
  wire — "absent branch field" is the wire encoding for primary.
- **Per entry:** its own `AgentSession` with `cwd` = that branch's worktree
  root (primary → `projectRoot`), its own `SessionManager.create(cwd)` (the
  SDK is cwd-scoped, so transcripts persist per branch, under each worktree),
  its own `SettingsManager` + resourceLoader (packaged skills), the same
  `readOnly`/`trustProject` flags, and `authStorage.reload()` on create
  (per-session, preserving the /login-then-Retry recovery path).
- **Lazy create:** a branch's session is created on first use (first
  `/api/events`, `/api/state`, `/api/prompt`, … while that branch is active).
- **Kept alive across switches:** switching the viewed branch never disposes
  or aborts another branch's session — that is the whole point.
- **Dispose:** `dispose(key)` aborts any in-flight turn, unsubscribes, and
  `session.dispose()`s. Wired into:
  - **worktree removal:** there is no explicit "remove worktree" endpoint
    today, so removal is detected by *reconciliation*: every
    `GET /api/worktrees` compares the registry's keys against
    `git worktree list`; sessions whose branch no longer has a worktree are
    disposed (and the sidecar is told to stop that branch's dev server via
    `worktreeProxy.stopBranch`). The primary session is never reconciled away.
  - **shutdown:** `api.shutdown()` disposes every entry.
- The registry is a standalone module with an injected session factory, so
  lifecycle tests run against fakes (no Pi SDK / auth needed).

### 2. Active-branch source of truth

The sidecar's `worktreeProxy` already knows the active branch. It gains one
member:

```ts
type WorktreeProxy = {
  activeBranch(): string | undefined;        // undefined = primary
  activeWorktreeRoot(): string | undefined;  // NEW: abs worktree root, undefined = primary
  switchTo(branch, notify): Promise<void>;
  stopBranch(branch): void;                  // NEW: stop that branch's warm dev server
};
```

`createApi` resolves the ACTIVE session as
`worktreeProxy?.activeBranch() ?? PRIMARY_SESSION_KEY`; `/api/state`,
`/api/prompt`, `/api/abort`, `/api/model`, `/api/new-session`, and the
`/api/events` initial `state` all operate on it.

- **Host mode (no proxy):** `worktreeProxy` is unset, so resolution always
  yields primary — unchanged single-session behavior. Per-branch instances in
  host mode are already separate processes; no unification attempted.
- **Raw-cwd retarget** (`POST /api/target/retarget` with `cwd`): bypasses
  branch tracking (`activeBranch = undefined`), so the agent resolves to the
  primary session. Documented degrade; the branch-name path (`{branch}`) is
  the supported one.

### 3. Branch-scoped events (wire shape)

All on the existing single SSE stream (`/api/events`); shape is backward
compatible — **absent `branch` field = primary**.

- `pi-event`: payloads from a non-primary branch's session gain
  `branch: "<name>"`. Primary payloads are byte-identical to before.
- `state`: gains `branch` (scoping key; absent = primary) and `branchName`
  (display: the session's git branch — for primary, the checkout's current
  branch resolved at session create). `cwd` is now the session's own cwd.
- `branch-status` (NEW event): `{ statuses: [{ branch, status }] }` where
  `status ∈ "working" | "done"` and `branch` is the *display* branch name.
  Emitted on every `agent_start` (→ working) / `agent_end` (→ done), and once
  to each new SSE client on connect (hydration after the reload a branch
  switch performs). A "done" status is cleared when that session is next
  served as the active `state` (the user saw the finished thread).
- `server-notice` / `server-error` stay global (rare, informational).

### 4. Chat UI binding (active branch)

A branch switch is a full-page navigation (stable proxy URL, `/__designbook`
bootstrap), so "swap thread on switch" is free: the reload's `/api/events`
connect receives the newly-active session's `state`, and the existing
hydration path replays its messages.

The real change is *scoping*: `DesignChat` records the session's scope key
from `state.branch` and **drops any `pi-event` whose `branch` doesn't match**
— without this, an inactive branch's streaming turn would corrupt the visible
thread. Events from inactive branches surface ONLY as branch-switcher badges
(no toasts):

- `useWorktrees` opens its own (second) `EventSource` on `/api/events` and
  folds `branch-status` events into an `agentStatuses: Record<branch, status>`
  slice on the branch model.
- `BranchSelector` renders, on non-current entries: "agent working" (with
  spinner) while streaming, "agent finished" after `agent_end`.
- Chat header/footer: the existing session badge gains the branch name
  (`Session a1b2c3d4 · design/hero`) from `state.branchName`.

### 5. Dev-server lifecycle (sidecar target manager, LRU warm pool)

`createTargetManager` (extracted to `src/node/sidecar/targetManager.ts`) now
owns a *pool* of target dev servers keyed by cwd instead of exactly one:

- **Lazy spawn on first VIEW:** a branch's dev server spawns on first
  retarget to it (branch switch), not when its session is created — editing
  needs no dev server.
- **Stay warm:** switching away leaves the previous dev server running, so
  switching back is instant (no respawn, no recovery page).
- **Cap + LRU:** at most `MAX_WARM_TARGET_SERVERS = 3` warm servers
  (`sidecarSupport.ts`, documented constant). Beyond the cap the
  least-recently-viewed is stopped (`killTree`), never the currently-viewed
  one. Eviction choice is the pure `selectTargetEvictions(entries, activeKey,
  cap)` helper (unit-tested). Agent sessions are unaffected by dev-server
  stops; returning to an evicted branch respawns behind the recovery page.
- **Forced `--target-port` degrades the cap to 1:** N servers can't share one
  forced port, so the old stop-then-respawn behavior is kept in that mode
  (the effective cap is `targetPort !== undefined ? 1 : 3`). Without a forced
  port, each spawned server's port is discovered from its own stdout (Vite
  auto-increments), so warm servers coexist on distinct ports.
- Per-entry state (child, port, ring buffer, restart backoff) is what the old
  single-target manager had, now per pool entry; the recovery page shows the
  ACTIVE entry's log/exit reason.
- `stopBranch(branch)` / worktree-removal reconcile stops that branch's
  entry; `shutdown()` kills the whole pool.

### 6. Cleanup & safety

- Disposing a session aborts any in-flight turn first.
- Removing a worktree (reconcile) disposes its session AND stops its dev
  server.
- Sidecar shutdown reaps everything: all sessions, the whole dev-server pool.
- The Figma bridge (device bridge, integration registry) stays
  sidecar-global — one bridge regardless of branches. Unchanged.

## Non-goals / punts

- No per-branch sessions in host mode (separate processes already).
- No toast/notification UX beyond the switcher badges.
- No explicit worktree-removal endpoint (reconcile covers it).
- `git worktree` removal does not delete the worktree's Pi transcripts (they
  live inside the removed worktree; nothing to clean).

## Tests

- `sessionRegistry.test.ts` — lazy create, per-branch cwd, keep-alive across
  active-key changes, dispose-on-reconcile, abort-on-dispose, active
  resolution, host-mode fallback, shutdown reap.
- Event branch-tagging + wire-shape compat (primary payloads carry NO
  `branch` key; branch payloads do; `branch-status` shape).
- `selectTargetEvictions` LRU policy (pure) — cap, active exclusion, LRU
  order, forced-port cap of 1.
- Source-scan guards (house style): DesignChat drops non-matching-branch
  pi-events; useWorktrees listens for `branch-status`; BranchSelector renders
  the status badges; api.ts reconciles + `authStorage.reload()` stays in the
  per-session create path.
