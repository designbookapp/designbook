# C4 spec — config in their build, formalized (OSS launch line)

_Phase C4 of [runtime-topology.md](../runtime-topology.md). Goal: the config's component graph becomes per-cell lazy — compiled by whichever bundler owns the config (theirs in injected mode, ours in host mode) — so one broken component is one red cell, never a dead workbench. Plus the injected-mode adapter story (host context) and the OSS onboarding surface. Host mode keeps working throughout; every stage lands green._

## Non-goals

Next/webpack (C5). Hosted convergence (C5). Model-A protocol work. No redesign of adapters — they gain a context *source*, not a new model.

## Design decisions (settled, do not re-litigate)

- **No plugin codegen needed for laziness**: non-eager `import.meta.glob` already returns `Record<path, () => Promise<module>>` — per-cell dynamic imports compiled by the owning bundler. C4 is config API + registry + error-boundary work, not a codegen engine.
- **Static registration stays supported** (`components: { Button }`) — it just can't give fault isolation (a broken static import fails the config module itself). Docs state the tradeoff; glob/lazy is the recommended path.
- **Failure modes contract** (from the decision record): broken component compile → one red cell (this phase); their app crashes at boot → workbench still opens (done, S1/C3); their dev server down → recovery page (done, C3.2); crash after load → toolbar badge (done, C3.1).
- **Host context** (Michael's Q&A): adapters can read live app state via config-declared getters (e.g. `locale: () => i18n.language`) and via fiber context reading (tenant-wrapper case). Collapsed/toolbar mode follows the app; the expanded canvas uses our switchers as today.

## Stages

### C4.1 — Lazy entries + per-cell error boundaries

1. **Registry accepts lazy component sources.** A set's `components` value may be, besides a component: a thunk `() => Promise<Module>` (a raw `import.meta.glob` entry). Resolution: prefer the export matching the entry key, else default export, else the module's sole component export; `overrides[key].exportName` forces it. Inspect `componentRegistry.ts` + `config/index.ts` types and keep `RegistryEntry.component` shape stable for consumers (a lazy entry materializes through React.lazy or an internal cache — builder's call, but fibers/hit-testing/serializer must keep working on the rendered result).
2. **Cell error boundary**, both canvas grid cells and the detail-page preview: import rejection OR render throw → a red cell (component name + first error line + retry button); everything else keeps rendering. Suspense fallback for the loading gap (subtle, no layout jump). HMR: a hot update that fixes the module clears the error on retry/re-render.
3. The config module itself failing to evaluate is still fatal (it's the user's code) — but the error must surface readably: workbench (or toolbar in injected mode) shows the config error instead of a blank screen. Check what happens today; fix if blank.
4. Selection/persist compatibility: a cell that errors has no `[data-db-entry]` content — C3.4 restore already drops silently (verified); keep it that way.

**Accept**: demo (host mode) with one entry converted to a thunk + a deliberately broken component file → grid shows one red cell, rest fine, detail page shows the red cell, fix file + retry recovers. Same demo in the scratch client-app (injected, prebuilt dist) via the tarball flow. Tests for export-resolution + error-boundary states. All 371+ tests, check-types, build green.

### C4.2 — Glob auto-registration

1. New config helper (in `@designbookapp/designbook/config`): `fromGlob(import.meta.glob("./src/components/*.tsx"))` → a `components` record: keys from file basename (PascalCase preserved, dedupe collisions by parent dir), values = the lazy thunks from C4.1. Options: `include`/`exclude` (e.g. drop `*.test.tsx`, `*.stories.tsx` — eager globs executing test files was a real incident), `key` mapper.
2. **sourcePath for free**: the glob key IS the source path — auto-fill the code panel's source attribution for glob-registered entries (no `sourceModules` needed for them; keep `sourceModules` for wrappers/manual entries).
3. `overrides` keep applying by entry key (matrixAxes, sourcePath, wrappers).
4. Update `examples/demo` to use `fromGlob` for one set (proves host mode), and `docs/client-setup.md` §2–3 to lead with `fromGlob` (fewer steps for the client-laptop agent).

**Accept**: demo set registered via `fromGlob` renders identically (entry names, matrix, code panel) with zero `sourceModules` for that set; injected e2e on the excalidraw clone with a glob set → cells lazy-load, one broken file = one red cell. Tests for key derivation + include/exclude.

### C4.3 — Host context providers (injected adapters)

1. Config option `hostContext?: Record<dimensionId, { get: () => string | undefined; subscribe?: (cb: () => void) => () => void }>` — declared getters run in the app's realm (config is compiled into their build in injected mode, so `i18n.language` etc. import naturally).
2. `readFiberContext(contextRef, fromElement?)` helper exported through the previewHost seam: walk their fiber tree (we're same-document) for the nearest Provider value — the tenant-wrapper case where no getter API exists.
3. Adapter runtime: a dimension with a hostContext source shows a "follow app" value in injected mode (badge in the switcher, value live-updates via subscribe/poll); explicit user selection in the canvas overrides it (today's behavior); host mode ignores hostContext entirely.
4. Keep it tight — no new adapter kinds, no writes back to app state.

**Accept**: excalidraw clone config declares `hostContext.locale` reading their i18n; expand overlay → locale dimension shows the app's live language + updates when the app's language changes; picking a different locale in the workbench still works and wins; host mode unchanged. Unit tests for the adapter-runtime resolution order.

### C4.4 — OSS onboarding surface

1. **`designbook init`** CLI subcommand: detects vite config + package manager, writes `designbook.config.tsx` (fromGlob template pointed at a detected components dir), `vite.designbook.config.ts` (the wrap-their-config pattern from docs/client-setup.md incl. checker-drop), and the `design`/`dev:designbook` scripts (idempotent, refuses to overwrite, `--force`). Print next steps.
2. README rewrite for the injected model (quickstart = install → init → design), pointing at docs; docs-site: new pages for `designbookPlugin`, `designbook dev` (sidecar/proxy/recovery/deep links/HMR behavior), `init`, and the host-mode repositioning ("no runnable app? host mode"); prune anything contradicting the injected model.
3. Version bump to 0.2.0.

**Accept**: in a fresh scratch vite app: `npm i -D <tarball> && npx @designbookapp/designbook init && npm run design` → working workbench with zero hand-written files. Docs-site builds. README accurate.

## Order

C4.1 → C4.2 (same builder is fine) → C4.3 ∥ C4.4. Commit per stage.

## Watch-outs

- `React.lazy` per cell: fibers hit-testing sees the lazy wrapper — verify `registryByRef` matching still resolves entries (may need to register the resolved component post-load).
- Non-eager glob + Suspense inside `LightDomSlot` (shadow mode): loading fallback renders into the light DOM — no flash of unstyled/foreign content.
- `fromGlob` key collisions across dirs (Button in two folders) — deterministic, documented.
- Eager-glob test-file execution incident (describe undefined) — `fromGlob` must default-exclude `*.{test,spec,stories}.*`.
- Rebuild dist/ui before any injected/tarball verification (stale dist keeps burning time).
- Host-mode compat servers (8811/8822/8833/8844) must still boot (spot-check one); ports 3010 + defaults in use — test on 3012/8790 (or 3013/8792 if free).
