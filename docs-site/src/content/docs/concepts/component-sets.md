---
title: Component sets & registration
description: Registering components bare vs. through demo wrappers, and pointing the code panel at the right source file.
---

A **component set** is a group of components shown together on the canvas. It's the primary
unit of registration:

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

Every key of `components` becomes a canvas entry labelled by that key. You can spread whole
modules in — a common pattern for a family of small atoms:

```tsx
import * as productAtoms from "./src/composite/product/atoms";

{
  id: "product",
  title: "Shop/Product",
  components: { ProductCard, ProductDetailSection, ...productAtoms },
  wrapper: ProductWrapper,
}
```

## Bare vs. wrapper registration

There are two ways to register a component, and the choice matters:

**Bare** — register the component directly. This works for self-contained components that
render meaningfully with no props and no surrounding context (primitives like `Button`,
`Badge`, `Card`). It's the simplest thing and a good default for a design-system's atoms.

**Demo wrapper** — for anything that needs context or realistic data, write a small wrapper
that provides it and renders `children`, and attach it as the set `wrapper`. The wrapper
reads the active dataset with `useDataset()`, so one wrapper serves the whole set and the
data stays swappable from the toolbar.

**We recommend wrappers** for any component that depends on providers or data. A component
that renders empty on the canvas is almost always missing context — a wrapper is the fix. See
[Troubleshooting](/reference/troubleshooting/#components-render-empty).

```tsx
function ProductWrapper({ children }: { children: ReactNode }) {
  const { data } = useDataset<DemoData>();
  return (
    <ProductProvider product={data.products[0]} currency={data.currency}>
      {children}
    </ProductProvider>
  );
}
```

Providers that should wrap **everything** on the canvas (a theme provider, an i18n provider)
belong in the top-level `providers` field instead of in per-set wrappers.

## The code panel and `sourcePath`

Designbook attributes each canvas entry back to its source file so the [code
panel](/concepts/code-panel/) can show real source and the agent can reference it. That
attribution comes from `sourceModules` (a glob of your component files).

There's one case the glob can't resolve: when the thing you registered is a **local demo
wrapper** defined *inside the config file* rather than a component imported from your source
tree. Since the wrapper lives in the config, `sourceModules` has no file to attribute it to.
Point the code panel at the real file with `overrides.sourcePath`:

```tsx
{
  id: "product",
  title: "Shop/Product",
  components: { ProductCardDemo },
  overrides: {
    ProductCardDemo: {
      // Repo-relative source file for the code panel.
      sourcePath: "./src/composite/product/variants/Card.tsx",
    },
  },
}
```

`sourcePath` is repo-relative. It only applies to the code panel's source attribution; see
[Component sets & overrides](/config/sets-and-overrides/) for the other override fields
(`matrixAxes`, `editableProps`, `previewWidth`, `label`).
