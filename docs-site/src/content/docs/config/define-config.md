---
title: defineConfig
description: Every field of the designbook.config.tsx DesignbookConfig object, with types and descriptions from the source.
---

Your config file default-exports the result of `defineConfig`, imported from
`@designbookapp/designbook/config`. It's a plain object — `defineConfig` is an identity helper that gives you
the types.

```tsx
import { defineConfig } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "My app",
  sets: [/* ... */],
});
```

Everything filesystem-shaped (locale files, component source modules, token/flag JSON) is
evaluated inside the config file via `import.meta.glob`, relative to it — Designbook itself
contains no repo-specific paths.

## Fields

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | Shown in the browser tab and workbench chrome. Optional. |
| `sets` | `ComponentSet[]` | The component groups shown on the canvas. Required. See [Component sets & overrides](/config/sets-and-overrides/). |
| `flows` | `Flow[]` | User-journey screens arranged alongside the sets. See [Flows](/config/flows/). |
| `datasets` | `PreviewDataset[]` | Named sample-data bundles selectable from the canvas toolbar; wrappers read the active one via `useDataset()`. |
| `sourceModules` | `Record<string, unknown>` | An **eager** `import.meta.glob` over component source files, used to attribute canvas components back to their file for the code panel and agent prompts. |
| `providers` | `ComponentType<{ children: ReactNode }>[]` | Context providers wrapped around everything rendered on the canvas. |
| `i18n` | `I18nConfig` | Turns on the i18next text adapter. See [Text & i18next](/adapters/text/). |
| `adapters` | `Adapter[]` | Text/editing adapters, run as an ordered chain. See [Adapters](/adapters/overview/). |
| `themes` | `ThemeOption[]` | Preset theme options that inject canvas-scoped CSS custom properties. See below. |
| `viewports` | `ViewportSize[]` | Named preview widths (`{ id, label, width }`). |
| `integrations` | `Record<string, boolean \| object>` | Tool integrations, keyed by name. Built-ins (`figma`) are on by default; `false` disables one, an object passes its options. See [Integration plugins](/reference/integration-plugins/). |

## `datasets` — `PreviewDataset`

```ts
type PreviewDataset<Data = unknown> = {
  id: string;
  label: string;
  data: Data;
};
```

Selectable from the canvas toolbar. A set [wrapper](/concepts/component-sets/) reads the
active dataset with `useDataset<Data>()` and feeds it to its components — the
Storybook-decorator model, so switching datasets re-renders the set with new data.

## `providers`

Context providers wrapped around **everything** on the canvas — a theme provider, a language
provider, and so on. Use this for app-wide context; use a set
[`wrapper`](/concepts/component-sets/) for context only some components need.

```tsx
providers: [ThemeProvider, LanguageProvider],
```

## `themes` — `ThemeOption`

A lightweight preset-theme mechanism: each option injects CSS custom properties **scoped to
the canvas**, so only the preview re-themes.

```ts
type ThemeOption = {
  id: string;
  label: string;
  /** CSS custom properties injected scoped to the canvas, so only the preview re-themes. */
  cssVars?: {
    root?: Record<string, string>;
    dark?: Record<string, string>;
  };
};
```

For *editable* tokens (not just presets) with write-back to your stylesheet, use the
[theme adapter](/adapters/theme/) instead.

## `viewports` — `ViewportSize`

```ts
type ViewportSize = { id: string; label: string; width: number };
```

Named preview widths offered on the canvas.

## Exports from `@designbookapp/designbook/config`

Alongside `defineConfig`, the module exports `useDataset()` and the `TextAdapter` /
`TextClaim` / `TextNodeHit` types for [custom adapters](/adapters/custom/), plus the
framework-free theme-token and Figma helper types. All `DesignbookConfig` field types
(`ComponentSet`, `EntryOverride`, `Flow`, `I18nConfig`, `ThemeOption`, `ViewportSize`, …) are
exported as types.
