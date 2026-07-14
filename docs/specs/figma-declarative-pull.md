# Figma declarative pull (settled-design rewrite)

Status: in progress. Replaces the delta-based Figma→code pull with a 100%
declarative "annotated HTML" pull, and slims the push path to a single root
marker. Real-Figma e2e is pending the user (needs Figma desktop + the plugin);
everything here is verified via unit tests + typecheck + build.

## Locked design (final — not relitigated here)

1. **Declarative, not delta.** The plugin converts the selected Figma component
   → **annotated HTML** (HTML, not JSX). The server bundles a Pi prompt of
   {annotated-HTML target + current component source + concrete sample values}
   and asks Pi to "rewrite this component so it renders this output." One path
   handles edits AND brand-new components. A **confirm prompt** precedes Pi
   applying. NO frozen baseline, NO pull cursor, NOTHING written to committed
   git.

2. **Delete the delta machinery:** `src/config/figmaDiff.ts` (+ test),
   `src/config/figmaDeltaPrompt.ts` (+ test), `src/node/figma/figmaBaselines.ts`
   and the `.designbook/figma/*.json` baseline concept, per-node `dbId` stamping
   (`figma-plugin/render.ts`) + reading (`figma-plugin/readTree.ts`), and
   `pushHash`/`pushedAt`/cursor plumbing. `figmaTree.ts` is removed once the read
   path no longer needs it (the new reader emits HTML directly, not FigmaTreeNode).

3. **Bindings ride the most native Figma surface** (stamped/named = dynamic slot,
   unstamped = static design):
   - **Content / prop slots** → native Figma **Component Properties** (text /
     boolean / instance-swap) PRIMARY, **`#name`** layer-name convention
     FALLBACK. Emitted as `data-slot` / `data-i18n`.
   - **Token / style slots** → Figma **Variable bindings**
     (`node.boundVariables`). Emitted as `data-token-<cssProp>`.
   - **Nested registered components** → Figma **component link**
     (`instance.mainComponent`); the main's NAME is the registry id. Emitted as
     `<div data-component="product.ProductThumb">` — NOT inlined (bounds payload
     to top layers).
   - **Lists / repeats** → an **`items[]`** container frame. Emitted as
     `data-list`; the LLM renders one per item, anchored by the code's `.map`.
   - **Static design** → unnamed/unbound → literal HTML/CSS.

4. **Concrete values sent through** as each slot's current content. i18n/content
   slot text IS the edit to capture; `data.` prop slots are SAMPLES only (the
   prompt instructs Pi NOT to hardcode them).

5. **Exactly ONE hidden marker** on the component ROOT: `sharedPluginData`
   namespace `designbook`, key `root` → JSON `{ component: <registryId>, v:
   <schemaVersion> }` (plus the existing `componentId`/`kind` keys that re-push
   targeting already relies on — see "Root marker" below). NO fileKey/nodeId.
   NOTHING else per-node.

## Concrete implementation map

### New files
- `src/config/figmaHtml.ts` — **pure, framework-free, ES2017** converter. Defines
  the intermediate `HtmlNode` shape (what the plugin reads Figma into) and
  `htmlNodeToString(node)` → annotated HTML string. Lives in `src/config` (not
  `figma-plugin/`) because that is the only tree in vitest's `include`
  (`src/**/*.test.ts`) AND is already compiled by the plugin tsconfig — same
  pattern as the pure `figmaRender.ts`. Exported from `src/config/index.ts`.
- `src/config/figmaHtml.test.ts` — fixture-driven unit tests (mirrors
  `figmaDiff.test.ts`).
- `src/config/figmaPullPrompt.ts` — **pure** `formatPullPrompt(ctx)` building the
  declarative Pi prompt (replaces `figmaDeltaPrompt.ts`). Exported from index.
- `src/config/figmaPullPrompt.test.ts`.
- `figma-plugin/readHtml.ts` — replaces `readTree.ts`. Walks `figma.*`
  (SceneNode) into `HtmlNode`s reading: Component Properties + `#`-names →
  slot; `boundVariables` → tokens; `mainComponent` → component ref (stops
  recursion); `items[]` frame → list; concrete text; else literal. Calls
  `htmlNodeToString`. Returns `{ componentId, html }`.

