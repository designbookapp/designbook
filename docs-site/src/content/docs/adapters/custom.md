---
title: Custom adapters
description: The adapter runtime surface for writing your own adapter — experimental and unstable.
---

:::caution[Experimental]
The custom-adapter surface is **early and unstable**. The shipped adapters
([theme](/adapters/theme/), [text](/adapters/text/), [flags](/adapters/flags/)) are built on
it, so it exists and works — but the SDK for authoring your own is not yet frozen and may
change without notice. Prefer the shipped adapters where they fit.
:::

An adapter is a plain object the config lists in `adapters`. At minimum it has a `name`; from
there it can contribute a text claim, context dimensions, editable-field tabs, and a provider.

## Text adapters

The narrowest useful adapter is a **text adapter** — it participates in the canvas text tool's
claim chain. The `TextAdapter` interface is exported from `@designbookapp/designbook/config`:

```ts
type TextAdapter = {
  name: string;
  /** Runs once at boot; return locale plumbing if the adapter owns language state. */
  setup?(): Promise<{ Provider?; setLocale?; languages?; defaultLocale? } | void>;
  /** Claim a rendered text node (carry its own save), or return null to pass it on. */
  resolveText(hit: TextNodeHit): TextClaim | Promise<TextClaim | null> | null;
  /** Optional synchronous, side-effect-free hover preview. */
  previewText?(hit: TextNodeHit): TextClaim | null;
};
```

Adapters run as an ordered chain and the first non-null `resolveText` claim wins.
`previewText` must be synchronous and side-effect-free (it runs on hover). See `TextAdapter`,
`TextClaim`, and `TextNodeHit` in the exported types from `@designbookapp/designbook/config`.

Adapters are **browser code** — the config runs in the workbench — so they may touch the DOM
and `fetch` the Designbook API (the write-back endpoints like `/api/json`, `/api/style`,
`/api/i18n`, `/api/file`).

## The fuller adapter surface

Beyond claiming text, an adapter's `setup()` can return an `AdapterSetup` that contributes:

- **`dimensions`** — context selectors shown in the canvas settings bar. Each has an `id`,
  `label`, `options`, and `defaultValue`; ids are namespaced `"<adapter.name>:<id>"`
  automatically.
- **`tabs`** — side-rail tabs of editable fields. A tab's `fields(ctx)` returns fields
  (`control` of `color`/`number`/`text`/`toggle`/`select`) each with a `value` and a `save`
  callback; it may also expose `actions` (like the theme adapter's Figma sync).
- **`Provider`** — a component wrapped around the canvas preview, receiving `{ context,
  values, children }`.
- **`getValues(ctx)`** — resolves the adapter's per-context values (fed to the provider).
- **`onContextChange(id, value, context)`** — called when one of the adapter's dimensions
  changes.

The runtime aggregates every adapter's contributions into the canvas: context is a flat map of
namespaced id → value, persisted to `localStorage`; `notifyValuesChanged()` re-renders after
an optimistic field edit. This is exactly how the [theme](/adapters/theme/) and
[flags](/adapters/flags/) adapters work — read their source as reference implementations.

### Scope your `Provider` through context, not the DOM

A `Provider` mounts inside the workbench's shadow root, but canvas cells render as slotted
light DOM — React context crosses that boundary fine, but a wrapper `data-*` attribute plus
descendant CSS does not, because the light DOM elements aren't CSS descendants of where they're
slotted. Feed values through context (a hook your cells call), not attributes your cells'
ancestor CSS depends on. See the [flags adapter's gotcha](/adapters/flags/#your-provider) for
the concrete failure mode and the `FlagScope` pattern that fixes it.

:::note
Because this surface is unstable, the safest pattern today is to model your adapter closely on
a shipped one and pin your `designbook` version.
:::
