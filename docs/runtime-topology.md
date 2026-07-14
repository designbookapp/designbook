# Runtime topology — decision record

_2026-07-06. Decision: **Model C, "injected workbench"** for the web, pre-OSS. Full analysis (4 models, prior art, failure modes, wireframes) in the briefing artifact; spike evidence in [spikes/s1-injected-workbench.md](./spikes/s1-injected-workbench.md)._

## The decision

designbook becomes a **dev-only dependency inside the target app's build**. A `designbookPlugin()` in their vite (later next) config injects: an agent script, `designbook.config.tsx` as an entry compiled by **their** bundler, and a lazy prebuilt workbench chunk. Collapsed = floating toolbar on their real app. Expanded = full-screen overlay owning the viewport: our chrome in shadow DOM, canvas cells in light DOM rendering their components under their React, their providers, their styles.

Why: the compat tax (the entire class of bugs the 4-repo spike fought) exists only because their code and our workbench share one pipeline — in Model C their toolchain compiles everything, so it evaporates by construction, while the canvas survives intact and same-document sync access (fibers, markers, serializer) is preserved.

- **Model 0 (host mode, current)** collapses into C after C2: a tiny stock host app we ship with the plugin pre-installed, for component libraries with no runnable app. No further compat investment.
- **Model A (shell outside)** deferred to the native/hosted era — the only shape for simulators; reachable later because C's agent + `PreviewHost` seam are exactly A's protocol pieces.
- **Model B (inline toolbar)** subsumed as C's collapsed state.
- Spike S2 (iframe pathology probe) deferred with A; reload rehydration folded into C3 as build work.

## Spike S1 (decisive) — 6/6 PASS on excalidraw

Chrome renders on their React 19 · bidirectional shadow/light style isolation · config through their build (their `@excalidraw/*` aliases, zero userVite) · boot-crash isolation (their entry throws, grid still renders) · broken import = one red cell · HMR hot-updates cells with overlay open. Actual cost 0.11M tokens. Gotcha: drop `vite-plugin-checker` when inheriting their config — host-mode deny-list covers the class.

## Pre-OSS phases (token estimates ±50%, grounded in compat-spike actuals)

| Phase | Scope | Est. |
|---|---|---|
| C2 | Workbench → library: `mountWorkbench()` entry, config as a value (kill `virtual:designbook-config` coupling), prebuilt ESM + css, react externalized (peer), shadow-DOM isolation mode, `PreviewHost` seam | 1.0–1.4M |
| C3 | `designbookPlugin()` for Vite: agent + toolbar + overlay; HMR prevent/defer; **reload rehydration** (durable selection addresses, hash/sessionStorage state, sidecar draft autosave); sidecar proxy front (stable URL across worktrees, recovery page when their dev server is down); `pnpm design` auto-expand | 0.9–1.3M |
| C4 | Config compiled by their bundler; `import.meta.glob` → plugin codegen with per-cell dynamic imports + error boundaries (crash layer 1). **← OSS launch line** | 0.5–0.7M |
| C5+ | Next/webpack plugin; hosted convergence (sandbox runs their dev + injection); protocol formalization → Model A shells for native | post-OSS |

## Failure modes (design requirements)

1. Component fails to compile → per-cell dynamic imports + error boundaries (one red cell) — C4
2. Their app crashes at boot → our own sibling root; canvas mounts components itself — default behavior, proven in S1
3. Their dev server won't start → sidecar proxy serves recovery page (error + Pi chat); drafts/sessions live in sidecar — C3
4. Crash after load → agent error listener; toolbar offers "open workbench anyway"
