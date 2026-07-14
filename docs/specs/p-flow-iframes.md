# P spec — app iframes (App page + live flow screens)

_Same-origin iframes of the running app inside the workbench canvas. Designed
2026-07-06 alongside the M (page tools) pivot; updated 2026-07-07 with
Michael's "App page" entry point. Model C makes this cheap: the overlay and
the app share the dev server/proxy, so an `<iframe src="/checkout">` is the
REAL app at a real route — live data, their router, their auth._

## Decisions (settled)

- **Recursion guard in the boot module**: the iframed page is served by the
  same Vite with `designbookPlugin()`, so the boot module checks `window.top`
  (same-origin reachable) for the `window.__designbook` marker and bails
  completely — no toolbar, no crash listeners, no persist/rehydrate, no
  reload-defer (frames HMR/reload freely). Try/catch for cross-origin-parent
  edges; `?__designbook_frame` query param as belt-and-suspenders so the
  plugin/server can also know.
- **No postMessage protocol**: same-origin means `iframe.contentDocument` and
  its fiber tree are directly reachable. Frame tooling = a `framePreviewHost`
  implementing the existing PreviewHost seam. (Model A's shell running inside
  Model C, minus the protocol.)
- **URL safety inverts**: navigation happens inside the frame's own
  location/history; the user's top-level URL is never touched (same rule as
  page mode).
- **Perf rule**: every live iframe is a full app boot. Grids show
  thumbnails/wireframes; live frames mount only on open (or viewport-lazy),
  concurrency capped.
- **v1 dimension split**: iframed pages follow real app state, not the
  workbench locale/theme/flag switchers (opposite of component cells).
  Documented limitation; bridging is a later phase.

## P1 — App page (~0.3–0.4M)

The toolbar-expand entry point. Expanding from a running app (pill/strip)
lands on a new top-level **"App" page** in the workbench: the route the user
was just on, live in an iframe on the canvas.

1. Boot-module recursion guard (+ `?__designbook_frame` param).
2. "App" as a first-class top-level page beside the component sets in
   workbench nav (injected mode only).
3. Canvas shows one live frame cell of the current route — the route captured
   at expand time (page-tools state → expand carries `location.pathname`).
   Route bar above the cell (editable path, reload, open-in-tab).
4. Collapse returns to the live app exactly as before — expand/collapse never
   touches the real page's URL or state.
5. Frame cell participates in canvas chrome (zoom/pan, selection border) but
   is a page, not a component cell — no matrix/dimension axes in P1.

**Accept**: on the demo app (`pnpm demo:app`) — strip → expand lands on App
page showing the page you were on (e.g. `/trips/coastal-trail`) live;
interacting inside the frame navigates the frame only; no second toolbar
inside the frame; collapse restores the untouched live app; host mode
unaffected.

## P2 — flow screens go live (~0.3M)

1. Screens accept a `route: "/checkout"` field; flow grids render those
   screens as live-page cells using the P1 frame cell.
2. Thumbnail-until-opened default in grids; live mount on screen-open.

## P3 — tools inside frames (~0.4–0.6M)

`framePreviewHost`: hit-test/drill/selection/code-panel/text tool against
`iframe.contentDocument` through the PreviewHost seam. Page tools and canvas
tooling work identically inside a frame cell.

## P4 — dimension bridging + Figma (~0.3M)

_Design drafted 2026-07-07 (the frame's boot module is guard-bailed, so
overrides need their own channel into the frame's module graph)._

**Channel: the frame bridge.** The plugin already knows a request is a frame
(the `?__designbook_frame=1` param is on the HTML request — `ctx.originalUrl`
in `transformIndexHtml`). For frame documents ONLY, inject a small
`virtual:designbook-frame-bridge` script instead of nothing: it registers
`window.__designbookFrameBridge` and does nothing else until asked (no
persist, no toolbar — the recursion guard's promises hold).

**Reaching the frame's real instances.** The config compiles in the app's
build, so importing it INSIDE the frame's module graph resolves
`config.pageText.i18n` / adapter handles to the FRAME's own instances (same
mechanism that makes injected-mode `registryByRef` work). On first override
request the bridge lazy-imports the config module and applies overrides
through the existing seams: locale via the `pageText.i18n` handover, theme /
flags via adapter-declared appliers (new optional `applyToApp` on
theme/flags adapters). No postMessage protocol — parent calls
`frame.contentWindow.__designbookFrameBridge.apply(overrides)` directly
(same-origin), and re-applies after frame load events.

**UI.** The App page gets the workbench's dimension bar (locale/theme/flags
pickers); "follow app" remains the default state — bridging only engages
when the user picks an override, and a reset returns to follow-app (frame
reload).

**Figma.** Serialize through `framePreviewHost` (P3's seam) so App-page /
flow-screen frames can push to Figma like canvas cells; frame documents are
same-origin so the existing serializer walks them directly.

**Watch-outs.** Config import inside the frame pulls config-side deps into
the frame's graph — lazy-import only on first override, never eagerly.
Adapters without `applyToApp` degrade to a documented "reload with
follow-app" no-op, never a guess.

## Watch-outs

- P3 marker runtime: the pageText transform applies inside frames (same dev
  server), but the recursion guard bails the frame's boot module, so
  `window.__designbook` won't exist there. The frame's `__dbMark` runtime must
  read tool state from `window.top.__designbook` (same-origin) instead —
  markers stay passthrough in frames until the parent's text tool arms.

- Guard must run before ANY boot side effect (persist writes, WebSocket
  patch, crash badge) — an iframe that half-boots designbook corrupts the
  parent's sessionStorage state (shared per-origin).
- sessionStorage/localStorage are shared same-origin between frame and top —
  workbench persist keys must not be written from frames (the guard's bail
  covers this; keep it that way).
- Apps with auth redirects may bounce the frame to /login — fine (it's the
  real app), but the route bar must show the frame's ACTUAL current path,
  not the requested one.
- Frame cell sizing: pages want viewport-ish dimensions, not component-cell
  hugging; give the App page a device-width preset row (desktop/tablet/phone)
  later, fixed desktop first.
- `beforeunload`-style handlers inside their app can block frame reloads —
  don't fight them, surface them.

## Unresolved

1. P1 before or after OSS sweep?
2. App page in nav when NOT injected (host mode): hidden, or shown disabled?
3. Route bar free-typing: allow any path, or only known flow routes + history?
