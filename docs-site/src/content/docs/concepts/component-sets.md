---
title: Component registration
description: Registering components gives designbook names, source attribution, and a props schema surface — selection and editing work even on unregistered elements.
---

:::caution[Deprecated]
Component registration via `sets` is **deprecated**: designbook now detects
your app's exported components automatically (the vite plugin's export
index) — selection, drill, labels, and code attribution need no config.
Existing `sets` keep working with a one-time warning this release and win
name collisions while present; removal comes next release.
:::


A **component set** groups components under a shared name in your config:

```tsx
type ComponentSet = {
  id: string;
  /** `/`-delimited title used to derive folder structure, e.g. "Shop/Product". */
  title: string;
  components: Record<string, unknown>;
  wrapper?: ComponentType<{ children: ReactNode }>;
  overrides?: Record<string, EntryOverride>;
};
```

You can spread whole modules in — a common pattern for a family of small atoms:

```tsx
import * as productAtoms from "./src/composite/product/atoms";

{
  id: "product",
  title: "Shop/Product",
  components: { ProductCard, ProductDetailSection, ...productAtoms },
}
```

## What registration buys you

Designbook doesn't need a component registered to let you select, edit text on, or chat about
it — [selection](/concepts/selection/) works on anything rendered in your app. What
registration adds:

- **A friendly name.** A registered instance shows its `components` key (e.g. `ProductCard`)
  instead of a DOM tag/class; the set's `/`-delimited `title` groups related entries.
- **Reliable source attribution.** Registration plus [`sourceModules`](/concepts/code-panel/)
  is the most direct path from a selection to the file the [Code panel](/concepts/code-panel/)
  opens and [chat](/concepts/agent/) references — an unregistered element still resolves to a
  source file via a best-effort scan, but a registered one is exact.
- **A props schema.** The [Props panel](/concepts/props-panel/) can extract typed controls for
  any component whose source and export it can resolve — registration is the simplest way to
  guarantee that resolution.

## Bare registration

The common case is simple: register the component directly. Nothing else is required.

```tsx
{
  id: "primitives",
  title: "Primitives",
  components: { Button, Badge, Card, CardHeader, CardContent },
}
```

## `wrapper` and `datasets`

`ComponentSet.wrapper` and top-level `datasets` are still part of the config type — a wrapper
provides context via `useDataset()` around a set's members, and `datasets` are named
sample-data bundles a wrapper can read. They come from an earlier version of designbook that
rendered registered components inside its own workbench canvas (`wrapper` supplied the context
that canvas needed). In the current full view, everything you select renders inside your
**real, running app** — with its real providers already in place — so designbook no longer
needs a config-level wrapper to construct that context; it's not required for selection,
Props/Code panels, or chat to work. Existing `wrapper`/`datasets` config still type-checks and
is harmless to keep, but don't reach for it to make a component "show up" anywhere — there's no
canvas surface left that consumes it.

Providers that apply app-wide belong in your app's own provider tree (your real
`main.tsx`/`App.tsx`), not in designbook's config.

## The Code panel and `sourcePath`

There's one case source attribution can't resolve on its own: when the thing you registered is
a **local demo wrapper** defined *inside the config file* rather than a component imported from
your source tree. Since the wrapper lives in the config, `sourceModules` has no file to
attribute it to. Point the Code panel at the real file with `overrides.sourcePath`:

```tsx
{
  id: "product",
  title: "Shop/Product",
  components: { ProductCardDemo },
  overrides: {
    ProductCardDemo: {
      // Repo-relative source file for the Code panel.
      sourcePath: "./src/composite/product/variants/Card.tsx",
    },
  },
}
```

`sourcePath` is repo-relative. It only affects source attribution; see [Component sets &
overrides](/config/sets-and-overrides/) for the other override fields (`editableProps`,
`previewWidth`, `label`).
