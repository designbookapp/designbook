---
title: Adapters overview
description: What adapters are, the ordered chain, and how theme/text/flags plug into the canvas.
---

**Adapters** are how Designbook exposes each discipline's layer of the app as editable
controls on the canvas — design tokens, translated copy, feature flags — with every edit
written back to its source of truth.
An adapter reads a source (your CSS, locale JSON, flag files), surfaces it as editable canvas
controls scoped to the active context, and persists changes back to disk.

## What an adapter contributes

Adapters contribute up to three kinds of capability, all read + write over a source of truth
scoped by the active context:

- **Context dimensions** — selectors shown in the canvas settings bar (mode, variant, tenant,
  language). Selections are namespaced `"<adapter>:<id>"` and persisted to `localStorage`.
- **Editable-field tabs** — a tab in the side rail with editable fields (colour, number,
  text, toggle, select) that save on change.
- **A provider** — wrapped around the canvas preview, fed the live context and the adapter's
  resolved values (this is how the flags adapter feeds the active tenant to your provider).

There is also a **text chain**: adapters can claim a rendered text node for the canvas text
tool, first claim wins. See [Text & i18next](/adapters/text/).

## The adapter chain

Adapters run as an ordered chain. The order is:

1. An `i18nextAdapter(config.i18n)` is **prepended** when your config sets `i18n` and doesn't
   already list an i18next adapter.
2. Then your config's own `adapters`, in order.
3. Then a built-in `sourceLiteralAdapter` fallback is **always appended last**.

So the common case needs no `adapters` field at all — set `i18n`, and text editing works.
List adapters explicitly to add the theme/flags adapters, plug in your own, or control
ordering:

```tsx
import { defineConfig } from "@designbookapp/designbook/config";
import { themeAdapter, flagsAdapter } from "@designbookapp/designbook/adapters";

export default defineConfig({
  // ...sets, providers...
  adapters: [
    themeAdapter({ /* ... */ }),
    flagsAdapter({ /* ... */ }),
  ],
});
```

## The shipped adapters

Import these from `@designbookapp/designbook/adapters`:

| Adapter | Purpose | Page |
| --- | --- | --- |
| `themeAdapter` | Edit design tokens (colour/dimension/number) from your stylesheet or JSON, with light/dark modes and preset variants. | [Theme](/adapters/theme/) |
| `i18nextAdapter` | Keyed i18next catalog editing for the canvas text tool. Turned on by the `i18n` config field. | [Text & i18next](/adapters/text/) |
| `flagsAdapter` | Edit per-tenant feature flag values from JSON. | [Flags](/adapters/flags/) |
| `sourceLiteralAdapter` | Built-in fallback that edits a plain string literal in its `.tsx` source. Always appended. | [Text & i18next](/adapters/text/#the-source-literal-fallback) |

Adapters are browser code — the config runs in the workbench — so they can touch the DOM and
`fetch` the Designbook API. You can also write your own; see
[Custom adapters](/adapters/custom/).

In [injected mode](/getting-started/injected-mode/), an adapter that needs to share a module
instance with your app (the i18next adapter is the shipped example) depends on that module
being a resolvable, deduped dependency of the app — see
[Text & i18next](/adapters/text/#injected-mode-sharing-one-react-i18next-instance) for what's
automatic and what isn't.
