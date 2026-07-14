# C2 spec — workbench as an embeddable library

_Phase C2 of [runtime-topology.md](../runtime-topology.md). Goal: the workbench UI becomes a prebuilt, host-React-rendered, style-isolated library that mounts into any page — the foundation `designbookPlugin()` (C3) injects. Host mode keeps working throughout; every stage lands green._

## Non-goals
No vite plugin yet (C3). No config codegen (C4). No behavior changes to workbench features.

## Stages

### C2.1 — Entry + config decoupling
- New public entry `src/ui/mount.tsx`: `mountWorkbench(options): { unmount(): void }` with `options: { container: Element; config: DesignbookConfig; configDir: string; serverUrl?: string }`.
- Kill the direct `virtual:designbook-config` coupling: `src/ui/designbook.ts` currently imports the virtual module at module scope; refactor so config/configDir flow from `mountWorkbench` (module-level store initialized before first render is acceptable; context preferred where cheap).
- Server keeps working: `virtualConfigPlugin` (or a sibling virtual bootstrap module) now emits `import config from <user config>; mountWorkbench({ config, ... })`; `main.tsx` becomes that thin bootstrap.
- **Accept**: demo (8855-style boot) + excalidraw host-mode behave identically; `pnpm check-types`, tests, build green.

### C2.2 — Library build
- Vite lib-mode build (new config in packages/designbook) → `dist/ui/index.js` (ESM) + `dist/ui/style.css`. Entry = `mount.tsx`. Externals: `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime` (peers — host React renders us). Bundle everything else (radix, codemirror, lucide...). Tailwind v4 compiled at build time into `style.css` (workbench chrome only).
- Package export `"./ui"` → dist. Add `build:ui` script; wire into `build`.
- Internal `@designbook-ui/*` alias must resolve in the lib build.
- **Accept**: a scratch host app (separate tiny vite app in scratchpad/fixture with React 18 installed) imports `@designbookapp/designbook/ui` from the built dist, calls `mountWorkbench` with a minimal inline config (a couple of local components), and the workbench renders + is interactive. Proves host-React (18!) + prebuilt consumption.

### C2.3 — Shadow-DOM isolation mode
- `mountWorkbench` option `isolation?: "none" | "shadow"` (default "none" = today). Shadow mode: chrome mounts inside a shadowRoot; `style.css` injected via constructable stylesheet; canvas cell contents render into light-DOM slots (portal pattern proven in spike S1 — chrome sealed, cells styled by host page css).
- `overlay?: boolean`: fixed full-screen top-layer mount + collapse/expand API (the C3 toolbar will drive it).
- **Accept**: rebuild spike S1 on the real library — replace the mini-workbench in `tmp-repos/excalidraw/designbook-spike/` with `dist/ui`; excalidraw overlay shows the real workbench, style isolation holds both directions, cells styled by their scss.

### C2.4 — PreviewHost seam
- `src/ui/previewHost.ts`: interface over all preview/document access — registry rendering, hit-testing/drill-in (fibers), text claims/markers, computed-style reads for the Figma serializer, HMR/update events. Same-document implementation = current code, moved behind it. Panels/toolbars/overlays import ONLY the interface.
- No behavior change. This is the future protocol line (Model A shells implement it with messages).
- **Accept**: tests green; no direct `fibers.ts`/`figmaSerialize` imports outside the PreviewHost implementation (grep-enforced); demo + excalidraw unchanged.

## Order
C2.1 → C2.2 → C2.3; C2.4 can follow any time after C2.1. Commit per stage.

## Watch-outs
- react-refresh/preamble assumptions in the lib build (dev-only code paths must not leak into dist).
- CSS: tailwind preflight must not escape the shadow root; fonts (Geist) need data-uri or system fallback in lib mode.
- `virtual:designbook-config` type decl (`vite-env.d.ts`) consumed by demo tsconfig — keep demo check-types green.
- The 8811/8822/8833/8844 compat servers must still boot after each stage (spot-check one).
