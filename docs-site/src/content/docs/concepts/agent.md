---
title: Chat & the Pi agent
description: Real per-branch conversations with the embedded Pi coding agent — selection-anchored asks, memory across selections, and variant cards.
---

Designbook embeds a **Pi coding agent**, reachable from the **Chat** section of the [left
rail](/concepts/full-view/). Describe a change and the agent applies it as **real edits to your
source files** — staged in a [changeset](/concepts/changesets/) if a conversation is open, so
nothing lands on your real branch until you bake it. There's no separate "design" artifact to
reconcile later; the output is always code.

## Conversations are real sessions

Chat isn't a scratch pad — each branch has one live **conversation**, a real, continuous agent
session with memory across everything you've selected and asked in it. Select something, ask
about it, select something else, say "do the same to this one" — the next turn resolves "this
one" against what you just selected and remembers what you discussed about the last thing,
because it's the same session throughout. "New conversation" really does reset it; your prior
conversations stay in history, reopenable.

## Selection is context, not a mode switch

Select anything in the running app with the **Select** tool, then type in chat: the message
carries your selection along as a small **pin chip** on the message, and the model receives the
resolved context behind it — the component (or element), where it's defined, where this
particular instance is used. You never leave the conversation to do this; there's no separate
"selection thread" to manage.

- A **plain question** just gets answered.
- **"Make this bigger," "fix the spacing here"** — an ordinary edit turn, staged on this
  selection's changeset.
- **Asking for options** ("give me three variants," "show me some alternatives") — the agent
  generates each variant as its own changeset branch, and every ready variant renders as a
  **card** right in the conversation. Flipping between cards is a **live, in-place preview** in
  your running app — hot, no reload — so you can compare options without losing your place.
  Picking one keeps working from there; the others stay on their own branches if you want to
  come back to them (see [Changesets](/concepts/changesets/)).

## Direct edits join the conversation

A manual edit made with the **Edit text** tool (or a [Props panel](/concepts/props-panel/)
change) while a conversation is open lands on that conversation's own changeset too — it shows
up in [Changes](/concepts/changesets/) and the [history explorer](/concepts/history/) right
alongside the agent's own turns, as one coherent trail of what happened in this conversation.
With no conversation open, the same edit writes your real file directly, exactly as it always
did.

## Where it runs

The agent runs server-side and streams to the chat panel over SSE — from the
[sidecar](/reference/designbook-dev/) in injected mode, or the single Node server the CLI
starts in host mode. Each branch gets its **own** agent session and dev server — kick off a
turn on one branch, switch to look at another, come back later and the first one has kept
working in the background. See [Branch instances](/branch-instances/).

## Authentication & debugging

The agent uses the Pi SDK's standard auth flow (`~/.pi/agent/auth.json`, then provider
environment variables such as `ANTHROPIC_API_KEY`). With no credential, Chat shows a setup
callout instead of the prompt input: run `npx designbook login` → `/login` (the Pi CLI ships
with designbook) or restart with a provider key set, then click **Retry connection** — a new
session re-reads `auth.json`, so no restart is needed after `/login`. Agent and API errors
always log to the terminal; run with `--debug` (or `DESIGNBOOK_DEBUG=1`) to additionally log
every API request and Pi agent event. Turn errors also surface in the chat panel.

## Next steps

- **[Changesets & the Changes panel](/concepts/changesets/)** — where a conversation's edits
  actually land.
- **[History explorer](/concepts/history/)** — the clock icon, and rolling a conversation back.
- **[Selection & drill-in](/concepts/selection/)** — how selection works.
- **[Props panel](/concepts/props-panel/)** — the other direct-edit surface that joins a
  conversation's changeset.
