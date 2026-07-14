---
title: Next.js
description: Component-level rendering of Next.js components via shims — and what isn't supported yet.
---

Designbook can render components from a Next.js repo at the **component level**, but it does
not run the Next.js framework.

:::note[Next.js uses host mode]
[Injected mode](/getting-started/injected-mode/) needs a Vite dev server to inject into, and
Next.js apps don't have one. So Next.js repos run in [host mode](/getting-started/install-and-run/#host-mode-no-runnable-app)
(`designbook [config]`), where Designbook's embedded Vite renders your components with the shims
below.
:::

## What works: shims

When your repo depends on `next`, Designbook auto-aliases the Next imports your components
reach for to inert stubs, so they render outside a Next runtime:

- `next/link` → a plain `<a>`
- `next/image` → a plain `<img>`
- `next/navigation` → no-op router hooks
- `next/dynamic` → a pass-through

It also defines `process.env` (so Next client modules that read `process.env.NEXT_PUBLIC_*` at
module scope don't throw). A [sidecar](/repo/compat/#the-designbookvite-sidecar) or repo alias
for any of those ids overrides the shim if you need real behavior.

With the shims in place, a typical presentational Next component — one that imports `next/link`
or `next/image` and renders markup — shows up in designbook like any other component.

## What isn't supported yet

:::caution[Component-level only]
Designbook renders Next.js components; it does **not** run Next.js. Full framework support is
not yet available.
:::

Because there's no Next runtime, anything that depends on the framework rather than just
rendering markup won't work as it does in production — Server Components' server-side data
fetching, App Router request context, `next/font` optimization, middleware, and route
handlers. Components that rely on real routing or server data need mock data or a
[wrapper](/concepts/component-sets/) that provides it, the same as any component with external
dependencies.
