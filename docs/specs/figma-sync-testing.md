# Figma sync fidelity testing

Status: P0+P1 BUILT (2026-07-08; see "Decisions" at the end). P2/P3 pending.
Companion to `docs/specs/figma-declarative-pull.md`.

Goal: a semi-automated harness that, for a curated matrix of HTML/CSS cases,
(1) renders the case in the browser, (2) pushes it to real Figma, (3) exports
what Figma actually rendered as PNG, (4) compares browser-PNG vs Figma-PNG,
(5) pulls the annotated HTML back and asserts nothing was lost. This tests
what the pure round-trip tests (`src/config/figmaReadCss.test.ts`) CANNOT:
what Figma's real engine does with our node specs — font rasterization,
autolayout HUG/FILL resolution, stroke alignment, shadows, gradients,
absolute positioning, instance behavior, native Component Property
origination.

## Honest constraint up front

The bridge requires **Figma desktop open with the designbook plugin running**
(plugin UI iframe connects outbound to `/api/figma-bridge`; no headless
Figma exists). So this is `pnpm test:figma` run locally with Figma open —
**never CI**. The pure vitest round-trip suite remains the CI gate; this
harness is the periodic/pre-release live-engine check. Current live-Figma
validation is entirely manual ("Real-Figma e2e is pending the user" in the
pull spec); this replaces that with a repeatable scripted run + reviewable
report.

## Research findings (verified against the tree, 2026-07-08)

### PNG export from the plugin — viable, cheap

- `node.exportAsync(settings?: ExportSettings): Promise<Uint8Array>` —
  confirmed in local typings
  (`node_modules/.pnpm/@figma+plugin-typings@1.130.0/.../plugin-api.d.ts`
  L8673). `ExportSettingsImage` (L4887): `format: 'PNG'`,
  `constraint: { type: 'SCALE'|'WIDTH'|'HEIGHT', value }`,
  `contentsOnly` (default true), `useAbsoluteBounds`,
  `colorProfile: 'DOCUMENT'|'SRGB'|'DISPLAY_P3_V4'`. We want
  `{ format: 'PNG', constraint: { type: 'SCALE', value: 2 }, colorProfile:
  'SRGB' }` — SRGB pins the color space so pixel compare against Chromium
  (sRGB) is apples-to-apples.
- `figma.base64Encode(data: Uint8Array): string` exists in the main-thread
  API (typings L1886) — encode in the plugin, ship a JSON string. No binary
  frames needed anywhere.
- Perf/limits (Figma docs + forum): export is the slow path of the plugin
  API; reports of degradation are at ~250-frame batch scale. Figma's 4096px
  asset limit is far above our component-sized cases (< ~1000px @2x). One
  export per case, ~25 cases, sequential ⇒ well inside budget. Sources:
  https://www.figma.com/plugin-docs/api/properties/nodes-exportasync/ ,
  https://developers.figma.com/docs/plugins/api/ExportSettings/ ,
  https://forum.figma.com/ask-the-community-7/performance-issue-with-exportasync-27682

### How the bytes travel (and the real size caps)

Path: plugin main thread `exportAsync` → `figma.base64Encode` →
`figma.ui.postMessage` (structured clone, cheap) → UI iframe →
`ws.send(JSON.stringify({type:"result", ...}))` → bridge resolves the
pending invoke (`src/node/figma/figmaBridge.ts`).

- The bridge relays **JSON strings only** (`handleMessage` does
  `JSON.parse`, malformed input is dropped — figmaBridge.ts L112-119).
  Base64-in-JSON is the only transport; cost is 4/3× raw bytes.
- **Correction to folklore**: there is NO 10MB bridge refusal. The 10MB cap
  is client-side on push (`MAX_TREE_BYTES = 10MB`,
  `src/ui/previewHost/figmaSerialize.ts`); the push HTTP body cap is 25MB
  (`FIGMA_PUSH_MAX_BODY_BYTES`, api.ts); the WS server itself
  (`new WebSocketServer({ noServer: true })`) uses `ws`'s default
  `maxPayload` of 100MiB. A 2×-scale PNG of a component-sized frame is
  ~50KB-1MB → ~70KB-1.4MB base64. **No chunking needed.** Add a defensive
  guard in the export tool (error above ~8MB base64) so a pathological case
  fails loudly instead of stalling the socket.