### Changed files
- `figma-plugin/code.ts` — dispatch `figma_read_html` → `readHtml` (was
  `figma_read_tree` → `readTree`).
- `figma-plugin/render.ts` — stop stamping per-node `dbId`; stamp only the root
  marker; author Component Properties/`#`-names for slots, variable bindings for
  tokens, component instances for nested components (Phase 4). Drop
  `pushHash`/`pushedAt`.
- `figma-plugin/tsconfig.json` — swap `readTree.ts`+`figmaTree.ts` for
  `readHtml.ts`+`figmaHtml.ts`.
- `src/node/api/api.ts` — replace `figma_pull_component_delta` tool with
  `figma_pull_component` (returns annotated HTML + declarative instruction);
  `/api/figma/pull` returns `{ componentId, html }`; remove `/api/figma/ack`;
  remove baseline reads/writes from push; drop the pre-push "unpulled edits"
  diff warning (it depended on the differ + baseline). `/api/figma/tree` debug
  endpoint becomes `/api/figma/html` (raw HTML, no diff).
- `src/ui/screens/FigmaSyncControls.tsx` — pull receives `{ componentId,
  html, render }`, builds the prompt with `formatPullPrompt`, and drafts it
  straight into the chat input. No confirm panel (`FigmaDeltaPanel` and its
  short-lived `FigmaPullPanel` successor are both gone): the user's send
  click in the chat tab is the single confirm gate; nothing POSTs
  `/api/prompt` from the Figma tab. No `/api/figma/ack`.
- `src/config/index.ts` — drop delta/baseline exports, add `htmlNodeToString`,
  `HtmlNode`, `formatPullPrompt`, `PullPromptContext`.

### Deleted
- `src/config/figmaDiff.ts` + `figmaDiff.test.ts`
- `src/config/figmaDeltaPrompt.ts` + `figmaDeltaPrompt.test.ts`
- `src/config/figmaTree.ts`
- `src/node/figma/figmaBaselines.ts`
- `figma-plugin/readTree.ts`

## HTML annotation schema (emitted by `htmlNodeToString`)

A component renders to a single root element with descendants. Annotations are
`data-*` attributes; concrete current values are the element text / attrs.

| Figma surface | HTML emission |
|---|---|
| Component Property (TEXT) / `#name` text layer | `<span data-slot="price">$49.99</span>` |
| i18n-bound text (`#i18n.<ns>.<key>` layer / `i18n.<ns>.<key>` property) | `<span data-i18n="app.cart.add.button">Add to cart</span>` |
| Component Property (BOOLEAN, hidden) | element carries `data-slot-if="showBadge"`; when currently hidden, `hidden` attr is also present |
| Component Property (INSTANCE_SWAP) | `<div data-slot-swap="icon" data-component="icon.Star"></div>` |
| Variable binding (`boundVariables`) | `data-token-color="color/primary"`, `data-token-background="color/surface"`, `data-token-border-radius="radius/md"`, `data-token-gap="space/2"` |
| Nested registered component (`mainComponent` name = registry id) | `<div data-component="product.ProductThumb"></div>` (recursion stops here) |
| `items[]` container frame | `<div data-list>…one item template…</div>` |
| Static frame/text (unnamed, unbound) | literal `<div style="…">` / text, computed CSS inlined per the style-coverage table below |

Rules:
- Element tag: `span` for text nodes, `img` for image nodes, otherwise `div`.
- `data-slot` / `data-i18n` values are the slot NAME (Component Property name or
  `#`-stripped layer name). An `i18n.` prefix routes a slot to `data-i18n`
  (value = the rest, dotted `<ns>.<key>`); everything else is `data-slot`.
- i18n uses DOT notation, namespace always explicit: layer name `#i18n.<ns>.<key>`,
  component-property name `i18n.<ns>.<key>`, attribute value `<ns>.<key>`. Because
  i18next keys contain dots, the split rule is: the FIRST dot-segment is the
  NAMESPACE, the entire remainder (dots kept) is the KEY — so
  `app.cart.add.button` → ns `app`, key `cart.add.button`. On push the namespace
  defaults to the config `defaultNamespace` (commonly "app") when a string
  doesn't carry one. See `src/config/figmaSlots.ts` (`i18nBinding` /
  `parseI18nValue`).
