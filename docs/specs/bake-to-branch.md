# Bake to branch — changesets become PRs

Status: **B1 SHIPPED (2026-07-14) via changesets-on-git.md G3** — the intent
below carried over; the MECHANICS were superseded by git (changesets live on
hidden refs, so materialization is a squashed `git apply --3way` in a temp
worktree + plumbing branch update, not mktree over layer files — see that
spec's G3 notes for the recorded choices). B2 (multi-select + push/PR) still
open. Original draft (assistant, 2026-07-13, per Michael's decision to spec
after L3) builds on docs/specs/changeset-layers.md (L1–L3 shipped).
Realizes the "future direction" note of docs/specs/sandbox-overrides.md:
changesets absorb design iteration; branches remain the collaboration
substrate; bake-to-branch is the bridge between them.

B1 deviations from the draft, as shipped: single changeset only (multi-select
is B2); drifted changesets get the same 409-unless-force admission as bake
(the new Rebase action is the clean path — forced apply conflicts fail with a
pointer at it, no merge turn); commit author = the user's git identity when
configured, designbook identity fallback; naming resolved (Q1): default
`designbook/<changeset-slug>`, editable inline; keep-active resolved (Q2):
stays active, `bakedTo` badge, in-place bake keeps dissolve; gate resolved
(Q3): temp-worktree tsc by default, `skipGate` flag.

## Problem

In-place bake writes the winning design into the CURRENT branch's working
tree. Teams that review through PRs want the same result as a proposed
branch instead — without designbook's per-branch worktree/dev-server churn,
and without leaving the exploration the user is standing in.

## Core idea

Bake a SELECTION of changesets onto a NEW git branch as one commit, built
with git plumbing — no checkout, no worktree, the user's working tree and
running app are untouched. The changesets stay live locally; the branch is
a snapshot vehicle for review.

## Model

- **Input**: an ordered selection of this branch's changesets (default =
  one changeset, same entry point as bake today; multi-select from the
  Changes panel later). Selection must be conflict-free: file-level
  conflicts inside the selection follow the existing ladder (choose /
  compose / rebase) BEFORE bake-to-branch is enabled.
- **Materialization**: per file, exactly the L1 bake rules — baseHash
  unchanged → selected alternative verbatim; drifted → 3-way with the
  stored base snapshot; data files → structured merge (additions + the
  direct-edits mutation set), selections applied in stack order. Conflict →
  one merge-agent turn, as in-place bake.
- **Commit mechanics**: read the tree of the current branch HEAD, apply the
  materialized file writes as tree objects (`hash-object`/`mktree`
  equivalents through the git seam), `commit-tree`, `update-ref
  refs/heads/<name>`. Author = the git user; message carries the changeset
  titles + conversation link; trailer notes designbook provenance.
- **After bake**: changesets stay ACTIVE and unchanged locally (the user is
  still exploring); each gets `bakedTo: {branch, commit}` recorded and a
  badge. Re-bake to the same branch = new commit on it. Discard/in-place
  bake later behave exactly as today. (In-place bake keeps its dissolve
  semantics — the two exits differ deliberately.)
- **Gate**: the tsc gate needs a real tree; running it means a TEMP
  worktree checkout of the new commit (created, gated, removed). v1 runs it
  by default with a skip flag; PR CI is the real backstop.
- **PR (phase B2)**: optional follow-up action — push the branch and open a
  PR via `gh` when a remote + gh are available; designbook never pushes
  without an explicit user action.

## Non-goals

Dismantling per-branch sessions/pool (explicit spec-note carryover: not
until changesets prove out in real use); baking selections that span
SOURCE branches; rewriting history on existing branches; auto-push.

## Phases

- **B1**: single-changeset bake-to-branch end-to-end (materialize via
  plumbing, temp-worktree tsc gate, `bakedTo` badge, branch appears in the
  existing branch switcher).
- **B2**: multi-changeset selection UX in the Changes panel + push/PR
  action + re-bake flow.

## Unresolved questions

1. Branch naming: `designbook/<changeset-slug>` default, editable?
2. Keep-active-after-bake OK, or should bake-to-branch offer dissolve too?
3. tsc gate via temp worktree acceptable (seconds, disk), or CI-only?
4. B2 PR body: auto-generated from thread history?