- `figmaBridge.invoke` default timeout is 15s; push/pull already pass 60s.
  Export should pass 120s.

### Why not REST `GET /v1/images/:file_key`

Loses on every axis designbook chose the plugin bridge for: needs a
PAT/OAuth token (designbook is deliberately zero-credential), rate-limited,
requires the fileKey + node-id plumbing we deleted, and renders server-side
from last-synced state (desktop may not have synced when we export —
race). The plugin exports the live in-memory scene the push just wrote.
Rejected.

### Existing surface the harness builds on

- Push: workbench serializes the **live DOM** under
  `[data-db-entry="<entryId>"]` (`FigmaSyncControls.tsx` `push()` →
  `serializeComponent` → `POST /api/figma/push` → plugin
  `figma_render_nodes`). Cases MUST render in a real workbench canvas —
  serialization reads computed styles + React fibers (registry boundaries),
  so there is no DOM-free shortcut.
- Pull: `GET /api/figma/html?componentId=` already returns the raw annotated
  HTML (debug endpoint, same read as pull) — the deterministic tier calls
  this directly, no UI needed.
- Root lookup for a new export tool: same
  `findAllWithCriteria` + sharedPluginData `componentId`/`kind:"root"`
  match `readHtml.ts` uses (L460-471), with the same `[not-found]` error
  convention.
- Routing: workbench selects a component via hash route
  `#/component/<entryId>` (`src/ui/models/catalog/useCanvasRoute.ts`) —
  URL-drivable.
- **No browser-test infra exists** (no playwright/puppeteer/pixelmatch
  anywhere in the workspace). The harness introduces it as devDeps of the
  designbook package only.
- Plugin discovery: the plugin probes ports **8787→8797 in order** and
  attaches to the FIRST designbook it finds (`figma-plugin/ui.ts`). The
  harness sidecar must run inside that range (default **8791**) and the run
  instructions must say: stop other designbook instances first, or the
  plugin will attach to the lower-port instance. Preflight catches this
  (below).

## Architecture

```
pnpm test:figma
  └─ runner (node, test/figma-fidelity/run.ts)
       ├─ spawns sidecar: dist/cli/index.js test/figma-fidelity/fidelity.config.tsx --port 8791 --no-open
       ├─ preflight: GET /api/figma/status → plugin connected? file? else exit with instructions
       └─ per case (sequential):
            1. playwright chromium (headless, deviceScaleFactor: 2)
               → http://localhost:8791/#/component/<caseId>
               → wait [data-db-entry] stable → element.screenshot() → browser.png
            2. click the real push button (data-testid) → wait "Updated in Figma" → assert 0 warnings
            3. POST /api/figma/export { componentId, scale: 2 }
               → plugin figma_export_png → exportAsync → base64 → figma.png
            4. GET /api/figma/html?componentId → pulled.html
               → normalize → compare vs cases/<id>/expected.html  (TIER 1)
            5. pixelmatch(browser.png, figma.png) → diff.png + mismatch%  (TIER 2)
       └─ emit results/<run>/index.html report; exit code = tier-1 failures only
  optional: --vision → TIER 3 agent compare on flagged cases
```

### Fixture representation: tiny React components (decision)

Cases are **tiny React components** registered in a dedicated designbook
config (`test/figma-fidelity/fidelity.config.tsx`, a `fidelity` set — same
pattern as the dogfood `designbook.config.tsx`). Not raw HTML strings,
because:

1. Push serializes a LIVE DOM through the workbench preview host — the
   canvas must mount the case anyway; a component is the native unit.
2. Instance nesting, slot-children, i18n markers, and token attribution all
   flow through React fibers + adapter runtime — unreachable from
   `dangerouslySetInnerHTML` strings.
3. Registry entry id doubles as the stable `componentId`/case id/route.

Static-CSS-only cases are still ~10 lines of JSX with inline styles; the
cost over an HTML string is negligible. Cases use inline `style={{}}` for
static CSS (exact, no Tailwind compilation variance) and theme CSS
variables/Tailwind utilities only in the token-attribution cases (where
matching the token pipeline is the point).

