---
title: Adapters overview
description: What adapters are, the ordered chain, and how theme/text/flags plug into the full view.
---

**Adapters** are how designbook exposes each discipline's layer of your app as editable
controls in the [full view](/concepts/full-view/) — design tokens, translated copy, feature
flags — with every edit written back to its source of truth.
An adapter reads a source (your CSS, locale JSON, flag files), surfaces it as editable controls
scoped to the active context, and persists changes back to disk.

## What an adapter contributes

Adapters contribute up to three kinds of capability, all read + write over a source of truth
scoped by the active context:

- **Context dimensions** — selectors shown in the center's **top bar** (mode, variant, tenant,
  language). Selections are namespaced `"<adapter>:<id>"` and persisted to `localStorage`.
- **Editable-field tabs** — a tab in the left panel (Tokens, Flags, …) with editable fields
  (colour, number, text, toggle, select) that save on change.
- **A provider** — a component wrapped around the rest of the designbook chrome, fed the live
  context and the adapter's resolved values. It does **not** wrap your running app — see
  [Reaching your running app](#reaching-your-running-app) below.

There is also a **text chain**: adapters can claim a rendered text node for the text tool, first
claim wins. See [Text & i18next](/adapters/text/).

## Reaching your running app

The center of the full view is your **actual running app**, shown live in its own frame — not a
second render of your components inside designbook's own tree. That changes how a dimension
switch or a field edit actually reaches it:

- Editing a token, flag, or translation writes to your **real source file** (CSS, JSON) through
  the designbook API — the same file your app already reads. Your dev server's own hot reload
  picks the change up, exactly as if you'd hand-edited the file.
- Two dimensions get an extra, direct nudge into the frame, so they don't wait on a file-watcher
  round trip: switching the theme adapter's **mode** dimension toggles a `dark` class straight
  on the frame's document, and switching a **locale** dimension best-effort calls
  `changeLanguage` on the frame's own i18next instance (if one is reachable — see
  [Text & i18next](/adapters/text/)).
- Every other dimension — a flags adapter's **tenant** picker, say — relies entirely on the file
  write above plus your app's own hot reload. There's no extra live mirroring for it.

The `Provider` a `setup()` returns is wrapped around the designbook chrome (panels, tabs, the
top bar), not around your app — your app always renders live in its own frame, a separate
document a chrome-side React tree can't reach into. The shipped i18next and flags adapters still
return a `Provider` for internal/back-compat reasons, but it isn't what makes an edit show up in
your running app; the file write + hot reload above is.

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
| `i18nextAdapter` | Keyed i18next catalog editing for the text tool. Turned on by the `i18n` config field. | [Text & i18next](/adapters/text/) |
| `flagsAdapter` | Edit per-tenant feature flag values from JSON. | [Flags](/adapters/flags/) |
| `sourceLiteralAdapter` | Built-in fallback that edits a plain string literal in its `.tsx` source. Always appended. | [Text & i18next](/adapters/text/#the-source-literal-fallback) |

Adapters are browser code — your config runs in the browser, as part of designbook — so they
can touch the DOM and `fetch` the designbook API. You can also write your own; see
[Custom adapters](/adapters/custom/).

The i18next adapter attributes a rendered string back to its source without any module-sharing
on your part — see [Text & i18next](/adapters/text/#marker-attribution) for how that works in
your running app's frame.