- Token attributes are per-CSS-property (`data-token-<prop>`), because one node
  can bind several variables and duplicate `data-token` attrs are illegal HTML.
  The design doc's illustrative `data-token="color/primary"` is the color case;
  we spell it `data-token-color` for uniformity. A legend in the prompt explains
  every attribute, so exact spelling is not load-bearing to the LLM.
- A `data-component` node emits no children (bounded payload).
- Concrete text lives as the element's text content; it is the SAMPLE for
  `data-slot`, the SOURCE OF TRUTH for `data-i18n`.
- Static CSS is emitted only for the subset of properties designbook already
  round-trips, kept minimal and human-legible.

## Style coverage (push↔pull parity table)

The pull's CSS readback lives in the pure `src/config/figmaReadCss.ts`
(`figmaNodeToCss(snapshot, parentContext)` → `{ style, tokens }`);
`figma-plugin/readHtml.ts` is a thin adapter that builds the plain
`FigmaNodeSnapshot` from `figma.*` (variable ids resolved to names via the
cached lookup) and calls the mapper. Parity contract: **whatever the push
writes into a Figma node, the pull reads back** — as the same CSS prop in
inline `style`, or as `data-token-<cssProp>` when a variable is bound. Push
never writes a prop → pull never invents it. Two-way tests:
`src/config/figmaReadCss.test.ts` (CSS → push mappers → simulated render.ts
application → pull mapper → same CSS).

| CSS prop | Push source (writes) | Pull source (reads) | Token-bindable |
|---|---|---|---|
| `background` | `background-color` → solid fill (render.ts `solidPaint`) | first visible SOLID fill | yes (`fill` color variable) |
| `background-image` | `linear-gradient(...)` → GRADIENT_LINEAR fill | GRADIENT_LINEAR fills (angle inverted from `gradientTransform`) | no |
| `color` (TEXT) | text fill (buildText) | TEXT node's first SOLID fill | yes |
| `border-color` | uniform CSS border → stroke paint | first visible SOLID stroke | yes |
| `border-width` | `strokeWeight` | `strokeWeight` (when a stroke exists) | no |
| `border-style: solid` | implied by stroke existence | emitted when a stroke exists | no |
| `border-radius` | `cornerRadius` / per-corner radii | four corner radii (uniform → single value; else 4-value shorthand) | yes, uniform only (`topLeftRadius` alias — push binds all four to one var). Bindable against the base `radius` token AND the derived radius scale `radius-sm\|md\|lg\|xl` (px FLOAT variables published by the theme sync from the `@theme` calc() expressions), so `rounded-xl` → `data-token-border-radius="radius-xl"`, never a raw px |
| `position: absolute` + `left`/`top` | CSS `position: absolute/fixed` → `layout.absolute`: under an AUTOLAYOUT parent render.ts sets `layoutPositioning: "ABSOLUTE"` + x/y; under a `mode:"none"` parent plain `x`/`y` (appendChildren) | node `x`/`y` when the parent is NONE-layout OR the node has `layoutPositioning: "ABSOLUTE"`. INSTANCE children too: the pull builds a MINIMAL snapshot (size + x/y + layoutPositioning only), so an absolute nested component keeps position/left/top/width/height on its `data-component` node without reading its internals. Fill/grow semantics are suppressed on absolute nodes | no |
| `position: relative` | implied by a `mode:"none"` parent with children, or an autolayout parent with an ABSOLUTE child | NONE-layout container with ≥1 visible child, or autolayout with ≥1 `layoutPositioning: "ABSOLUTE"` child (absolute children are excluded from the stretch-default probe) | no |
| `display: flex` + `flex-direction` | `layoutMode` HORIZONTAL/VERTICAL | same | no |
| `flex-wrap: wrap` | `layoutWrap: "WRAP"` (horizontal only) | same | no |
| `gap` (+ cross gap) | `itemSpacing` (+ `counterAxisSpacing` when wrapping) | same (`row column` shorthand when they differ) | yes (`itemSpacing` alias) |
| `padding` / `padding-*` | `paddingTop/Right/Bottom/Left` | same (shortest shorthand; per-side when aliases bound) | yes, per side (`paddingTop`… aliases; designer-bound only — push has no source) |
| `justify-content` | `primaryAxisAlignItems` (MIN/CENTER/MAX/SPACE_BETWEEN) | same (MIN = `flex-start` stays implicit) | no |
| `align-items` | `counterAxisAlignItems` (+ stretch = MIN with all children `layoutAlign: STRETCH`) | same; the stretch encoding collapses back to the implicit CSS default | no |
| `width` / `height` | FIXED from the measured rect, EXCEPT: content-determined heights push as HUG (`layout.hugHeight` — the serializer forces `height: auto` in a synchronous no-paint toggle and compares; unchanged ⇒ content-sized ⇒ sizing mode AUTO), all-auto-text flex frames hug width (`layout.hug`), text auto-resizes. Skipped for grow children (flow-owned) | FIXED → px; HUG (`AUTO` sizing / text auto-resize) → omitted (so an unauthored height never round-trips as a hardcoded px); FILL (`layoutGrow`/`layoutAlign STRETCH`) → `flex-grow: 1` / `align-self: stretch` | no |
| `min/max-width/height` | never written by push | frame `minWidth`… fields (designer-set only) | no |
| `flex-grow: 1` | `layoutGrow = 1` (from `flex-grow > 0`) | `layoutGrow > 0` along the parent's primary axis | no |
| `align-self: stretch` | `layoutAlign = STRETCH` | `layoutAlign STRETCH` on the counter axis (omitted under a stretch-default parent) | no |
| `box-shadow` | DROP_SHADOW / INNER_SHADOW effects | same (`inset` for inner; x y blur spread color) | no (push never binds effect variables) |
| `opacity` | `opacity` | `opacity < 1` | no |
| `overflow: hidden` | `clipsContent` (from hidden/clip/auto/scroll) | `clipsContent` | no |
| `font-family` | `fontName.family` (first CSS family) | same | no |
| `font-weight` / `font-style` | `fontName.style` (via `cssWeightToFigmaStyle`) | style name reverse-mapped (`figmaStyleToCssWeight`); 400/upright implicit | no |
| `font-size` | `fontSize` | same | no |
| `line-height` | `lineHeight` PIXELS | PIXELS → px, PERCENT → `%` (designer-set), AUTO → omitted | no |
| `letter-spacing` | `letterSpacing` PIXELS | PIXELS → px (0 implicit), PERCENT → em (designer-set) | no |
| `text-align` | `textAlignHorizontal` | same (LEFT implicit) | no |
| `text-decoration` | never written by push | `textDecoration` UNDERLINE/STRIKETHROUGH (designer-set only) | no |
| `text-transform` | never written by push | `textCase` UPPER/LOWER/TITLE (designer-set only) | no |

