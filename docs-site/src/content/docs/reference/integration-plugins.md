---
title: Integration plugins (experimental)
description: The public seam behind Designbook's tool integrations — how the built-in Figma integration is registered, how to configure or disable it, and the shape a future third-party integration will implement.
---

:::caution[Experimental]
The integration-plugin API (`@designbookapp/designbook/integration`) is **experimental**.
The built-in Figma integration runs on it, but the shapes below may change in a minor
release while the seam settles. External-package integrations are not loadable yet — today
the API describes how built-ins are wired, and pins the contract they'll share.
:::

An **integration** connects Designbook to an external design/dev tool. The built-in one is
[Figma](/figma/): its push/pull REST routes, WebSocket bridge to the Figma plugin, Pi agent
tools, the `figma-pull` skill, a Props-panel section, and a selection-context contribution all
register through this seam — core Designbook contains no Figma-specific code paths.

## Configuring integrations

Built-in integrations are **on by default**; most configs never need an `integrations` key.
Use it to disable one or pass options:

```tsx
export default defineConfig({
  // …
  integrations: {
    // Disable the built-in Figma integration entirely
    // (routes, bridge, agent tools, skill, props-panel section, selection context):
    figma: false,
  },
});
```

```tsx
export default defineConfig({
  // …
  integrations: {
    figma: {
      // Theme-token ↔ Figma-variable sync options:
      tokens: {
        collection: "designbook/theme",
        nameRule: (token) => `brand/${token}`,
        nameMapFile: "./figma-names.json",
      },
    },
  },
});
```

Keep boolean toggles **literal** (`figma: false`, not a computed expression): the node server
never evaluates your config file — it honors the toggle via a literal source scan, while the
workbench UI evaluates the real value.

## The plugin shape

One integration, one name, two halves:

```ts
import type {
  IntegrationPlugin,
  PluginNodeSpec,   // server half
  PluginUiSpec,     // browser half (lazy)
  PluginScreenProps,
  TokenSource,
} from "@designbookapp/designbook/integration";

const myIntegration: IntegrationPlugin = {
  name: "mytool",
  ui: async () => uiSpec,   // props-panel section(s) + selection context (below)
  node: nodeSpec,           // routes, device bridge, Pi tools, skills, events
};
```

- **`PluginNodeSpec.routes`** — REST routes served same-origin-gated at
  `/api/x/<name>/…`. Routes marked `write: true` are blocked automatically under
  `--read-only`. Integrations **cannot** declare cross-origin exemptions; the only
  cross-origin route is core's `GET /api/hello` discovery probe (`{ app, version, port }`),
  which is how a tool running from an opaque origin finds the Designbook server.
- **`PluginNodeSpec.bridge`** — requests a core-owned **device bridge**: a WebSocket relay
  at `/api/bridge/<name>` for tools that can't listen on a socket themselves (the Figma
  plugin's UI iframe connects outbound to it). Handed to routes/tools/events as `ctx.bridge`.
  This is the only WebSocket surface integrations get.
- **`PluginNodeSpec.piTools` / `skillsDir`** — tools and packaged Agent Skills contributed
  to the embedded Pi session.
- **`PluginUiSpec.propsSections`** — an integration's real surface today: sections a
  plugin appends to the end of the right panel's **Props** tab for the current selection,
  rendered collapsible in `order` then `id` order. This is where the Figma integration
  actually lives now — a "sync" section with push/pull/status for the selected component.
- **`PluginUiSpec.selectionContext`** — a contributor that adds facts (and, on send, a
  prompt snippet) to the selection context surfaced alongside the Props/Code panels and
  drafted chat prompts. Figma uses this to report plugin connection status.
- **`PluginUiSpec.serializeEntry`** — serializes a rendered entry's DOM subtree into the
  integration's transfer format; the Figma push flow reads this to build what it sends.
- **`PluginUiSpec.tab`** — a left-rail tab, `Screen` typed against `PluginScreenProps`
  (`apiUrl()`, `openChat()`, the open entry, `tokenSources`). Still part of the type
  contract, and the built-in Figma integration still declares one — but **full view's
  current UI does not render integration tabs**. The left rail is fixed to
  Chat/Changes/Tokens/Flags; `getIntegrationTabs()` resolves a tab list from the enabled
  integrations, but nothing in full view calls it today. Treat `tab` as reserved for a
  future mount point, not a working extension point right now — build against
  `propsSections`/`selectionContext` instead.
- **`TokenSource`** — theme adapters publish neutral token facts (names, per-mode values,
  CSS vars); integrations map them to their own tool's naming. This is how the Figma
  variable sync works without the theme adapter knowing about Figma.

## What's not here yet

Auto-discovery of third-party integration packages (a `package.json` marker) is planned but
not built; today only the built-in Figma integration registers. If you want to build an
integration, the types above are the contract to write against — expect breaking refinements
until this page loses its experimental banner.
