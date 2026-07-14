# Compat spike — zero-config onboarding across 4 real repos

_2026-07-05. Working doc for the multi-agent compatibility effort. Orchestrator: main Claude session. Goal: designbook "just works" on real repos (Storybook philosophy: zero-config by default, special settings only as overrides). Not just cataloguing — fix/support as we go._

## Design principle (decided)
Prefer **auto-detection in core** over required config: merge the repo's own `vite.config` (today we run `configFile:false` and ignore it — server.ts:71), mine tsconfig paths, auto-detect adapters (i18next vs Lingui, Tailwind vs Emotion vs SCSS, flags). `designbook.config.tsx` = override layer, not entry fee.

## Test repos (each = one subagent in own worktree)
| Agent | Repo | Stack | Stresses |
|---|---|---|---|
| A | excalidraw/excalidraw (~99MB) | React 19 + plain Vite, custom JSON i18n, SCSS | most likely to boot; custom i18n adapter; canvas-heavy component discovery |
| B | documenso/documenso (~264MB) | React Router 7 framework mode + Vite 7, Tailwind, Lingui | framework-mode Vite conflict; Tailwind theme should work; Lingui |
| C | twentyhq/twenty (`packages/twenty-front`) | React 19 + Vite, Emotion theme, Lingui, built-in flags | monorepo scoped import; tsconfig aliases; CSS-in-JS theming; real flags |
| D | calcom/cal.com | Next.js + next-i18next + Tailwind monorepo | no Vite at all — scope what's possible (component-level render w/ shims vs needs Next runner) |

## Process loop
1. **Repo agents (A–D)**: designbook worktree each; shallow-clone target repo into a gitignored dir inside the worktree (e.g. `tmp-repos/`, add to .gitignore); link workspace `designbook` package; write a `designbook.config.tsx`; attempt boot + browser-verify canvas. Iterate: fix what they can locally (config-level; small core patches allowed in-worktree but flagged). Report: booted?, issues categorized (build-env / framework / adapter-gap / core-bug), local patches, recommended core changes.
2. **Orchestrator triage** into: (a) **core features** — spec → dedicated builder subagent on main → repo agents rebase + retry; (b) **adapters/plugins** — e.g. Lingui text adapter, Emotion theme adapter, custom-i18n hooks; (c) **acceptable per-repo config** (the Storybook-style special settings).
3. Repeat until all four boot with minimal config (D may conclude with a scoped "what Next support requires" spec instead of a boot).

## Anticipated core items (verify via agents before building)
- Respect/merge user `vite.config` (biggest lever; replaces configFile:false)
- tsconfig path aliases
- Adapter auto-detection framework
- SCSS/preprocessor passthrough; CSS-in-JS theme adapter story
- Next.js strategy (separate track)

## Round 1 results (2026-07-05)
| Agent | Boot | Core patches needed |
|---|---|---|
| A excalidraw | FULL (module-graph, curl-verified) | sidecar vite-config merge (resolve/css/optimizeDeps); `sass` as designbook dep |
| B documenso | FULL for 16 macro-free `packages/ui` primitives | none (config-only + hand-written Tailwind v3→v4 `@theme` bridge shim) |
| C twenty | PARTIAL — JS graph 200s after core patch; CSS layer blocked | tsconfig-paths resolution + `@ui` de-collision; `sass-embedded`; repo scss options + forced-Tailwind conflicts remain |
| D cal.com | FULL for `packages/ui` (Form barrel incl.) | sidecar alias merge + 3 `next/*` shims. Next spec: T1 shims (built) / T2 auto-shims+paths / T3 embed Next dev server (separate product) |

