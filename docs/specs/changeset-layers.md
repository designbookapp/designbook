# Changeset layers — file overlays replace shims/switches

Status: DECIDED (Michael + assistant, 2026-07-13). Implementation on branch
`changeset-layers`. SUPERSEDES the shim/switch mechanism of
docs/specs/sandbox-overrides.md (the changeset CONCEPT, bake gates, drift
rules, and UX carry over; the resolution mechanism is replaced). Builds on
docs/specs/sandbox.md v1–v3.

## Problem with the shim model

1. Agents must be prompt-disciplined about WHERE to write ("edit only the
   variant file, never the real source") — the live sweep (2026-07-13) proved
   models still trip on these rules, and the rules themselves grow (adapter
   data exception, import re-pointing, module-artifact-is-truth).
2. Copies live at NON-mirrored paths, so relative imports break and need
   deterministic re-pointing — a whole bug class (two live fixes to date).
3. Export-level switching needs generated shims, a runtime switch store, SSE
   sync, and per-export conflict logic — lots of machinery.

## Core idea (Michael, 2026-07-13)

A changeset is a LAYER: a folder of files stored at their full repo-relative
paths, as if rooted at the repo root. Active layers stack on top of the real
tree — topmost wins per file — and the vite plugin resolves any request for a
real file to the topmost active layer's copy. Like overlayfs/Docker layers:
no custom logic per file, just layering.

Agents don't know layers exist. Their file tools (read/write/edit/grep/find/
ls) operate on a virtual merged view: reads see base + active layers + their
own layer; writes land in their own layer. No prompt rules about paths, no
import re-pointing (same path ⇒ imports/aliases/tailwind just work).

## Model

- **Changeset** = one layer + metadata. Belongs to a CONVERSATION (see
  Sessions below). A conversation owns a LIST of changesets: one per pin/
  exploration it opens, plus one "direct edits" changeset for manual edits
  made while the conversation is open.
- **Layer content**: for each overridden repo path, one or more ALTERNATIVES
  (variants) and a SELECTION naming the live one. Enabling/disabling the
  changeset toggles the whole layer; picking a different variant updates the
  selection. Both are index writes + HMR hot update.
- **Activation order** = stack order (v1; explicit reordering later). Topmost
  active layer wins per file.
- **Conflict** = same file overridden by ≥2 ACTIVE layers (file-level; two
  changesets touching different exports of one file IS a conflict — accepted
  narrowing). Surfaced immediately at activation AND as a live badge, with
  the choices: keep one on / preview one at a time / merge now / rebase.
  Data files are exempt (see Data merge).

### Storage

    .designbook/changesets/<changesetId>/
      meta.json      # id, title, conversationId, pinId?, branch, baseCommit,
                     # createdAt, active, order, baseHashes,
                     # overrides: { <repo-path>: { selection, alternatives } }
      alts/<altId>/<repo-relative-path>   # alternative file contents

- **Out of source control** (gitignored; template updated). Layers are
  short-lived working state — dead code after bake/discard.
- **Local to branch**: each entry is tagged `{branch, baseCommit}`. Entries
  from OTHER branches (possible in a shared tree after branch switches) are
  tolerated and HIDDEN by default — filtered out of every list, never
  resolved. No cross-branch application in v1.
- Pins, threads, and canvas positions stay in the sandbox index as today;
  changeset entries there shrink to references.

### Resolution (vite / ModuleOverrideHost)

- The seam is UNCHANGED (redirect table, invalidate, hotUpdate, bypass
  marker) — the implementation gets simpler: file-level map real path →
  selected alternative path. No generated shims, no `_runtime.ts`, no
  useSyncExternalStore switch store, no `data-db-version` instance prop
  (dropped; a micro-shim can resurrect it later if changeset pages need it).
- Layer-only NEW files (a variant adds a module) resolve through the same
  map; imports between layered files work because paths mirror the repo.
- Any flip (activate/deactivate/selection change) = update map + invalidate +
  ONE hot update, batched per action so cross-module changesets flip
  atomically. Never a full reload (HMR discipline unchanged). The flipped
  component remounts (local state resets) — accepted.
- Dev-only, hard-gated, exactly as before.

### Data merge (json/po/cssvar)

- Data files layer by STRUCTURED MERGE, not shadowing: serve-time resolution
  merges base + each active layer's key CHANGES (existing dataClassify
  machinery identifies add vs mutate). Same at bake.
- ~~Additions only~~ RELAXED (round 2, Michael, 2026-07-14): mutations of
  EXISTING keys are first-class for EVERY layer kind — a changeset turn may
  change a shared i18n string / token value; the mutation is recorded
  key-level exactly like an addition, the layer's value WINS while the layer
  is active, discard reverts it, bake merges it into the real file.
  Rationale: the prohibition predated git+layer-wins — with the real file
  never touched and per-key attribution + conflict detection in place, a
  mutation is as safe as an addition. Two layers changing the SAME key with
  different values = the same changeset conflict as two same-key additions.
  (Quality guidance to agents is unchanged: NEW text still gets NEW keys in
  every locale; no runtime translation registration.)
