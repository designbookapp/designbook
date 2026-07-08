---
title: Flags adapter
description: Edit per-tenant feature flag values from JSON, fed to your own FlagsProvider on the canvas.
---

The **flags adapter** teaches the canvas to read and edit per-tenant feature flag values from
a JSON source of truth. It contributes a **tenant** dimension, a **Flags** tab of editable
fields, and a provider that feeds the active tenant's flag map to your own `FlagsProvider`.

```tsx
import { flagsAdapter } from "@designbookapp/designbook/adapters";
import { FlagsProvider } from "./src/providers/FlagsProvider";

adapters: [
  flagsAdapter({
    Provider: FlagsProvider,
    source: import.meta.glob("./src/flags/*.json", { eager: true, import: "default" }),
    sourcePath: "./src/flags/tenants.json",
    flags: {
      newCheckout: { label: "New checkout", control: "toggle" },
      density: {
        label: "Density",
        control: "select",
        options: ["comfortable", "compact"],
      },
    },
  }),
],
```

## Options

| Option | Type | Description |
| --- | --- | --- |
| `Provider` | `ComponentType<{ tenant, flags, children }>` | Your provider, fed `{ tenant, flags }` for the active tenant. |
| `source` | `Record<string, unknown>` | The flag source: an `import.meta.glob` result (eager, `import: "default"`) or a plain object. See layouts below. |
| `sourcePath` | `string` | Write target (config-relative) for the single-file layout. |
| `flags` | `Record<string, FlagSpec>` | The flags to surface as editable fields, keyed by flag id. |
| `tenants` | `{ value, label }[]` | Tenants offered in the selector. Default: top-level keys of `source`. |
| `id` | `string` | Adapter name + dimension namespace. Default `"flags"`. |
| `label` | `string` | Tab label. Default `"Flags"`. |
| `icon` | `string` | Tab/side-rail icon name. Default `"flag"`. |

### `FlagSpec`

```ts
type FlagSpec = {
  label: string;
  control: "toggle" | "select" | "text" | "number" | "color";
  /** For control: "select" — the allowed values. */
  options?: string[];
};
```

## Source layouts

The adapter accepts two file layouts and figures out which you're using:

- **Single file keyed by tenant** — `{ acme: { newCheckout: true }, globex: { … } }`. Set
  `sourcePath` to the file; edits write `POST /api/json` at key path `"<tenant>.<flag>"`.
- **Per-tenant files** — a glob of `acme.json`, `globex.json`, … each a flat flag map. The
  tenant is the filename stem; edits write to that tenant's file at key path `"<flag>"`.

Either way the adapter keeps a mutable in-memory copy (the eager glob is a build-time
snapshot), updates it optimistically on each save, and persists a surgical one-field write —
rolling back on failure.

## Your provider

The active tenant's flag map is passed to your `Provider` as `{ tenant, flags }`, wrapped
around the canvas preview. Switching the tenant dimension re-renders the preview with that
tenant's flags, and editing a flag field re-renders it immediately. Your provider is your own
code — it decides how components consume the flags.

:::caution[Gotcha: DOM-based scoping inside a Provider doesn't reach cell content]
Your `Provider` mounts inside the workbench's **shadow root**; canvas cells are **slotted light
DOM**. React context crosses that boundary fine — a `Provider` that feeds values through
context (the pattern above) works everywhere. But a `Provider` that scopes via the **DOM**
(sets a `data-*` attribute on a wrapper element and relies on CSS like
`[data-flag] .thing { … }`) won't affect cells: for slotted content, the CSS ancestor is where
an element is *defined* (the light DOM), not where it's *slotted* (under your shadow-root
wrapper) — so that wrapper is never an ancestor-selector match.

Prefer context-based scoping — a prop or className your cells read from context — over
attribute-plus-descendant-CSS in the first place; it's boundary-agnostic. If you do need to
re-emit an attribute for CSS to key off, mirror it **in the light DOM, inside the cell**, not
on the Provider's own wrapper:

```tsx
function FlagScope({ children }: { children: ReactNode }) {
  const { flags } = useFlags(); // your provider's context
  return <div data-density={flags.density}>{children}</div>;
}
// Render <FlagScope> at the root of each cell demo (or your variant wrapper).
```
:::
