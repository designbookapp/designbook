---
title: Branch instances
description: Worktree-backed branch switching, the designbook:setup hook, and where their logs live — host mode spins up a separate instance; designbook dev retargets the same proxy URL.
---

Switching branches doesn't disturb your working tree — Designbook checks the branch out into
its own **git worktree**, nested inside your repo at `.designbook/worktrees/<branch>`, and
works from there. What happens next differs by mode.

## Host mode: a separate instance per branch

In host mode, switching to a branch other than the one you started on spins up a **separate
Designbook instance** for it, on its own deterministic port (derived from the branch name, in
the 5300–5499 range), and the browser navigates there. The branch you started on keeps being
served by the instance you launched.

## `designbook dev`: one URL, retargeted

Under the proxy (`designbook dev`), there's no second instance and no port to navigate to —
the branch you're viewing is just whichever worktree the sidecar's proxy currently targets.
Switching branches prepares the worktree (below) and retargets the proxy onto it; you stay on
the same stable URL the whole time. Each branch also gets its **own agent session** so work
started on one branch keeps running in the background while you look at another — see
[Chat & the Pi agent](/concepts/agent/#where-it-runs).

## Preparing a worktree

Whichever mode you're in, bringing a branch's worktree up does the same three things:

1. **Creates the git worktree** at `.designbook/worktrees/<branch>` if it doesn't exist yet
   (checking out the branch, or creating it if it doesn't exist). This path is excluded from
   your repo's `git status` (a local `.git/info/exclude` entry, added automatically) so it
   never pollutes the Changes panel or a plain `git status` in your terminal.
2. **Installs dependencies**, using the package manager it detects
   (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, otherwise npm).
3. **Runs the `designbook:setup` hook** if present (see below).

In host mode, a fourth step **resolves the `designbook` bin** by walking up from the config
file's directory — so in a monorepo it finds the bin next to the package that depends on
Designbook, not just one at the repo root — and starts the branch's instance, waiting for it to
come up before handing off.

## The `designbook:setup` hook

If your repo **builds Designbook from source** (or otherwise needs a build step before the bin
is runnable), add a `designbook:setup` script to the worktree root's `package.json`. It runs
**after** the dependency install, before anything else:

```json
{
  "scripts": {
    "designbook:setup": "pnpm --filter '@designbookapp/designbook' build"
  }
}
```

If there's no such script, the step is simply skipped. (This monorepo uses the hook to build
`packages/designbook` after each worktree install.)

## Logs

Each branch's worktree preparation (and, in host mode, its running instance) appends output to:

```
~/.designbook/logs/<repo>--<branch>.log
```

Branch instances run detached with no terminal of their own, so this log is where their output
goes. Failure messages point you to the exact log path. If a branch doesn't come up, that log
is the first place to look.
