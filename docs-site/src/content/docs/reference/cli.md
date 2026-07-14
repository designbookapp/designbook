---
title: CLI reference
description: The designbook command, its arguments and options, and the environment variables it reads.
---

The `designbook` command dispatches five subcommands:

| Command | Purpose |
| --- | --- |
| [`designbook init`](/reference/init/) | Scaffold injected-mode files into a Vite app. |
| [`designbook dev`](/reference/designbook-dev/) | Run the injected-mode sidecar + proxy (the `design` script). |
| `designbook login` | Connect a model for the chat tab (below). |
| `designbook pi [args…]` | Run the bundled Pi coding-agent CLI directly (below). |
| `designbook [config]` | **Host mode** — serve the workbench from an embedded Vite dev server (below). |

`designbook init` and `designbook dev` each have their own page. This page documents `designbook
login`, `designbook pi`, and the bare `designbook [config]` invocation — **host mode**.

## `designbook login`

```bash
designbook login
```

Connects a model provider for the chat tab. There's no `--login` flag to drive non-interactively —
this is sugar for launching the bundled Pi CLI and running its interactive `/login` slash command;
designbook prints a one-line hint (`run /login, then /exit`) and hands off to Pi. Credentials land
in `~/.pi/agent/auth.json`, the same store the Pi SDK's standard auth flow reads — so a login here
is picked up by any `designbook`/`designbook dev` session afterward without further setup.

## `designbook pi [args…]`

```bash
designbook pi [args…]
```

A passthrough escape hatch to the exact Pi coding-agent CLI designbook bundles as a dependency —
every argument after `pi` is forwarded to it unmodified, with inherited stdio. Useful for anything
the Pi CLI supports that designbook doesn't expose its own flag for (inspecting sessions, running
one-off Pi commands, etc.), without needing Pi installed or resolvable separately in your project.
designbook resolves the bundled Pi binary from its own dependency tree, so this works the same
regardless of your project's package manager.

## Host mode: `designbook [config]`

```bash
designbook [config] [options]
```

Host mode serves designbook from its own embedded Vite dev server, for repos with no
runnable app (a standalone component library, or a Next.js repo). With no `config` argument it
looks for a config file in the current directory.

### Arguments

| Argument | Description |
| --- | --- |
| `config` | Path to the config file. Defaults to `designbook.config.{tsx,ts,jsx,js}` in the current directory (searched in that order). |

## Options

| Option | Description |
| --- | --- |
| `-p, --port <port>` | Port to listen on. Default `8787` (env `DESIGNBOOK_PORT`). |
| `--host <host>` | Host to bind. Default `localhost`. |
| `--allow-lan` | Required to bind a non-loopback `--host` (e.g. `0.0.0.0` or a LAN IP). Without it, a non-loopback `--host` refuses to start — see [Security & trust model](/reference/security/). |
| `--read-only` | Restrict the Pi agent to read-only tools (no bash/edit/write) and reject the file-write data endpoints with `403`. |
| `--trust-project` | Trust this repo's `.pi/` directory (extensions, settings, system prompt) — same gate Pi's own CLI has. Default: untrusted. |
| `--root <dir>` | Project root the agent works in. Default: the git root above the config file (env `DESIGNBOOK_CWD`). |
| `--no-open` | Don't open (or refocus) designbook in a browser. |
| `--debug` | Verbose logging: API requests + Pi agent events. Errors are always logged (env `DESIGNBOOK_DEBUG=1`). |
| `-h, --help` | Show help. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `DESIGNBOOK_PORT` | Default port when `--port` is not given. (Falls back to `PORT`, then `8787`.) |
| `DESIGNBOOK_CWD` | Default project root when `--root` is not given. |
| `DESIGNBOOK_DEBUG` | Set to `1` to enable verbose logging (same as `--debug`). |

## Notes

- **Config discovery** — with no `config`, the CLI tries `designbook.config.tsx`, then `.ts`,
  then `.jsx`, then `.js` in the current directory, and fails if none exists.
- **Project root** — this is the repo the embedded agent reads and writes. It defaults to the
  git root found above your config file; set `--root` / `DESIGNBOOK_CWD` when your config lives
  outside the repo you want edited.
- **Auto-open** — designbook opens in your browser on start (refocusing an existing tab on
  macOS with a Chromium-family browser). It's disabled automatically for non-TTY/CI runs and
  for [branch instances](/branch-instances/); `--no-open` disables it explicitly.
- **Authentication** — the embedded Pi agent uses the Pi SDK's standard auth flow
  (`~/.pi/agent/auth.json`) and provider environment variables.
- **Security** — `--allow-lan`, `--read-only`, and `--trust-project` are the same flags across
  both `designbook dev` and host mode (the two subcommands that run a full session); see
  [Security & trust model](/reference/security/) for the reasoning behind each.
