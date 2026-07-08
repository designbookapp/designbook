# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-07-08

### Added

- **No-model setup callout** — with no provider credential the chat tab now
  replaces the prompt input with setup instructions (`npx pi` → `/login`, or
  a provider env var like `ANTHROPIC_API_KEY`) and a **Retry connection**
  button; a new session re-reads `~/.pi/agent/auth.json`, so logging in
  after launch needs no restart.

### Fixed

- **Canvas selection under `display:contents` wrappers** — components whose
  first host DOM node is boxless (e.g. a flag-scope wrapper rendering
  `display: contents`) measured 0×0 and were silently unselectable; rect
  collection now descends into children when a host has no box.

## [0.3.0] - 2026-07-08

### Added

- **Page tools** — select, prompt, and in-place text editing directly on the
  live app, not just in the canvas: click a rendered component or string on a
  running page, prompt Pi against it, or edit text inline and have the change
  write back to the real source (i18n locale file or literal).
- **App page** — a canvas page that renders the app's own current route live
  in an iframe, with matching frame-freshness handling and deterministic
  reloads; page tools (select/prompt/text-edit) work inside these frames too,
  including nested flow screens.
- **Adapter token live-commit** — theme token edits commit as you type
  (debounced), not only on blur.
- **Declarative Figma pull** — "Pull from Figma" now converts the edited
  Figma layers into annotated HTML (a declarative target preserving
  slot/i18n/token/nested-component wiring) and drafts the prompt straight
  into the chat input; sending it is the confirm gate, and the Pi agent
  makes the real code edits. Replaces the old delta/baseline/ack pull — no
  sync-state files to commit.
- **`figma-pull` Agent Skill** — the pull reconciliation rules ship in the
  npm package as a Pi skill loaded into every embedded session (trust-
  independent; repo `.pi/` skills stay gated).
- **Props panel** — live fiber props for the selected component, alongside
  chat and code in the right panel.

### Changed

- **Workbench panel layout** — chat, props, and code now live in a
  collapsible right-hand panel with horizontal tabs; the left rail hosts
  files, changes, Figma, and adapters. Figma sync moved into its own
  self-contained left tab (on-canvas sync controls removed).
- **Figma push** — components arrive with native Component Properties,
  i18n text encoded in layer names (explicit namespace, dot notation), and
  a single root marker recording the render context (locale/theme/mode/
  dimensions) for round-trip pulls, instead of per-node hidden metadata.

- Injected-mode adapter bundling: `@designbookapp/designbook/adapters` resolves to a
  prebuilt bundle sharing the workbench runtime (fixes dep-optimizer 504s and
  `@designbook-ui/*` resolution failures).
- i18next adapter now externalizes `react-i18next`/`i18next` so the adapter
  and the app's own components share one instance in injected mode, which is
  required for text-tool attribution to work at all.
- `designbookPlugin()` auto-injects `resolve.dedupe: ["react-i18next",
  "i18next"]`, merged with any dedupe the app already declares — no more
  manual dedupe config for the common case.

### Fixed

- `matchFiber` direct lookup for `forwardRef`/`memo`-wrapped fibers (select
  and text tools now attribute components wrapped in `memo`/`forwardRef`
  correctly instead of missing them).
- Designbook-written CSS token updates now pass through HMR instead of being
  swallowed, in injected mode.
- Vite transform cache invalidation for designbook-written locale files, so
  text-tool edits show up immediately.

### Security

- **Same-origin API gate** — the sidecar's `/api/*` now rejects
  cross-origin requests by default, closing off the local dev server to
  other pages/tabs on the machine. Sole exemption: `GET /api/figma-hello`,
  the Figma plugin's discovery probe (its UI iframe runs from a `data:`
  URL, so its fetches are inherently cross-origin); it returns only
  `{app, version, port}`.
- **`--read-only`** — run the workbench and agent without any write access
  to the repo (maps to a read-only tool set for Pi).
- **`--allow-lan`** — binding to all interfaces (for testing on another
  device) is now opt-in rather than the default.
- **Project-trust default-off** — the agent no longer assumes a project is
  trusted; trust must be established explicitly, matching Pi's own CLI model.
- A dirty git tree now warns before the agent starts editing.
