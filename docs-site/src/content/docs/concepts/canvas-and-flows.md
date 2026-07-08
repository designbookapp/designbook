---
title: Canvas & flows
description: The infinite canvas of component sets, and flows that arrange screens into user journeys.
---

The workbench is organised around an **infinite canvas**. Everything you register in your
config is laid out on it as live, hot-reloading React — the same rendering path your app
uses. In [injected mode](/getting-started/injected-mode/) that's your app's own dev server;
in host mode it's Designbook's embedded Vite.

## The canvas

Your [component sets](/concepts/component-sets/) are grouped Storybook-style. Each set's
`title` is `/`-delimited, so `"Shop/Product"` and `"Shop/Search"` nest under a shared
**Shop** folder in the sidebar. Within a set, every key in `components` is an entry you can
pan to, zoom into, and select.

The canvas toolbar carries the controls that adapters and datasets contribute:

- **Datasets** — switch the sample-data bundle fed to set wrappers via `useDataset()`.
- **Context dimensions** — selectors contributed by adapters, e.g. light/dark mode, theme
  variant, tenant, and language. See [Adapters](/adapters/overview/).

Adapter selections are namespaced and persisted to `localStorage`, so a reload restores the
mode, tenant, and language you were viewing.

## Flows

Where sets show components in isolation, **flows** arrange *screens* into a user journey —
useful for reviewing an end-to-end path like a booking or checkout funnel. Add them with the
`flows` field:

```tsx
flows: [
  {
    id: "booking",
    title: "Shop/Booking funnel",
    screens: [
      {
        id: "search-results",
        label: "Search results",
        description: "Trip search results with filters.",
        registryId: "search.ResultsList",
      },
      {
        id: "checkout",
        label: "Checkout",
        description: "Traveller details and payment.",
        wireframeKind: "form",
        wireframeStrings: ["Traveller details", "Payment", "Confirm"],
      },
    ],
  },
],
```

Each screen renders one of two ways:

- **A real component** — set `registryId` to `"setId.ComponentKey"` (for example
  `"search.ResultsList"`) and the flow renders the actual registered component.
- **A wireframe** — set `wireframeKind` (`"hero" | "list" | "cards" | "form" | "summary" |
  "bar"`) and optional `wireframeStrings` to sketch a screen you haven't built yet, so the
  journey is complete even where the UI isn't.

A screen may also carry `previews` — an ordered list of alternative renderings (a wireframe
plus the real component, say) to show side by side. See the
[flows reference](/config/flows/) for the full screen shape.
