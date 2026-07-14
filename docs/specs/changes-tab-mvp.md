# Changes tab MVP — spec

_Planned 2026-07-08. Descoped per Michael: original "designer-friendly change
summary" vision is out; MVP is **a list of changed files, VS Code Source
Control style**. Stretch (only if genuinely easy): visual diff on canvas —
assessed below, mostly not easy; the easy win is per-card "changed" badges._

## Current state (investigated)

- **Changes tab exists but is 100% mock.** Left rail (`src/ui/components/
  SideRail.tsx`) has `files / changes / figma` + adapter tabs; `Workbench.tsx`
  line ~635 renders `<ChangesPanel />` from `src/ui/screens/panels.tsx`, which
  maps over a hardcoded `mockChanges` array ("Search results / Results list
  switched to the Image-led variant…") plus dead "Create PR" / "Discard"
  buttons. Nothing feeds it.
- **No existing change ledger.** `createRecentWrites` (`src/node/sidecar/
  hmrSuppress.ts`) is a **5-second TTL** map used only to suppress HMR echo of
  designbook's own data-endpoint writes (`GET /api/recent-writes`). Pi's file
  edits surface only as transient `pi-event` SSE messages (tool calls in the
  chat stream) — no persistent record of files Pi touched. Neither is a sound
  source of truth.
- **Git infra already in api.ts**: `execFileAsync` + `checkDirtyWorkingTree()`
  runs `git status --porcelain` (cwd `projectRoot`), degrades silently when not
  a git repo; worktrees API (`GET/POST /api/worktrees`, helpers in
  `src/node/lib/worktrees.ts`). Each worktree instance has its own
  `projectRoot`, so changes are naturally scoped per branch instance.
- **File read/write endpoints exist**: `GET /api/file?path=` / `POST /api/file`
  with `resolveSourceFile()` containment (resolve → `relative()` escape check →
  extension allowlist `.tsx .ts .jsx .js .css .json .md`). Read-only mode 403s
  via the `READ_ONLY_BLOCKED_ROUTES` set. The same-origin + DNS-rebinding gate
  (`src/node/plugin/apiOrigin.ts`, applied in `sidecar/server.ts` via
  `rejectCrossOriginApiRequest` before routing) covers **all** `/api/*` routes
  — new endpoints inherit it for free.
- **Refresh signals available**: SSE `/api/events` broadcasts `state`,
  `pi-event` (incl. `agent_start`/`agent_end`), `server-notice`, `figma-event`.
  No FS-watch broadcast exists.
- **Code tab**: `src/ui/screens/CodePanel.tsx` — CodeMirror
  (`@uiw/react-codemirror` + lang packs) fetching `/api/file`, selection-driven
  (`selectedNode.path`), save/discard. **`@codemirror/merge` is NOT a dep** —
  needs adding (official CodeMirror package; its `unifiedMergeView` extension
  gives an inline unified diff with per-chunk revert, drops straight into the
  existing editor).
- **Component↔file mapping exists**: `RegistryEntry.sourcePath`
  (projectRoot-relative, `src/ui/models/catalog/componentRegistry.ts`) — set
  from glob keys or `sourceModules` matching. Enables changed-file → entry
  badges.
- **No screenshot infra** (the `toDataURL` in `previewHost/figmaSerialize.ts`
  serializes canvas/image nodes for Figma push, not component snapshots).

## Source of truth: `git status --porcelain` vs HEAD

Decision: **git working tree vs HEAD** is the only sound source. It captures
Pi edits, designbook data-endpoint writes, AND the user's own IDE edits
uniformly; recent-writes is too short-lived and Pi events too lossy. No-git
projects degrade to an empty state with a hint (same pattern as
`handleListWorktrees`).

Staged vs unstaged: **collapsed to one state per file** (designers don't have
an index mental model). Combine the X/Y porcelain columns; pick the dominant
status (any `A`→added, any `D`→deleted, `R`→renamed, `??`→new, else modified;
`U`/conflict → "conflicted", listed but diff-only, no discard).

## MVP UX (P0)

**List** — flat, VS Code style (no directory grouping at typical change-set
sizes; paths make grouping redundant):

- Row: status dot/badge + `basename` (medium) + dirname (muted, truncating
  middle). Sorted by path.
- Badge copy for designers: `Edited` (M), `New` (A/??), `Deleted` (D),
  `Renamed` (R, shows `old → new`), `Conflict` (U). Color via existing
  `Badge` variants.
- Header: "Changes in this worktree" (existing copy) + count. Manual refresh
  icon button (same affordance as CodePanel's reload).
- Empty state: keep existing hint "Edits made in this worktree will show up
  here." Non-git repo: same empty state + one muted line "Not a git repo —
  change tracking is off."
- Drop the mock "Create PR" button (out of scope; worktree/branch flow already
  exists elsewhere). Discard: see below.

**Click → diff in RHS Code tab.** Clicking a row calls
`openRightTab("code")` and sets a workbench-level `codeFile` override (new
small state in `Workbench.tsx`, passed to `CodePanel`; override wins over
selection, cleared when the user changes canvas selection). CodePanel gains a
**diff mode**: when opened from Changes, it fetches `GET /api/file-diff` and
mounts `unifiedMergeView` (`@codemirror/merge`) with HEAD as original and
working content as the editable doc — designers see green/red inline chunks;
per-chunk revert buttons come free (disable in read-only mode). A small
"Diff / Edit" toggle switches back to the plain editor. Deleted files: diff
mode read-only, whole file red. New/untracked: whole file green (HEAD side
empty).

**Discard per file** — include in MVP but **behind a confirm dialog**
("Discard changes to Card.tsx? This can't be undone."). Valuable to designers
("undo my changes"), but destructive: gate it. Tracked files →
`git restore -- <path>` (restores staged+unstaged from HEAD). Untracked files
→ label the action "Delete file" (that's what it is) with its own confirm.
Blocked in `--read-only` mode. No "discard all" in MVP.

**Refresh strategy** — event-driven with a visibility-scoped poll backstop
(external IDE edits have no signal today; don't build FS-watch for MVP):

1. Refetch on Changes tab activation.
2. Refetch on SSE `pi-event` `agent_end` (Pi just finished editing).
3. Refetch after any designbook write action resolves (Code-tab save, props/
   i18n/json writes) — model exposes `refresh()`; simplest wiring is a window
   event (`designbook:fileWritten`, same style as navigationBus) fired by the
   write paths, consumed by the provider.
4. 10s poll **only while the Changes tab is visible** (git status on a normal
   repo is a few ms; cheap).

## Server side

New routes in `src/node/api/api.ts` (parsing/pure logic in a new
`src/node/api/gitChanges.ts` + colocated `gitChanges.test.ts`, mirroring
`cssVarEdit.ts`/`jsonEdit.ts`):

**`GET /api/changes`** → run `git status --porcelain=v1 -z -- .` with cwd
`projectRoot` (`-z`: rename pairs + no quoting of unicode/space paths; `-- .`
scopes to projectRoot when it's a repo subdir). Porcelain paths are repo-root
relative — convert to projectRoot-relative via `git rev-parse --show-prefix`
so they compose with `/api/file` and `RegistryEntry.sourcePath`. Response:

```json
{ "git": true, "changes": [
  { "path": "src/composite/product/variants/Card.tsx",
    "status": "modified",          // modified|added|deleted|renamed|untracked|conflicted
    "origPath": null }             // set for renamed
] }
```

Not a repo / git missing → `200 { "git": false, "changes": [] }` (mirror
`handleListWorktrees` degrade).

**`GET /api/file-diff?path=`** → returns both sides; client renders the diff
(no unified-diff parsing needed for `@codemirror/merge`):

```json
{ "path": "…", "status": "modified",
  "head": "<content at HEAD or null>",     // git show HEAD:<prefix+path>
  "working": "<current content or null>" } // null when deleted
```

**`POST /api/changes/discard`** `{ path }` → tracked: `git restore --
<path>`; untracked: `unlink` (only after the client's explicit delete
confirm; endpoint distinguishes via status check server-side too). Response
`{ ok: true }`. **Add to `READ_ONLY_BLOCKED_ROUTES`.** Also call
`noteDataWrite()` so HMR-suppress treats the restore like any designbook
write.

Security (all three): reuse `resolveSourceFile`-style containment — resolve
against `projectRoot`, reject escapes; always pass paths after a `--`
separator and via `execFile` array args (no shell, no option injection);
reject absolute paths. For `file-diff`, keep the `SOURCE_FILE_EXTENSIONS`
allowlist (unsupported/binary → `{ head: null, working: null,
unsupported: true }`, UI shows "No preview for this file type" but still
lists + allows discard). List endpoint has no path input → no containment
concern. Same-origin gate: inherited (routes live under the guarded `/api/*`
handler).

## Client model

Per the R spec target tree, file changes belong to the **`branch` model**
(`models/branch/` — "branch, worktrees, file changes"). Follow the
provider+atoms pattern (BranchProvider is the template):

- `models/branch/changesModel.ts` — pure: parse/sort/label statuses, badge
  variant mapping, `changedPathSet` derivation. + `changesModel.test.ts`.
- `models/branch/ChangesProvider.tsx` — owns fetch/refresh lifecycle (signals
  above), accepts `data` prop for cells/tests; exposes
  `{ changes, git, refresh, discard(path), openDiff(path) }` (actions
  injected from Workbench composition root, same altitude as BranchProvider).
- `models/branch/fixtures.ts` — extend with a canonical changes dataset.
- `models/branch/atoms.tsx` — `ChangeStatusBadge`, `ChangePathLabel`,
  `useChangedPaths()`.

Screens: rewrite `ChangesPanel` (move out of `panels.tsx` into
`src/ui/screens/ChangesPanel.tsx`, matching FilesPanel/CodePanel); CodePanel
diff mode; Workbench plumbing (`codeFile` override + provider mount +
`openRightTab`). NOTE: another agent is currently editing src/ui
(FigmaPanel/NodeDetailView/chat) — implementation should rebase on their
merge; overlap is small (Workbench.tsx wiring).

## Visual diff on canvas (stretch) — honest assessment

- **(a) Render HEAD version beside working version**: NOT easy. Requires
  serving `git show HEAD:` content through Vite as a parallel module graph —
  a virtual module for the file itself is doable, but its **relative imports
  must also resolve at HEAD** (transitive graph), else you render HEAD source
  against today's deps and lie. Plus duplicate React/context/singleton
  hazards inside one canvas. Reject for MVP. (If ever wanted: the credible
  route is the existing **worktrees infra** — a detached HEAD worktree gets
  its own instance and the canvas iframes the same entry from both origins.
  Real project, real module graph, zero Vite tricks — but it's a second
  running instance. P2 candidate, not "easy".)
- **(b) Per-card "changed" badges**: EASY and honest. `changedPathSet ∩
  entry.sourcePath` (both projectRoot-relative) → small "Edited" badge on the
  canvas card header (`PreviewCell`); click → Changes tab (or straight to the
  diff). This is the recommended stretch — ships in P1.
- **(c) Before/after screenshots**: no screenshot infra exists. Reject.

## Phasing

**P0 — list + diff** (ship alone):
- `src/node/api/gitChanges.ts` + `.test.ts` (porcelain -z parse, status
  collapse, prefix mapping — pure, fixture-tested)
- `src/node/api/api.ts` (`/api/changes`, `/api/file-diff`, routing)
- `package.json` (+`@codemirror/merge`)
- `src/ui/models/branch/changesModel.ts` + `.test.ts`, `ChangesProvider.tsx`,
  `atoms.tsx`, `fixtures.ts`
- `src/ui/screens/ChangesPanel.tsx` (new; delete mock from `panels.tsx`)
- `src/ui/screens/CodePanel.tsx` (diff mode)
- `src/ui/screens/Workbench.tsx` (provider, `codeFile` override, refresh
  wiring)

**P1 — discard + canvas badges**:
- `src/node/api/api.ts` (`POST /api/changes/discard` +
  `READ_ONLY_BLOCKED_ROUTES`)
- ChangesPanel row action + confirm dialog (shadcn `AlertDialog`)
- `src/ui/screens/PreviewCell.tsx` (badge via `useChangedPaths`)

**P2 — parked**: worktree-based side-by-side HEAD render (option a-via-
worktrees), FS-watch → SSE `changes` push replacing the poll. Neither meets
"easy"; do not start without a fresh decision.

## Open questions (Michael)

1. Discard in P0 or defer to P1? (Spec says P1.)
2. Untracked-file "Delete file" action: include at all?
3. Diff default: open rows in diff mode (recommended) or plain editor?
4. Badge copy "Edited/New/Deleted" vs git-literal "M/A/D"?
5. 10s visible-tab poll OK, or event-only (misses IDE edits)?
6. Canvas badge click → Changes tab or straight to diff?
7. "Create PR" button from mock: kill for MVP, right?
