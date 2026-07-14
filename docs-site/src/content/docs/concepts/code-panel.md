---
title: Code panel
description: The Code tab of the right panel shows the real source of the selected component — powered by sourceModules — with edit, diff, and changeset-aware resolution.
---

The **Code** tab of the [right panel](/concepts/full-view/) shows the real source file behind
the current [selection](/concepts/selection/), and lets you edit it in place — edits save back
to the file on disk (via `POST /api/file`), or to the active [conversation's
changeset](/concepts/changesets/) when one is open. It's the bridge between what you see live
in your app and the code that produces it.

## Turn it on with `sourceModules`

The panel needs to know which file each selection came from. You provide that mapping with
`sourceModules` — an **eager** `import.meta.glob` over your component source files:

```tsx
sourceModules: import.meta.glob(
  [
    "./src/composite/*/variants/*.tsx",
    "./src/composite/*/atoms.tsx",
    "./src/components/ui/*.tsx",
  ],
  { eager: true },
),
```

Designbook uses the glob to attribute a rendered component back to its file, so the panel can
show real source and [chat](/concepts/agent/) can reference it. A selection outside any
registered component (a plain DOM element, a page-shell wrapper) still resolves to a source
file when possible — a bounded, read-only server-side scan finds the owning export — so the
Code panel isn't limited to components you explicitly registered.

## Warnings

The glob is **eager**, which means every matched module is *executed* at config load — the
same as importing it. Two consequences:

- **Exclude test and story files.** Don't match `*.test.tsx` or `*.stories.tsx`. Executing a
  test file at load time runs its top-level code (and can pull in test-only setup), which you
  don't want. Keep the globs scoped to real component source.
- **Server-only imports break the optimizer.** If a matched file transitively imports
  server-only code, eager-executing it can knock out Vite's dependency optimizer. Scope your
  globs to the components you actually register. See
  [Troubleshooting](/reference/troubleshooting/#dependency-optimize-churn).

## Demo wrappers: use `sourcePath`

If a registered entry is a demo wrapper defined *inside your config file*, `sourceModules` has
no file to attribute it to — the wrapper isn't in your source tree. Point the panel at the real
file with `overrides.sourcePath` on that entry. See [Component
registration](/concepts/component-sets/#the-code-panel-and-sourcepath).

## Changesets change what you're editing

When the selected file is overridden by an **active changeset** (you're mid-conversation, or
previewing a variant), the Code panel points at the changeset's version of the file instead of
the real one: edits land in the changeset, and diff mode compares the changeset's content
against the real file rather than against your last commit, labeled with the changeset it
belongs to. See [Changesets & the Changes panel](/concepts/changesets/).