Known-lossy (push drops it, so pull cannot recover — documented in
`figmaReadCss.test.ts`): `*-reverse` flex directions (push reverses children
instead), non-uniform border widths, font fallback lists, image fills / SVG
innards, padding on non-flex elements (applyLayout skips it for
`mode: "none"`). Children of non-autolayout parents come back as `position:
absolute; left/top` (parent `position: relative`) even when the original CSS
was static flow — Figma NONE layout is free positioning, so absolute is the
faithful readback.

### Block-stack upgrade + the residual FIXED case

Figma NONE frames can neither HUG their content nor host `layoutPositioning:
"ABSOLUTE"` children. The serializer therefore upgrades a NON-FLEX container
to a VERTICAL autolayout frame when its in-flow children form a clean stack
(`blockStackGap`, pure: every in-flow child full-content-width, stacked in
document order with uniform gaps from the padding origin, 1px tolerance;
direct text / inline / floated children veto). CSS-absolute children ride
along as native ABSOLUTE children. This is what lets a content-sized
positioning wrapper (the ProductCard image+badges `div.relative`) round-trip
with no fixed height — the pull emits `display: flex; flex-direction:
column; position: relative` and nothing else.

**Residual FIXED case (documented, accepted):** containers whose in-flow
children do NOT stack cleanly stay `mode: "none"` — Figma requires literal
sizes there, so their width/height (and their children's x/y) round-trip as
fixed px even when content-determined in CSS. Same for `mode:"none"` leaf
frames (no hug surface exists).

### Token variables: units + stale-value refresh

- **Dimension variables are px.** `tokensToCollection` projects `dimension`
  tokens to FLOAT **px** (rem/em × 16, the CSS default root font-size);
  `collectionToTokens` rescales back to the token's original unit on pull.
  Rationale: Figma FLOAT variables bind to px node fields (cornerRadius,
  itemSpacing), so a rem-valued float (`--radius: 0.625rem` → 0.625) would
  render a 0.625px radius when bound.
- **Derived radius scale.** The Tailwind `--radius-sm|md|lg|xl` calc()
  expressions live in the `@theme` block (never parsed as tokens); the theme
  adapter captures them (`parseRadiusScale`), evaluates them per mode against
  the active model (`evaluateCssDimension` — a pure calc()/var() evaluator),
  and publishes them as px FLOAT variables alongside the real tokens. Push
  attribution probes the same expressions (hidden-probe `width`), so a node's
  border-radius equal to a scale value binds to that variable.
- **Stale-value refresh on push** (`render.ts refreshVariableValue`): when a
  component push binds a node property to an existing variable whose value in
  the push's target mode differs from the pushed resolved value, the variable
  is refreshed to the pushed value — the push is the source of truth for the
  tokens it touches. Only variables actually bound during the push, only the
  pushed mode (`tree.meta.mode` → collection modeId; skipped when the mode is
  missing, e.g. single-mode plans); alias values are never clobbered. Surfaced
  in the push notice as `Refreshed N stale token value(s) in Figma (…)` via
  the existing warnings channel.

## Prompt + skill (`formatPullPrompt` + the shipped `figma-pull` skill)

The static ~90% of the old pull prompt (annotation legend, declarative-target
framing, reconciliation rules) moved into a designbook-SHIPPED Agent Skill:

- **`skills/figma-pull/SKILL.md`** — name `figma-pull`; description tuned for
  auto-invocation whenever a prompt mentions a Figma pull target / the
  annotated `data-*` attributes. Body: declarative-target framing, the full
  annotation legend (`data-slot` sample semantics, `data-i18n`
  first-dot-is-namespace rule, `data-token-<prop>`, `data-component`,
  `data-list`, `data-slot-if`+`hidden`, `data-slot-swap`), idiomatic-code +
  minimal-diff + preserve-wiring rules, read-source-first, locale-file rule,
  ambiguity → ask first.
- **Shipping**: `skills/` is in the npm `files` list AND copied to
  `dist/skills` by the build (`scripts/copy-skills.mjs`); resolved at runtime
  from the package root (`packagedSkillsDir`, tries `skills/` then
  `dist/skills`).
- **Loading (trust-INDEPENDENT)**: `src/node/api/piSkills.ts
  createDesignbookResourceLoader` builds the same `DefaultResourceLoader`
  the Pi SDK would build itself (same cwd/agentDir/settingsManager) plus the
  packaged dir as `additionalSkillPaths` — which the loader merges
  UNCONDITIONALLY, while repo `.pi/` resources stay gated by
  `projectTrusted` exactly as before. `api.ts createSession()` passes it as
  `resourceLoader` to `createAgentSession`. Verified by
  `src/node/api/piSkills.test.ts` (real loader, `projectTrusted: false`,
  repo `.pi/skills` NOT loaded, `figma-pull` loaded).

The per-pull prompt is now short (`src/config/figmaPullPrompt.ts`):

```
Update <sourcePath> (component <componentId>) to match the TARGET below — a
declarative Figma pull target. Follow the figma-pull skill for the annotation
format and reconciliation rules; read the current source before editing.

Target was rendered with: locale en-US, theme default, mode light,
flags:tenant=acme. Differences explained by this context (sample values,
translations, flag-driven presence) are NOT design edits.

TARGET (annotated HTML from Figma):
<html>

Keep the edit minimal and idiomatic; if a change is ambiguous or needs
restructuring, ask before editing.
```

The CURRENT SOURCE is never inlined anymore — Pi reads the file itself (read
tools exist even in `--read-only`). The context line is omitted when the
marker predates render-context stamping. The confirm gate is the user's send
click on the drafted chat prompt. The Pi tool variant (`figma_pull_component`)
returns the same short prompt.

## Root marker

`render.ts` stamps the root with sharedPluginData keys `componentId`,
`kind:"root"`, and the ONE JSON marker key `root` =
`{ component, v, render? }` (helpers `formatRootMarker`/`parseRootMarker` in
the pure `figmaRender.ts`; round-trip tested). `componentId`/`kind` are
retained because find-or-update targeting (and nested-main lookup) depends on
them. `v` (schemaVersion) is `1`; `render` was ADDED without a bump —
readers ignore unknown fields; bump only when a field's meaning changes.

`render` is the **render context** the push reflects (PullRenderContext):
`{ locale?, theme? (variant), mode?, dimensions? }` where `dimensions` holds
every OTHER active adapter dimension value (`flags:tenant` etc.), gathered by
`FigmaSyncControls` from the adapter runtime at push time and carried via
`RenderTreeMeta.dimensions`. The pull (`readHtml.ts`) parses it back into
`ReadHtmlResult.render`, `/api/figma/pull` passes it through, and the prompt
renders it as the one "Target was rendered with: …" line so Pi can tell
sample/locale/flag differences from design edits. Markers without `render`
(old pushes) simply produce no context line.

## Phase 4 push decisions (as built)

- **Native Component Properties ARE originated on push, `#`-name is the
  fallback** (Michael's ruling, Change 2). On a component main (nested
  registered components), `render.ts` `authorComponentProperties` authors the
  content slots it can see — today the only push-side signal is i18n text →
  native TEXT properties named `i18n.<ns>.<key>`, wired to the text node via
  `componentPropertyReferences.characters`. The `#i18n.<ns>.<key>` layer name is
  still set (textLayerName), so the pull round-trips whether or not the native
  property took. The ROOT is a plain FRAME (can't hold component properties), so
  its slots fall back to the `#`-name convention by design. The
  descriptor→definition mapping (TEXT/BOOLEAN/INSTANCE_SWAP + the
  `componentPropertyReferences` aspect) lives in the pure, unit-tested
  `src/config/figmaSlots.ts`; the `figma.addComponentProperty` /
  `deleteComponentProperty` wiring in `render.ts` is feature-detected and
  defensively guarded, and is **only verifiable against live Figma desktop**.
  BOOLEAN / INSTANCE_SWAP have no push-side signal yet (mapping is ready,
  origination is a no-op until a signal exists).
- **i18n uses DOT notation, namespace explicit** (Change 1): `#i18n.<ns>.<key>` /
  `i18n.<ns>.<key>` / `data-i18n="<ns>.<key>"`, first-segment-is-namespace split.
- **Nested-component mains are NAMED by their registry id** (`ensureMain`), so
  the pull recovers the id from `instance.mainComponent` without a per-node
  stamp. The main keeps its `componentId`/`kind:main` sharedPluginData as the
  re-push anchor.
- **Per-occurrence text overrides were removed** (`applyTextOverrides` is gone).
  They were matched by per-node `dbId`, which no longer exists; every instance
  now shows its main's text. Accepted (Michael, #3): the pull stops at instances
  and never read overrides. Native instance-level Component Property overrides
  are the eventual fix.
- **Root marker** is `sharedPluginData designbook.root = {"component":id,"v":1}`
  plus the retained `componentId`/`kind:"root"` anchor. No `dbId`/`pushHash`/
  `pushedAt`/`locale` stamps remain.

## Open questions (reversible defaults chosen to keep moving)

1. **Confirm UX location.** Default: the confirm gate is the workbench panel
   ("Send to Pi" = confirm), not a server-side interstitial — matches the
   existing Send-to-Pi affordance and keeps the server stateless. *Q: is a
   client-side confirm sufficient, or do you want the Pi tool itself to require a
   second confirmation turn?*
2. **Token attribute spelling.** Default `data-token-<cssProp>` (uniform,
   HTML-legal). Accepted as-is (#4).
3. **Static CSS fidelity.** Default: emit only the property subset designbook
   already maps, inline, human-legible. Accepted as-is (#5).
4. **`figma_read_html` payload size.** Component-ref + `items[]` template already
   bound depth; no explicit byte cap added (pull HTML is small vs the 25MB push).
   *Q: want a defensive cap anyway?*
5. **Native-property naming charset (NEW — pending live Figma).** Component
   property names are set to `i18n.<ns>.<key>` (contains dots). Figma may reject
   or mangle certain characters in property names; unverifiable without Figma
   desktop. If it rejects dots, the `#`-name fallback still round-trips, so pull
   is unaffected — but native origination for that slot would be skipped. *Q:
   acceptable, or should the property name be sanitized (and the mapping to the
   dotted key stored elsewhere)?*
