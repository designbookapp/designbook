# Set up adapters: theming, i18n, tenant config

Audience: a coding agent adding adapters to an existing designbook install.
Prereq: designbook ≥ 0.2.0 (fromGlob + hostContext need it), workbench already
boots per client-setup.md.

Adapters add three things to the workbench: **context dimensions** (the
selectors in the canvas top bar — locale, theme, tenant…), **tabs** (editable
panels in the side rail), and **providers** (wrapped around every canvas cell).
They are declared in the designbook config's `adapters` array; imports come
from `@designbookapp/designbook/adapters`. All `source`/`sourcePath` paths are relative to the
config file.

```tsx
import { defineConfig } from "@designbookapp/designbook/config";
import { themeAdapter, flagsAdapter } from "@designbookapp/designbook/adapters";
```

## 1. Theming — `themeAdapter`

Gives a Theme tab (token editor writing back to your source of truth) and, with
`variants`, a theme selector dimension on the canvas.

```tsx
themeAdapter({
  // CSS form: a stylesheet whose SELECTOR BLOCKS hold the tokens per mode.
  source: "./src/index.css",
  modes: { light: ":root", dark: ".dark" },   // mode → selector (defaults shown)

  // Optional preset variants layered over the base as sparse overrides:
  variants: {
    source: import.meta.glob("./src/themes.json", { eager: true, import: "default" }),
    sourcePath: "./src/themes.json",          // write target
    labels: { forest: "Forest", sunset: "Sunset" },
  },
}),
```

- **JSON form**: `source: { light: { primary: "#…" }, dark: { … } }` +
  `sourcePath: "./tokens.json"` when tokens aren't in CSS selector blocks.
- **Tailwind v4 caveat**: the CSS parser reads *selector* blocks. If your
  tokens live ONLY inside `@theme { … }`, point `source` at a file where they
  also appear under `:root`/`.dark` (common in practice — TW4 emits them on
  `:root`), or use the JSON form. Verify by checking the Theme tab lists your
  tokens.
- Edits write through the sidecar to the real file; the canvas updates without
  reloading the app (HMR suppression handles it).

## 2. i18n — the `i18n` config field (i18next) or `linguiAdapter`

If the app uses **react-i18next**, don't add an adapter explicitly — set the
top-level `i18n` field (it auto-installs the i18next adapter):

```tsx
i18n: {
  resources: import.meta.glob("./locales/*/app.json", { eager: true, import: "default" }),
  languages: [
    { id: "en-US", label: "EN" },
    { id: "fr-FR", label: "FR" },
  ],
  defaultLocale: "en-US",
  defaultNamespace: "app",
  localePath: "./locales/{locale}/{namespace}.json",   // write target for text edits
},
```

This gives: a locale dimension on the canvas, and the **text tool** — click any
rendered string, edit it, and the change writes to the right key in the right
locale file (placeholders and plurals get a structured editor).

- Non-standard file layout → `i18nextAdapter(i18nConfig, { parseResourceKey })`
  from `@designbookapp/designbook/adapters` with a custom glob-key → `{locale, namespace}`
  mapper.
- **Requirement**: components must read translations through react-i18next
  context (`useTranslation()`), not a module singleton — the adapter wraps the
  canvas in an instrumented `I18nextProvider` that adds invisible attribution
  markers to resolved strings, and the text tool reads those markers back.
  Apps with a singleton `t()` (no provider) need a small custom adapter
  instead; ask for the excalidraw reference pattern if you hit this.
