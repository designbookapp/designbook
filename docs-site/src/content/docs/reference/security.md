---
title: Security & trust model
description: What the sidecar can do, why localhost isn't automatically safe, and the flags that harden a session — read-only mode, LAN opt-in, and project trust.
---

Designbook embeds a coding agent with **bash, file read, and file write access to your
repo**, reachable over HTTP from your browser. That's what makes chat-driven edits work — but
it also means the sidecar deserves the same caution you'd give any credentialed dev server.
This page states the trust model plainly, then covers the flags that harden it.

## The trust model, in one paragraph

Anyone who can make an HTTP request to the sidecar can drive the Pi agent to run commands and
edit files in your repo. By default that's just you, because the sidecar binds to
`localhost`. But **"it only binds to localhost" is a weaker guarantee than it sounds like** —
any browser tab open on the same machine while designbook is running can still reach a
localhost server. Treat the sidecar port the way you'd treat a dev server that happens to have
write access to your source tree, because that's what it is.

## Same-origin by default

The sidecar's `/api/*` routes (and the proxy's `/__designbook/api/*` in injected mode) reject
cross-origin requests: a request carrying an `Origin` header that doesn't match the server's
own origin gets a `403`, and a `Host` header that doesn't resolve to a loopback alias is
rejected too (a DNS-rebinding guard). This closes the class of bug where an untrusted page
open in another tab quietly calls into your local designbook instance. It has no effect on
normal use — your own browser tab talking to its own sidecar is always same-origin.

This check applies to designbook's own API. It does not apply to your app's own `/api/*`,
which the proxy forwards through untouched.

One deliberate exemption: `GET /api/figma-hello`, the [Figma plugin](/figma/)'s discovery
probe. The plugin's UI iframe runs from a `data:` URL, so every fetch it makes is inherently
cross-origin; the endpoint answers with public identity info only (`{app, version, port}`)
and nothing else bypasses the gate.

## `localhost` by default; LAN mode is an explicit opt-in

`--host` defaults to `localhost`. Binding to anything else — `0.0.0.0`, a specific LAN IP, any
non-loopback address — **refuses to start** unless you also pass `--allow-lan`:

```bash
designbook dev --host 0.0.0.0 --allow-lan
```

With `--allow-lan`, designbook prints a warning every time it binds to a non-loopback address,
and keeps printing it — this is a deliberate, visible opt-in, not a silent mode. Use LAN
binding only for short, supervised sessions (demoing on a shared screen or testing from a
second device on a network you trust), and turn it back off when you're done. Everything in
["The trust model"](#the-trust-model-in-one-paragraph) above applies to **every device on that
network**, not just your own machine, while it's on.

## `--read-only`

Run designbook and the agent without any write access to the repo:

```bash
designbook dev --read-only
```

This restricts the Pi agent to read-only tools (`read`, `grep`, `find`, `ls` — no `bash`,
`edit`, or `write`), and the write-back endpoints full view itself uses (token edits, text
edits, flag edits, props edits, and direct code edits) all reject with `403` instead of touching
disk. Use it
when you want to browse, chat, and get Pi's proposed changes described in the chat panel
without anything landing on disk automatically.

## Project trust is off by default

Some agent runtimes will auto-load a repo's own configuration — extensions, settings, system
prompt overrides — the moment you open it. Designbook doesn't: a project's `.pi/extensions/`,
`.pi/settings.json`, and `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md` are **not loaded** unless you
opt in with `--trust-project`. This matters because those files can contain arbitrary code —
loading them unconditionally would mean cloning an untrusted repo and opening it in designbook
runs that repo's code before you've reviewed anything.

```bash
designbook dev --trust-project
```

Pass it only for repos you'd vet the way you'd vet a `postinstall` script. If a project has a
`.pi/` directory and you haven't passed the flag, designbook shows a one-time notice explaining
why its extensions and settings didn't load. `AGENTS.md`/`CLAUDE.md` context files are
unaffected by this flag either way — they load regardless of trust, matching Pi's own model.

## API keys

The Pi chat tab needs `ANTHROPIC_API_KEY` (or another supported provider key) in the shell
that runs `designbook`/`designbook dev` — the rest of designbook (full view, code panel, deep
links) works without it. Authentication otherwise follows the Pi SDK's standard flow
(`~/.pi/agent/auth.json`, shared with any other Pi/`pi` CLI usage on the machine).

- **Never** put an API key in `designbook.config.tsx`, `.designbook/`, or any file that gets
  committed. There is no config-driven key path in designbook — the environment variable (or
  `pi login`'s stored credential) is the only supported route.
- Don't commit `~/.pi/agent/auth.json`.

## A dirty working tree gets a warning, not a block

Before the agent's first turn in a session, designbook checks `git status --porcelain` in your
project root. If the tree is dirty, it surfaces a notice — Pi's edits are about to land on top
of your uncommitted changes. It's a warning, not a gate: commit or stash first if you want a
clean diff to review afterward, or ignore it if you're fine with the edits mixing in.

## Hardening checklist

- Keep `--host` at its `localhost` default unless you have a specific, time-boxed reason not
  to, and pass `--allow-lan` deliberately when you do.
- Don't leave `designbook`/`designbook dev` running in the background while browsing untrusted
  sites in the same browser — treat it like any other credentialed localhost dev server.
- Reach for `--read-only` when you want the agent's read/chat abilities without write access.
- Only pass `--trust-project` for repos whose `.pi/` contents you've reviewed.
- Run agent sessions from a clean working tree — a dedicated branch or a
  [branch instance](/branch-instances/) — so a bad edit is a `git diff`/`git reset` away from
  undone.
- Keep API keys in the environment, never in a repo-tracked file.

## See also

- **[CLI reference](/reference/cli/)** and **[`designbook dev`](/reference/designbook-dev/)** —
  the full flag list, including `--read-only`, `--allow-lan`, and `--trust-project`.
- **[The Pi agent](/concepts/agent/)** — how the agent runs and what it can reach.
