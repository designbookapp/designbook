# V spec — agent-generated design variations (rev 2 — DECIDED, build contract)

_Select a component, ask for a few variations, N parallel agent sessions each write one candidate, candidates render on the canvas AS THEY LAND (no reload, ever), the designer keeps / iterates / abandons. Rev 2 incorporates Michael's three redirections (2026-07-09): no globs for variants, no full reload + parallel generation, N ephemeral Pi sessions._

## DECIDED (Michael, 2026-07-09) — locked; this spec is the build contract

All rev-2 settled items stand: `.designbook/variations/` + `index.ts` durable record (no globs); progressive `/@fs/` dynamic-import landing, no reload; N parallel ephemeral Pi sessions under a director, main chat free; compare strip + focus cycler, no app-code wrapper. The former open questions are resolved:

- **D1 consent**: Generate button POSTs directly — no chat draft. Generation writes confined to `.designbook/variations/` (restricted tools + prompt constraints; endpoints write-flagged for `--read-only`).
- **D2 director**: one fast model call proposes N distinct directions; fixed palette fallback when the call fails.
- **D3 iterate-on-one**: inline note on the cell → ephemeral session; main chat stays free.
- **D4 keep-multiple**: promote to a real component file next to the original — **prompt the user for a name**.
- **D5 in-app compare**: v1 = promote-then-look, one-click revertible.
- **D6 (§G import-star attribution)**: separate unit, NOT in this build — spec section stays as future work.
- **Knobs**: default N=3, cap 5, cost estimate shown in the Generate popover; index stores a LOAD THUNK (per-cell fault isolation).

## The one-line architecture

**Variants are files in `.designbook/variations/` — outside every config glob — dynamically imported by the workbench the moment they land** (the dev server compiles any `.tsx` on demand via `/@fs/`), written by N parallel ephemeral Pi sessions under a director, reviewed as live canvas cells that pop in one by one. An `index.ts` in the same dir is the **durable record** (reconstruction after browser reload), not the mount mechanism. Review chrome is workbench UI; no app-code wrapper, no per-framework cost.

## Settled by Michael (do not re-litigate)

1. **No globs for variants** — he dislikes `fromGlob` generally (not enough control); variants live in `.designbook/variations/` with an explicit `index.ts` registration record. Consequence: **any entry can have variants** (the index names its base) — the old "non-glob entries greyed out" limitation is gone.
2. **No full reload; progressive landing** — each variant renders as it lands; virtual-module auto-mount + full reload is fallback-appendix material only (Appendix A).
3. **Generation = N ephemeral in-process Pi sessions** under a main director; main chat session stays free; N× API spend is the honest price.

## Grounding — verified in code (this branch, post-merge d416cda)