- This replaces the write-real-immediately + `dataAdditions` GC model:
  changes live in the layer, so discard = drop the layer, no GC scan, and
  the additive-only endpoint enforcement becomes unnecessary for sandbox
  writes. Manual text-tool edits: real layer when no conversation is open;
  the conversation's direct-edits changeset when one is (see UX).

### Agent transparency (the tool overlay)

- Sessions bound to a changeset get an OVERLAY TOOLSET: designbook-provided
  read/write/edit/grep/find/ls implementing the merged view (read = topmost;
  write/edit = copy-up into own layer; grep/find/ls = merged listing).
  Preferred seam: pi extension `registerTool()` with built-ins excluded from
  the session's tools list (we already pass explicit tool names). Fallback
  seam (proven available): the `tool_call` hook — `event.input` is mutable
  pre-execution — path-rewrite + copy-up for read/write/edit; accept
  real-tree results for search tools.
- The prompt-discipline rules die: no "never edit X", no adapter-data
  exception wording, no module-artifact-is-truth framing. The director/
  variant/edit/iterate prompts describe the DESIGN task only.
- Read-view composition: base + all ACTIVE layers + own layer (own topmost).
  "Alternatives from original" = deactivate others first, as today.

### Bash (conversation sessions only — sandbox turns have no bash)

- Bash stays UNRESTRICTED (Michael: don't limit). It sees the REAL tree.
- Searches are fine — grep/find/ls are tools, not bash, and get the overlay.
- WRITE-CAPTURE lift, best-effort: during a turn, an fs-watcher (excluding
  .designbook, node_modules, .git) records real-tree changes; at turn end,
  files the turn modified are LIFTED into the session's changeset layer and
  the real file restored to its pre-turn content (recorded at first change;
  git as fallback source). Every lift/restore is event-logged to the thread.
  Known corner: a human edit during the turn window can be misattributed —
  acceptable for v1, the log makes it visible.
- The session context notes "bash reads the base tree; your file tools see
  your working state" so the model isn't misled.
- Future option if this bites: materialize the conversation view as a
  copy-on-write clone dir and run bash there.

### Sessions & conversations

- Each conversation = a REAL fresh Pi session ("new conversation" actually
  resets — today the drawer/proto row reuses the one live per-branch
  session). History list unchanged; Resume stays deferred.
- Sub-turns (director / per-variant / intent / title) stay ephemeral
  disposable sessions, now TAGGED with the parent conversationId and bound
  to the same changeset overlay.
- The thread UI groups: conversation → its changesets → variants, replacing
  pin-thread = changeset 1:1. Pins remain the anchor mechanism inside a
  conversation.

### Bake

- Per changeset, serialized queue as today. Per file:
  - base unchanged since layer capture (baseHashes match) → deterministic
    copy of the selected alternative over the real file. NO LLM turn.
  - base drifted → 3-way merge (`git merge-file` semantics: base snapshot,
    real, layer) → clean = write; conflicted = ONE merge-agent turn.
  - data files → structured merge of additions.
- tsc gate retained on the result; dissolve = deactivate + delete layer
  (files are dead after bake; the thread keeps the history).
- Discard = drop the layer. Nothing else to clean.
- FUTURE (noted): bake a SELECTION of changesets onto a fresh git branch →
  PR ("PRs from changesets"); toggle sets for live preview already falls out
  of activation.

## What this kills (on the branch)

Shim codegen + `_runtime.ts` + switch SSE store; `data-db-version`;
dataAdditions recording/GC + additive-only endpoint enforcement for sandbox
writes; import re-pointing (`rewriteRelativeImports`); edit-through-changeset
prompt framing (SANDBOX_DATA_ADDITION_RULE, module-artifact-is-truth);
the LLM replace turn for clean component bakes.

## What survives unchanged

Pins/capture/canvas gallery (alternatives are plain files — the canvas
imports them directly, wrapper mechanism untouched); intent classification;
render-failure loop; drift watcher (per-layer baseHashes); tsc gate + bake
queue; ModuleOverrideHost portability seam + layer-lint; HMR discipline
(generatedTailwindRefresh, hotUpdate guards — watch paths updated).

## Out of scope (v1)

package.json/config/deps and anything outside the vite client graph
(real edits or branch work, as before); prod/build-time layering;
cross-branch changeset application; explicit stack reordering; changeset
pages; Resume.

## Phases (branch `changeset-layers`)

- **L1 — layer engine**: storage + meta, file-level resolution through the
  seam, activation/selection flips (atomic, hot-only), conflict detection +
  choose-or-merge surfacing, serve-time data merge, existing orchestrator
  REGISTERS layers instead of shims (same UX: variant cards, preview in
  place, tray). Shim/switch machinery deleted. Bake/discard rewired
  (deterministic copy + 3-way; merge-agent on conflict only).
- **L2 — transparent agents**: overlay toolset (registerTool or tool_call
  seam), sandbox turns lose all path-discipline prompt rules, stacking =
  read-view composition, compose = merge into a new layer.
  SHIPPED (2026-07-13). Seam as built: the SDK's own tool FACTORIES with
  pluggable operations (`createReadToolDefinition(cwd, { operations })` …)
  passed via `customTools`, which shadow same-named built-ins — neither
  registerTool nor tool_call was needed. Grep alone is re-implemented (the
  SDK grep always spawns rg on the real tree). Data additions are captured
  from the turn's STAGED writes (diffed against the pre-write resolved
  view); the lift-and-restore for tool writes is gone. Data files fetched
  over HTTP (not ESM imports) are served by a redirect middleware ahead of
  vite's statics. Compose stays ONE overlay-bound merge turn with both
  parents' designs EMBEDDED (they shadow the same path — a merged read can
  only ever surface the topmost).
