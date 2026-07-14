# M spec — page tools (in-place design mode on the live app)

_Injected-mode middle state between the pill and the full canvas. Clicking the pill opens a small tool strip; tools operate on the CURRENT live app screen — select a component and prompt Pi, edit text in place (M2) — with "go to component" as the escalator into the full workbench. Decided with Michael 2026-07-06._

## Why this works (constraints that make it cheap)

- Same-document: the live app tree is reachable with the existing fiber tooling.
- The config compiles in THEIR build → `registryByRef` holds the same module
  instances the live app renders — registered components match by reference on
  the real screen, no heuristics.
- PreviewHost seam already abstracts document access; page mode is a second
  consumer, not a new architecture.

## Decisions (settled, do not re-litigate)

- Pill click → **tool strip**, not the full canvas. Strip: select, text (M2),
  chat, expand-to-workbench, close. Full canvas only via explicit expand or
  "go to component".
- Page mode does NOT arm the reload-defer guard (the live page stays live) and
  never touches their URL (nothing new — page tools don't route).
- **No text-edit fallbacks.** Live-page text editing (M2) uses exact key
  attribution via a dev-only build transform: translation call sites are
  wrapped `t(k) → __dbMark(t(k), k, ns)`; `__dbMark` appends the invisible
  marker ONLY while the text tool is active (`window.__designbook.textToolActive`),
  else passthrough. Per-lib matchers (i18next `t`, Lingui `i18n._`/macros).
  Dynamic keys work (runtime first-arg). Fallback when transform is off:
  instrument the app's real i18n instance (config hands it over,
  hostContext-style) — postProcessor toggled with the tool. Reverse catalog
  lookup / source-string matching are DELETED from the plan (too flaky).
  Hardcoded literals route to "Prompt Pi", not inline edit.

## M1 — select + prompt + go-to-component (~0.4–0.5M)

1. **Strip UI**: pill click swaps to a compact tool strip (same shadow host).
   Icons: select, chat, expand, close. Loads the workbench chunk lazily on
   first open (same ensureWorkbench path) but enters PAGE MODE — no overlay.
2. **Page select**: hover highlight + click selection on the live app DOM —
   a page-space variant of the canvas overlay (identity transform, document
   root, `elementsFromPointWithin`, same drill semantics where sensible).
   Selection chip: component label (registry match) or `tag.class` (DOM),
   actions: **Prompt Pi**, **Go to component** (registered only), dismiss.
3. **Prompt Pi**: docked compact chat drawer (DesignChat, shared server
   session); prompt prefilled with the selection's code targets
   (`resolveCodeTargets` — file + usage line), like the canvas chat context.
   Unregistered components degrade to fiber-derived hints where available.
4. **Go to component**: expands the full workbench on that entry
   (`navigateTo` + expand), carrying the drill selection when representable.
5. Page-tools-open state persists across reloads (sessionStorage flag beside
   the existing persist blob); reloads themselves are never blocked in page
   mode.

**Accept**: on excalidraw via `designbook dev` — pill → strip; select tool
highlights live UI; clicking a registered component (e.g. Island in the left
panel) shows the chip with its registry label; Prompt Pi opens the drawer with
file context and streams a reply; Go to component opens the canvas on that
entry; close returns to the untouched app; their URL never changes; full-canvas
flow unchanged; host mode unaffected (page tools are injected-only). Tests for
the pure pieces; all gates green.

## M2 — in-place text editing (~0.5M)

1. Plugin transform (dev-serve only, opt-out `pageTextTransform: false`):
   wrap i18next `t()` / Lingui `i18n._` + macro output call sites with
   `__dbMark(value, key, ns)`; runtime injected via the boot module; markers
   gated on text-tool activation.
2. Text tool in the strip: marked strings highlight on the live page; the
   existing popover editor (placeholders/plurals) edits them; writes go through
   the same adapter/sidecar path (HMR-suppressed, page updates live).
3. Instance-instrumentation fallback (`pageText: { i18n: () => appI18n }`)
   for no-transform setups; unmarked strings show "not an i18n string — ask Pi"
   affordance, never a guess.

**Accept**: on a real i18next app — activate text tool, edit a live string,
the right key in the right locale file changes, page updates without reload,
markers absent from the DOM when the tool is off. Lingui path proven on the
documenso clone or a fixture.

## Watch-outs

- Page overlay must not eat the app's own pointer events except in an active
  tool (select/text on = capture; strip open but no tool = app fully usable).
- Chip/drawer are chrome → shadow hosts, styled by our css only.
- `registryByRef` match requires the config's component imports to resolve to
  the same modules as the app's — true in injected mode; do not "fix" a miss
  by name-matching against unrelated components.
- Rebuild dist/ui before browser verification.
- z-index vs app modals; Esc must not leak to the app while a tool is active.
