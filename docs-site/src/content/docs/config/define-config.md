---
title: defineConfig
description: Every field of the designbook.config.tsx DesignbookConfig object, with types and descriptions from the source.
---

Your config file default-exports the result of `defineConfig`, imported from
`@designbookapp/designbook/config`. It's a plain object — `defineConfig` is an identity helper
that gives you the types.

```tsx
import { defineConfig } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "My app",
  i18n: {/* ... */},
  adapters: [/* ... */],
});
```

Components need no registration: the vite plugin indexes your app's exported
components automatically, so selection, drill, labels, and code attribution
work out of the box. The fields below marked deprecated are accepted with a
one-time warning this release and will be removed in the next.

Everything filesystem-shaped (locale files, component source modules, token/flag JSON) is
evaluated inside the config file via `import.meta.glob`, relative to it — designbook itself
contains no repo-specific paths.

## Fields

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | Shown in the browser tab. Optional. |
| `sets` | `ComponentSet[]` | **Deprecated.** Superseded by automatic component detection (the plugin's export index). Still functional with a warning; explicit entries win name collisions while present. See [Component registration](/concepts/component-sets/). |
| `flows` | `Flow[]` | **Deprecated, no-op** (its UI is retired). See [Flows](/config/flows/). |
| `datasets` | `PreviewDataset[]` | Named sample-data bundles read via `useDataset()`. Part of the same retired-canvas machinery as `ComponentSet.wrapper` — see [Component registration](/concepts/component-sets/#wrapper-and-datasets). Still type-checks; nothing in the current UI switches between them. |
| `sourceModules` | `Record<string, unknown>` | **Deprecated.** Source attribution now comes from the automatic export index (with a bounded scan fallback). Still accepted with a warning. |
| `providers` | `ComponentType<{ children: ReactNode }>[]` | **Deprecated, no-op.** Wrapped context around the retired component canvas; your running app has its own real provider tree now. |
| `i18n` | `I18nConfig` | Turns on the i18next text adapter. See [Text & i18next](/adapters/text/). |
| `adapters` | `Adapter[]` | Text/editing adapters, run as an ordered chain. See [Adapters](/adapters/overview/). |
| `themes` | `ThemeOption[]` | Preset theme options selectable from the full view's top bar. See below. |
| `viewports` | `ViewportSize[]` | Named preview widths for the full view's viewport control. |
| `integrations` | `Record<string, boolean \| object>` | Tool integrations, keyed by name. Built-ins (`figma`) are on by default; `false` disables one, an object passes its options. See [Integration plugins](/reference/integration-plugins/). |

## Deprecated fields, precisely

`providers`, `datasets`, and `flows` are **no-ops** — nothing consumes them.
`sets` and `sourceModules` (and the `fromGlob` helper) **still work with a
one-time console warning and a dismissible banner**, and are removed next
release. The migration for all of them is the same: delete the field —
automatic detection covers what they did.

## `providers` and `datasets` background

Earlier designbook versions rendered registered components inside the workbench's own canvas,
so `providers` (wrapped around the whole canvas) and `datasets` (switched from a canvas
toolbar, read via `useDataset()`) mattered. That canvas is retired — everything you select now
renders inside your **real, running app**, with its real provider tree already in place. Both
fields still type-check so existing configs keep compiling, but nothing in the current UI
consumes them. See [Component registration](/concepts/component-sets/#wrapper-and-datasets) for
the fuller picture (this applies to `ComponentSet.wrapper` too).

## `themes` — `ThemeOption`

A lightweight preset-theme mechanism: each option injects CSS custom properties scoped to the
running app's frame.

```ts
type ThemeOption = {
  id: string;
  label: string;
  cssVars?: {
    root?: Record<string, string>;
    dark?: Record<string, string>;
  };
};
```

For *editable* tokens (not just presets) with write-back to your stylesheet, use the [theme
adapter](/adapters/theme/) instead.

## `viewports` — `ViewportSize`

```ts
type ViewportSize = { id: string; label: string; width: number };
```

Named preview widths offered by the full view's viewport control.

## Exports from `@designbookapp/designbook/config`

Alongside `defineConfig`, the module exports `useDataset()` and the `TextAdapter` /
`TextClaim` / `TextNodeHit` types for [custom adapters](/adapters/custom/), plus the
framework-free theme-token and Figma helper types. All `DesignbookConfig` field types
(`ComponentSet`, `EntryOverride`, `Flow`, `I18nConfig`, `ThemeOption`, `ViewportSize`, …) are
exported as types.
