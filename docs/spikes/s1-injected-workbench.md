# Spike S1 — Model-C "injected workbench" proof (excalidraw)

_2026-07-06. Evidence spike, no product code, no commits. Timeboxed ~90 min._

## What was tested
Topology change: designbook as a **dev-only dep inside the target app's build**. A vite
plugin injects a SEPARATE module-script entry into the app's served `index.html`; that
entry mounts a floating toolbar + full-screen overlay workbench, all compiled by THEIR
bundler and rendered by THEIR React — zero designbook `userVite`/host-mode bridging.

Target: excalidraw clone at
`.claude/worktrees/agent-a62292d74a15d2010/tmp-repos/excalidraw` (React 19.0.0, plain
Vite, SCSS, `@excalidraw/*` source aliases). Host-mode server on 8811 left untouched.

### Artifacts (all new, uncommitted)
- `excalidraw-app/vite.designbook-spike.config.mts` — extends their real `vite.config.mts`
  (their plugin-react, svgr, ejs, scss, `@excalidraw/*` aliases), drops `vite-plugin-checker`
  only, appends the spike plugin, sets `server.fs.allow=[repoRoot]` for the out-of-root entry.
- `designbook-spike/plugin.ts` — `transformIndexHtml` injects
  `<script type="module" src="/@fs/…/designbook-spike/entry.tsx">`.
- `designbook-spike/entry.tsx` — toolbar pill → overlay; shadow-DOM chrome + light-DOM
  3-cell grid; per-cell `React.lazy(() => import(...))` in per-cell error boundaries.
- `designbook-spike/spike.config.ts` — imports `COLOR_PALETTE` via `@excalidraw/common`
  alias, exports the registry the overlay reads.
- `designbook-spike/cells/{Island,FilledButton,Card,Broken}Cell.tsx` — demo cells.

Run: `cd excalidraw-app && npx vite --config vite.designbook-spike.config.mts --port 3010`.

## Kill-question results

### K1 chrome-on-their-React — **PASS**
- Transform of `entry.tsx` shows `react` → `/node_modules/.vite/deps/react.js` (the app's
  single optimized copy) and `/@react-refresh` injected by THEIR plugin-react. `react-dom`
  and `react-dom/client` likewise from their optimized deps.
- Runtime console: `[designbook-spike] entry mounted on their React 19.0.0`.
- Toolbar + overlay render and are fully interactive (expand/collapse, lazy cells) on their
  React, alongside the running excalidraw app.

### K2 style isolation — **PASS**
- Their SCSS applies inside the light-DOM canvas cells: Island, FilledButton (purple
  primary / red danger-outlined / icon), and Card (download icon, "Save to disk", purple
  button) look identical to port 8811.
- Computed styles: shadow-chrome `.title` = `monospace` + `rgb(124,252,0)` (from CSS
  attached inside the shadow root); light-DOM cells + their buttons =
  `Assistant, system-ui, …` (excalidraw font). The aggressive shadow `* { font-family:
  monospace !important }` did **not** leak into the cells or the app; the app's global
  styles did **not** restyle the shadow chrome. Bidirectional isolation confirmed.

### K3 config in their build — **PASS**
- `curl` of the transformed `spike.config.ts`: `import { COLOR_PALETTE } from
  "/@fs/…/packages/common/src/index.ts"` — their `@excalidraw/common` alias resolved to
  their source, no designbook compat code in the path.
- Runtime: the "accent from @excalidraw/common" label computes to `rgb(34,139,230)`, a real
  value read from `COLOR_PALETTE` through the alias.

### K4 boot-crash isolation — **PASS**
- Added `throw new Error("designbook spike: simulated boot crash")` at top of
  `excalidraw-app/index.tsx`. Reload: app area blank, no canvas; console shows the
  EXCEPTION at `index.tsx`. Yet `[designbook-spike] entry mounted…` still logs, the toolbar
  mounts, and the overlay grid renders **all 3** real components fully styled — because the
  cells import the component modules directly, independent of the app's dead entry. Reverted.

