---
title: Figma integration
description: Install the plugin, connect the bridge, sync tokens as variables, push components to Figma, and pull designer edits back for the agent to apply.
---

Designbook has a two-way Figma integration: sync design tokens with Figma variables, push
registered components into Figma as **native layers**, and pull designer edits back out as a
declarative target the [Pi agent](/concepts/agent/) applies to your source. The connection is
a local plugin + WebSocket bridge — no Figma REST API, no tokens to configure.

:::note[Local-only bridge, no authentication]
The connection between the Figma plugin and Designbook is local-only — the plugin talks to
your own machine over `localhost`, the same way the rest of the workbench does — but the
bridge itself accepts any localhost connection with no credential check. Don't pair it with
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

The workbench shows connection status on the Figma tab (backed by
`GET /api/x/figma/status`). Actions that need the plugin — variable sync, component
push/pull — are enabled only while it's connected.

## Token ↔ variable sync

The Figma tab syncs the [theme adapter](/adapters/theme/)'s design tokens with a Figma
**variable collection** (default name `designbook/theme`):

- **Sync to Figma** creates/updates variables from your tokens — COLOR, FLOAT, and STRING
  types, with per-mode values (light/dark map to Figma modes).
- **Sync from Figma** reads variable values back and writes changed ones into your theme
  source through the adapter's normal write-back.

Token ↔ variable naming follows the Figma integration's `tokens.nameRule` /
`tokens.nameMapFile` options (see [Integration plugins](/reference/integration-plugins/)).
On Figma plans that limit a collection to one mode, extra modes are reported as skipped in
the result.

## Push components to Figma

Pushing a registered component serializes its rendered tree and builds **native Figma nodes** —
not a flat image:

- **Auto-layout frames** with gap/padding/alignment from the component's flexbox layout.
- **Text nodes** with resolved fonts.
- **Inline SVGs** and **image fills**.
- **Bound variables** — solid fills and numeric tokens (corner radius, item spacing) are bound
  to the matching theme variables, so the Figma layers stay linked to your tokens.
- **Components & instances** — nested registered components become a Figma **component** (parked
  in a "designbook / components" section) with an **instance** at each occurrence, so repeated
  UI stays DRY in Figma too. Per-occurrence text overrides ride along on the instances.
- **Slots** arrive pre-inlined as plain diffable frames.

The pushed root frame carries a Designbook marker recording the component id and the **render
context** it was pushed with (locale, theme, mode, adapter dimensions), which makes re-pushing
**idempotent**: the plugin finds the previous frame and rebuilds it in place, keeping node ids
stable so existing instances and links keep working. Everything else the pull needs — i18n
keys, slot bindings, nested-component identity — rides along in layer-name conventions rather
than hidden per-node metadata, so what you see in the Figma layer list is the whole contract.

## Pull designer edits back

Designers then edit in Figma. **Pull from Figma** reads the pushed frame back and converts it
into **annotated HTML** — a declarative *target* describing what the component should now
render, not code to paste. The annotations preserve the wiring the push encoded:

- `data-slot` / `data-slot-if` / `data-slot-swap` — prop-bound content, conditional slots, and
  swappable instance slots (the shown text is a sample of the current value, never hardcoded).
- `data-i18n` — translated text with its namespace + i18next key.
- `data-token-*` — CSS properties bound to design tokens.
- `data-component` — a nested registered component renders here (used, never inlined).
- `data-list` — repeated children rendered from an array.

Applying the target to code always goes **through the agent**, never as a mechanical file
write. A successful pull drafts the prompt — the component's source path, the render context
from the root marker, and the annotated HTML target — straight into the chat input, and **your
send is the confirm gate**. The [Pi agent](/concepts/agent/) then rewrites the component's
source so it renders that target, keeping the diff minimal and the prop/i18n/token wiring
intact.

The reconciliation rules the agent follows (the annotation legend, "sample values and
translations are not design edits", minimal-diff guidance) ship inside the `designbook`
package as a `figma-pull` **Agent Skill**, loaded into every embedded Pi session
automatically — nothing to install, and no sync-state or baseline files to commit to your
repo.
