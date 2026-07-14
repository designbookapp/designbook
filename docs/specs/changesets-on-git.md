# Changesets on git — hidden refs, real worktrees, projected layers

Status: DECIDED (Michael, 2026-07-14). Implementation on branch
`changesets-git` after the UI merge landed on main (051c8ec). Builds on
docs/specs/changeset-layers.md (L1-L3 shipped); supersedes its agent-boundary
mechanisms (overlay toolset, bash capture) and the bake mechanics of
docs/specs/bake-to-branch.md. Visual: claude.ai artifact "Changesets on Git".

## Decisions (locked)

- Hidden refs + ephemeral worktrees in CLIENT repos: acceptable.
- GIT REQUIRED. No folder-engine fallback; a non-git project gets a clear
  error at changeset creation.
- Variants are BRANCHES OFF the changeset branch (model below).
- Commit granularity: per TOOL-WRITE, turn boundaries marked. Rollback UI
  offers both levels.
- Sequencing: after UI merge (done); G1 first.

## Model

Three planes. Git = truth & history; the L1 layer dir = derived projection;
the serve plane (vite resolution, data merge, conflicts, Changes UI) is
UNCHANGED.

### Refs

    refs/designbook/changesets/<id>/trunk          # the changeset branch
    refs/designbook/changesets/<id>/v/<altId>      # variant branches OFF trunk

- Invisible to `git branch`/GUIs (not under refs/heads); never pushed.
- Trunk parents start at `baseCommit`. Edit-only asks commit on trunk.
- A variants ask cuts N variant branches at the CURRENT trunk tip: "three
  different ways you could branch off".

### Selection = checkout (Michael's variant semantics)

- Selecting a variant checks the changeset's worktree onto that variant
  branch. Subsequent edits commit THERE — the work goes in that variant's
  direction.
- Switching variants later: your edits STAY on the previous variant's branch
  (preserved, never orphaned in place, never silently reapplied — a change
  made on top of variant A may be wrong on B). The UI offers an explicit
  "reapply N changes onto this variant" (cherry-pick range; conflicts
  surface, resolvable by a merge turn). Decline = the edits simply live on
  the other branch, revisitable by selecting it again.
- Overhead: none that matters — branches are refs; switching variants in the
  worktree rewrites only differing files; ONE worktree per changeset serves
  all its branches (checkout up/down).

### Worktrees (agent workspaces)

- `.designbook/worktrees/<changesetId>` (gitignored), detached-attached to
  the selected branch, `node_modules` symlinked from the main tree (sound:
  deps/config are real-only per spec — lockfile never differs).
- Created lazily when a session needs one, reused across turns, pruned after
  idle. Serving NEVER waits on a worktree.
- Agent sessions run with cwd = worktree and the SDK's BUILT-IN tools.
  DELETE: overlayTools.ts, bashCapture.ts, the bash-sees-base context note.
  Bash just works. Agents can `git diff`/`git show` their own work natively.

### Commits & linkage to Pi messages

- Every tool-write = one commit (hooked at the tool layer we already own);
  message = tool + file summary. Turn end marks the boundary: final commit
  carries trailers, and the conversations sidecar records the turn span.
- Trailers: `Designbook-Conversation: <id>`, `Designbook-Turn: <sessionId>/<n>`,
  `Designbook-Tool-Call: <toolCallId>` (per-write).
- Sidecar (designbook-conversations.json) gains per-turn commit ranges →
  thread rows can show a per-turn diff and "restore to here" (both
  directions: message→commits and commit→message resolvable offline).

### Projection (the shipped L1 engine becomes a cache)

- After any ref move: diff `baseCommit...tip` per variant branch → write
  changed blobs into `.designbook/changesets/<id>/alts/<altId>/<path>` —
  today's exact layout; every variant tip projects (canvas gallery needs all
  of them), selection names the live one. meta.json fully derived.
- baseHashes/base snapshots come from git (baseCommit blobs) — the stored
  base/ dir dies.