Layout on disk:

```
packages/designbook/test/figma-fidelity/
  fidelity.config.tsx        # designbook config: fidelity set, theme w/ tokens, i18n locale
  cases/<caseId>/Case.tsx    # the component
  cases/<caseId>/expected.html   # approved pull snapshot (committed)
  cases/<caseId>/meta.json   # tier flags, pixel threshold override, notes
  run.ts / normalize.ts / compare.ts / report.ts
  results/                   # gitignored: <timestamp>/<caseId>/{browser,figma,diff}.png, pulled.html, report
```

## Style matrix (v1: 24 cases)

Grouped; each maps to parity-table rows (pull spec "Style coverage") +
compositions. Tiers: **H** = HTML equality, **P** = pixel diff, **V** =
vision-eligible.

Fundamentals (rows → cases):
1. `solid-bg` — fixed-size div, background-color, opacity. H P
2. `gradient` — linear-gradient 90°/135°, 3 stops; on top of radius. H P V
3. `border-radius` — uniform border (color/width) + uniform radius; sibling
   with per-corner radii. H P
4. `shadow` — two stacked drop shadows + one inset. H P V
5. `overflow-clip` — overflow:hidden child bleeding out. H P
6. `text-basic` — font-family/size/weight(400/500/700)/italic/color/
   line-height/letter-spacing/text-align in one stack. H P V
7. `text-autoresize` — unconstrained text (HUG both axes) vs fixed-width
   wrapping text. H P

Layout:
8. `flex-row-gaps` — row, gap, padding shorthand + per-side. H P
9. `flex-justify-align` — column of rows: justify start/center/end/
   space-between; align-items center/end/stretch. H P
