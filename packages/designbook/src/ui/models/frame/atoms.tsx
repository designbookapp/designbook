/**
 * `frame` model atoms: the small, declarative pieces the App page or
 * a cell composes over the frame state. Thin — the frame model's substance is
 * the live iframe handle + the pure route/hit ops (frameModel.ts) — so these
 * exist only so a cell can show the frame's route without reaching into the App
 * page, and so that display has ONE home.
 *
 * `useFrameModel` (re-exported from FrameProvider) is the context hook the
 * overlays use to reach the handle + ops.
 */

import { useFrameModel } from "./FrameProvider";

/** The frame's current route with designbook's `?__designbook_frame` plumbing
 * stripped back off — what the route bar shows. */
function FrameRoute({ path }: { path: string }) {
  return <>{useFrameModel().stripFrameParam(path)}</>;
}

/** The live iframe element, or null before the App page mounts one. */
function useFrameElement(): HTMLIFrameElement | null {
  return useFrameModel().iframe;
}

export { FrameRoute, useFrameElement, useFrameModel };
