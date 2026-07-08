---
title: Code panel
description: The code panel shows the real source of the selected component — powered by sourceModules.
---

The **code panel** shows the real source file behind the selected component, and lets you
edit it in place — edits save back to the file on disk (via `POST /api/file`). It's the
bridge between what you see on the canvas and the code that produces it.

## Turn it on with `sourceModules`

The panel needs to know which file each canvas entry came from. You provide that mapping with
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

Designbook uses the glob to attribute each rendered component back to its file, so the panel
can show real source and the [agent](/concepts/agent/) can reference it.

## Warnings

The glob is **eager**, which means every matched module is *executed* at config load — the
same as importing it. Two consequences:

- **Exclude test and story files.** Don't match `*.test.tsx` or `*.stories.tsx`. Executing a
  test file at load time runs its top-level code (and can pull in test-only setup), which you
  don't want in the workbench. Keep the globs scoped to real component source.
- **Server-only imports break the optimizer.** If a matched file transitively imports
  server-only code, eager-executing it can knock out Vite's dependency optimizer. Scope your
  globs to the components you actually register. See
  [Troubleshooting](/reference/troubleshooting/#dependency-optimize-churn).

## Demo wrappers: use `sourcePath`

If a canvas entry is a demo wrapper defined *inside your config file*, `sourceModules` has no
file to attribute it to — the wrapper isn't in your source tree. Point the panel at the real
file with `overrides.sourcePath` on that entry. See
[Component sets](/concepts/component-sets/#the-code-panel-and-sourcepath).
