/**
 * Forces the App page frame's own `t()` calls to re-run — needed
 * both to re-mark strings when the text tool arms/disarms and to reflect a
 * saved edit live, the frame counterpart of `pageTools/pageMark.ts`'s
 * `refreshPageText`/`applyEditToApp`.
 *
 * ## Why a reload, not an in-place patch
 * `pageMark.ts` forces the TOP app to re-render by emitting `languageChanged`/
 * `loaded` on its own i18next instance, reached via a normal same-realm
 * `import("i18next")`. The frame is a SEPARATE module instantiation (its own
 * `<script type=module>` graph), so reaching ITS instance means evaluating an
 * import inside the frame's own realm — tried via `iframe.contentWindow.eval`
 * (an "indirect eval", which per spec always runs in the callee's own global
 * scope) plus Vite's `/@id/<pkg>` dev-resolution to dodge bare-specifier
 * failures. It technically runs, but lands in a DIFFERENT module-cache entry
 * than the frame's own resolved import — Vite's dev-server ESM cache key
 * includes the resolved `?v=` query, which differs per call site — so the
 * "live" instance reached this way is never the one the frame's components
 * actually render through; `emit()` on it is a no-op as far as the visible
 * page is concerned. There is no general, reliable way to force an arbitrary
 * React app's arbitrary i18n setup to re-render from outside without its
 * cooperation.
 *
 * A reload sidesteps the "reach the live instance" problem for RE-MARKING
 * (arm/disarm): the frame's fresh boot re-runs `__dbMark`, which (per
 * `markRuntime.ts`) picks up the CURRENT `window.top.__designbook` marking
 * state on its own — verified working. This is by design
 * ("frames HMR/reload freely," unlike the guarded top-level reload) — cheap
 * for a frame cell, unlike a workbench reload. Callers must pair this with
 * `AppFrameContext`'s `ignoreNextNavigation()` so the reload's `load` event
 * isn't mistaken for a real navigation and disarms the tool it was meant to
 * serve.
 *
 * It does NOT fully solve reflecting a SAVED locale edit, though (see the
 * KNOWN GAP note on `AppFrameTextOverlay`'s `withFrameReloadOnSave`): the
 * target app's Vite dev server deliberately ignores `**\/locales/**` in its
 * watcher (`HMR_WATCH_IGNORED`) so a locale write never disrupts the TOP
 * app with a full-reload — but that same blind spot means its module-graph
 * cache for the locale JSON's compiled import never invalidates either, so a
 * reload can still serve the PRE-edit transform until that Vite instance
 * itself restarts. Verified via direct requests: the raw (non-`?import`) JSON
 * endpoint always has the fresh write; the `?import`-transformed one doesn't,
 * confirming the stale layer is Vite's transform cache, not the write or any
 * browser/frame-side cache.
 */

/** Reload the frame, ignoring cross-origin/already-navigated-away failures
 * (nothing to do in that case — same-origin is a precondition of the whole
 * App-page frame feature). */
function reloadFrame(iframe: HTMLIFrameElement): void {
  try {
    iframe.contentWindow?.location.reload();
  } catch {
    // Cross-origin navigation inside the frame — not our frame cell anymore.
  }
}

export { reloadFrame };
