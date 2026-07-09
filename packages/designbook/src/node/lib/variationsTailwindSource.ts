/**
 * Tailwind source coverage for `.designbook/variations/` (design-variations
 * spec — live-dogfood fix).
 *
 * Variant files live in `<configDir>/.designbook/variations` (the app owns
 * its variations — monorepo rule, design-variations spec §A) but can still sit
 * outside the app's own Tailwind v4 source scope (e.g. a css saying
 * `@source "./src";`). Utilities used ONLY by a variant (`h-96`, overlay
 * gradients, …) then generate no CSS, and a structurally-sound variant
 * renders collapsed — the exact "rendered empty" failure the strip flags.
 *
 * Fix at the compiler seam: a tiny `enforce: "pre"` plugin appends
 * `@source "<repo>/.designbook/variations";` to any css module that imports
 * tailwind v4 (`@import "tailwindcss"`), BEFORE @tailwindcss/vite scans it.
 * v3 repos (no v4 import anywhere) are untouched — the bridge owns those.
 * Host-mode only for now; injected mode documents the one-line app-side
 * `@source` addition instead (their build, their css).
 */

import { join } from "node:path";
import type { Plugin } from "vite";

const VARIATIONS_DIRNAME = ".designbook/variations";

/** True for css that starts a Tailwind v4 graph (worth extending sources). */
function importsTailwindV4(code: string): boolean {
  return /@import\s+(["'])tailwindcss\1/.test(code);
}

/**
 * Append the variations `@source` to a Tailwind v4 entry css. Returns
 * undefined when the code is not a v4 entry (caller leaves it untouched) or
 * already covers the dir.
 */
function appendVariationsSource(
  code: string,
  appRoot: string,
): string | undefined {
  if (!importsTailwindV4(code)) return undefined;
  const dir = join(appRoot, VARIATIONS_DIRNAME);
  if (code.includes(dir)) return undefined;
  return `${code}\n@source ${JSON.stringify(dir)};\n`;
}

/** The embedded-server plugin (must run before @tailwindcss/vite's pre pass).
 * `appRoot` = the ABSOLUTE dir owning `.designbook/variations` — the config
 * file's dir (== repo root only in single-repo layouts). */
function variationsTailwindSourcePlugin(appRoot: string): Plugin {
  return {
    name: "designbook:variations-tailwind-source",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null;
      const appended = appendVariationsSource(code, appRoot);
      return appended === undefined ? null : { code: appended, map: null };
    },
  };
}

export {
  VARIATIONS_DIRNAME,
  appendVariationsSource,
  importsTailwindV4,
  variationsTailwindSourcePlugin,
};
