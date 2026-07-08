/**
 * Tailwind v3 -> v4 token bridge.
 *
 * designbook bundles Tailwind **v4** (`@tailwindcss/vite`). A target repo on
 * Tailwind **v3** describes its semantic utilities (`bg-primary`,
 * `text-subtle`, …) in a JS config / preset (e.g. documenso's
 * `packages/tailwind-config/index.cjs` maps `primary` -> `hsl(var(--primary))`).
 * v4 ignores that JS config entirely, so those utilities generate nothing and
 * the previewed components are unstyled.
 *
 * This module auto-generates the equivalent of the hand-written bridge Agent B
 * wrote for documenso (`@import "tailwindcss"` + `@theme inline { … }` +
 * `@custom-variant dark …`): it loads the repo's OWN Tailwind v3 config through
 * THEIR `tailwindcss/resolveConfig` (so presets resolve), then emits a v4
 * `@theme inline` block mapping every resolved color/radius/font token to a v4
 * CSS variable. The block is served as a virtual CSS entry imported by the
 * workbench, and an `@source "<repo>"` directive makes Tailwind v4 scan the
 * repo's component files so the utilities actually generate.
 *
 * A second, independent piece — the directive shim — lets the repo's own theme
 * css (which starts with v3 `@tailwind base/components/utilities;` directives
 * that v4 rejects) be imported for its `:root`/`.dark` CSS-var values.
 *
 * v4 repo, or no Tailwind at all -> the whole feature is inert (empty CSS, no
 * shim). See `buildTailwindBridge`.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import {
  findDependencyInTree,
  findDependencyInWorkspaceMembers,
  listSubdirsSafe,
  workspaceGlobParents,
} from "./userVite.ts";

/** The specifier the workbench entry imports; always resolvable (empty when inert). */
export const BRIDGE_SPECIFIER = "virtual:designbook-tailwind-bridge.css";

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

/**
 * package.json path of the workspace member that declares `tailwindcss` — the
 * config's own dependency chain / workspace root first, then any workspace
 * member one level under `apps/*`/`packages/*` (documenso declares Tailwind
 * only in nested members). Undefined when no repo package declares it.
 */
export function findTailwindDeclarer(
  configDir: string,
  projectRoot?: string,
): string | undefined {
  const inTree = findDependencyInTree("tailwindcss", configDir, projectRoot);
  if (inTree) return inTree;
  const root = projectRoot ?? configDir;
  return findDependencyInWorkspaceMembers("tailwindcss", root, workspaceGlobParents(root));
}

/** Leading integer of a semver string / range (`"^3.4.1"` -> 3), or undefined. */
export function parseMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const m = /(\d+)/.exec(version);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

/**
 * Major version of the `tailwindcss` resolvable FROM `dir` — the INSTALLED
 * version (`tailwindcss/package.json`, handling pnpm hoisting), else the
 * declared range in `dir`'s own package.json. Undefined when neither is found.
 * This is version-detection tied to a specific package, which matters in
 * monorepos that mix majors (documenso: `apps/docs` is v4 while the UI stack —
 * `packages/ui`, `packages/tailwind-config` — is v3).
 */
