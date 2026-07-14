---
title: Text & i18next
description: The text tool, keyed i18next catalog editing, plurals and placeholders, and the source-literal fallback.
---

The **text tool** (the footer tool picker's "Edit text", next to Select) attributes each
rendered string in your running app back to its source of truth and saves edits there. That
mapping is pluggable: a **text adapter** claims a text node, provides its display value and
editor, and knows how to persist a change. Adapters run as an ordered chain — the first to
claim a node wins.

Two text adapters ship in `@designbookapp/designbook/adapters`:

- **`i18nextAdapter(i18n)`** — keyed i18next catalog editing. This is what the `i18n` config
  field turns on.
- **`sourceLiteralAdapter()`** — a built-in fallback that edits a plain string literal
  directly in its `.tsx` source. Always appended last.

## The `i18n` config field

Setting `i18n` is sugar: an `i18nextAdapter(i18n)` is prepended automatically when no i18next
adapter is listed, and `sourceLiteralAdapter()` is always appended. So the default text
experience needs no `adapters` field:

```tsx
i18n: {
  resources: import.meta.glob("./locales/*/app.json", { eager: true, import: "default" }),
  languages: [
    { id: "en-US", label: "EN" },
    { id: "fr-FR", label: "FR" },
    { id: "es-419", label: "ES" },
  ],
  defaultLocale: "en-US",
  defaultNamespace: "app",
  localePath: "./locales/{locale}/{namespace}.json",
},
```

### `I18nConfig` fields

| Field | Type | Description |
| --- | --- | --- |
| `resources` | `Record<string, unknown>` | `import.meta.glob` over locale JSON, **eager**, `import: "default"`. Keys must match `…locales/<locale>/<namespace>.json`. |
| `languages` | `LanguageOption[]` | Languages offered in the top bar's language picker. Defaults to the locales found in `resources`. |
| `defaultLocale` | `string` | Locale used at startup and as fallback. Default `"en-US"`. |
| `defaultNamespace` | `string` | Default i18next namespace. Defaults to the first namespace found in `resources`. |
| `localePath` | `string` | Where the text tool writes edits back, config-relative. `{locale}` and `{namespace}` are substituted. Default `"./locales/{locale}/{namespace}.json"`. |

## How keyed editing works

The i18next adapter owns its own i18next instance, built from your `resources` and used to
drive the rich editor (templates, plurals, placeholder metadata) — separate from whatever
i18next instance your running app renders through. Marker attribution — how a rendered string
carries its **key** back to the text tool — works differently; see
[Marker attribution](#marker-attribution) below.

- **Live language switching** — a **Language** dimension in the top bar; switching drives
  `i18next.changeLanguage` on the adapter's instance and best-effort mirrors it into your
  running app's own instance (see [Reaching your running
  app](/adapters/overview/#reaching-your-running-app)); edits read and write the **currently
  viewed** locale, not the default.
- **Plurals** — when a key has plural forms (`_zero`, `_one`, `_two`, `_few`, `_many`,
  `_other`), the editor shows every form together.
- **Placeholders** — interpolation placeholders are surfaced with their example/description
  metadata (authored under an `@<key>` entry), so translators see what each `{{name}}` means.

### Per-locale write-back

Edits persist through `POST /api/i18n`, writing to the path from `localePath` with `{locale}`
resolved to the **currently viewed** locale — so translating while viewing `fr-FR` writes the
French catalog, not English. Writes are optimistic and roll back on failure.

### Non-standard locale layouts

If your locale files don't match the default `…locales/<locale>/<namespace>.json` shape, call
`i18nextAdapter` yourself and pass `parseResourceKey` — a function mapping an
`import.meta.glob` key to `{ locale, namespace }` (return `null` to skip a file):

```tsx
import { i18nextAdapter } from "@designbookapp/designbook/adapters";

adapters: [
  i18nextAdapter(i18nConfig, {
    parseResourceKey: (key) => /* { locale, namespace } | null */,
  }),
],
```

## The source-literal fallback

`sourceLiteralAdapter()` is always appended last, so it catches strings no keyed adapter
claimed. It edits a **plain string literal directly in its `.tsx` source** — but only when the
rendered text matches exactly one literal in the owning component's file. Ambiguous matches
(the same text appears more than once, or is computed) fall through to a "hardcoded string"
callout rather than risk editing the wrong one.

This is why plain, un-internationalised strings are still editable in your running app with no
`i18n` config at all — the fallback handles the unambiguous cases.

## Marker attribution

Your app renders live inside its own frame — a separate document designbook's own React tree
can't reach into — so attributing a rendered string back to its i18next key can't rely on a
shared React context or a shared module instance. Instead, `designbookPlugin()` rewrites your
app's own source at dev-server transform time: a call whose callee is a bare `t`, a
non-computed `.t` member (`i18n.t(...)`), or a non-computed `._` member (Lingui's compiled
`t`/`msg` macros) gets wrapped so its resolved string carries an invisible marker back to
designbook. This needs **no configuration** and does not depend on your app sharing an
i18next/react-i18next instance with designbook — it works whether your app renders through its
own instance, a copy that happens to be shared, or Lingui.

:::note[Gotcha: strings show up as "hardcoded" with no error]
The rewrite is a syntactic match on the call site, not a runtime check — so a translation
function that isn't named `t` (or called as `i18n.t(...)` / `i18n._(...)`) won't be recognized,
and the text tool falls back to treating that string as a plain hardcoded literal (routed to
"Prompt Pi" rather than inline/keyed editing), with no error anywhere. If in-place text editing
shows nothing editable on a screen you know is translated, check that the call site matches one
of those three shapes.
:::

## Explicit ordering

List adapters explicitly to add your own or control ordering. The example below tries a custom
catalog adapter first, then keyed i18next, then the plain-literal fallback:

```tsx
import { i18nextAdapter, sourceLiteralAdapter } from "@designbookapp/designbook/adapters";

adapters: [
  myCatalogAdapter(),
  i18nextAdapter({ resources /* … */ }),
  sourceLiteralAdapter(),
],
```