## Triage #1 → round-1 core build (builder agent)
**(a) Core** — 1. user-Vite bridging: auto-detect repo `vite.config` (safe allowlist: `resolve.alias`, `css`, `optimizeDeps`, `define`; monorepo app-dir scan) + explicit sidecar `designbook.vite.{ts,mjs}` incl. appended `plugins` (A+D built convergent versions). 2. importer-aware tsconfig paths (`vite-tsconfig-paths`; C's flat version can't disambiguate per-package `@/`). 3. rename designbook's internal `@ui` alias (squats common user alias). 4. ship `sass` with designbook (Vite resolves preprocessors from OUR root — target's install invisible; A+C hit identically). 5. don't let `@tailwindcss/vite` break non-Tailwind repos (Lightning CSS rejects twenty's sass). 6. Next.js shim pack auto-applied when `next` detected (bundle D's link/navigation/image shims).
**(b) Adapters/plugins (later rounds)** — Lingui text adapter + macro compile (needs babel/swc plugin-injection seam; B ~40 components, C twenty-front); Tailwind v3 token auto-bridge (B shimmed by hand, D same gap); custom-`t()` i18n adapter (A); CSS-var/Emotion runtime theme adapter (C); server-only-import guard (B's prisma leak — partly solved by optimizeDeps merge).
**(c) Acceptable per-repo config** — scoped component registration (no barrels/wildcards; all 4 agents), provider wrappers, deep-source imports for monorepo internals.

## Round-1 retry results (post-fce5a55)
| Agent | Verdict |
|---|---|
| A excalidraw | **ZERO-CONFIG** — auto-detect found `excalidraw-app/vite.config.mts`, merged `@excalidraw/*` source aliases; 9 components (incl. full App.tsx graph, jotai-wrapped editor pieces) |
| B documenso | PASS w/ sidecar; **regression zero-config**: auto-merged `css.postcss` (Tailwind v3) poisons bridge CSS + tailwind detection misses nested-workspace v3 → v4 plugin wrongly scoped. RR7 safety held (config loaded, plugins not merged, prisma alias merge helps) |
| C twenty | **CSS-COMPLETE** — all 4 round-1 blockers fixed zero-config; 7 twenty-ui components + scss modules end-to-end. Sidecar still needed for cross-package scss options + unbuilt-dist workspace aliases |
| D cal.com | **ZERO-CONFIG** — auto next-shims substituted in transforms; stretch set (Dialog/Dropdown/Alert/List/EmptyScreen/TopBanner/Toast) all clean |

## Triage #2
**Round-2a bugfixes (core, small):**
1. `tailwind-scope-miss` (B, breaker): tailwind detection must also count nested workspace members + detected-vite-config `css.postcss` containing tailwindcss
2. `css.postcss` poisoning (B, breaker): drop `css.postcss` from the auto-merge allowlist (keep preprocessorOptions/modules)
3. unresolvable auto-merged `optimizeDeps.include` (B, noise): resolve relative to detected config dir; drop what doesn't resolve
4. wrong-package vite-config fallback (C `create-twenty-app`, D `packages/embeds`): restrict candidates to configDir ancestors + packages the config's package depends on; no alphabetical sibling scan
5. next-detection false positive (A/B/C): require declared dep; remove bare `node_modules/next` existence check
6. bundle `next/dynamic` shim → React.lazy wrapper (D)

**Round-2b features (core, medium) — RESPEC'd 2026-07-05 to the Storybook model (decided: inheritance over injection; maximizes repo coverage — the repo's own config already describes a working build):**
7. **Plugin inheritance + react dedupe** (replaces the injection-API idea): auto-merge the detected repo vite config's `plugins` with a deny-list of framework/server plugins (react-router/remix, next, astro, pwa, ssr/framework plugins…); if the user's plugins include `@vitejs/plugin-react` or `-swc`, use THEIRS (their babel/swc plugins ride along — Lingui macros work with zero new config surface) and drop ours; else keep ours. Sidecar plugins remain the `viteFinal`-style escape hatch. This is exactly how Storybook's vite builder gets macros/svgr for free.
8. workspace-dep css collection (union `css.preprocessorOptions` from workspace packages the config's package depends on; closest wins, sidecar beats all) + synthesize source aliases when workspace `exports` point at unbuilt `dist/` but `src/` exists — would zero out C's remaining sidecar
9. (roadmap, post-spike — structural follow-up) prebuild/isolate the workbench UI + same-origin iframe preview so the Vite pipeline belongs purely to the target repo; same server/port (static mount + middleware), later proxy foreign dev servers (Next) through our origin. Eliminates the css/plugin-collision class; prep for the Next runner. Requires plumbing fibers/serializer/overlays through `contentDocument`.

**Round-3+ adapters:** Tailwind v3 token auto-bridge (B/D), custom-`t()` i18n (A), CSS-var themeAdapter targeting (C — twenty is Linaria + CSS vars, NOT Emotion; brief updated), Lingui text adapter (after 7).

## Status
- [x] Agents A–D launched (2026-07-05; own worktrees; ports A:8811 B:8822 C:8833 D:8844)
- [x] First reports in (all 4, 2026-07-05)
- [x] Triage #1 → core specs (above)
- [x] Round-1 core fixes shipped (fce5a55: userVite bridging, tsconfig-paths, @ui rename, sass, tailwind scoping, next shims)
- [x] Round-1 retry done: A/D zero-config, C CSS-complete (justified sidecar), B pass-w/-sidecar + 2 core bugs
- [x] Triage #2 (above)
- [x] Round-2a bugfixes shipped (0a69851; + demo check-types repaired)
- [x] Round-2b shipped (423fca0: plugin inheritance + react dedupe + workspace css collection + source-alias synthesis)
- [x] Round-2b verify: **B documenso — Lingui macros COMPILE via inherited babel-macros plugin, sidecar obsolete (model validated)**; **C twenty — fully zero-config, sidecar deleted**; A excalidraw — pass after deny-list addition
- [x] Round-2c safety fixes shipped (4455f93 + follow-up): deny write-side-effect plugins (vite-plugin-sass-dts rewrote 95 repo files on twenty), dev-tooling checkers (vite-plugin-checker crashed server on excalidraw), dev-server middleware (@hono/vite-dev-server hijacked `/` on documenso); serialize loadConfigFromFile; traceable next-detection log; optimizeDeps.include filtered by designbook packageRoot (the only root that predicts Vite-optimizer resolvability)
- [x] Round-2c verified: B — workbench 200, hono denied, macros compile, warnings gone (after packageRoot filter fix); C — repo stays clean (0 dirty, was 95), scss zero-config end-to-end

## Final state (2026-07-05)
All four repos boot **zero-config** (only `designbook.config.tsx`): excalidraw 9 components incl. full editor graph; documenso 16 primitives + Lingui-macro components compiling via inherited babel-macros; twenty 8 components w/ scss modules via workspace-dep css collection + synthesized source aliases; cal.com 13 components via auto Next shims. Core shipped across fce5a55/0a69851/423fca0/4455f93: user-Vite bridging (sidecar + auto-detect), plugin inheritance w/ deny-list + react dedupe (Storybook model — decided over injection API), importer-aware tsconfig paths, @ui→@designbook-ui, bundled sass, scoped tailwind, next shim pack, workspace css collection, source-alias synthesis, inheritance safety denies.

**Known residuals:** ERR_INTERNAL_ASSERTION on 2 twenty workspace configs (require-of-in-flight-ESM inside Vite's loader, graceful skip, non-blocking); next-detection intentionally broad (shims lowest-precedence, log names trigger); twenty-front Lingui needs sidecar `plugins` (their lingui-swc config structurally unloadable).

## Browser verification round (2026-07-05, human-driven)
All 4 checked live in Chrome. Runtime-only issues curl missed: Linaria `styled` runtime trap (twenty-front component blanked the app — removed from config; needs sidecar plugins), missing `ReadonlyURLSearchParams` in next/navigation shim (fixed, f493f18), `process is not defined` (Next define polyfill added to shim pack, ff80a2f). **Code-panel gap**: repo configs lacked `sourceModules` (source map for code panel) and agent A registered demo wrappers, which can never match the glob — added `EntryOverride.sourcePath` to core so wrappers can point at the real file; all 4 configs fixed + verified (excalidraw shows real FilledButton.tsx). Lessons for round 3 + onboarding agent: (1) configs must include `sourceModules` (exclude `*.test/stories.tsx` — eager glob executes them) or per-key `sourcePath` overrides; (2) demo wrappers w/ sample props are the RIGHT pattern (bare registrations render empty) but need sourcePath overrides; (3) verification must include a real browser render — transform-level curl checks miss runtime traps; (4) broad eager globs trigger dep re-optimize reload churn — keep them scoped.

## Round 3 progress (2026-07-05)
- [x] **Tailwind v3 token bridge shipped** (tailwindBridge.ts): auto-detects v3 per-config (mixed-major monorepos handled), loads their tailwind.config via THEIR resolveConfig (presets, TS via jiti), generates v4 `@theme inline` + dark variant into a virtual css entry (`@source` repo scan; tailwind scoped to uiRoot for v3 repos), strips v3 `@tailwind` directives from repo css. Proven live on documenso (316 tokens, `bg-primary`→`hsl(var(--primary))`); demo v4 inert. Note: cal.com clone upgraded to Tailwind v4 upstream — bridge correctly inert there; their tokens need their v4 @theme css imported in config. `@apply` in global css not converted (deferred).
- [x] **Presentation polish** (excalidraw + twenty configs): `.excalidraw` scoping class + `standalone` buttons; twenty's `theme-light/dark.css` token imports; demo wrappers w/ realistic props + sourcePath overrides; browser-verified styled + code panel. Onboarding-agent lesson: discover the repo's theming entry (scoping class + token css) and wire it into the config.
- [x] **Docs site** (docs-site/, Astro Starlight, 26 pages from source; c5fb9c0)

- [x] **Custom-adapters proof** (config-level, no core changes): twenty themeAdapter on real `--t-*` tokens (994; mode-sync adapter bridging designbook `theme:mode` ↔ their ThemeProvider; live edit verified) + excalidraw custom text adapter (reverse-lookup claim on their `t()`, edit wrote real `locales/en.json`). **7 SDK gaps → adapter-SDK-hardening backlog (roadmap Phase 0):**
  1. themeAdapter source is single-file — no per-mode source map (twenty splits light/dark across files; needed a generated merged css)
  2. `readDeclarations` regex breaks on `;` inside values (`url(data:image/png;base64,…)`)
  3. `cssVarEdit.findBlockRange` unguarded indexOf — duplicate selectors (`.light{}` twice) written by file-order luck
  4. marker/hit-test toolkit not exported publicly (only via internal `@designbook-ui/*`) — export from `@designbookapp/designbook/adapters` for non-i18next systems
  5. `TextClaim.getTemplate` undocumented; omitting silently opens empty editor
  6. text tool can't reach `title`/`aria-label` (buildHit reads textContent only)
  7. no post-save re-render path for static-snapshot i18n (excalidraw t() reads import-time JSON; needs reload)
  Also: worktree configs get IDE TS errors (`Cannot find module '@designbookapp/designbook/config'`) — clones lack the dep; `designbook init` should write tsconfig paths hint.

- [x] **Lingui text adapter shipped** (6945ec9): wraps repo's @lingui/core instance for marker injection; PO-format-preserving writes via POST /api/po; optimistic catalog refresh; live-verified on documenso. v1 skips ICU placeholders/plurals.
- [x] cal.com config: v4 theme root (designbook.css importing their tokens.css + @source scan), TooltipProvider + Skeleton demo wrappers w/ sourcePath overrides

**Round-3 remaining:** custom-`t()` toolkit generalization (excalidraw adapter works but via reverse-lookup; needs public marker toolkit — SDK gap 4), twenty-front Lingui (blocked on their unloadable vite config → sidecar), presentation props for documenso/cal.com sets (bare registrations), SDK-hardening pass (gaps 1–7 above) — styling gaps are the "doesn't look great" factor: Tailwind v3 token bridge (documenso/cal.com unstyled), excalidraw CSS-var scoping (`.excalidraw` class wrapper), sample-props wrappers for twenty/documenso, TooltipProvider-style missing contexts (cal.com), Skeleton import mismatch (cal.com).
**Round-3 adapters (as before):** — Tailwind v3 token auto-bridge (documenso/cal.com semantic tokens unstyled), custom-`t()` i18n adapter (excalidraw), CSS-var themeAdapter targeting (twenty — Linaria + CSS vars, not Emotion), Lingui text adapter. Plus roadmap item 9 (prebuilt workbench + same-origin iframe preview — structural collision fix + Next-runner prep).