- Rollback = move ref → re-project → one batched hot update. Other
  changesets untouched by construction (reflog keeps rolled-off commits
  recoverable until gc).

### db-original

Unchanged, and PURELY serve-plane: the vite hosts' loop-guard for reading a
real module that a layer shadows. Agents never see or need it — nothing to
communicate; their worktree is a real repo where the original is
`git show <base>:<path>`.

### Drift / bake / bake-to-branch

- Drift = trunk behind baseCommit's branch → surfaced as today; resolve =
  `git rebase` in the changeset worktree (merge turn only on conflict).
  The 2s hash watcher + stored-base merge-file path die.
- Bake in place = merge/cherry-pick selected branch into the working tree
  (native 3-way), tsc gate + serialized queue unchanged; dissolve deletes
  refs + cache + worktree.
- Bake to branch = `git branch <name> <tip>` — it already exists. The B1
  plumbing spec (mktree/commit-tree) is superseded; naming/PR flow (B2)
  carries over.

### Cleanup ("mess is temporary")

Discard/dissolve deletes the refs and the worktree (including its admin dir
+ reflogs) immediately — nothing visible in any git surface from that
moment. Commit objects linger UNREACHABLE until normal git gc reclaims them
(standard behavior, same as any deleted branch); no forced gc in the user's
repo. While active: hidden refs + objects + a gitignored worktree, nothing
else.

### Unchanged

