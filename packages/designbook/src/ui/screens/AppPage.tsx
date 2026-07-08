/**
 * App page — the toolbar-expand entry point. A live, same-origin
 * iframe of the running app, shown as one page cell on the canvas: a fixed
 * desktop-ish width, no matrix/dimension axes (unlike a component cell), and
 * an editable route bar above it.
 *
 * Mount lifecycle is owned by the caller (Workbench renders this only when the
 * route resolves to the App page) — unmounting this component tears the
 * iframe down, satisfying the "lazy: mounts only while active" rule.
 *
 * The route bar shows the frame's ACTUAL current path, read from
 * `iframe.contentWindow.location` on `load` (same-origin) — an app that
 * bounces to `/login` must be shown truthfully, not the path that was
 * requested.
 */

import { useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { cn } from "@designbook-ui/lib/utils";
import { buildFrameSrc, normalizeAppPath, stripFrameParam } from "@designbook-ui/models/frame/appFrame";
import { useFrameModel } from "@designbook-ui/models/frame/FrameProvider";

/** Fixed desktop-ish width for the frame cell (no device-width presets yet). */
const APP_FRAME_WIDTH = 1280;
const APP_FRAME_HEIGHT = 800;

const copy = {
  routeLabel: "App route",
  reload: "Reload",
  openInTab: "Open in new tab",
  frameTitle: "App",
};

function AppPage({ path }: { path: string }) {
  // The frame model OWNS the live iframe handle: report the
  // element on mount/remount/unmount via `setIframe`, and each `load` via
  // `notifyNavigated` (which bumps the generation, consumes the reload latch,
  // and — on a real navigation — disarms the active tool). A fresh document has
  // no stale selection to protect, so treating the first load like any other is
  // simplest (no dangling overlays across a frame document swap).
  const { setIframe, notifyNavigated } = useFrameModel();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // `requestedPath` drives the iframe `src`; `actualPath` is what the frame is
  // REALLY showing (corrected from `load`, e.g. after an auth redirect).
  const [requestedPath, setRequestedPath] = useState(() =>
    normalizeAppPath(path),
  );
  const [actualPath, setActualPath] = useState(requestedPath);
  const [draft, setDraft] = useState(requestedPath);
  const [reloadNonce, setReloadNonce] = useState(0);

  // A fresh expand-from-strip (or nav to a different app route) re-seeds the
  // frame — but don't clobber the user's own in-frame navigation on every
  // re-render, only when the REQUESTED path actually changes upstream.
  const lastPathProp = useRef(path);
  if (lastPathProp.current !== path) {
    lastPathProp.current = path;
    const next = normalizeAppPath(path);
    setRequestedPath(next);
    setActualPath(next);
    setDraft(next);
  }

  useEffect(() => {
    setDraft(actualPath);
  }, [actualPath]);

  function commitDraft() {
    const next = normalizeAppPath(draft);
    setRequestedPath(next);
    setActualPath(next); // optimistic; `handleLoad` corrects it if the app redirects
  }

  function handleReload() {
    setReloadNonce((n) => n + 1);
  }

  function handleOpenInTab() {
    window.open(stripFrameParam(requestedPath), "_blank", "noopener,noreferrer");
  }

  function handleLoad() {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      try {
        // `location.search` genuinely carries our own `?__designbook_frame=1`
        // marker (that's how the frame's own boot module sees it) — strip it
        // back off so the bar shows the app's real route, not our plumbing.
        setActualPath(
          stripFrameParam(win.location.pathname + win.location.search),
        );
      } catch {
        // Cross-origin navigation inside the frame (e.g. an external auth
        // provider) — its location isn't readable; leave the bar as-is rather
        // than guess.
      }
    }
    // Every load — reload, route-bar navigation, or an in-app redirect — swaps
    // (or at least invalidates) the frame's document; the frame model disarms/
    // rewires tools accordingly (no dangling overlays across a
    // frame navigation).
    notifyNavigated();
  }

  function setFrameRef(el: HTMLIFrameElement | null) {
    iframeRef.current = el;
    setIframe(el);
  }

  const src = buildFrameSrc(requestedPath);

  return (
    <div className="grid content-start justify-items-start gap-1.5">
      <div
        className="flex w-full items-center gap-1.5"
        style={{ width: APP_FRAME_WIDTH }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
              commitDraft();
            } else if (event.key === "Escape") {
              setDraft(actualPath);
            }
          }}
          onBlur={commitDraft}
          aria-label={copy.routeLabel}
          spellCheck={false}
          className="h-8 flex-1 rounded-md border bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <button
          type="button"
          title={copy.reload}
          aria-label={copy.reload}
          onClick={handleReload}
          className={cn(
            "flex size-8 cursor-default items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <RotateCwIcon className="size-4" />
        </button>
        <button
          type="button"
          title={copy.openInTab}
          aria-label={copy.openInTab}
          onClick={handleOpenInTab}
          className={cn(
            "flex size-8 cursor-default items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <ExternalLinkIcon className="size-4" />
        </button>
      </div>
      <div
        className="overflow-hidden bg-background shadow-md"
        style={{ width: APP_FRAME_WIDTH, height: APP_FRAME_HEIGHT }}
      >
        <iframe
          key={reloadNonce}
          ref={setFrameRef}
          src={src}
          title={copy.frameTitle}
          onLoad={handleLoad}
          className="size-full border-0"
        />
      </div>
    </div>
  );
}

export { APP_FRAME_HEIGHT, APP_FRAME_WIDTH, AppPage };
