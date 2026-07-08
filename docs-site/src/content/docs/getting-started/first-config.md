---
title: Your first config
description: A minimal designbook.config.tsx you can run today, then how to grow it with wrappers, sets, and datasets.
---

Everything Designbook shows comes from a single config file. In injected mode it lives at
`.designbook/config.tsx` in your app (globs are then relative to `.designbook/`, so `../…`); a
legacy `designbook.config.tsx` at the project root still works, and is what the host-mode
examples below pass to the CLI. You author it with `defineConfig`, importing your own
components directly — the config file runs in the workbench, so anything you can import in your
app you can import here.

## A minimal config

Start with one set of components. This is the smallest thing worth running:

```tsx
// designbook.config.tsx
import { defineConfig } from "@designbookapp/designbook/config";
import "./src/index.css";
import { Button } from "./src/components/ui/button";
import { Badge } from "./src/components/ui/badge";
import { Card, CardHeader, CardContent } from "./src/components/ui/card";

export default defineConfig({
  title: "My app",
  sets: [
    {
      id: "primitives",
      title: "Primitives",
      components: { Button, Badge, Card, CardHeader, CardContent },
    },
  ],
});
```

Run it:

```bash
designbook designbook.config.tsx
```

Note the `import "./src/index.css"` — Designbook renders your real components, so you have to
bring in whatever global stylesheet they expect, exactly as your app's entry point does.
Without it, components render unstyled. See [Troubleshooting](/reference/troubleshooting/) if
styles look missing.

Each key in `components` becomes an entry on the canvas; the key is the label. The `title` is
`/`-delimited, so `"Shop/Product"` nests the set under a **Shop** folder in the sidebar.

## Grow it

### Wrappers for context

Bare components render fine until they need a provider or sample data. Instead of threading
props, give a set a **wrapper** — a component that provides the context its members need and
renders `children`. Wrappers read the active dataset with `useDataset()`:

```tsx
import { defineConfig, useDataset } from "@designbookapp/designbook/config";
import type { ReactNode } from "react";
import { ProductProvider } from "./src/composite/product/context";
import { ProductCard } from "./src/composite/product/variants/Card";
import type { DemoData } from "./src/data/products";
import { datasets } from "./src/data/products";

/** Feeds the first product of the active dataset to product composites. */
function ProductWrapper({ children }: { children: ReactNode }) {
  const { data } = useDataset<DemoData>();
  return (
    <ProductProvider product={data.products[0]} currency={data.currency}>
      {children}
    </ProductProvider>
  );
}

export default defineConfig({
  title: "Demo Shop",
  sets: [
    {
      id: "product",
      title: "Shop/Product",
      components: { ProductCard },
      wrapper: ProductWrapper,
    },
  ],
  datasets,
});
```

This is the Storybook-decorator model: components read data from context rather than
receiving it through props. We recommend wrappers over bare registration for anything that
depends on context — see [Component sets](/concepts/component-sets/).

### Multiple sets

`sets` is a list, so group related components however makes sense — one set per feature
area, one for shared primitives, and so on. Give each a unique `id` and a `title`.

### Datasets

`datasets` are named sample-data bundles selectable from the canvas toolbar. A wrapper reads
the selected one via `useDataset()`, so switching the dataset re-renders every component in
that set with new data — handy for empty/loading/populated states or different content
shapes.

```tsx
datasets: [
  { id: "default", label: "Default", data: { /* ... */ } },
  { id: "empty", label: "Empty", data: { /* ... */ } },
],
```

## Where to go from here

- **[Component sets & overrides](/config/sets-and-overrides/)** — matrix axes, editable
  props, and pointing the code panel at a source file.
- **[Adapters overview](/adapters/overview/)** — turn on theme, text, and flag editing.
- **[Configuration reference](/config/define-config/)** — every `defineConfig` field.