Serve-time data merge (_merged), file-level conflict detection + Changes
panel Keep/Compose, conversations/direct-edits model (direct edits = commits
on the conversation's direct-edits changeset trunk), intent routing, render
loop, HMR discipline, tsc gate.

## Phases (branch `changesets-git`)

- **G1 — engine swap**: refs + lazy worktrees + per-write commits with
  trailers + sidecar turn ranges + projection; sessions move to worktree cwd
  with built-in tools; overlayTools/bashCapture deleted; existing UX
  (variants, flips, discard, conflicts, data merge) works on the projected
  cache exactly as today. Rollback API (`POST /api/sandbox/rollback`
  {changesetId, commit|turn}) server-side.
  **STATUS: SHIPPED.** Deviations worth recording: parallel variant fan-out
  arms run in TEMP worktrees (the shared changeset worktree serves only
  serialized turns); a dirty working tree at changeset creation surfaces as
  DRIFT (baseCommit = HEAD; the uncommitted edits diff against it);
  cross-changeset reads are ancestry-only (rollback / turn-diff targets must
  descend from the changeset's own base ref).
- **G2 — history UX**: per-turn diff rows in threads, restore-to-here (turn
  and tool-write), variant-switch "reapply changes" flow (cherry-pick +
  conflict merge turn).
  **STATUS: SHIPPED (2026-07-14).** Turn rows render in the live chat (GET
  /api/sandbox/turns + the `conversation-turn` SSE event; diff via the
  read-only, size-capped GET /api/sandbox/turn-diff); "Restore" = rollback
  by turn; the expansion lists the per-tool-write commits with commit-level
  restore. Reapply: switchSelect emits `reapply-available` when the previous
  branch has commits past its GENERATION baseline (`generatedTips` on the
  layer meta, recorded at fan-out / render-auto-fix / first-edit landing;
  pre-G2 layers have none and never prompt); POST /api/sandbox/reapply
  cherry-picks the range in the shared worktree — conflict = ONE merge turn
  (mechanical `--continue` when the agent resolves without continuing;
  unresolved markers never commit), total failure aborts + restores the
  target tip; decline is client-side only (edits stay on the old branch).
  The L3 conversation-session GATE is restored: worktree cwd + commit
  capture ONLY while a conversation is ACTIVE (active-conversation
  handshake); otherwise repo-root cwd with REAL writes — a flip rebuilds the
  session on the same transcript, mid-turn flips defer to turn end.
  Resolves unresolved question 1: offer AUTOMATICALLY (non-blocking strip in
  the thread + Changes UI), never auto-apply.
- **G3 — git-native lifecycle**: drift→rebase swap, bake via merge, dissolve
  cleanup, bake-to-branch (B2 naming/PR on top).
  **STATUS: SHIPPED (2026-07-14).** Choices recorded:
  - **Drift→rebase**: detection stays the cheap hash check (baseHashes derive
    from baseCommit blobs at projection); RESOLUTION is the new explicit
    "Rebase onto current source" action (POST /api/sandbox/rebase + a Rebase
    button on drifted Changes-panel groups). The new base is a SNAPSHOT
    commit: HEAD's tree + the on-disk content of every overridden path
    (parent HEAD) — uncommitted drift rebases too; a clean tree reuses HEAD
    itself. **Rebase order**: trunk first (`git rebase --empty=keep --onto
    newBase oldBase tip`, DETACHED in the shared worktree), then each variant
    branch onto the rebased trunk at its original fork distance
    (merge-base → `newTrunkTip~N`); refs move only after EVERY branch landed
    (a mid-run ref move would dirty the attached worktree, and abort must
    find all tips untouched). generatedTips remap by tip distance
    (`--empty=keep` keeps counts stable). Conflict = ONE merge turn per
    conflicted branch (worktree cwd) + mechanical `rebase --continue`;
    any unresolved branch aborts the WHOLE rebase and restores every tip.
    Post-rebase, pre-rebase turn rows no longer diff/restore (history was
    rewritten; sidecar records retained). The 2s hash watcher remains as the
    drift TRIGGER only; the stored-base merge-file path died as the primary.
  - **Bake apply strategy**: squashed diff + `git apply --3way` (chosen over
    cherry-pick range: the user's tree may be dirty and per-write commits are
    noise at bake). Per selected branch, `git diff --full-index --binary
    base..tip -- <modules>` applies onto the REAL working tree via a TEMP
    index seeded from HEAD + on-disk content — the user's index is never
    touched, "ours" is exactly what's on disk, and the clean path runs ZERO
    model turns. Conflicted files are restored to pre-bake content and fall
    back per-file (copy / merge-file / ONE merge-agent turn — the L1 path,
    now git-sourced). tsc gate + serialized queue + bake-status events
    unchanged; the 409-unless-force admission stays for un-rebased drift.
    Data files keep structured-merge semantics (unchanged).
  - **Dissolve/discard cleanup**: refs (base + trunk + variants + selected
    symref) deleted, worktree removed with its admin dir, layer cache dir
    removed; `git for-each-ref refs/designbook` is empty after (test-pinned).
    Sidecar turn records are retained (thread history).
  - **Bake-to-branch (B1)**: POST /api/sandbox/bake-to-branch
    {changesetId, name?, skipGate?, force?} — default name
    `designbook/<changeset-slug>`, editable in the Changes panel. The
    squashed changes (+ data merges) materialize in a TEMP worktree DETACHED
    at the current branch HEAD, commit there (user git identity when
    configured, designbook identity fallback; trailers Designbook-Changeset /
    Designbook-Conversation), tsc gate runs against the temp worktree by
    default (skippable), then `refs/heads/<name>` moves by plumbing — no
    checkout, user tree/index untouched, NOTHING pushed. Changeset stays
    ACTIVE with `bakedTo: {branch, commit, at}` + a badge; re-bake to the
    same branch = a new commit (same tree, parent = branch tip). Baking to
    the CURRENT branch is refused. Apply conflicts on this path fail with a
    pointer at the Rebase action (no merge turn — B1 keeps the branch exit
    deterministic). The branch shows up in the branch switcher naturally.

- **G4 — history explorer** (Michael's sketch, 2026-07-14): the chat/thread
  title bar of a changeset-bound conversation gains a right-aligned CLOCK; it
  opens an ACCORDION sliding down from the title with a vertical git-graph of
  that conversation's changesets.
  **STATUS: SHIPPED (2026-07-14).** Shape:
  - **Graph**: `GET /api/sandbox/history-graph?conversationId|changesetId` →
    the full DAG in one shot per changeset: refs with titles
    (`kind: trunk|variant|fork`, fork topology via `forkCommit`/`forkOfRef`),
    per-TURN nodes (sidecar records; commit = the turn's `to`), `selectedRef`,
    `parked`. Rendering is pure HTML/CSS + one inline SVG per changeset
    (`historyGraphModel.ts` layout: trunk column 0, rails by first activity,
    chronological node rows, one pill row per rail; the SELECTED ref's
    ancestry traces blue down through fork points). Per-write zoom is NOT in
    G4 — nodes are commit-keyed so a finer level can slot in later.
  - **Pills = selection**: clicking a pill is the EXISTING switchSelect (any
    overridden module names the flip; checkout semantics make it
    changeset-wide) — the app flips hot-only.
  - **Dots = PARK** (`POST /api/sandbox/park {changesetId, commit|turn|null}`):
    a NON-DESTRUCTIVE preview — the projection substitutes the parked commit
    for the parked rail's tip in the CACHE while `for-each-ref` shows every
    ref untouched. The pointer persists in the layer meta (`parked`), shows
    as a "viewing turn N" banner in the chat (Exit returns to the tips), and
    every ref-moving op (rollback/reapply/rebase/switch/bake admission)
    clears it first — restore/reapply semantics are unchanged by
    construction.
  - **New work while parked = IMPLICIT FORK**: the ask paths cut
    `v/fork-<ts>` at the parked commit, selection moves onto it, the park
    clears, `generatedTips[fork] = cut` (reapply baseline) — the graph
    growing a rail is what makes the implicit cut safe. On the CONVERSATION
    path the chat forks too: the parent Pi transcript is sliced at the parked
    turn's boundary (`SessionManager.createBranchedSession(leaf)`; the leaf
    is stamped per turn record at turn end, with a count-user-prompts
    fallback) into a NEW session/conversation; the sidecar gains `forks[]`
    (conversation lineage) and the layer meta `forks{altId}` binds the new
    conversationId to the PARENT changeset, so the forked chat's turns land
    on the fork ref. The live session rebuilds onto the sliced transcript via
    the G2 resume machinery; thread lists nest the fork under its parent.
    NOTE for Resume: `createBranchedSession` + the resume rebuild is exactly
    the "open a history row live" mechanism — G4 proved it end-to-end.
  - Iterate (branch-targeted) exits the preview instead of forking; pin
    threads fork the REF only (their turns are ephemeral sessions — no
    transcript to slice).

## Round 2 (Michael's feedback, 2026-07-14) — SHIPPED

Six items on top of G1-G4:

1. **Branch-scoped threads**: `/api/sandbox/threads` + `/api/sandbox/thread`
   were the last endpoints keyed off the live session's cwd (peek + primary
   fallback) — a fresh branch listed the PRIMARY checkout's threads. Both now
   key off `activeRepoRoot()` like every other handler: a new branch starts
   with an empty thread list; switching back restores that branch's threads.
2. **One history per conversation**: the clock accordion renders ONE unified
   graph per conversation — every changeset it touched (pin work + direct
   edits + forks) contributes rails to the SAME grid, all turns share one
   chronological row axis, per-rail pills stay, the per-changeset boxes are
   gone (`buildUnifiedHistoryGraph`). Group header = the conversation title.
   Refinements: graph nodes are BARE dots (one per turn — labels live in the
   TOOLTIP and the G2 turn rows, never as node text), and a parked
   ("viewing") commit traces its root→parked ancestry in the amber viewing
   accent, distinct from the blue selected-ref trace.
3. **Turn labels**: ~~at turn end ONE cheap title-mode turn runs over the
   turn's diff summary → an async `label` + lazy backfill.~~ SUPERSEDED
   (2026-07-14, Michael): the async title-mode label turn was a separate
   session boot — slow, labels visibly lagged. DELETED (incl. the lazy
   backfill queue + `turn-label` event). The WORKING turn now supplies its
   own label: write-class turn prompts end with an instruction to close the
   reply with `Summary: <what changed>` (+ an OPTIONAL `Title: <better
   branch name>` — only when the turn sees one). Parsed at turn end
   (turnSummary.ts): the summary becomes the sidecar record's `label`
   (synchronously, WITH the record) and the catch-all turn-end commit's
   subject (per-write commits keep tool subjects); the title renames the
   ref's display title (see §Ref titles). Both lines are STRIPPED from the
   visible reply (client + pin threads). Fallback chain unchanged: `prompt`
   line, then commit subjects/files.
4. **Park/fork canvas staleness (root cause + fix)**: content-only
   re-projections (park, exit, rollback, turn-end) rewrite alt files at
   UNCHANGED redirect paths, so the redirect push channel stayed silent
   (table byte-stable) and re-render depended on the target vite's watcher —
   racy against atomic renames (rename events intermittently missed; the
   variant-card toggle "fixed" it because a selection change DOES change the
   table). Now every projection/data-merge write bumps a monotonic CONTENT
   STAMP per target; stamps ride the redirect table (version bump, push
   seam, poll payload `stamps`), and the host driver treats a stamp change
   exactly like a variant flip: invalidate both sides + ONE batched hot
   update. Ordering is structural: stamps are recorded after the bytes land
   and the table refresh runs after projection, so the push can never
   precede the content. Regression-tested at the orchestrator seam
   (sandboxG4.test.ts "projection → hot-update ordering").
5. **String mutations allowed**: the pin-layer additive-only enforcement at
   projection (drop + warn) is DELETED — mutations of existing data keys
   are first-class layer overrides for every layer kind (key-level record,
   layer-wins while active, same-key-two-layers = the existing conflict
   surface, discard reverts, bake merges). Rationale: git + layer-wins made
   the prohibition obsolete — the real file is never touched. The prompt
   note keeps the QUALITY guidance (new text = NEW keys in every locale; no
   runtime registration) without the ban. See changeset-layers.md §Data
   merge.
6. **Changes tab = all changesets, grouped, toggleable**: the panel listed
   ACTIVE changesets only with no conversation grouping (the graph's
   360de6b turn-membership union never applied here — an inactive/
   other-conversation changeset was invisible). Now EVERY changeset of the
   viewed branch shows, grouped under conversation headers (direct-edits
   rows included, conversation-less ones under "Other changesets"), each
   row with an ACTIVE toggle (existing activate machinery); bake/discard/
   conflict badges unchanged.

## Conversation-routed asks (Michael's design, SHIPPED 2026-07-14)

Selection-scoped asks route through the PERSISTENT CONVERSATION SESSION
instead of spawning separate ephemeral pin threads — ONE continuous chat
where the selection is a moving pointer and the agent keeps conversational
memory across selections (the whole point: discuss item A, select item B,
say "do the same to this one" — the turn resolves the reference from its own
transcript).

- **Routing**: the full-view composers (DesignChat intercept + the
  SelectionPromptBar) reuse-or-create the selection's pin (promptTarget.ts —
  the pin remains the anchor/changeset record), RE-CAPTURE at send (fresh
  capture per message: a reused pin's `contextSnapshot` refreshes from the
  send-time capture; source-embed/props/owner resolution unchanged), then
  POST /api/prompt `{message, selection: {pinId, label, contextSnapshot?}}`.
  The server composes the turn message — `[Selection: <label>] (pin <id>)`
  first line + the capture-derived context + `User request:` — and the
  client renders it in the conversation thread as the bare request behind a
  PIN CHIP (the context block is display-folded; the model sees everything).
- **Per-turn workspace binding (the heart)**: the G1/G2 conversation gate is
  generalized from a fixed binary mode to a WORKSPACE IDENTITY
  (`root` | `cs:<changesetId>`), resolved PER TURN before the prompt
  dispatches: the selected pin's changeset worktree for a selection-scoped
  turn (resolution-aware — edits follow the active resolution), the
  conversation's direct-edits worktree for a plain turn, repo root when no
  conversation is active (real writes, unchanged). A differing workspace
  rebuilds the session on the SAME transcript (existing resume machinery);
  consecutive turns on the SAME changeset never rebuild; mid-turn flips
  defer to turn end, and a session still in another changeset's workspace
  never opens capture (wrong-branch safety). Turn commits land on the pin
  changeset's selected branch, turn records carry that changesetId — the
  history graph + Changes panel grouping just work.
- **Intent**: the conversation turn decides answer/edit ITSELF (it has tools
  + context — no pre-classification). Only VARIANTS keep the cheap intent
  classifier as a pre-step on selection-scoped prompts: variants n → the
  existing director/fan-out pipeline runs on the pin UNCHANGED (ephemeral
  arms, progressive landing, render-fix, replace), while the CONVERSATION
  anchors the ask + result as two custom transcript messages
  (`designbook-selection-ask` / `designbook-variants-result`, kept in LLM
  context so later turns can reference the variant names) that the client
  renders as the chip-anchored message and a VARIANT-CARDS thread item
  (live pin state — flip/iterate/bake in place). n=1 degrades to a normal
  conversation turn.
- **Pin threads**: kept rendering (history/back-compat; still the drill-in
  surface for a pin's cards/bake via the Changes panel), and a variants run
  still records on the pin's own thread. NEW selection asks stop creating
  pin threads as conversation surfaces. The pin's busy latch covers the
  conversation turn (no interleaved pin runs).
- **Parked**: selection asks while parked follow the existing implicit-fork
  rule — the conversation's own changeset forks chat+ref (api.ts), a PIN
  changeset forks the REF only (beginSelectionGitTurn).
- **Chat time-travel under a park**: going back in the history graph rolls
  the CHAT back too — with the conversation's changeset parked on a past
  turn, thread items after that turn's row collapse behind one marker
  ("N later items hidden — exit viewing to return";
  `truncateThreadForViewing`, display-level only). Exit restores the full
  transcript; prompting while parked = the implicit fork, whose sliced
  transcript exactly matches the truncated view (that consistency is the
  point). The boundary resolves off the sidecar turn records (same
  resolution as forkSliceLeaf).

### Ref titles (naming rules, 2026-07-14)

Per-ref display titles persist on the layer meta (`refTitles`:
altId → {title, source: user|agent|prompt}); the history graph prefers them
over the derived defaults.

- A new implicit fork's initial name = the CREATING PROMPT truncated to 10
  chars (`forkTitleFromPrompt`; source "prompt") — not `Fork · <id>`.
- A working turn MAY emit `Title: <name>` (optional, see turn labels) →
  source "agent".
- USER RENAME: double-click a tip pill → in-place input (Enter/blur commit,
  Escape cancels) → POST /api/sandbox/ref-title {changesetId, altId, title}
  → source "user", broadcast via `changesets-changed`. USER NAMES ARE
  LOCKED: agent Title: lines are ignored for that ref from then on.

### History graph = conversation timeline (screenshot round, 2026-07-14)

The unified graph is a CONVERSATION TIMELINE: all the conversation's turns
(pin work + direct edits) interleave chronologically on ONE mainline column
(a turn dot's changeset is tooltip info); rails split only at REAL
divergence (fork refs always; variant refs when they have their own turns
or are selected; zero-commit variants render as short pill STUBS at their
fork row, still selectable). Empty direct-edits changesets contribute
nothing. Tip pills ellipsize (max-width + full title in the tooltip); a
trunk pill repeating the conversation title renders "main".

## Unresolved questions

1. ~~Reapply-on-variant-switch: offer automatically when the old branch has
   post-selection commits, or only via an explicit thread action?~~
   RESOLVED (G2): automatic, non-blocking offer; never auto-applied.
2. ~~gc: leave entirely to the user's git auto-gc, or targeted
   `git prune-packed`-style tidy on discard (still no repo-wide gc)?~~
   RESOLVED (G3): left entirely to the user's git auto-gc. Discard/dissolve
   delete refs + worktrees only; unreachable commit objects reclaim on the
   repo's own gc cadence (same as any deleted branch). No prune-packed
   tidy — designbook never runs gc-shaped commands in a client repo.
