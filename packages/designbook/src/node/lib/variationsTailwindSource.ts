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
 * Host mode registers the two `enforce: "pre"` plugins ahead of
 * @tailwindcss/vite in its fixed plugin array; injected mode uses
 * `generatedDirsTailwindSourcePlugin` (hook-level order "pre") since it
 * cannot control its position in the app's plugin array.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type { Plugin } from "vite";

const VARIATIONS_DIRNAME = ".designbook/variations";
/** The sandbox home needs the same coverage (docs/specs/sandbox.md, D5): its
 * generated wrapper + variant files use utilities the app may not. */
const SANDBOX_DIRNAME = ".designbook/sandbox";
/** Changeset LAYERS (docs/specs/changeset-layers.md): alternative modules at
 * mirrored paths carry utility classes the app may not — same coverage. */
const CHANGESETS_DIRNAME = ".designbook/changesets";

/**
 * Designbook DATA/SHIM paths tailwind must NOT treat as content (sandbox
 * overrides O1, live-run finding): @tailwindcss/vite sends a SILENT
 * `full-reload` whenever a SCANNED file with no real JS module changes — and
 * the durable index is rewritten on every drag/switch flip/landing, while
 * shims carry no utility classes at all. Excluded via `@source not` when the
 * app's tailwind supports it (v4.1+); older v4 keeps the status quo.
 */
const SCAN_EXCLUDED_PATHS = [
  ".designbook/sandbox-index.ts",
  `${SANDBOX_DIRNAME}/index.ts`, // legacy in-dir index (pre-O1)
  `${VARIATIONS_DIRNAME}/index.ts`, // same rewrite-churn hazard
  `${CHANGESETS_DIRNAME}/_merged`, // serve-time data-merge artifacts (no markup)
];

/** Cache: appRoot → whether its tailwindcss supports `@source not` (≥4.1). */
const sourceNotSupport = new Map<string, boolean>();

/** True when the APP's tailwindcss version understands `@source not`. */
function supportsSourceNot(appRoot: string): boolean {
  let cached = sourceNotSupport.get(appRoot);
  if (cached !== undefined) return cached;
  cached = false;
  try {
    const version = (
      createRequire(join(appRoot, "package.json"))(
        "tailwindcss/package.json",
      ) as { version?: string }
    ).version;
    const [major, minor] = (version ?? "0.0").split(".").map(Number);
    cached = major > 4 || (major === 4 && minor >= 1);
  } catch {
    // No resolvable tailwindcss — nothing to exclude anyway.
  }
  sourceNotSupport.set(appRoot, cached);
  return cached;
}

/** True for css that starts a Tailwind v4 graph (worth extending sources). */
function importsTailwindV4(code: string): boolean {
  return /@import\s+(["'])tailwindcss\1/.test(code);
}

/**
 * Append a generated-dir `@source` to a Tailwind v4 entry css. Returns
 * undefined when the code is not a v4 entry (caller leaves it untouched) or
 * already covers the dir.
 */
function appendDirSource(
  code: string,
  appRoot: string,
  dirname: string,
): string | undefined {
  if (!importsTailwindV4(code)) return undefined;
  const dir = join(appRoot, dirname);
  if (code.includes(dir)) return undefined;
  return `${code}\n@source ${JSON.stringify(dir)};\n`;
}

/** The variations `@source` append (behavior unchanged — see appendDirSource). */
function appendVariationsSource(
  code: string,
  appRoot: string,
): string | undefined {
  return appendDirSource(code, appRoot, VARIATIONS_DIRNAME);
}

/** The sandbox + changeset-layer `@source` appends (mirror the variations
 * handling), plus the `@source not` exclusions for designbook data files
 * (see SCAN_EXCLUDED_PATHS) on tailwind ≥4.1. */
function appendSandboxSource(
  code: string,
  appRoot: string,
): string | undefined {
  const withSandbox = appendDirSource(code, appRoot, SANDBOX_DIRNAME);
  const withLayers = appendDirSource(
    withSandbox ?? code,
    appRoot,
    CHANGESETS_DIRNAME,
  );
  const appended = withLayers ?? withSandbox;
  if (appended === undefined) return undefined;
  if (!supportsSourceNot(appRoot)) return appended;
  const exclusions = SCAN_EXCLUDED_PATHS.map(
    (rel) => `@source not ${JSON.stringify(join(appRoot, rel))};`,
  ).join("\n");
  return `${appended}${exclusions}\n`;
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

/** The sandbox counterpart (host mode; injected mode = documented app-side
 * `@source` line — see the troubleshooting doc that covers variations). */
function sandboxTailwindSourcePlugin(appRoot: string): Plugin {
  return {
    name: "designbook:sandbox-tailwind-source",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null;
      const appended = appendSandboxSource(code, appRoot);
      return appended === undefined ? null : { code: appended, map: null };
    },
  };
}

/**
 * Injected-mode counterpart covering BOTH generated dirs in one plugin.
 *
 * Host mode controls its plugin array, so `enforce: "pre"` + being listed
 * before @tailwindcss/vite is enough there. The injected plugin cannot
 * control where the app registers it (typically AFTER `tailwindcss()`), so
 * this uses hook-level `transform.order: "pre"` instead — Vite runs
 * order-"pre" hooks before ALL other plugins' transforms, including
 * enforce-"pre" ones, regardless of registration order. Dev-serve only.
 *
 * This makes injected mode self-sufficient like host mode: without it, a
 * repo that gitignores `.designbook/` (Tailwind v4's default source
 * detection skips gitignored paths) would never generate variant-only
 * utilities at all, hot or not.
 */
function generatedDirsTailwindSourcePlugin(appRoot: string): Plugin {
  return {
    name: "designbook:generated-tailwind-source",
    apply: "serve",
    transform: {
      order: "pre",
      handler(code, id) {
        if (!id.split("?")[0].endsWith(".css")) return null;
        let out = appendVariationsSource(code, appRoot) ?? code;
        out = appendSandboxSource(out, appRoot) ?? out;
        return out === code ? null : { code: out, map: null };
      },
    },
  };
}

export {
  CHANGESETS_DIRNAME,
  SANDBOX_DIRNAME,
  SCAN_EXCLUDED_PATHS,
  VARIATIONS_DIRNAME,
  appendSandboxSource,
  appendVariationsSource,
  generatedDirsTailwindSourcePlugin,
  importsTailwindV4,
  sandboxTailwindSourcePlugin,
  variationsTailwindSourcePlugin,
};
