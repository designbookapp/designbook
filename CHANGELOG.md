# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-07-09

### Added

- **Design-variations review polish** — compare-strip cells are now
  self-contained column cards: labels truncate inside the cell header, the
  preview area hard-contains hostile variant styling (`contain: layout paint`
  + scroll — absolute/fixed roots and 1200px layouts cannot escape their
  cell), action rows align across cells, and the row scrolls horizontally.
  Collapsed renders (zero-height roots) are detected by measuring the mounted
  preview root and flagged "rendered empty" with failed-cell prominence
  (iterate/discard stay available); the variations skill + variant prompt now
  require an intrinsic-height root. Variant-only Tailwind utilities generate
  correctly (an `@source` for `.designbook/variations/` is appended to v4
  entry css in host mode). The director call and every ephemeral variant
  session now **inherit the chat's selected model** (SDK default only when
  none is selected), and the Generate popover shows which model will run.

- **Branch worktrees now live inside the repo** — new branch worktrees are
  created under `.designbook/worktrees/<branch>` (like Claude Code's
  `.claude/worktrees`) instead of a sibling `<repo>-worktrees/` dir. On first
  creation designbook writes `.designbook/worktrees/` to the repo's
  `.git/info/exclude` (idempotent; respected if already in `.gitignore`) so the
  nested checkout never pollutes `git status` / the Changes tab — zero user
  setup. `designbook init` also scaffolds the entry into `.gitignore`. Existing
  sibling-dir worktrees keep working (everything lists via `git worktree list`);
  no migration. A nested worktree's files are fenced off from the primary root's
  read/write endpoints (containment guard) and from the primary Vite watcher
  (HMR ignore), so editing inside a worktree can't fire the primary app's HMR.

- **Uncommitted-change count on the branch switcher** — `GET /api/worktrees`
  returns an additive `dirtyCount` per worktree (`git status --porcelain`,
  capped at 99); the switcher shows a compact dot + count ("3", "99+") per
  branch. Wire-compatible (optional field).

- **`designbook login` / `designbook pi` CLI subcommands** — connect a model
  for the chat tab without the broken `npx pi`. The bundled Pi CLI is resolved
  from designbook's *own* dependency tree (via its package.json `bin`), not
  `node_modules/.bin`, so it works under pnpm and yarn-pnp (which don't link a
  transitive dep's bins, making `npx pi` run an unrelated registry package).
  `designbook login` spawns it interactively with a `/login` hint; `designbook
  pi [args…]` is a passthrough escape hatch. The no-model chat callout and docs
  now say `npx designbook login`.

- **Per-branch agent sessions + warm dev servers** (`designbook dev`) — the
  proxy is purely a proxy: each branch worktree gets its own Pi session
  (cwd-scoped, transcripts per branch) that keeps running in the background
  across branch switches, so a turn started on branch A finishes while you
  explore branch B. The chat binds to the viewed branch (session badge shows
  the branch); inactive branches show "agent working"/"agent finished"
  badges in the branch switcher. Dev servers spawn lazily on first view,
  stay warm when switching away (instant switch-back), LRU-capped at 3
  (forced `--target-port` caps at 1). SSE events gain an optional `branch`
  field (absent = primary; wire compatible) plus a new `branch-status`
  snapshot event. Removing a worktree disposes its session and stops its
  dev server. Host mode unchanged. See docs/specs/per-branch-sessions.md.

- **Info panel + selection-context registry (PREVIEW)** — the right-panel
  Props tab is now **Info** (first tab; persisted "props" migrates): one
  contributor registry renders the same derived selection context to the
  panel and the chat prompt (core / props / render context / i18n incl.
  hardcoded-string count / React context scope / figma status). Drilled
  selections now send both the usage site AND the definition to the agent,
  and the chat's selected-node marker expands to show the full context.
  New `selectionContext` hook on `PluginUiSpec` and `AdapterSetup`.

- **Integration-plugin seam (EXPERIMENTAL)** — the built-in Figma integration
  now registers through a public plugin API (`@designbookapp/designbook/integration`):
  same-origin-gated routes under `/api/x/<name>/…`, a core device bridge at
  `/api/bridge/<name>`, Pi tools/skills, and a left-rail tab fed
  `PluginScreenProps`. New generic `GET /api/hello` discovery route (the only
  cross-origin-exempt path). Config key `integrations:` — built-ins are
  default-ON, `integrations: { figma: false }` opts out,
  `integrations: { figma: { tokens: { … } } }` carries the Figma token-sync
  options.

### Changed

- **Sync to/from Figma moved to the Figma tab** — the theme adapter now
  publishes a neutral token source; Figma naming/collection options moved to
  `integrations.figma.tokens`. `themeAdapter({ figma: … })` still works but
  logs a deprecation warning and forwards.
- Shipped Figma surfaces keep working via aliases: `/api/figma-hello`,
  `/api/figma-bridge`, and `/api/figma/*` all alias their canonical forms.
- The figma-specific pure mappers (`figmaTokens`, `figmaRender`, …) are no
  longer exported from `@designbookapp/designbook/config` (they were
  undocumented internals; they now live inside the figma plugin).

## [0.3.1] - 2026-07-08

### Added

- **No-model setup callout** — with no provider credential the chat tab now
  replaces the prompt input with setup instructions (`npx pi` → `/login`, or
  a provider env var like `ANTHROPIC_API_KEY`) and a **Retry connection**
  button; a new session re-reads `~/.pi/agent/auth.json`, so logging in
  after launch needs no restart.

### Fixed

- **Chat "Selected node context" marker mis-described drilled instances** — for
  a drilled selection the collapsed one-line marker above the chat input showed
  the bare component definition path, reading as if the component itself were
  selected rather than the instance inside its parent. It now frames the usage
  site (`Instance <Card> in ProductCard — …/variants/Card.tsx`); the definition
  path stays in the expanded assembled-context view. (The prompt half was
  already fixed — the core selection-context fragment sends both usage site and
  definition.)

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
