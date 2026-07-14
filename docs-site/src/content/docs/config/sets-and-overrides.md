---
title: Component sets & overrides
description: The ComponentSet shape and every EntryOverride field — what's live today, and which fields are deprecated no-ops left over from the retired component canvas.
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
| `id` | `string` | Unique set id. |
| `title` | `string` | `/`-delimited title; groups related entries under a shared label. |
| `components` | `Record<string, unknown>` | Map of key → component. Each key becomes a registered entry. |
| `wrapper` | `ComponentType<{ children }>` | **Deprecated, no-op.** Left over from the retired component canvas — see [Component registration](/concepts/component-sets/#wrapper-and-datasets). |
| `overrides` | `Record<string, EntryOverride>` | Per-entry tweaks, keyed by the `components` key. |

See [Component registration](/concepts/component-sets/) for what registering a component
actually does today.

## `EntryOverride`

Overrides are keyed by the component's key in `components`:

```tsx
overrides: {
  ProductCardDemo: {
    sourcePath: "./src/composite/product/variants/Card.tsx",
  },
}
```

| Field | Type | Description |
| --- | --- | --- |
| `label` | `string` | Override the entry's display label (defaults to a name derived from the `components` key). |
| `sourcePath` | `string` | Repo-relative source file for the [Code panel](/concepts/code-panel/). Needed when the registered component is a local demo wrapper (its source is the config file, so `sourceModules` can't attribute it to the real file). |
| `exportName` | `string` | Force which export of a lazy component module renders for this entry. |
| `matrixAxes` | `MatrixAxis[]` | **Deprecated, no-op.** Rendered a prop-combination grid on the retired component canvas; nothing reads it today. |
| `editableProps` | `EditableProp[]` | **Deprecated, no-op.** Declared canvas-only prop controls; superseded by the [Props panel](/concepts/props-panel/)'s TypeScript-derived controls, which need no config. |
| `previewWidth` | `number` | **Deprecated, no-op.** Fixed a canvas cell's preview width; there's no canvas cell to size. |

`label`, `sourcePath`, and `exportName` are live and do what they say. `matrixAxes`,
`editableProps`, and `previewWidth` still type-check (kept for compatibility with existing
configs) but nothing in the current UI reads them — they're inert.
