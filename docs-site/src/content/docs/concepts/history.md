---
title: History explorer
description: The clock icon on a chat's title bar — a timeline graph of a conversation's changesets and turns, with time travel and forking.
---

Every [conversation](/concepts/agent/) has a full, inspectable history: every turn, every
[changeset](/concepts/changesets/) it opened, every variant it branched. The **history
explorer** is how you see and navigate that history without leaving the chat.

## Opening it

A small **clock icon** in a conversation's title bar opens an accordion that slides down under
it, showing a vertical timeline graph of everything that conversation has done: one line when
the conversation's work is linear, with rails branching off at forks and variants. Turns render
as plain dots on their rail — labels live in the tooltip and in the turn rows already visible
in the chat, not as text cluttering the graph. Rail pills (the tip of a branch) are
double-click renamable, and the graph traces the currently-selected branch's ancestry in blue
so you can always see where "now" sits in the history.

## Time travel

Clicking a dot rolls the view back to that moment — both the canvas (whatever changeset state
was active then) and the chat transcript up to that turn roll back together, so what you see
matches what the conversation actually saw when it made that change. A banner marks that
you're viewing a past point; exiting returns you to the present.

Prompting while viewing a past point doesn't overwrite anything that came after it — it
**forks**: a new branch is cut from that point, in both the code (a new changeset branch) and
the chat (the transcript is sliced at that turn and continues from there as its own thread,
nested under the original in the history list). Nothing you already did past that point is
lost; it's just no longer in the path you're now on.

## Why this matters

Because changesets are real git underneath (see
[Changesets & the Changes panel](/concepts/changesets/)), the history explorer isn't a
separate record designbook keeps on the side — it's a view onto commits and refs that actually
exist, which is what makes rollback, fork, and "restore to here" reliable rather than
best-effort.
