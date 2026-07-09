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
[Figma](/figma/): its left-rail tab, push/pull REST routes, WebSocket bridge to the Figma
plugin, Pi agent tools, and the `figma-pull` skill all register through this seam — core
Designbook contains no Figma-specific code paths.

## Configuring integrations

Built-in integrations are **on by default**; most configs never need an `integrations` key.
Use it to disable one or pass options:

```tsx
export default defineConfig({
  // …
  integrations: {
    // Disable the built-in Figma integration entirely
    // (tab, routes, bridge, agent tools, skill):
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
  ui: async () => uiSpec,   // left-rail tab + optional canvas serializer
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
- **`PluginUiSpec.tab`** — a left-rail tab. Its Screen receives `PluginScreenProps`: the
  open canvas entry, `apiUrl()` resolution, `openChat()` (drafts a prompt into the chat tab;
  the user's send click is the confirm gate), and the neutral `tokenSources` registry.
- **`TokenSource`** — theme adapters publish neutral token facts (names, per-mode values,
  CSS vars); integrations map them to their own tool's naming. This is how the Figma
  variable sync works without the theme adapter knowing about Figma.

## What's not here yet

Auto-discovery of third-party integration packages (a `package.json` marker) is planned but
not built; today only the built-in Figma integration registers. If you want to build an
integration, the types above are the contract to write against — expect breaking refinements
until this page loses its experimental banner.
