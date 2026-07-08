/**
 * Scoping wrapper around `@tailwindcss/vite`.
 *
 * `@tailwindcss/vite` registers an `enforce: "pre"` `transform` hook that runs
 * BEFORE Vite's built-in CSS pipeline (i.e. before sass compilation). On a repo
 * that uses sass but not Tailwind (e.g. twenty), that hook receives raw `.scss`
 * — sass-only syntax like `// comments` — and Lightning CSS rejects it with
 * `Invalid declaration: '// ...'`.
 *
 * Fix: when the target repo does NOT depend on Tailwind, restrict Tailwind's
 * transform to designbook's own UI source (`uiRoot`). designbook's workbench
 * chrome and the Tailwind demo keep working; the repo's own CSS passes through
 * to sass untouched. When the repo DOES use Tailwind, the plugins are returned
 * unchanged so its project files are processed as normal.
 *
 * Detection also counts two cases the plain configDir→root chain misses
 * (documenso: Tailwind only declared in nested workspace members):
 *   - any workspace-member package.json one level under apps/packages/* (or
 *     any cheaply-derived `<dir>/*` workspace glob) declaring `tailwindcss`.
 *   - the auto-detected repo vite config's own `css.postcss` carrying a
 *     Tailwind plugin (computed once by userVite.ts's resolveUserVite, passed
 *     in as `autoDetectedPostcssTailwind` — avoids re-loading/re-executing
 *     the repo's vite config here).
 */

import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import {
  hasDependencyInTree,
  hasDependencyInWorkspaceMembers,
  workspaceGlobParents,
} from "./userVite.ts";

/**
 * True when the target repo depends on Tailwind — checked from the config's
 * directory up to the project/workspace root, in workspace-member packages
 * one level under apps/packages/*, or via a Tailwind plugin already found in
 * the auto-detected repo vite config's `css.postcss`.
 */
export function repoUsesTailwind(
  configDir: string,
  projectRoot?: string,
  opts?: { autoDetectedPostcssTailwind?: boolean },
): boolean {
  if (hasDependencyInTree("tailwindcss", configDir, projectRoot)) return true;
  if (opts?.autoDetectedPostcssTailwind) return true;
  const root = projectRoot ?? configDir;
  return hasDependencyInWorkspaceMembers("tailwindcss", root, workspaceGlobParents(root));
}

function idPath(id: string): string {
  // Strip Vite's query/suffix (`?used`, `?direct`, `?vue&type=style`, ...).
  const q = id.indexOf("?");
  return q === -1 ? id : id.slice(0, q);
}

/**
 * Restrict a Tailwind plugin's `transform` hook to files under `uiRoot`. Other
 * hooks (content scanning, hot update) are harmless and left intact.
 */
function scopeTransformToUiRoot(plugin: Plugin, uiRoot: string): Plugin {
  const t = plugin.transform;
  if (!t) return plugin;
  const handler = typeof t === "function" ? t : t.handler;
  const wrapped: typeof handler = function (this, code, id, options) {
    if (!idPath(id).startsWith(uiRoot)) return undefined;
    return handler.call(this, code, id, options);
  };
  return {
    ...plugin,
    transform: typeof t === "function" ? wrapped : { ...t, handler: wrapped },
  };
}

/**
 * Returns the Tailwind plugin(s), scoped to `uiRoot` unless the target repo
 * uses Tailwind itself (in which case its files are processed globally).
 *
 * `forceScopeToUiRoot` overrides that and keeps the scope on `uiRoot` even for
 * a Tailwind repo — used for **Tailwind v3** repos (see tailwindBridge.ts):
 * their css files are v3-shaped (`@apply`/`@layer` against a v3 theme) and
 * @tailwindcss/vite (v4) throws "Cannot apply unknown utility" if it processes
 * them. The generated v4 bridge entry lives UNDER `uiRoot` and carries an
 * `@source "<repo>"` directive, so Tailwind still scans the repo's components
 * and generates their utilities — without ever transforming the repo's own css.
 */
export function tailwindPlugins(opts: {
  uiRoot: string;
  configDir: string;
  projectRoot: string;
  autoDetectedPostcssTailwind?: boolean;
  forceScopeToUiRoot?: boolean;
}): Plugin[] {
  const plugins = tailwindcss() as unknown as Plugin[];
  const unscoped =
    !opts.forceScopeToUiRoot &&
    repoUsesTailwind(opts.configDir, opts.projectRoot, {
      autoDetectedPostcssTailwind: opts.autoDetectedPostcssTailwind,
    });
  if (unscoped) return plugins;
  return plugins.map((p) => scopeTransformToUiRoot(p, opts.uiRoot));
}