### K5 broken-cell isolation — **PASS**
- Pointed the FilledButton cell's lazy import at `cells/BrokenCell.tsx` (syntax error; their
  sources untouched). Result: exactly **one** red error cell ("Failed to fetch dynamically
  imported module: …/designbook-spike/cells/Broke…") while Island, Card, and the shadow
  chrome stayed alive and interactive. Reverted the registry pointer.

### K6 HMR behavior — **PASS (precise behavior below)**
- Hot path: with the overlay open, edited
  `packages/excalidraw/components/FilledButton.tsx` (added a magenta `outline`). Console:
  `[vite] hot updated: …/FilledButton.tsx`; the buttons gained the outline **in place**;
  the overlay **stayed open**. react-refresh (their inherited plugin-react) propagated the
  update through the lazy-loaded cell without a reload. Reverted → hot-updated back.
- Full reload (`location.reload()`): the app reboots and the workbench's React state
  **resets** — overlay closes back to the collapsed toolbar pill (`overlayOpen:false,
  toolbarPresent:true, appAlive:true`). Ephemeral UI state (expanded/collapsed, selected
  cell, scroll, chat contents) is lost because it's plain `useState` with no persistence.

## Gotchas discovered
- **Out-of-root entry**: the spike dir lives at repo root, outside the app's Vite root
  (`excalidraw-app/`). Injected via `/@fs/<abs>` and required `server.fs.allow=[repoRoot]`.
  A real product would either sit inside an allowed dir or add its path to `fs.allow`.
- **`vite-plugin-checker` dropped**: their config runs project-wide TS+ESLint checking that
  overlays/can crash the dev server (same issue noted in host-mode round-2c). Filtered out
  by name in the spike config. C2/C3 must strip or neutralize dev-tooling/checker plugins
  from the inherited plugin set (the host-mode deny-list already does this).
- **ESM import hoisting**: a `throw` on line 1 of their entry still runs after the hoisted
  `import`s evaluate, but before `createRoot().render()` — app still dead, isolation holds.
- **Shadow-root React**: rendered chrome into the shadow root via `createPortal` from the
  SAME (their) React tree — keeps one reconciler, passes props (registry) directly, and
  needs no second `createRoot`.
- No React duplication/context issues observed — single copy via their optimizer dedupe.

## What C2/C3 must account for
1. **Plugin-set curation on inheritance**: reuse the host-mode deny-list — drop
   checker/dev-tooling/PWA/framework/server/write-side-effect plugins; keep react + svgr +
   ejs + scss. The spike only had to drop `checker`, but the deny-list is the general answer.
2. **Entry injection seam**: `transformIndexHtml` (order `post`) with a SEPARATE module
   entry works cleanly and rides their react-refresh. Package the entry inside an fs-allowed
   location (or extend `fs.allow`) rather than `/@fs` out-of-root.
3. **Light-DOM cells + shadow-DOM chrome is the right split**: their SCSS must reach the
   cells (light DOM, `.excalidraw` wrapper for scoped vars); chrome isolates in shadow. This
   is exactly reproducible without host-mode CSS plumbing.
4. **Per-cell lazy + error boundary** gives real fault isolation (K4/K5) — keep it.
5. **Workbench state is ephemeral across full reloads** — if "survive HMR full-reload" is a
   requirement, persist overlay/selection state (URL hash or localStorage). Hot updates
   already preserve it.
6. **Config compiles through their build for free** (K3) — the registry module and cells
   resolve their aliases with zero bridging. This is the core simplification vs. host mode.

## Effort signals
- Spike stood up + all 6 kill-questions browser-verified in well under the timebox.
- Injection + their-React rendering + style isolation were effectively frictionless; the
  only config surgery was dropping `checker` and allowing the out-of-root path.
- The hard parts of a real C-model product are NOT proven here: prod build path, cross-repo
  plugin-set curation robustness (host-mode already invested here), workbench state model,
  and packaging the entry as a real dep. But the load-bearing risk — "does their bundler +
  their React host our workbench with real style isolation and fault isolation?" — is a
  clean YES on excalidraw.

## End state
`git -C tmp-repos/excalidraw status --short`:
```
 M packages/excalidraw/locales/en.json      (pre-existing, prior adapter session)
?? designbook-spike/                        (spike)
?? designbook.config.tsx                    (pre-existing untracked)
?? designbook.text.excalidraw.ts            (pre-existing untracked)
?? excalidraw-app/vite.designbook-spike.config.mts  (spike)
```
Temp edits (K4 index.tsx throw, K6 FilledButton outline) reverted — empty diffs. Port 3010
killed and free; 8811 host-mode server untouched. No commits.
```
```
