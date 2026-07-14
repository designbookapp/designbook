---
title: Changesets & the Changes panel
description: How designbook stages exploratory and direct edits as hidden git branches, and how the Changes panel lets you bake, branch, discard, or rebase them.
---

Every edit designbook's agent or tools make — a chat turn, a variant, a manual text/token/prop
edit — lands in a **changeset**: an isolated line of work that never touches your real git
branch until you decide to keep it. This is what lets you preview a change live in your
running app, throw it away with no trace, or turn it into a real commit, all without designbook
ever committing to your actual branch behind your back.

## What a changeset is

Under the hood, a changeset is a **hidden git ref** (`refs/designbook/changesets/<id>/...`) —
invisible to `git branch` and to any git GUI, never pushed — with its own short-lived worktree.
Every tool write is a commit on that ref; turn boundaries are marked so a conversation's
changeset has real, inspectable history from the moment it starts. Because it's real git, the
mechanics you'd expect all work: diffing, rebasing, branching off. Your actual working tree
stays pristine until you explicitly bake a changeset in.

A changeset belongs to a [conversation](/concepts/agent/): a conversation opens one changeset
per selection it works on, plus one **direct edits** changeset for manual token/text/prop
edits made while that conversation is open. With no conversation open, a manual edit writes
your real file directly, exactly as before — the changeset layer only exists while there's a
conversation to attribute it to.

**Variants** are branches off a changeset's trunk. Asking for a few options creates several
variant branches at the same point; picking one checks that changeset's worktree onto it, and
further edits land there. Switching to a different variant later doesn't lose the work you did
on the one you leave — it stays on that branch, and designbook offers to reapply it onto the
new selection if you want it there too.

## The Changes panel

The **Changes** section of the [left rail](/concepts/full-view/) lists every changeset touching
the branch you're viewing, grouped under the conversation that created them (plain edits with
no conversation group under "Other changesets"). Each row has:

- **An active toggle** — a changeset only affects what you see in the running app while it's
  active; toggling it off previews the app without that work, with everything preserved to
  toggle back on.
- **Bake** — merges the changeset into your real working tree in place. Clean files copy over
  deterministically; anything that drifted since the changeset was created gets a three-way
  merge (a merge turn resolves real conflicts). A type-check gate runs before it lands.
- **Branch** (bake-to-branch) — the same merge, but written onto a fresh, real, reviewable git
  branch (`designbook/<slug>`) instead of your working tree — nothing is pushed, and the
  changeset stays active so you can keep iterating and re-bake onto the same branch later.
- **Discard** — deletes the changeset and everything in it. Nothing lands anywhere.
- **Rebase** — appears when the changeset has drifted behind your current source (someone, or
  you, changed the files it touches outside the changeset). Replays the changeset's work onto
  the current source; conflicts get one merge turn.

## Conflicts

Two active changesets touching the same file is a conflict, surfaced immediately as a badge on
both rows. You resolve it by keeping one active (deactivating the other), previewing them one
at a time, or **Compose** — a merge turn that produces a new changeset combining both, which
you then activate in their place. Edits to structured data files (locale JSON, token JSON) are
usually exempt: two changesets touching *different* keys in the same file merge automatically.

## Next steps

- **[Chat & the Pi agent](/concepts/agent/)** — how conversations create changesets.
- **[History explorer](/concepts/history/)** — the graph of a conversation's changesets and
  turns, and how to look at (or fork from) an earlier point.
