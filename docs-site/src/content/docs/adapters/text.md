---
title: Text & i18next
description: The canvas text tool, keyed i18next catalog editing, plurals and placeholders, and the source-literal fallback.
---

The canvas **text tool** attributes each rendered string back to its source of truth and
saves edits there. That mapping is pluggable: a **text adapter** claims a text node, provides
its display value and editor, and knows how to persist a change. Adapters run as an ordered
chain — the first to claim a node wins.

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
| `languages` | `LanguageOption[]` | Languages offered in the canvas settings bar. Defaults to the locales found in `resources`. |
| `defaultLocale` | `string` | Locale used at startup and as fallback. Default `"en-US"`. |
| `defaultNamespace` | `string` | Default i18next namespace. Defaults to the first namespace found in `resources`. |
| `localePath` | `string` | Where the text tool writes edits back, config-relative. `{locale}` and `{namespace}` are substituted. Default `"./locales/{locale}/{namespace}.json"`. |

## How keyed editing works

The i18next adapter owns a workbench-private i18next instance built from your `resources`. It
registers an invisible-marker post-processor so each rendered string carries its **key** back
to the text tool — so when you click a string, the tool knows exactly which catalog entry it
is, and shows a rich editor:

- **Live language switching** — a **Language** dimension in the settings bar; switching drives
  `i18next.changeLanguage`, and edits read and write the **currently viewed** locale, not the
  default.
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

This is why plain, un-internationalised strings are still editable on the canvas with no
`i18n` config at all — the fallback handles the unambiguous cases.

## Injected mode: sharing one react-i18next instance

In [injected mode](/getting-started/injected-mode/), the i18next adapter's marker attribution
depends on your components and the adapter's `I18nextProvider` resolving to the **same**
`i18next`/`react-i18next` module — that's what lets a rendered string carry its key back to the
text tool instead of reading as a plain, unattributed literal.

Two things make this work with no configuration on your part:

- `i18next` and `react-i18next` are externalized from the workbench bundle, so the adapter
  resolves to your app's own copy rather than shipping a second one.
- `designbookPlugin()` automatically adds `resolve.dedupe: ["react-i18next", "i18next"]` to
  your Vite config (merged with any dedupe you already declare), so even a monorepo with more
  than one copy of these packages resolves to one shared instance. You don't need to add this
  dedupe yourself.

The only requirement on your side: `i18next` and `react-i18next` must be **resolvable
dependencies of the app**, not just of a library it happens to use internally.

:::note[Gotcha: strings show up as "hardcoded" with no error]
If `i18next`/`react-i18next` aren't resolvable dependencies of the app — or an unusual resolve
setup shadows them in a way the automatic dedupe can't reach — marker attribution silently
fails. The text tool then treats every live string as a plain hardcoded literal (routed to
"Prompt Pi" rather than inline editing), with no error anywhere. If in-place text editing shows
nothing editable on a screen you know is translated, check that both packages are direct,
resolvable dependencies of the app.
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