- **Injected mode (≥ 0.2.2)**: the i18next adapter is usable in injected mode.
  `i18next` and `react-i18next` are externalized from the workbench bundle and
  declared as optional peers — so the adapter's `I18nextProvider` and your
  components' `useTranslation()` resolve to the **same** react-i18next module
  (your app's copy) and share one context. That is what lets the text tool
  attribute strings instead of reading them as "hardcoded". Two consequences:
  - `i18next` + `react-i18next` must be resolvable dependencies of the **app**
    (they are, if the app uses i18n) — the workbench no longer ships its own
    copy into injected apps. If they aren't resolvable, the adapter can't
    instrument them and every string reads as "hardcoded" (see the gotcha at
    the end of this section).
  - **Dedupe is automatic (≥ 0.2.4)**: `designbookPlugin()` injects
    `resolve.dedupe: ["react-i18next", "i18next"]` for you (merged additively
    with any dedupe you already declare). This means a monorepo with two
    `react-i18next` copies still shares one context — no hand configuration.
    It is a no-op for a no-i18n app (nothing to dedupe, and the sugar path is a
    dynamic, lazily-reached chunk that never loads these imports). You should
    not need to add the dedupe yourself; the line above documents what the
    plugin does, not a step you must take.

  > **Gotcha — "everything is hardcoded" with no hint.** Marker attribution
  > depends on the adapter's provider and your components resolving to the same
  > `react-i18next` module. The plugin now dedupes automatically, but if
  > `i18next`/`react-i18next` are missing from the app entirely (or shadowed by
  > an unusual resolve setup the dedupe can't reach), the text tool falls back
  > to treating live strings as hardcoded literals — routed to "Prompt Pi", not
  > inline edit — with no error. If in-place text editing shows nothing
  > editable on a known-translated screen, check that both packages are direct,
  > resolvable dependencies of the app.
- **Lingui** apps: use `linguiAdapter` from `@designbookapp/designbook/adapters` (writes `.po`
  catalogs). Same dimension + text-tool behavior. The Lingui adapter takes your
  live `@lingui/core` `I18n` instance as an argument, so it is dep-free and
  works in injected mode without any externalization.

## 3. Tenant config

Two levels, use what fits:

**a) `flagsAdapter`** — tenant selector dimension + a Flags tab of editable
per-tenant values + a provider feeding `{ tenant, flags }` to every cell:

```tsx
flagsAdapter({
  Provider: FlagsProvider,   // your component: ({ tenant, flags, children })
  // single file keyed by tenant, or a glob of <tenant>.json files:
  source: import.meta.glob("./src/flags/*.json", { eager: true, import: "default" }),
  sourcePath: "./src/flags/tenants.json",
  flags: {
    newCheckout: { label: "New checkout", control: "toggle" },
    density: { label: "Density", control: "select", options: ["comfortable", "compact"] },
  },
}),
```

Switching tenant re-renders every cell through your Provider with that
tenant's values; toggling a flag in the tab writes the JSON and updates live.

> **Gotcha — DOM-based scoping inside a Provider doesn't reach cell content.**
> Adapter Providers mount inside the workbench's **shadow root**; canvas cells
> are **slotted light DOM**. React context crosses that boundary fine (it's
> JS), so a Provider that feeds values through context — the pattern above —
> works everywhere. But a Provider that scopes via the **DOM** (sets a
> `data-*` attribute on a wrapper element, then relies on CSS like
> `[data-flag] .thing { … }`) will not affect cells: for slotted content the
> CSS ancestor is where the element is *defined* (the light DOM), not where
> it's slotted (under your shadow-root wrapper), so that wrapper is never an
> ancestor selector match. Same family as the CSS-custom-property forwarding
> issue.
>
> Fix: don't scope from a wrapper the cells aren't inside — re-emit the
> attribute **in the light DOM, inside the cell**. A tiny component that reads
> the context and mirrors it onto its own element does it:
>
> ```tsx
> function FlagScope({ children }: { children: ReactNode }) {
>   const { flags } = useFlags(); // your provider's context
>   return <div data-density={flags.density}>{children}</div>;
> }
> // render <FlagScope> at the root of each cell demo (or your variant wrapper)
> ```
>
> Prefer context-based scoping (a prop/className the cell reads) over
> attribute+descendant-CSS in the first place — it's boundary-agnostic. The
> runtime mirroring provider-set attributes onto cell containers automatically
> is on the backlog; until then, `FlagScope` is the pattern.

**b) Custom adapter** — when tenant config isn't flags (theme packs, feature
matrices, API-driven): an adapter is just
`{ name, setup?: () => ({ dimensions?, tabs?, Provider? }) }`. A dimension is
`{ id, label, options: [{value,label}], defaultValue }`; a tab lists
`EditableField`s (`{ id, label, control, value, save }` — `save` persists via
your own endpoint or the sidecar file API). Start from `flagsAdapter`'s shape;
keep `setup` fast (it runs at canvas boot).

## 4. Following the app's live state (injected mode) — `hostContext`

By default the canvas dimensions are workbench-owned. In injected mode you can
make a dimension **follow the running app** (badge shows "App · <value>"),
because the config compiles inside the app's build and can import its runtime:

```tsx
hostContext: {
  locale: { get: () => i18n.language },                      // key = dimension id
  tenant: {
    get: () => window.__APP_STATE__?.tenant,
    subscribe: (cb) => appStore.subscribe(cb),               // optional; else ~2s poll
  },
},
```

Explicit picks in the workbench still win; the "App · …" option at the top of
the selector returns to follow mode. Read-only: designbook never writes app
state through this. Host mode ignores `hostContext` entirely.

## 5. Providers (no adapter needed)

App-wide context your components assume (ThemeProvider, QueryClient, router
stubs) goes in the top-level `providers: [ThemeProvider, LanguageProvider]` —
wrapped around every cell, outside any adapter.

## Acceptance checklist

- [ ] Canvas top bar shows the new dimensions (locale / theme / tenant).
- [ ] Switching each dimension visibly re-renders cells.
- [ ] Theme tab lists real tokens; editing one updates cells AND the source file.
- [ ] Text tool (T) highlights i18n strings; an edit lands in the locale file
      for the ACTIVE locale; no app reload occurs.
- [ ] Flags tab edits write the tenant JSON; cells react.
- [ ] Injected mode + hostContext: dimension shows "App" badge and tracks the
      app; explicit pick overrides; App option returns to follow.

## Gotchas

- Globs feeding adapters must be `{ eager: true, import: "default" }`.
- `sourcePath` is the WRITE target and is config-relative; wrong path = silent
  no-op edits. Watch the sidecar log (`wrote json: …`) to confirm writes land.
- Text edits not appearing → the component isn't rendering through the
  adapter's provider (singleton i18n; see §2 requirement).
- Everything here works without `ANTHROPIC_API_KEY`; only the chat tab needs it.
