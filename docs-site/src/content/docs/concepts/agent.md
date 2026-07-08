---
title: The Pi agent
description: The embedded coding agent that turns chat requests into real edits in your repo.
---

Designbook embeds a **Pi coding agent**, reachable from the chat panel in the workbench.
Describe a change and the agent applies it as **real edits to your source files** — the same
files you'd edit by hand. There is no separate "design" artifact to reconcile later; the
output is code in your repo.

## How it runs

The agent runs server-side and streams its turn to the chat panel over SSE (`/api/*`) — from the
[sidecar](/reference/designbook-dev/) in injected mode, or the single Node server the CLI starts in
host mode. It operates on the **project root** — the repo discovered above your config file, or
whatever you set with `--root` / `DESIGNBOOK_CWD`. That is the tree it reads and writes.

Because the canvas renders through Vite with hot reload (your app's own dev server in injected mode,
the embedded one in host mode), edits the agent lands show up on the canvas as soon as they hit disk.

## Selection is context

Selecting a component (and drilling into an element) gives the agent a precise anchor for
what you're describing — "make this heading larger" means more when *this* is a specific
selected node. See [Selection & drill-in](/concepts/selection/).

The agent shares the same write-back plumbing the adapters use, and it's how designer edits
pulled from Figma get applied — a pull drafts the annotated target into the chat as a prompt
and the agent makes the real code edits, rather than files being written mechanically. See
[Figma integration](/figma/).

## Authentication & debugging

The agent uses the Pi SDK's standard auth flow (`~/.pi/agent/auth.json`, then provider
environment variables such as `ANTHROPIC_API_KEY`). With no credential the chat tab shows a
setup callout instead of the prompt input: run `npx pi` → `/login` (the Pi CLI ships with
designbook) or restart with a provider key set, then click **Retry connection** — a new
session re-reads `auth.json`, so no restart is needed after `/login`. Agent and API errors
always log to the terminal; run with `--debug` (or `DESIGNBOOK_DEBUG=1`) to additionally log
every API request and Pi agent event. Turn errors also surface in the chat panel.
