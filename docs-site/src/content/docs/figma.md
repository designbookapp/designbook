---
title: Figma integration
description: Install the plugin, connect the bridge, sync tokens as variables, push components to Figma, and pull designer edits back as a declarative target for the agent to apply.
---

Designbook has a two-way Figma integration: sync design tokens with Figma variables, push
registered components into Figma as **native layers**, and pull designer edits back out as a
declarative target [chat](/concepts/agent/) applies to your source. The connection is a local
plugin + WebSocket bridge — no Figma REST API, no tokens to configure.

:::note[Local-only bridge, no authentication]
The connection between the Figma plugin and Designbook is local-only — the plugin talks to
your own machine over `localhost`, the same way the rest of designbook does — but the bridge
itself accepts any localhost connection with no credential check. Don't pair it with
[`--allow-lan`](/reference/security/#localhost-by-default-lan-mode-is-an-explicit-opt-in): a
LAN-exposed sidecar would let anyone on the network drive the bridge too.
:::

## Install the plugin

The plugin lives in the `designbook` package at `packages/designbook/figma-plugin/`. Build it
so its `dist/` output exists, then import it into Figma:

1. Build the plugin (run its `build.mjs` esbuild bundler with Node) — this produces
   `figma-plugin/dist/code.js` and `figma-plugin/dist/ui.html`.
2. In the Figma **desktop** app: **Plugins → Development → Import plugin from manifest…**
3. Select `packages/designbook/figma-plugin/manifest.json`.

The plugin shows up under your development plugins as **designbook sync**.

## Connect the bridge

Figma plugins can't listen on a socket, so the connection is **outbound from the plugin to
Designbook** — Designbook is the WebSocket server, the plugin is the client, and only one
plugin connects at a time.

1. Start Designbook on your repo (default port **8787**).
2. Run the plugin in Figma. Its UI probes `http://localhost:<port>/api/figma-hello` across
   the default port range, confirms it's talking to Designbook, and opens a WebSocket to
   `ws://localhost:<port>/api/figma-bridge`. It reconnects automatically if the connection
   drops.

Connection status and the push/pull actions live in the **Figma section** of the [Props
panel](/concepts/props-panel/) — a collapsible section at the bottom of the panel, shown when
you've selected a component the plugin can serialize and the integration is configured. Push/
pull are enabled only while the plugin is connected.

## Token ↔ variable sync

Designbook syncs the [theme adapter](/adapters/theme/)'s design tokens with a Figma **variable
collection** (default name `designbook/theme`):

- **Sync to Figma** creates/updates variables from your tokens — COLOR, FLOAT, and STRING
  types, with per-mode values (light/dark map to Figma modes).
- **Sync from Figma** reads variable values back and writes changed ones into your theme
  source through the adapter's normal write-back.

Token ↔ variable naming follows the Figma integration's `tokens.nameRule` /
`tokens.nameMapFile` options (see [Integration plugins](/reference/integration-plugins/)).
On Figma plans that limit a collection to one mode, extra modes are reported as skipped in
the result.

## Push components to Figma

Pushing a selected component serializes its rendered tree and builds **native Figma nodes** —
not a flat image:

- **Auto-layout frames** with gap/padding/alignment from the component's flexbox layout.
- **Text nodes** with resolved fonts.
- **Inline SVGs** and **image fills**.
- **Bound variables** — solid fills and numeric tokens (corner radius, item spacing) are bound
  to the matching theme variables, so the Figma layers stay linked to your tokens.
- **Components & instances** — a nested, [registered](/concepts/component-sets/) component
  becomes a Figma **component**, named after its registry id, with an **instance** at each
  occurrence, so repeated UI stays DRY in Figma too.
- **Content slots** — i18n-bound text is authored as a native Figma **Component Property**
  (falling back to a `#`-name layer-name convention where native properties aren't available),
  so pull can recover the binding either way.

The pushed root frame carries a small marker recording the component id, a schema version, and
the **render context** it was pushed with (locale, theme, mode, adapter dimensions), which
makes re-pushing **idempotent**: the plugin finds the previous frame and rebuilds it in place,
keeping node ids stable so existing instances and links keep working. Designbook also records a
small per-component marker (just a "last pushed" timestamp, under `.designbook/figma/`) so the
Props panel's Figma section can show whether a component has ever been pushed — this isn't a
diff baseline and nothing in the pull path depends on it.

## Pull designer edits back

Designers then edit in Figma. **Pull** reads the pushed frame back and converts it into
**annotated HTML** — a declarative *target* describing what the component should now render,
not code to paste. The annotations preserve the wiring the push encoded:

- `data-slot` / `data-slot-if` / `data-slot-swap` — prop-bound content, conditional slots, and
  swappable instance slots (the shown text is a sample of the current value, never hardcoded).
- `data-i18n` — translated text with its namespace + i18next key.
- `data-token-*` — CSS properties bound to design tokens.
- `data-component` — a nested registered component renders here (used, never inlined).
- `data-list` — repeated children rendered from an array.

There's no delta computed against a frozen baseline, no pull cursor, and nothing written to
committed git for the pull path itself — the annotated HTML **is** the target, every time.

Applying the target to code always goes **through the agent**, never as a mechanical file
write. A successful pull drafts the prompt — the component's source path, the render context
from the root marker, and the annotated HTML target — straight into the chat composer, and
**your send is the confirm gate**. [Chat](/concepts/agent/) then rewrites the component's
source so it renders that target, keeping the diff minimal and the prop/i18n/token wiring
intact — staged on the active conversation's [changeset](/concepts/changesets/) exactly like
any other chat-driven edit.

The reconciliation rules the agent follows (the annotation legend, "sample values and
translations are not design edits", minimal-diff guidance) ship inside the `designbook`
package as a `figma-pull` **Agent Skill**, loaded into every embedded Pi session
automatically — nothing to install.
