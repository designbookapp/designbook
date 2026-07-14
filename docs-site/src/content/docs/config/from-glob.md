---
title: fromGlob & lazy entries
description: Register a whole directory of components lazily with fromGlob — per-cell code splitting, red-cell error isolation, and free source attribution.
---

`fromGlob` turns an `import.meta.glob` of a directory into a set's `components` record — one
lazily-loaded, code-split entry per file. It's the recommended way to register components:
each entry is compiled on demand by your app's own bundler, so **one broken component is one
red cell**, never a dead full view. Import it (and `lazy`) from `@designbookapp/designbook/config`.

## Usage

```tsx
import { defineConfig, fromGlob } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "My App",
  sets: [
    {
      id: "primitives",
      title: "Primitives",
      components: fromGlob(import.meta.glob("./src/components/*.tsx")),
    },
  ],
});
```

The glob is **non-eager** (no `{ eager: true }`) — that's what makes each file a separate lazy
chunk. Pass the raw `import.meta.glob` record straight into `fromGlob`; it's evaluated relative
to the config file.

## Key derivation

Each entry's key is the file's basename, dropped of extension and PascalCased (existing caps are
preserved): `Button.tsx` → `Button`, `color-input.tsx` → `ColorInput`. Collisions across
directories are disambiguated deterministically — first by prefixing the parent directory name,
then a numeric suffix as a last resort.

## Auto-excluded files

`*.test.*`, `*.spec.*`, and `*.stories.*` are excluded automatically (eager-globbing those was a
real incident). You don't need to filter them out yourself.

## Free source attribution

For glob entries, the code panel's source path comes **free from the glob key** — Designbook
already knows each entry's file, so you don't need `sourceModules` for these. (You still need
`sourceModules` for statically-registered or demo-wrapper entries; see the tradeoff below.)

## Options

`fromGlob(glob, options)` accepts:

| Option | Description |
| --- | --- |
| `include` | Keep only paths matching. String = substring match; or a RegExp; or an array of either. Default: keep all. |
| `exclude` | Drop paths matching (string substring or RegExp, or an array). Applied *after* the default test/spec/stories exclusion. |
| `key` | `(path) => string \| undefined` mapper to derive a custom key. Return `""`/`undefined` to skip the file. |

```tsx
components: fromGlob(import.meta.glob("./src/ui/*.tsx"), {
  exclude: ["internal", /\.helpers\.tsx$/],
  key: (path) => path.split("/").pop()!.replace(/\.tsx$/, ""),
}),
```

### Pinning an export

`fromGlob` resolves each file's export automatically: the export matching the entry key, else the
default export, else the file's sole component export. Pin an unusual one per entry with
`overrides[Name].exportName`:

```tsx
{
  id: "primitives",
  title: "Primitives",
  components: fromGlob(import.meta.glob("./src/components/*.tsx")),
  overrides: {
    Toolbar: { exportName: "ToolbarRoot" },
  },
}
```

## One-off lazy entries with `lazy()`

For a single lazy, code-split entry (rather than a whole directory), use `lazy()` from
`@designbookapp/designbook/config`. It's mainly useful when you need to pin the export name:

```tsx
import { defineConfig, lazy } from "@designbookapp/designbook/config";

export default defineConfig({
  sets: [
    {
      id: "primitives",
      title: "Primitives",
      components: {
        Chart: lazy(() => import("./src/components/Chart"), { exportName: "Chart" }),
      },
    },
  ],
});
```

## Static registration & the tradeoff

Static registration still works — `components: { Button, Card }` from explicit imports — but it
gives up per-cell fault isolation: a **broken static import fails the whole config module**, taking
the whole thing down instead of showing one red cell. Static (and demo-wrapper) entries also need
`sourceModules` for the code panel to attribute them to a file:

```tsx
// Only needed for statically-registered / demo-wrapper entries.
sourceModules: import.meta.glob("./src/components/*.tsx", { eager: true }),
```

Prefer `fromGlob` unless a component needs a demo wrapper (sample props / providers written in the
config file) — in which case register the wrapper statically and point the code panel at the real
file with `overrides[Name].sourcePath`. See [Component sets & overrides](/config/sets-and-overrides/).

## Red-cell error isolation

Because each `fromGlob` / `lazy` entry is a separate dynamic import wrapped in its own error
boundary, a component that fails to compile or throws while rendering degrades to a single **red
cell** — showing the component name, the first line of the error, and a **retry** button — while
every other component keeps rendering. This is the main reason to prefer lazy
registration over static imports.

## See also

- **[Component sets & overrides](/config/sets-and-overrides/)** — wrappers, matrix axes, `sourcePath`.
- **[defineConfig](/config/define-config/)** — the full config shape.
- **[Injected mode](/getting-started/injected-mode/)** — how entries compile through your app's bundler.