- **On-demand compile, both modes** (probed 2026-07-09, throwaway Vite on :8806 against `examples/demo`): `GET /@fs/<abs>/.designbook/variations/X.tsx` → 200, TSX transformed, `import "react"` resolved to the server's optimized dep, relative imports into app source (`../../src/components/ui/button`) resolved, `?t=` cache-bust re-import → 200.
  - **Host mode**: the embedded Vite runs `root: uiRoot` with `fs.allow: [packageRoot, projectRoot]` (`src/node/sidecar/server.ts` ~248) — `/@fs/` absolute paths under the project root are served; root-relative URLs are NOT (root is uiRoot), so always build `/@fs/` + absolute.
  - **Injected mode**: the workbench runs same-origin inside THEIR dev server; Vite's default `fs.allow` is the workspace root, which covers `.designbook/`. Their react plugin transforms `/@fs/` modules like any other. If a repo narrows `fs.allow`, `designbookPlugin` appends `.designbook` via its `config()` hook (one line, our plugin, their config).
  - **Single React**: `dist/ui` externalizes `react`/`react-dom` (+ i18next pair) — `vite.lib.config.ts` — so a dynamically imported variant resolves the same React copy as the app and the workbench chrome in both modes. No duplicate-hooks hazard.
  - **Constraints noted**: use `import(/* @vite-ignore */ url)`; dev servers set no CSP (an app whose CSP blocked its own dev origin couldn't HMR either); Vite 6/7 environment API still serves `/@fs` through the client environment.
- **Ephemeral sessions pattern**: `src/node/api/sessionRegistry.ts` (per-branch sessions, 454c706) proves in-process multi-session — lazily created, cwd-scoped, `abort()`+`dispose()`, ~15–25 MB each. The variations orchestrator reuses the shape, not the registry (variant sessions are keyed by set+slug and disposed at turn end, never reconciled against worktrees).
- **Event channel**: `api.ts` `broadcast(eventName, payload)` fans out named SSE events to all `/api/events` clients (pi-event, state, branch-status, server-notice precedents). Variations add a `variations-event` — same channel, new name; the UI already holds an EventSource.
- **Changes tab**: `.designbook/` is tracked, not gitignored (e.g. `.designbook/figma/*.json` shows as modified in git status) — variant files appear as "New" rows with delete-file discard; `useChanges` refreshes on `agent_end` + `designbook:fileWritten` + visible-tab poll.
- **PreviewCell renders any `RegistryEntry`-shaped object with a `load` thunk** (`makeLazyComponent`) — set wrapper, Suspense, per-cell red error boundary, retry included. The review model synthesizes entries; `componentRegistry` itself is untouched.
- **Selection context** (in flight, another branch): the brief consumes its facts/prompt block when it lands; until then `CanvasNodeSelection` suffices.

## A. Materialization — `.designbook/variations/` + `index.ts` record (settled; mechanics below)

**Files**: `.designbook/variations/<setId>.<Key>.<slug>.tsx` (e.g. `product.ProductCard.compact.tsx`). The dir is dedicated, so names only need to be unambiguous across sets — the full entry id in the filename gives that plus sortability; the index stays authoritative.

**MONOREPO RULE (canonical path base — added after the 2026-07-09 sidecar dogfood).** The APP owns its variations: the home is **`<configDir>/.designbook/variations`**, where `configDir` is the designbook config file's directory. In a single repo `configDir` = repo root and nothing changes; in a monorepo (`projectRoot` = git root ≠ `configDir`, e.g. `examples/demo`) variants live at `examples/demo/.designbook/variations`, **never at the git root**. Rationale: the variant imports app source, the app's Tailwind source scope covers app-owned dirs (v4 auto-detection roots at the app), and the `/@fs` import + promote targets are app files. ONE base is used by all five sites — the session prompt's target path (repo-root-relative, session cwd = `projectRoot`), the post-turn verifier, the `/@fs` dynamic import (landing events carry `absPath`), the `index.ts` record, and the resolve/promote endpoints (`appDir` = config dir rebased into the active repo root, so branch worktrees keep the same relative home). The variant prompt states the computed import prefix (no hardcoded `../..`).

**Failure diagnostics (same dogfood).** A turn-level provider error (quota exhausted, auth, 4xx) RESOLVES `session.prompt()` — the failure exists only on the transcript (`stopReason: "error"`). The orchestrator's `RunTurn` therefore returns `errorMessage`, and a failed cell always shows: the real turn error when there was one, otherwise "no file written at `<expected target path>`" plus the session's final assistant text (truncated). The generic sentence alone is banned — "why" must never be invisible.

**`index.ts` — durable record, not mount mechanism.** Written incrementally by the ORCHESTRATOR (deterministic append as each variant lands — never agent-authored, so parallel sessions can't collide on it):

```ts
// .designbook/variations/index.ts — maintained by designbook; safe to delete (abandons all).
export const variations = [
  {
    baseEntryId: "product.ProductCard",
    slug: "compact",
    intent: "tighter density, image-left, one-line meta",
    sourcePath: ".designbook/variations/product.ProductCard.compact.tsx",
    load: () => import("./product.ProductCard.compact.tsx"),
  },
] as const;
```

- `load` thunk rather than Michael's eager `component` field: an eager re-export makes one broken variant poison the whole index import; the thunk keeps per-cell fault isolation (red cell, retry) — same reasoning as C4's lazy entries. The record still carries everything his shape asked for (base, slug, path; the component is one call away).
- Used ONLY to reconstruct a review after browser reload: boot tries `import(/* @vite-ignore */ "/@fs/" + projectRoot + "/.designbook/variations/index.ts")`; module-not-found → no pending sets. During generation the strip never waits for it — cells mount straight off the landing events. Repo stays the only store.
- **Structural virtue of the location**: `.designbook/` is matched by NO config glob and no app-source glob — writing variants never invalidates the config module, so there is **no reload during generate/review by construction**, in both modes.
- Variant modules import app source directly (relative paths or the repo's own aliases — both verified/native); they render under the base entry's set wrapper via the synthesized entry, so context/atoms/i18n behave exactly like the original.
- **Rendering**: review model synthesizes `{ id: "variation/<base>/<slug>", setId: base.setId, key, sourcePath, load: () => import(/* @vite-ignore */ "/@fs/" + absPath) }` → `PreviewCell` unchanged. Landing events carry both repo-relative and absolute paths so the UI never guesses the root.
- **Cleanup**: keep/abandon = delete variant files + their index entries (orchestrator-side, atomic). Deleting `index.ts` by hand abandons everything — a designed property, not an accident.

Rejected (rev 1 recap, still true): one-file/multi-export (HMR-poisons the original, unreadable diffs), branch/worktree per variant (can't compare side by side in one canvas; right tool for whole explorations — composes), virtual modules (state outside files; per-bundler hook; now also strictly worse than `/@fs/`, which needs no hook at all).

## B. Generation — director + N parallel ephemeral sessions

**Entry point**: component selected → "Variations…" opens a small popover: direction hints (free text), count (default 3, cap 5), model, estimated cost note. **Generate** button POSTs directly:

```
POST /api/variations/generate { baseEntryId, sourcePath, direction?, count? } → 202 { setId }
```

Direct POST, not a chat draft: generation writes ONLY into `.designbook/variations/` — additive, sandboxed, one-click discardable — so the button is an adequate consent gate; the destructive steps (promote/overwrite) have their own explicit buttons. This is a philosophy deviation from the figma-pull draft-to-chat rule (which guards edits to *app code*); flagged as open question Q1.

**Orchestrator** (in `api.ts`, alongside the session factory):

1. **Shared brief** = component source + props/context facts (selection-context block when available) + user direction + the `variations` skill rules.
2. **Director step** (recommended, load-bearing): ONE fast model call that proposes N *distinct* direction one-liners from the brief (e.g. "compact / editorial / bold"). Without it, N independent sessions given the same brief converge on similar output — the main failure mode of parallel generation. Fallback when the call fails: a fixed direction palette (density / hierarchy / emphasis / layout).
3. **Fan-out**: per slug, one ephemeral `createAgentSession({ cwd: projectRoot, … })` with a restricted toolset (read + write/edit; no bash — narrower, cheaper, safer) and a narrow prompt: brief + its assigned direction + *"write EXACTLY `.designbook/variations/<file>`; do not touch any other file; one component export; identical props contract."* Distinct target files ⇒ no write collisions by construction.
4. **Per-session completion**: turn ends → orchestrator stats the target file → appends the registration to `index.ts` → `broadcast("variations-event", { kind: "landed", base, slug, intent, path, absPath })`. Missing/broken file → `{ kind: "failed", slug, error }`. Session `abort()`+`dispose()` immediately (the ~15–25 MB is held only for the turn's duration; N=3–5 concurrent is well inside what the per-branch registry already tolerates).
5. **Partial sets**: the strip shows landed cells + a failed placeholder per failure with Retry (spawns one new ephemeral session). A set with some landed + some failed is fully usable — never wait for M of M.
6. **Iterate on one** (prompt-back): inline input on the cell → `POST /api/variations/iterate { base, slug, note }` → one ephemeral session scoped to that file → `{ kind: "updated", … }` event → cell re-imports with `?t=` cache-bust and remounts (probe-verified; deterministic in both modes, no react-refresh dependency). Main chat stays free throughout — that's the point of the ephemeral pool.
7. **Status**: in-flight state is server memory + events only; after a browser reload, whatever `index.ts` lists = landed, and the still-running orchestrator keeps emitting events to the reconnected EventSource. After a *server* restart, in-flight generations are simply gone; landed variants persist (files). Honest and repo-consistent.

**The `variations` skill** (packaged, loaded via the existing `additionalSkillPaths` seam — `piSkills.ts`): read the base source first; never touch any file except the assigned target; one component export; identical props contract + context expectations; reuse the app's atoms/i18n keys/tokens; imports point at app source (relative or repo alias); first line = provenance header with the intent one-liner; vary *direction*, not palette-noise.

**Cost note (the honest price)**: N variants = N parallel agent turns ≈ N× the API spend of one edit turn, plus one small director call. The popover shows count × model up front; default 3.

## C. Review UI — progressive compare strip + in-place focus cycler (settled shape, progressive behavior)

- Generate → the entry's detail view flips to **Compare** layout immediately, header "Variations of Card — 0 of 3 landed", with per-slug skeleton frames (direction one-liners appear as soon as the director step returns).
- Each `landed` event pops that cell in (dynamic import → PreviewCell). Cells arrive out of order; the strip never blocks on the set. `failed` → red placeholder + Retry.
- Frames are live cells: theme / locale / viewport / dataset switches drive original + all landed variants at once.
- Per-frame chrome: slug + intent, **Keep**, **Iterate** (inline note input → ephemeral session → cell remounts on `updated`), **Discard**. Strip header: **Keep original** (= abandon all), landed count.
- **Focus cycler** (Michael's "minimized" mode): click a frame → Single layout renders that variant in the original's exact spot, chrome `◀ compact (2/4) ▶ · Keep · Iterate · Back to compare`. Pure workbench chrome; the cycler just swaps which synthesized entry the cell renders.
- A toolbar pill ("Reviewing Card — 2 of 3") jumps back from anywhere; multiple concurrent sets (Card AND ResultsList) each get their own pill/strip, isolated by base entry id.
- Browser reload mid-review: index import reconstructs landed variants; in-flight ones re-announce via events. No state beyond files + live server memory.

## D. Decision semantics — file ops, Changes-tab-visible, never committed

| Action | Ops | Notes |
|---|---|---|
| **Keep one** | Write original file ← variant content with relative import specifiers REBASED from `.designbook/variations/` to the component's dir (deterministic path math, done server-side at promote time; provenance header stripped); delete the set's variant files + index entries | Original hot-updates per-cell (file exists → normal HMR, **no reload**). Changes: original "Edited" (discard restores), variant rows gone |
| **Iterate** | none (ephemeral session edits the variant file) | cell remounts via `?t=` re-import |
| **Keep multiple** | Promote each extra keep to a real component file next to the original (imports rebased, name chosen or auto `<Base><Slug>`); wiring it into the SET is set-style-dependent: a glob set picks it up via the glob (one config reload **at decision time**, review already over); an explicit-index set gets a drafted chat prompt ("register CardCompact in the product set") or a deterministic index edit once the main-set index style (§G) lands | Honest cost stated; never during review |
| **Discard one / Abandon all / Keep original** | Delete variant file(s) + index entries; empty index deleted | Same op as Changes-tab delete-New |

`POST /api/variations/resolve { base, action, slug?, newName? }` performs each row atomically (multi-file: content write + deletes + index rewrite) so a half-applied keep can't strand files. designbook still never commits; the user commits when the exploration settles.

## E. Wrapper / framework — settled: none

All review chrome is workbench UI (shadow-DOM chrome, light-DOM cells). Variants render through the same dev-server-compiled path as everything else, on the app's single React. The dynamic-import mechanism is **bundler-level** (`/@fs/` is Vite; a webpack target someday needs the equivalent serve-on-demand URL), never framework-level — no React wrapper now, no Vue wrapper later.

## F. Tie-ins

- **Selection context**: brief consumes its facts block when that spec lands; zero coupling meanwhile.
- **In-app compare**: v1 = promote-then-look (instant, one-click revertible). Live module-alias swap in `designbookPlugin` (`resolveId` override serving the variant in the original's place) remains the later, bundler-level option — now philosophically adjacent to the `/@fs/` mechanism already in use.
- **Figma push** applies to a kept variant as-is; **fidelity runner** can score variants later; a **flow-screen** strip falls out once synthesized entries exist.

## G. Separate future unit — `import * as components from "../folder"` for MAIN sets

Michael wants explicit imports (an index/barrel per folder) instead of `fromGlob` for main sets too. Components themselves are trivial (`components: componentsNamespace` already works — eager references render today). The one real problem is **per-component `sourcePath` attribution**, which glob keys currently provide free (code panel, change badges, selection→prompt, figma sync all key off it). `sourceModules` (an eager glob) also solves it today — but it's a glob, i.e. the thing being removed. Options:

1. **Explicit paths in config** — `EntryOverride.sourcePath` already exists per entry. Portable, zero build machinery; verbose (one line per component) and drift-prone on renames.
2. **Barrel-resolving transform** *(recommended)* — a small Vite transform (in `designbookPlugin` AND the embedded server — same plugin, both modes) that, when the config imports a barrel, resolves `export { X } from "./X"` / `export * from` chains at serve time and injects a `component → repo path` map (same brand mechanism as `readLazyMeta`). Zero authoring cost, rename-proof, works for `import * as`; cost is per-bundler (Vite now — acceptable, that's where designbook lives; option 1 is the documented fallback for anything else).
3. Runtime heuristics (`Function.name` + convention) — unreliable across minification/HOCs; reject.

Recommendation: **2 with 1 as the portable fallback**, shipped as its own worktree-agent unit (small–medium), independent of the variations build. Variations don't depend on it: the variations index carries explicit `sourcePath` per record regardless (the generator knows the paths it assigned — attribution is free there, exactly as Michael noted).

## Build plan (worktree-agent-sized units)

1. **V1 — dynamic-import rail** (small): `variationsModuleUrl(absPath)` helper + synthesized-entry rendering through `PreviewCell` + boot-time index import/reconstruction; hand-written variant file + index prove host AND injected modes. Unit tests on the entry synthesis + index parsing.
2. **V2 — orchestrator + skill** (medium): `variations` skill; `POST /api/variations/generate` + director step + ephemeral-session fan-out (restricted tools) + per-session landing verification + `index.ts` append + `variations-event` broadcast + disposal; failure/retry paths. Registry-style lifecycle tests against fake sessions (the `sessionRegistry` test pattern).
3. **V3 — progressive strip + cycler** (medium): Compare layout with skeleton→landed→failed frames, per-frame Keep/Iterate/Discard chrome, inline iterate input (`/api/variations/iterate`), toolbar pill, `?t=` remount on `updated`, reload-reconstruction test.
4. **V4 — resolve ops** (small–medium): `POST /api/variations/resolve` (keep / keep-many / discard / abandon; import rebasing; atomic), Changes-tab interplay tests, keep-many set-wiring (glob sets automatic; index sets → drafted prompt).
5. **V5 — later**: G's barrel transform; in-app alias swap; figma push of a pending set; fidelity scoring; early-pop via fs.watch (cells appear at first write, before the session's turn ends).

## Watch-outs

- **Tailwind content**: v4 auto-detects non-gitignored sources — `.designbook/` is tracked, so variant classes get CSS. Tailwind v3 repos with explicit `content` globs need `./.designbook/variations/**/*.tsx` added — doc note + init check.
- **`fs.allow` overrides** in the target repo can block `/@fs/` to `.designbook` — `designbookPlugin` appends it defensively (config hook).
- **Import rebasing at promote** is the fiddliest deterministic piece (relative specifiers, css/module imports) — unit-test hard; bail to a drafted agent prompt on anything non-mechanical (e.g. name collisions).
- **Orchestrator writes to `index.ts` must be serialized** (single in-process queue) — parallel sessions finish at arbitrary times.
- Ephemeral sessions must not pollute the branch-session registry, its statuses, or the main chat's SSE thread — `variations-event` is a separate event name; pi-events from ephemeral sessions are NOT re-broadcast to the chat (subscribe only for status tracking).
- Direction convergence without the director step — keep the fixed-palette fallback deterministic so N sessions never receive identical prompts.
- `.designbook/variations/` must stay out of any future config glob advice/docs.

## Appendix A — fallback: virtual-module auto-mount (NOT the design)

If on-demand `/@fs/` import hit an unforeseen wall in some bundler mode, the fallback is a virtual module (`virtual:designbook-variations`) that re-exports the variations dir and is invalidated on write — auto-mount via config-adjacent import, at the cost of a module-graph invalidation (and in the worst case the deferred-reload pill) per landing. Kept only as an appendix: the probe shows the primary mechanism works, and the fallback reintroduces exactly the jarring reload Michael rejected.

## Open questions

1. Consent gate: Generate button POSTs directly (writes confined to `.designbook/variations/`) — ok as deviation from draft-to-chat, or route the brief through chat anyway?
2. Director step: one fast model call proposing N distinct directions (recommended) vs fixed palette only — spend the extra call?
3. Iterate-on-one: inline input on the cell via ephemeral session (recommended, keeps main chat free) vs drafting into main chat?
4. Keep-multiple naming: prompt for name vs auto `<Base><Slug>`?
5. Default N=3 / cap 5 / show cost estimate in the popover — ok?
6. Index record: `load` thunk (per-cell fault isolation) vs Michael's eager `component` field — thunk ok?
7. Promote-then-look still acceptable for in-app compare v1?
8. §G barrel transform: schedule as its own unit now or after variations V1–V4?