10. `flex-wrap` — wrapping row, gap + cross gap (counterAxisSpacing). H P
11. `hug-fill-fixed` — row: fixed-px child + flex-grow:1 child + hug text;
    outer column HUG height (exercises serializer's height:auto probe). H P
12. `align-self` — stretch child under non-stretch parent. H P
13. `block-stack` — plain stacked divs, no flex (block-stack upgrade →
    VERTICAL autolayout, no fixed height). H P
14. `none-layout-residual` — overlapping/messy children that don't stack
    (documented residual FIXED case — expected.html asserts the fixed px). H P
15. `absolute-badges` — relative wrapper + `<img>` + two absolute badges
    (corners) — the ProductCard pattern. H P V

Bindings / semantics (the pull-annotation surface):
16. `token-colors` — bg/text/border bound to theme tokens →
    `data-token-background/color/border-color`. H P
17. `token-radius-gap` — rounded-xl → `data-token-border-radius="radius-xl"`,
    gap → space token. H P
18. `i18n-slot` — i18n-marked text → `data-i18n="app...."` + native TEXT
    Component Property `i18n.<ns>.<key>` (verifies open Q5 of the pull spec:
    dots in property names, live). H P
19. `named-slot` — `#name` fallback slot on the root. H
20. `nested-instance` — registered child component → COMPONENT main +
    INSTANCE; pull stops at `data-component`. H P
21. `nested-instance-absolute` — same, absolutely positioned over a sibling
    (minimal-snapshot x/y path). H P
22. `slot-children` — component receiving parent-authored children (inline
    kind:"slot" frame, not instance). H P
23. `items-list` — `items[]` container, 3 items → `data-list` + one
    template. H P

Kitchen sink:
24. `product-card` — the full examples/demo ProductCard composition
    (image + badges + text stack + tokens + button + i18n). H P V

Not in matrix (pull-only, push never writes — no round-trip to test):
`text-decoration`, `text-transform`, `min/max-*`, `%`-line-height,
designer-bound per-side padding tokens. Covered by pure tests already.
Image-fill fidelity is visual-only (`absolute-badges`/`product-card` carry
it; pull has no CSS readback for images — known-lossy).

## New code (where pieces land)

| Piece | Location | Size |
|---|---|---|
| `figma_export_png` tool: root lookup (shared w/ readHtml) → `exportAsync({PNG, SCALE 2, SRGB})` → `figma.base64Encode` → `{ base64, width, height }`; error if base64 > 8MB | `figma-plugin/export.ts` + dispatch line in `code.ts` | ~50 lines |
| `POST /api/figma/export` `{componentId, scale?}` → `figmaBridge.invoke("figma_export_png", …, 120_000)` → relays JSON (runner decodes) | `src/node/api/api.ts` | ~40 lines |
| `data-testid="figma-push"` on the push button (runner clicks the REAL path — no parallel serialize entry point) | `src/ui/screens/FigmaSyncControls.tsx` | 1 line |
| Fixtures config + 24 case components + expected.html snapshots | `test/figma-fidelity/` (new) | ~800 lines |
| Runner: spawn sidecar, preflight, playwright loop, compare, report | `test/figma-fidelity/run.ts` + helpers | ~500 lines |
| `"test:figma": "node --experimental-strip-types test/figma-fidelity/run.ts"` (or tsx) | `package.json` | 1 line |

New devDeps (designbook package only, never shipped): `playwright-core`
(chromium), `pixelmatch`, `pngjs`. Plain node script, NOT vitest — the run
is sequential, stateful (one shared Figma page), long (minutes), and its
output is a report humans review; vitest's parallelism and pass/fail model
fight all of that. Exit code reflects tier-1 (HTML) failures so it's still
scriptable.

## Comparison strategy — three tiers

### Tier 1 — deterministic HTML equality (every run, gates exit code)

`GET /api/figma/html?componentId` → normalize both sides → structural
compare. Normalizer (small, pure, unit-testable in the harness dir):
parse with a forgiving HTML parser, sort attributes, normalize colors to
rgba, round px to 0.1, numeric tolerance ±1px (Figma float coords),
whitespace-collapse text. Also asserts the annotation surface directly:
expected `data-token-*`, `data-slot`/`data-i18n`, `data-component` (with NO
children), `data-list` present. Free, exact, zero vision.

`expected.html` is an **approved snapshot**, not hand-written: first run
writes `pulled.html`; `--approve <case>` promotes it after human review.
Hand-writing is error-prone because the expectation embeds the documented
known-lossy transforms (absolute readback under NONE parents, shorthand
collapsing, implicit defaults).

### Tier 2 — pixel diff, browser vs Figma (every run, informational)

`pixelmatch` on browser.png vs figma.png (both 2×; pad to common canvas if
±2px size drift) → mismatch% + diff.png. **Expected noise**: Figma's text
rasterizer ≠ Chromium's (AA, hinting, kerning) — text-heavy cases will show
a few % mismatch when perfectly correct. Plan: calibrate in phase 2 (run
matrix 3×, record per-case floor; threshold = floor + margin, stored in
`meta.json`), start with a loose default (fail report cell red only above
~10%). If text noise drowns signal, next steps in order: `pixelmatch`
threshold option ↑ → SSIM (`ssim.js`) → text-region masks derived from the
serialize tree's text rects (we already know them — no CV needed). Tier 2
never gates exit code; it feeds the report and tier 3.

### Tier 3 — agent vision (on demand, `--vision`)

For cases flagged by tier 2 (or `--vision all`): send browser.png +
figma.png to an agent ("same component? list semantic differences — color,
spacing, missing/extra elements, text content; ignore antialiasing/
kerning/subpixel") → JSON verdict into the report. This is the right tool
for "did the button turn blue" — pixel diff can't rank severity, vision
can. Mechanism: shell out to `claude -p` with both images (keeps the
harness decoupled from the sidecar's Pi session; no designbook code
touched). Not per-run: costs latency/money and its value is triage, not
gating.

## Report

`results/<run>/index.html` — static, self-contained. One row per case:
name | browser.png | figma.png | diff.png (mismatch%) | tier-1 verdict
(pass / diff snippet of the first normalized mismatch) | tier-3 verdict if
present | push warnings. Summary header: pass counts, run metadata
(file/page from `/api/figma/status`, commit, duration). Thumbnails
click-to-zoom. Human reviews after each run; the tier-1 column is the only
machine gate.

## Phasing

- **P0 — export spike (½ day)**: `figma_export_png` tool + `/api/figma/export`
  route + curl-driven manual test against the already-pushed demo
  ProductCard. Proves: base64 size, export latency, SRGB profile, timeout
  headroom. No harness.
- **P1 — first slice (1-2 days)**: fidelity config + 5 cases (`solid-bg`,
  `text-basic`, `flex-justify-align`, `absolute-badges`, `token-colors`) +
  runner (spawn, preflight, playwright, push-click, export, pull) + tier 1
  only + minimal report (images side by side, no diff). Already useful: it
  is the scripted replacement for today's manual e2e.
- **P2 — full matrix + pixel tier (2-3 days)**: all 24 cases, pixelmatch +
  calibration pass, thresholds in meta.json, full report, `--approve`
  workflow, `--case <id>` filter for fast iteration.
- **P3 — vision tier + polish (1 day)**: `--vision`, severity JSON in
  report, doc page for the run ritual (open Figma → run → review).

## Open questions (Michael)

1. devDeps playwright-core + pixelmatch + pngjs in designbook pkg — ok?
2. Harness port 8791 + "stop other designbook instances first" rule — acceptable? (plugin probes 8787→8797, attaches to first)
3. results/ gitignored (only expected.html committed) — or keep last-known-good figma.pngs too?
4. Tier 3 via `claude -p` shell-out — ok, or route through sidecar Pi session?
5. expected.html approve-on-first-run snapshot flow — ok?
6. Push trigger: real button click via data-testid (1-line UI change) — ok, or want a window test hook instead?
7. Matrix: 24 cases — trim? additions (dark-mode variant per case? RTL)?
8. Dedicated Figma test file/page convention for runs (exports overwrite same page) — care, or any open file fine?

## Decisions (2026-07-08)

Michael's answers to the 8 open questions, applied in the P0+P1 build.

1. **devDeps** playwright-core + pixelmatch + pngjs — YES, as devDependencies
   of packages/designbook (don't ship to npm consumers).
2. **Port 8791** default + documented "stop other designbook instances first"
   rule — YES (stays inside the plugin's 8787→8797 probe range; the harness's
   OWN automated tests never bind a server — they mock the boundaries).
3. **results/ gitignored**, only `expected.html` committed — YES (no
   last-known-good PNGs in git).
4. **Tier 3** vision via `claude -p` shell-out — YES for v1 (P3, not yet built).
5. **expected.html approve-on-first-run** snapshot flow — YES. Cases ship
   without a baseline; first run reports NEW + writes `pulled.html`;
   `--approve <id|all>` promotes it.
6. **Push trigger**: real button click via `data-testid="figma-push"` — YES
   (the 1-line UI change on FigmaSyncControls; runner drives the real path).
7. **Matrix**: the 24 cases as specced; no dark-mode/RTL variants in v1. P1
   ships the 5-case first slice (solid-bg, text-basic, flex-justify-align,
   absolute-badges, token-colors); the rest land with the P2 pixel tier.
8. **Figma file convention**: documented "use a dedicated test file/page" in
   the run ritual (README.md); not enforced programmatically.

### Build status (this branch)

- **P0 done**: `figma_export_png` plugin tool (`figma-plugin/export.ts` +
  dispatch in `code.ts`), `POST /api/figma/export` route (`src/node/api/api.ts`,
  120s timeout, 404 on `[not-found]`), and the `data-testid="figma-push"` hook.
- **P1 done**: `test/figma-fidelity/` — `fidelity.config.tsx` + theme + 5 case
  components, the runner (`run.ts`: spawn → preflight → playwright → real-push
  click → export → pull → tier-1 compare → report), and the pure modules
  (`caseConfig`/`normalize`/`report`/`cli`) with vitest unit tests. Tier 1 only,
  minimal side-by-side report. `pnpm test:figma` wired.
- **P2 not built** (full matrix + pixelmatch tier + calibration). `caseConfig`
  and `report` already carry the tier-2 fields; `compare.ts`/pixel wiring is the
  next step.
- The real end-to-end loop needs Figma desktop + plugin attached, so it stays a
  manual run (see `test/figma-fidelity/README.md`). The runner's UI-navigation
  assumptions (entry visible on route; push button visible) are flagged
  `VERIFY ON FIRST RUN` in `run.ts` — the only glue no unit test can cover.
