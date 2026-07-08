---
title: Branch instances
description: Worktree-backed branch instances, the designbook:setup hook, and where their logs live.
---

Switching branches in the workbench doesn't disturb your working tree — Designbook spins up a
separate **branch instance** backed by a git worktree, so you can review or work on another
branch's components alongside your current one.

## How it works

When you switch to a branch, Designbook:

1. **Creates a git worktree** next to the repo at
   `<repo>-worktrees/<branch>` (checking out the branch, or creating it if it doesn't exist).
2. **Installs dependencies** in the worktree, using the package manager it detects
   (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, otherwise npm).
3. **Runs the `designbook:setup` hook** if present (see below).
4. **Resolves the `designbook` bin** by walking up from the config file's directory — so in a
   monorepo it finds the bin next to the package that depends on Designbook, not just one at
   the repo root.
5. **Starts a Designbook instance** on a **deterministic port derived from the branch name**
   (in the 5300–5499 range), detached and with the browser auto-open disabled. Designbook waits
   for the instance to come up before handing off.

The current (checked-out) branch is served by the main workbench itself, not a separate
instance.

## The `designbook:setup` hook

If your repo **builds Designbook from source** (or otherwise needs a build step before the bin
is runnable), add a `designbook:setup` script to the worktree root's `package.json`. It runs
**after** the dependency install, before the instance starts:

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

Each instance's output — the dependency install, the setup hook, and the running server — is
appended to:

```
~/.designbook/logs/<repo>--<branch>.log
```

Branch instances run detached with no terminal of their own, so this log is where their output
goes. Failure messages point you to the exact log path. If a branch instance doesn't come up,
that log is the first place to look.
