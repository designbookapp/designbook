---
title: Troubleshooting
description: Common issues — port conflicts, optimizer churn, empty renders, and missing styles.
---

## Port already in use

Designbook listens on **8787** by default. If that port is taken, `designbook` (host mode) and
`designbook dev` print a one-liner — `port 8787 in use — another designbook running? --port to
change` — and exit (no stack trace). Pass another:

```bash
designbook --port 8788
# or: DESIGNBOOK_PORT=8788 designbook
```

`designbook dev` also opens a **direct api port** at `--port` + 1; if that clashes it warns and
skips it (the proxy's `/__designbook/api` still works) — move it with `--api-port`.

[Branch instances](/branch-instances/) use deterministic ports in the 5300–5499 range,
separate from the main port.

## My app's `/api` returned designbook's response

Fixed in current versions: through the proxy, plain `/api/*` is forwarded to **your** app —
designbook serves its own api under `/__designbook/api/*` instead, so a same-origin `/api`
(health checks, data routes) is never shadowed. If you still see designbook answering your
`/api`, update designbook.

## Requests to `/api` get a 403 "Cross-origin request rejected"

Expected behavior, not a bug: designbook's own `/api/*` (and `/__designbook/api/*` in injected
mode) reject cross-origin requests by default — see
[Security & trust model](/reference/security/#same-origin-by-default). If you're hitting this
from your own tooling rather than a browser, make the request same-origin (no `Origin` header,
or one that matches the sidecar's own origin) rather than disabling the check.

## i18n text tool shows everything as "hardcoded"

Attribution doesn't depend on sharing an i18next/react-i18next instance with your app —
`designbookPlugin()` rewrites your app's own `t(...)` call sites at dev-transform time so their
resolved strings carry an invisible marker back to designbook, regardless of which instance
rendered them. The rewrite is a **syntactic** match on the call site (a bare `t`, `i18n.t(...)`,
or Lingui's `i18n._(...)`), not a runtime check, so it fails silently rather than erroring: a
translation call under a different name, or a shape it doesn't recognize, just falls back to
"hardcoded literal" (routed to chat rather than inline/keyed editing). If a screen you know is
translated shows nothing editable, check that its call sites match one of those three shapes.

See [Marker attribution](/adapters/text/#marker-attribution) for the full explanation.

## React deduplication (invalid hook call, context misses)

Your running app renders inside the full view's **own frame** — a separate module graph from
designbook's own chrome — so selection and the text tool never need a shared React instance
with your app; they walk fiber/DOM data that's readable regardless of which `react` copy
produced it. Where a shared instance still matters: **variant previews** (the cards a
[chat](/concepts/agent/) turn generates, and the [sandbox canvas](/concepts/changesets/)) render
your actual components directly inside designbook's own React tree, composed with a generated
wrapper. A monorepo with a nested or mismatched `react`/`react-dom` range there shows up as
"Invalid hook call" errors or a variant that silently fails to render.

Fix by adding both to `resolve.dedupe` in the app's **own** Vite config (the one
`vite.designbook.config.ts` wraps — dedupe has to apply before `designbookPlugin` is even in
the picture):

```ts
// vite.config.ts — the app's own config, not the designbook variant
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
});
```

If a workspace package pins an incompatible `react` range, align it with the app's before
retrying. (This is unrelated to the automatic `react-i18next`/`i18next` dedupe above.)

## Dependency-optimize churn after config edits {#dependency-optimize-churn}

After editing your config (adding components, changing globs), you may see Vite re-run its
dependency optimizer and full view reload a few times as it settles. If it seems stuck in a
reload loop, **restart the server** — a fresh start re-optimizes cleanly and cures it.

## Server-only imports kill the optimizer

`sourceModules` is an **eager** `import.meta.glob`, so every matched module is *executed* at
config load. If a matched file transitively pulls in **server-only** code, eager-executing it
can knock out Vite's dependency optimizer.

Fixes:

- **Scope your registrations and globs** to the components you actually register —
  don't glob your whole `src`. Narrow globs are the main defense.
- **Exclude the offending dependency** from optimization via a
  [sidecar](/repo/compat/#the-designbookvite-sidecar)'s `optimizeDeps.exclude`.
- Keep test/story files out of the glob (see below).

## Components render empty {#components-render-empty}

A component that renders as an empty box is almost always **missing context or props**. The
component needs a provider or data it isn't getting when designbook renders it.

Fixes:

- Give the set a [**wrapper**](/concepts/component-sets/) that provides the required context
  and reads sample data via `useDataset()`.
- Provide **sample props** through the wrapper, or register a small demo wrapper (and point the
  code panel at the real file with [`sourcePath`](/config/sets-and-overrides/#entryoverride)).
- Put app-wide providers (theme, i18n) in the top-level `providers` field so they wrap
  everything.

## Styles are missing

Designbook renders your **real** components but doesn't guess your global styles. If everything
looks unstyled:

- **Import your stylesheet in the config.** Add `import "./src/index.css";` (or whatever your
  app's entry imports) at the top of `designbook.config.tsx`.
- **Tailwind v3 tokens** — dedicated v3 semantic-token support is still in progress; see
  [Tailwind](/repo/tailwind/#tailwind-v3).
- **CSS-variable scoping** — if your styles depend on a scoping class that your app's root sets
  (for example a theme class), make sure whatever provides it is in `providers` or a wrapper so
  the rendered subtree gets it too. Design tokens declared on `:root` are forwarded into the
  shadow-DOM cells automatically — if they aren't applying, update designbook.
- **Workspace-lib utilities never generated (Tailwind).** If components from a workspace
  package render with the right classes in markup but no CSS, the host's Tailwind isn't
  *scanning* that package's source. In Tailwind v4, add an `@source` to the css entry that
  imports your theme, e.g. `@source "../../packages/ui/src";` (path relative to the css file),
  so v4 generates the utilities those components use.
- **Generated variants render unstyled (Tailwind).** Design variations, the sandbox, and
  changeset layers write generated files into `.designbook/variations/`, `.designbook/sandbox/`,
  and `.designbook/changesets/` respectively — none of these are `src`, so they can sit outside
  your Tailwind v4 source scope, and utilities only a generated file uses then emit no CSS (the
  variant/variation renders collapsed). This is handled **automatically in both host mode and
  injected mode** — a dev-time transform appends `@source` for all three directories to your
  Tailwind v4 entry css, so there's normally nothing to configure. If you still see it, the
  auto-detection likely isn't recognizing your entry css: it looks for a literal
  `@import "tailwindcss";`, so a differently-shaped import needs the three lines added by hand:
  `@source "./.designbook/variations"; @source "./.designbook/sandbox"; @source
  "./.designbook/changesets";` (paths relative to the css file).

## Test / story files loaded unexpectedly

Because `sourceModules` executes matched files, matching `*.test.tsx` or `*.stories.tsx` runs
their top-level code at load. Keep those out of the glob — scope it to real component source
only (e.g. `./src/components/**/*.tsx` with tests/stories excluded).

## The agent won't start

Agent and API errors always log to the **terminal**. Run with `--debug` (or
`DESIGNBOOK_DEBUG=1`) for full request and agent-event logging. Check that Pi auth is set up
(`~/.pi/agent/auth.json`) and any required provider environment variables are present. Turn
errors also surface in the chat panel.

## A text or token edit doesn't show up live

Designbook's write-back endpoints are designed to update full view without a page reload —
if an edit seems to land on disk but full view or the live app doesn't reflect it, restart the
dev server before assuming the write failed; this is usually a transform-cache staleness issue
in Vite rather than a lost write, and a fresh start picks up the change. This applies in both
injected and host mode, since both serve your components through a Vite dev server underneath.

## A branch instance didn't come up

Each [branch instance](/branch-instances/) logs its install, setup, and server output to
`~/.designbook/logs/<repo>--<branch>.log` — start there. Common causes: a failing
`designbook:setup` hook, or the `designbook` bin not being resolvable from the config file's
directory (add `designbook` to that package's dev dependencies).
