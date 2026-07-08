---
title: Component sets & overrides
description: The ComponentSet shape and every EntryOverride field — matrix axes, editable props, preview width, source path.
---

## `ComponentSet`

```ts
type ComponentSet = {
  id: string;
  /** `/`-delimited title used to derive folder structure, e.g. "Shop/Product". */
  title: string;
  components: Record<string, unknown>;
  wrapper?: ComponentType<{ children: ReactNode }>;
  overrides?: Record<string, EntryOverride>;
};
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique set id. Used in flow `registryId`s as `"setId.ComponentKey"`. |
| `title` | `string` | `/`-delimited title; nests the set into folders in the sidebar. |
| `components` | `Record<string, unknown>` | Map of label → component. Each key becomes a canvas entry. |
| `wrapper` | `ComponentType<{ children }>` | Optional context/data provider wrapped around the set's members; reads `useDataset()`. |
| `overrides` | `Record<string, EntryOverride>` | Per-entry tweaks, keyed by the `components` key. |

See [Component sets & registration](/concepts/component-sets/) for bare-vs-wrapper guidance.

## `EntryOverride`

Overrides are keyed by the component's key in `components`:

```tsx
overrides: {
  Button: {
    matrixAxes: [
      { name: "Variant", values: ["default", "secondary", "outline", "destructive", "ghost", "link"] },
      { name: "Size", values: ["default", "sm", "lg", "icon"] },
      { name: "State", values: ["Default", "Disabled"] },
    ],
  },
}
```

| Field | Type | Description |
| --- | --- | --- |
| `label` | `string` | Override the entry's display label (defaults to the `components` key). |
| `matrixAxes` | `MatrixAxis[]` | Render the component across a matrix of prop values — a grid of every combination. |
| `editableProps` | `EditableProp[]` | Props exposed as canvas controls (see below). |
| `previewWidth` | `number` | Fixed preview width in px. Previews are auto-width and user-resizable otherwise. |
| `sourcePath` | `string` | Repo-relative source file for the [code panel](/concepts/code-panel/). Needed when the registered component is a local demo wrapper (its source is the config file, so `sourceModules` can't attribute it to the real file). |

### `MatrixAxis`

```ts
type MatrixAxis = { name: string; values: string[] };
```

Each axis is a named list of values; the entry renders as a matrix over every combination
across all axes. Great for a `Button` across variant × size × state.

### `EditableProp`

```ts
type EditableProp =
  | { name: string; kind: "enum"; values: string[] }
  | { name: string; kind: "boolean" }
  | { name: string; kind: "text" };
```

Exposes a prop as an interactive control on the canvas — an enum picker, a toggle, or a text
input.

### `sourcePath`

Repo-relative. Only affects the code panel's source attribution. The canonical use is a demo
wrapper defined in the config file:

```tsx
components: { ProductCardDemo },
overrides: {
  ProductCardDemo: { sourcePath: "./src/composite/product/variants/Card.tsx" },
},
```
