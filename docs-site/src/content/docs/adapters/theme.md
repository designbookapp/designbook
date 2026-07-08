---
title: Theme adapter
description: Edit design tokens from your CSS or JSON — light/dark modes, preset variants, and Figma variable sync.
---

The **theme adapter** teaches the canvas to read and edit your design tokens — colours,
dimensions, numbers — straight from your app's stylesheet (or a JSON tokens object). It
contributes a **mode** dimension (light/dark, …), a **Theme** tab of editable token fields,
and drives the canvas light/dark preview. Edits are optimistic (the canvas recolours
immediately) and persist to your source, rolling back on failure.

Import it from `@designbookapp/designbook/adapters`:

```tsx
import { themeAdapter } from "@designbookapp/designbook/adapters";

adapters: [
  themeAdapter({
    source: "./src/index.css",
    modes: { light: ":root", dark: ".dark" },
  }),
],
```

## Options

| Option | Type | Description |
| --- | --- | --- |
| `source` | `string \| Record<string, unknown>` | The token source of truth. Either a config-relative `.css` path whose per-mode selector blocks are parsed, or a mode-keyed JSON tokens object (`{ light: { primary: "…" }, dark: {} }`). |
| `modes` | `Record<string, string>` | CSS: mode name → the selector whose block holds that mode's vars. JSON: mode name → the object key. Default `{ light: ":root", dark: ".dark" }`. |
| `sourcePath` | `string` | Config-relative `.json` write target, when `source` is a JSON object. |
| `variants` | object | Editable preset variants layered over the base source (see below). |
| `tokens` | `Record<string, { type? }>` | Per-token control-type overrides, keyed by token name. |
| `id` | `string` | Adapter name + dimension namespace. Default `"theme"`. |
| `label` | `string` | Tab label. Default `"Theme"`. |
| `icon` | `string` | Tab/side-rail icon name. Default `"palette"`. |
| `figma` | object | Figma variable sync (see below). |

### CSS vs. JSON source

- **CSS** (`source: "./src/index.css"`): each mode's tokens are read from that mode's selector
  block (`:root`, `.dark`). Edits write back through `POST /api/style` — a surgical property
  edit in the stylesheet.
- **JSON** (`source: { light: {...}, dark: {...} }` or a glob): tokens come from the object;
  set `sourcePath` to the `.json` write target. Edits write back through `POST /api/json` — a
  surgical one-field write.

The control type per token is inferred (colour / number / text) and can be overridden with
`tokens`.

## Variants

Variants are **editable preset themes** layered over the base `source` as sparse per-mode
token overrides. Each variant becomes a value of a `variant` context dimension (the canvas
"Theme" selector); the Theme tab shows and edits the **active** variant, resolving each token
to its override or the base value. The base is the built-in `"default"` variant.

```tsx
themeAdapter({
  source: "./src/index.css",
  modes: { light: ":root", dark: ".dark" },
  variants: {
    source: import.meta.glob("./src/themes.json", { eager: true, import: "default" }),
    sourcePath: "./src/themes.json",
    labels: { forest: "Forest", sunset: "Sunset" },
  },
}),
```

| `variants` field | Type | Description |
| --- | --- | --- |
| `source` | `string \| Record<string, unknown>` | The overrides source: a writable JSON `{ variant: { mode: { token: value } } }`. Either an `import.meta.glob` result / object, or a config-relative `.json` path. |
| `sourcePath` | `string` | Config-relative `.json` write target. Required when `source` is a glob/object; defaults to `source` when it's a path string. |
| `labels` | `Record<string, string>` | Variant key → display label. Missing keys are capitalized. |
| `defaultLabel` | `string` | Label for the built-in base variant. Default `"Default"`. |

Editing a token while a non-default variant is active writes a **sparse override** into the
variants JSON; editing under `"default"` writes the base source. Omit `variants` to keep the
adapter single-variant.

## Figma variable sync

Set `figma` to add **Sync to Figma** / **Sync from Figma** actions to the Theme tab, enabled
only while the [Figma plugin](/figma/) is connected. "Sync to Figma" pushes the active
variant's tokens to a Figma variable collection; "Sync from Figma" pulls matching variable
values back into your theme source.

```tsx
figma: {
  collection: "designbook/theme",   // target collection name (default)
  nameRule: (token) => token,       // token name → Figma variable name (default identity)
  nameMapFile: "./tokens.map.json", // repo-relative JSON { tokenName: figmaName }; overrides win
},
```

Token ↔ variable naming is `nameRule` (default identity), overlaid by the optional
`nameMapFile`. On non-enterprise Figma plans that limit a collection to one mode, extra modes
are reported as skipped in the sync result. See [Figma integration](/figma/) for the plugin
and connection.