export function resolveTailwindMajorFromDir(dir: string): number | undefined {
  try {
    const req = createRequire(join(dir, "package.json"));
    const pkgPath = req.resolve("tailwindcss/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    const major = parseMajor(pkg.version);
    if (major !== undefined) return major;
  } catch {
    /* not installed / unresolvable — fall through to the declared range */
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const major = parseMajor(pkg[field]?.tailwindcss);
      if (major !== undefined) return major;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Major version of the Tailwind the target repo uses, resolved from the member
 * that DECLARES `tailwindcss` (config chain / workspace root / a member under
 * apps|packages/*). Undefined when no repo package depends on Tailwind. Note:
 * in a mixed-major monorepo this reflects whichever declarer is found first —
 * the authoritative, per-config check happens in `buildTailwindBridge`, which
 * resolves the version from each candidate config's own directory.
 */
export function detectTailwindMajor(
  configDir: string,
  projectRoot?: string,
): number | undefined {
  const declarer = findTailwindDeclarer(configDir, projectRoot);
  return declarer ? resolveTailwindMajorFromDir(dirname(declarer)) : undefined;
}

// ---------------------------------------------------------------------------
// Pure @theme synthesis
// ---------------------------------------------------------------------------

export type BridgeThemeInput = {
  colors?: unknown;
  borderRadius?: unknown;
  fontFamily?: unknown;
  /** Tailwind v3 `darkMode` config value (drives `@custom-variant dark`). */
  darkMode?: unknown;
  /** Absolute path Tailwind v4 should scan for utility usage (`@source`). */
  sourceRoot?: string;
};

/** Strip Tailwind's ` / <alpha-value>` placeholder from a color value. */
export function stripAlphaValue(value: string): string {
  return value.replace(/\s*\/\s*<alpha-value>/g, "").trim();
}

/**
 * Flatten a (possibly nested) Tailwind color tree into `--color-*` variables.
 * `DEFAULT` collapses to the parent name (`primary.DEFAULT` -> `--color-primary`);
 * nested keys join with `-` (`primary.foreground` -> `--color-primary-foreground`,
 * `documenso.500` -> `--color-documenso-500`). Non-string leaves (functions,
 * numbers) are skipped.
 */
function flattenColors(
  node: unknown,
  prefix: string,
  out: [string, string][],
): void {
  if (!node || typeof node !== "object") return;
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (typeof val === "string") {
      const name = key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;
      if (name) out.push([`--color-${name}`, stripAlphaValue(val)]);
    } else if (val && typeof val === "object") {
      const name = key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;
      flattenColors(val, name, out);
    }
    // numbers / functions / null: skipped
  }
}

/** `borderRadius` -> `--radius-*` (`DEFAULT` -> `--radius`). String leaves only. */
function radiusVars(node: unknown): [string, string][] {
  const out: [string, string][] = [];
  if (!node || typeof node !== "object") return out;
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (typeof val !== "string") continue;
    out.push([key === "DEFAULT" ? "--radius" : `--radius-${key}`, val]);
  }
  return out;
}

/**
 * `fontFamily` -> `--font-*`. Values may be a string or an array of family
 * names (v3's resolved form: `['var(--font-sans)', 'ui-sans-serif', …]`) which
 * is joined with `, `; a trailing config object (v3 allows `[families, opts]`)
 * is filtered out. `DEFAULT` is skipped (no meaningful v4 name).
 */
function fontVars(node: unknown): [string, string][] {
  const out: [string, string][] = [];
  if (!node || typeof node !== "object") return out;
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (key === "DEFAULT") continue;
    let value: string | undefined;
    if (typeof val === "string") {
      value = val;
    } else if (Array.isArray(val)) {
      const families = val.filter((x): x is string => typeof x === "string");
      if (families.length) value = families.join(", ");
    }
    if (value) out.push([`--font-${key}`, value]);
  }
  return out;
}

/**
 * Translate a Tailwind v3 `darkMode` value into a v4 `@custom-variant dark`
 * selector body, or undefined for media-based / disabled dark mode (no class
 * variant to emit).
 *   'class' | ['class', sel?]        -> `&:is(<sel> *)`   (default sel `.dark`)
 *   'selector' | ['selector', sel?]  -> `&:is(<sel> *)`
 *   ['variant', sel | sel[]]         -> the raw selector(s), comma-joined
 */
export function darkVariantBody(darkMode: unknown): string | undefined {
  const classBody = (sel: unknown): string =>
    `&:is(${typeof sel === "string" && sel ? sel : ".dark"} *)`;
  if (darkMode === "class" || darkMode === "selector") return classBody(undefined);
  if (Array.isArray(darkMode)) {
    const [strategy, selector] = darkMode;
    if (strategy === "class" || strategy === "selector") return classBody(selector);
    if (strategy === "variant") {
      const sels = (Array.isArray(selector) ? selector : [selector]).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
      if (sels.length) return sels.join(", ");
    }
  }
  return undefined;
}

/**
 * Build the v4 bridge CSS from a resolved v3 theme. Returns "" when there are
 * no tokens to map (feature stays inert). Emits, in order: `@import
 * "tailwindcss"`, an optional `@source` so v4 scans the repo, an optional
 * `@custom-variant dark`, and the `@theme inline` block.
 */
export function buildBridgeCss(input: BridgeThemeInput): string {
  const vars: [string, string][] = [];
  flattenColors(input.colors, "", vars);
  vars.push(...radiusVars(input.borderRadius));
  vars.push(...fontVars(input.fontFamily));
  if (vars.length === 0) return "";

  const lines: string[] = [
    "/* designbook: auto-generated Tailwind v3 -> v4 token bridge. */",
    '@import "tailwindcss";',
  ];
  if (input.sourceRoot) lines.push(`@source ${JSON.stringify(input.sourceRoot)};`);
  const dark = darkVariantBody(input.darkMode);
  if (dark) lines.push(`@custom-variant dark (${dark});`);
  lines.push("@theme inline {");
  for (const [name, value] of vars) lines.push(`  ${name}: ${value};`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// v3 config loading (impure: require / jiti / resolveConfig)
// ---------------------------------------------------------------------------

const TW_CONFIG_NAMES = [
  "tailwind.config.cjs",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];

/**
 * Candidate Tailwind config files, in preference order: the configDir ->
 * projectRoot chain first, then workspace members one level under
 * `apps/*`/`packages/*`. Within a directory, non-TS extensions come first
 * (TS needs jiti). De-duplicated, preserving order.
 */
export function findTailwindConfigCandidates(
  configDir: string,
  projectRoot: string,
  listSubdirs: (dir: string) => string[] = listSubdirsSafe,
): string[] {
  const out: string[] = [];
  const add = (dir: string) => {
    for (const name of TW_CONFIG_NAMES) {
      const p = join(dir, name);
      if (existsSync(p) && !out.includes(p)) out.push(p);
    }
  };
  // configDir -> projectRoot chain.
  let dir = configDir;
  for (;;) {
    add(dir);
    if (dir === projectRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Workspace members.
  for (const parent of workspaceGlobParents(projectRoot)) {
    const parentDir = join(projectRoot, parent);
    for (const sub of listSubdirs(parentDir)) add(join(parentDir, sub));
  }
  return out;
}

/** Load a raw (unresolved) Tailwind config module from disk. Async for mjs/esm. */
async function loadRawConfig(
  configFile: string,
  req: NodeJS.Require,
  requireFromDir: string,
): Promise<unknown> {
  const ext = extname(configFile);
  if (ext === ".ts" || ext === ".mts") {
    // TS config: use the repo's bundled jiti (Tailwind v3 ships one). jiti v2's
    // default export is the factory. Best-effort — caller skips on throw.
    const jitiFactory = req("jiti") as (
      from: string,
      opts?: unknown,
    ) => { import: (id: string, opts?: unknown) => Promise<unknown> } & ((id: string) => unknown);
    const jiti = jitiFactory(requireFromDir, { interopDefault: true });
    const mod = await jiti.import(configFile, { default: true });
    return (mod as { default?: unknown })?.default ?? mod;
  }
  try {
    const mod = req(configFile) as { default?: unknown };
    return mod?.default ?? mod;
  } catch {
    // ESM-only (.mjs, or a .js with "type":"module") — require() rejects it.
    const mod = (await import(pathToFileURL(configFile).href)) as { default?: unknown };
    return mod?.default ?? mod;
  }
}

export type LoadedTheme = BridgeThemeInput & { configFile: string; colorCount: number };

/**
 * Load + resolve one Tailwind v3 config via THEIR `tailwindcss/resolveConfig`
 * (so presets resolve), returning the theme slices the bridge needs. Undefined
 * on any failure (unloadable TS, missing resolveConfig, throwing config).
 */
export async function loadResolvedTheme(
  configFile: string,
  requireFromDir: string,
  log: (msg: string) => void,
): Promise<LoadedTheme | undefined> {
  try {
    const req = createRequire(join(requireFromDir, "package.json"));
    const raw = await loadRawConfig(configFile, req, requireFromDir);
    if (!raw || typeof raw !== "object") return undefined;
    const resolveConfig = req("tailwindcss/resolveConfig") as (c: unknown) => {
      theme?: { colors?: unknown; borderRadius?: unknown; fontFamily?: unknown };
      darkMode?: unknown;
    };
    const resolved = resolveConfig(raw);
    const theme = resolved.theme ?? {};
    const colorProbe: [string, string][] = [];
    flattenColors(theme.colors, "", colorProbe);
    return {
      configFile,
      colors: theme.colors,
      borderRadius: theme.borderRadius,
      fontFamily: theme.fontFamily,
      darkMode: resolved.darkMode ?? (raw as { darkMode?: unknown }).darkMode,
      colorCount: colorProbe.length,
    };
  } catch (err) {
    log(
      `[designbook] tailwind bridge: could not load v3 config ${configFile}: ${String(err)}`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type TailwindBridge = {
  /** True when a Tailwind v3 repo was detected and a theme resolved. */
  isV3: boolean;
  /** The generated bridge CSS ("" when inert). */
  css: string;
  /** The config file the theme was resolved from (diagnostics). */
  configFile?: string;
  /** Detected Tailwind major (undefined when the repo has no Tailwind). */
  major?: number;
};

export type BuildTailwindBridgeOptions = {
  configPath: string;
  projectRoot: string;
  uiRoot: string;
  log?: (msg: string) => void;
};

/**
 * Detect Tailwind v3 in the target repo and, if found, synthesize the v4
 * `@theme` bridge CSS from the repo's own resolved config. v4 / no-Tailwind ->
 * inert (`isV3: false`, `css: ""`). Among multiple candidate configs the one
 * yielding the richest color set wins (documenso: a member config presetting
 * the shared `tailwind-config` beats a sparser sibling).
 */
export async function buildTailwindBridge(
  opts: BuildTailwindBridgeOptions,
): Promise<TailwindBridge> {
  const { configPath, projectRoot } = opts;
  const log = opts.log ?? (() => {});
  const configDir = dirname(configPath);

  const summaryMajor = detectTailwindMajor(configDir, projectRoot);
  if (summaryMajor === undefined) {
    log("[designbook] tailwind bridge: repo has no Tailwind — inert");
    return { isV3: false, css: "" };
  }

  const candidates = findTailwindConfigCandidates(configDir, projectRoot);
  if (candidates.length === 0) {
    log(
      `[designbook] tailwind bridge: Tailwind detected (v${summaryMajor}) but no tailwind.config found — inert`,
    );
    return { isV3: false, css: "", major: summaryMajor };
  }

  // Resolve the Tailwind major PER candidate config (a monorepo can mix majors)
  // and only bridge from v3 configs; among those the richest color set wins.
  let best: (LoadedTheme & { major: number }) | undefined;
  let sawV3 = false;
  for (const candidate of candidates) {
    const major = resolveTailwindMajorFromDir(dirname(candidate));
    if (major !== 3) {
      log(
        `[designbook] tailwind bridge: skipping ${candidate} — its Tailwind is v${major ?? "?"} (bridge is v3-only)`,
      );
      continue;
    }
    sawV3 = true;
    const theme = await loadResolvedTheme(candidate, dirname(candidate), log);
    if (theme && theme.colorCount > (best?.colorCount ?? 0)) best = { ...theme, major };
  }

  if (!best) {
    log(
      sawV3
        ? `[designbook] tailwind bridge: found v3 config(s) but none resolved to any tokens — inert`
        : `[designbook] tailwind bridge: no v3 tailwind.config found (repo is Tailwind v${summaryMajor}) — inert`,
    );
    return { isV3: false, css: "", major: summaryMajor };
  }

  const css = buildBridgeCss({
    colors: best.colors,
    borderRadius: best.borderRadius,
    fontFamily: best.fontFamily,
    darkMode: best.darkMode,
    sourceRoot: projectRoot,
  });
  log(
    `[designbook] tailwind bridge: Tailwind v3 detected — generated @theme from ${best.configFile} (${best.colorCount} color tokens)`,
  );
  return { isV3: css.length > 0, css, configFile: best.configFile, major: best.major };
}

// ---------------------------------------------------------------------------
// Directive shim (pure + plugin)
// ---------------------------------------------------------------------------

const TW_DIRECTIVE_RE = /^[^\S\n]*@tailwind\s+(?:base|components|utilities|screens|variants)\s*;[^\S\n]*$/gm;

/**
 * Remove v3 `@tailwind base/components/utilities;` (and `screens`/`variants`)
 * directive lines — v4 rejects them, and a repo's theme css needs to be
 * importable purely for its `:root`/`.dark` CSS-var values. `@apply`/`@layer`
 * are deliberately left untouched.
 */
export function stripTailwindDirectives(code: string): string {
  return code.replace(TW_DIRECTIVE_RE, "");
}

function idPath(id: string): string {
  const q = id.indexOf("?");
  return q === -1 ? id : id.slice(0, q);
}

/**
 * Vite plugins for the bridge:
 *   1. `designbook:tailwind-bridge` — serves the generated CSS as the virtual
 *      entry `BRIDGE_SPECIFIER`, resolved to a path UNDER `uiRoot` so Tailwind
 *      v4 resolves `@import "tailwindcss"` against designbook's own v4 (not the
 *      repo's v3). Always registered; serves "" when inert.
 *   2. `designbook:tailwind-v3-directive-shim` — strips v3 `@tailwind`
 *      directives from TARGET-REPO css (never ours / node_modules). `enforce:
 *      "pre"` + placed before `@tailwindcss/vite` so the strip is what Tailwind
 *      sees. Registered only for v3 repos.
 */
export function tailwindBridgePlugins(opts: {
  bridge: TailwindBridge;
  uiRoot: string;
  projectRoot: string;
  packageRoot: string;
  log?: (msg: string) => void;
}): Plugin[] {
  const { bridge, uiRoot, projectRoot, packageRoot } = opts;
  const log = opts.log ?? (() => {});
  // A path under uiRoot (not written to disk — served via `load`) so Tailwind's
  // `@import "tailwindcss"` resolves from designbook's node_modules and the
  // scoped-transform check (`startsWith(uiRoot)`) never excludes it.
  const resolvedBridgeId = join(uiRoot, "__designbook_tailwind_bridge.css");

  const bridgePlugin: Plugin = {
    name: "designbook:tailwind-bridge",
    resolveId(id) {
      return id === BRIDGE_SPECIFIER ? resolvedBridgeId : undefined;
    },
    load(id) {
      return id === resolvedBridgeId ? bridge.css : undefined;
    },
  };

  if (!bridge.isV3) return [bridgePlugin];

  const shimmed = new Set<string>();
  const shimPlugin: Plugin = {
    name: "designbook:tailwind-v3-directive-shim",
    enforce: "pre",
    transform(code, id) {
      const p = idPath(id);
      if (!p.endsWith(".css")) return undefined;
      if (p.startsWith(packageRoot)) return undefined; // designbook's own css
      if (!p.startsWith(projectRoot)) return undefined; // outside the repo
      if (p.includes("/node_modules/")) return undefined;
      const out = stripTailwindDirectives(code);
      if (out === code) return undefined;
      if (!shimmed.has(p)) {
        shimmed.add(p);
        log(`[designbook] tailwind bridge: stripped v3 @tailwind directives from ${p}`);
        if (/@apply\b|@layer\b/.test(out)) {
          log(
            `[designbook] tailwind bridge: ${p} still contains @apply/@layer — left as-is (not converted)`,
          );
        }
      }
      return { code: out, map: null };
    },
  };

  return [bridgePlugin, shimPlugin];
}