- **L3 — conversations**: real per-conversation sessions + changeset lists,
  direct-edits changeset (+ text-tool routing), bash write-capture lift,
  branch tagging/filtering, thread UI regrouping (conversation → changesets).
  SHIPPED (2026-07-13). As built:
  - **Conversation identity**: each per-branch live Pi session IS one
    conversation; a `conversationId` is minted at session creation and
    persisted in a sidecar map next to the transcripts
    (`designbook-conversations.json`, keyed by Pi session id) so history
    rows keep their linkage after "New conversation" (which now REALLY
    resets the per-branch session — the drawer's explicit action row).
    Sub-turn (director/variant/edit/intent/title) sessions are tagged into
    the same map with the parent conversationId. Resume stays deferred.
  - **ACTIVE-CONVERSATION DEFINITION** (normative): a conversation is
    active when the page-tools DRAWER is OPEN on (a) the live
    conversation's chat view, or (b) a pin thread whose pin carries that
    conversationId. The client reports it via
    `POST /api/sandbox/active-conversation` (`null` clears; drawer closed /
    list / history views clear it; page-tools teardown clears it). Manual
    structured data edits (`/api/i18n`, `/api/po`, `/api/json`,
    `/api/style`) route into the active conversation's direct-edits
    changeset; with NO active conversation they write the real layer
    exactly as before. Conversation turns get the overlay + bash capture
    only while a conversation is active.
  - **Direct-edits changeset**: lazy, one per conversation
    (`direct-<conversationId>`), PIN-LESS (`pinId: ""`,
    `conversationId` names the owner). The data machinery carries CHANGES
    (additions + key mutations — `computeDataChanges`/`applyDataChanges`);
    serve-time merge and bake apply a layer's changed keys with layer-wins
    semantics. Round 2 (2026-07-14): mutations are first-class for EVERY
    layer kind now — the former variant-turn additive-only enforcement
    (projection drop + warning) is deleted; see §Data merge.
    Bake/discard work like any other changeset (bake statuses ride the
    same queue with `pinId: ""` on the wire). An edit that cannot be
    represented as key changes falls back to the REAL write (surfaced).
  - **Main-session overlay binding**: conversation sessions get the L2
    overlay toolset behind a SWITCHABLE binding — during a turn with an
    active conversation, reads see the active layer stack and writes stage
    into the conversation's direct-edits layer (captured + registered at
    turn end); with no active conversation the tools are passthrough
    (built-in behavior, real writes). Chosen over always-on binding
    because the main chat legitimately does non-design work (designbook
    config, out-of-graph files) that must stay real; the drawer-open
    signal is the user's own "I'm designing now" boundary.
  - **Bash write-capture** (best-effort, as specced): watcher opens at
    prompt, closes at turn end; pre-turn content = snapshot for files
    DIRTY at turn start, `git show HEAD:` for clean files, absent for
    turn-created files (restore = delete). CORNERS (logged, not solved):
    a human edit inside the turn window lifts+restores like a bash write
    (event log makes it visible); deleted/binary/oversized (>2MB) files
    are skipped and left as-is; a DATA file change that cannot be
    expressed as key changes is left in the real tree (restoring would
    lose work) with a warning. Every lift/restore emits `bash-capture` +
    a chat server-notice.
  - **Branch surface**: `GET /api/sandbox/changesets?allBranches=1`
    returns foreign-branch layers tagged (`branch`, `baseCommit`,
    `foreign: true`) — read-only, never resolved/activatable.
  - **Wire**: all additive — `conversationId` on session state, pins,
    changesets, history thread rows; `direct`/`title` on changesets;
    `conversations` summary on GET /api/sandbox; `staged: true` on data
    writes that routed into a layer.

## Decided follow-ups (Michael, 2026-07-13)

1. `data-db-version` docs/UI mentions: stripped WITH L1 (done — the
   historical sandbox-overrides spec carries superseded-notes).
2. Conflict badge lives in the CHANGES PANEL (done at proto convergence).
3. Bake-to-branch got its own spec after L3 (docs/specs/bake-to-branch.md;
   largely superseded by the changesets-on-git direction).
