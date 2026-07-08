/**
 * Bridges the target repo's Vite/TS configuration into designbook's embedded
 * Vite instance, which runs with `configFile: false` (see server.ts) and would
 * otherwise ignore everything the repo's own build knows about.
 *
 * Two sources, in precedence order (highest first):
 *   1. designbook's own reserved aliases — always win.
 *   2. an explicit sidecar `designbook.vite.{ts,mts,js,mjs}` next to the
 *      designbook config: the escape hatch. Contributes resolve.alias +
 *      resolve.dedupe, css, optimizeDeps, define, and (uniquely) appended
 *      `plugins` — e.g. Lingui/svgr.
 *   3. the repo's own auto-detected `vite.config.*`: zero-config. alias/css/
 *      optimizeDeps/define are merged from a safe allowlist; its `plugins` are
 *      ALSO inherited (the Storybook model) but run through a deny-list that
 *      strips framework/server plugins (RR7/Next/Astro/SvelteKit/PWA/…), drops
 *      any that collide with one of ours, and — if the repo ships
 *      `@vitejs/plugin-react(-swc)` — swaps THEIR react plugin into our fixed
 *      slot so their babel/swc config (Lingui macros, Emotion, …) rides along.
 *      Inherited-plugin filtering + react splicing happens in server.ts, where
 *      our own plugin names are known; `resolveUserVite` only captures the raw
 *      inherited plugin array plus source-alias synthesis / css collection.
 *   4. Next.js shims (`next/link` etc.) when the repo depends on `next` — lowest
 *      precedence, so a user/sidecar/repo alias for those ids overrides them.
 *
 * Item 8 additions: css `preprocessorOptions`/`modules` are also unioned from
 * the vite configs of workspace packages the config's package depends on
 * (closest-to-config wins; sidecar beats all), and source aliases are
 * synthesized for those deps when their `exports`/`main` point at an unbuilt
 * `dist/` but a `src/` exists (`pkg` → `src/index`, `pkg/x` → `src/x`).
 *
 * Sidecars are loaded via Vite's own `loadConfigFromFile` (so they can be TS,
 * and are not run through designbook's fixed Vite instance — no chicken/egg).
 * Auto-detection is wrapped in try/catch: foreign configs may execute
 * env-dependent code, and a throw must degrade to "continue without it".
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  loadConfigFromFile,
  type Alias,
  type CSSOptions,
  type DepOptimizationOptions,
  type Plugin,
  type PluginOption,
  type UserConfig,
} from "vite";

const SIDECAR_NAMES = [
  "designbook.vite.ts",
  "designbook.vite.mts",
  "designbook.vite.js",
  "designbook.vite.mjs",
];
const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
];
const NEXT_SHIM_IDS = [
  "next/link",
  "next/navigation",
  "next/image",
  "next/dynamic",
] as const;

/**
 * Inherited (auto-detected repo) plugins whose `name` matches one of these are
 * DENIED — a framework/server plugin would hijack designbook's dev server.
 * Matched case-insensitively against the flattened plugin `name`. `react`
 * plugins are handled separately (dedupe, see filterInheritedPlugins) and are
 * NOT in this list. `[^a-z]`-guarded tokens avoid false positives (e.g. "next"
 * must not match inside "context").
 */
const PLUGIN_DENY: { re: RegExp; reason: string }[] = [
  // @react-router/dev vite plugin registers several: `react-router`,
  // `react-router:*` (config/hmr/virtual-modules/…).
  { re: /react-router/i, reason: "react-router framework plugin" },
  { re: /remix/i, reason: "remix framework plugin" },
  { re: /(^|[^a-z])next($|[^a-z])/i, reason: "next framework plugin" },
  { re: /astro/i, reason: "astro framework plugin" },
  { re: /svelte/i, reason: "svelte(kit) framework plugin" },
  { re: /(^|[^a-z])solid($|[^a-z])/i, reason: "solid framework plugin" },
  { re: /qwik/i, reason: "qwik framework plugin" },
  { re: /(^|[^a-z])pwa($|[^a-z])|vite-plugin-pwa/i, reason: "pwa plugin" },
  { re: /nitro/i, reason: "nitro server plugin" },
  // Vite's own internal plugins (`vite:*`) should never arrive via a user
  // config; if one does, dropping it is safe (ours already provides it).
  { re: /^vite:/i, reason: "vite-internal plugin" },
  // dts/codegen plugins: write-side-effect plugins that regenerate files
  // inside the TARGET REPO while serving. `vite-plugin-sass-dts` rewrote 95
  // `.module.scss.d.ts` files in twenty mid-run. Bounded "dts" (real `name`,
  // not a package-name guess) also catches `vite-plugin-dts` and
  // `unplugin-dts` (the latter is what `vite-plugin-dts`@5+ registers under,
  // per its own source) without matching e.g. "dtsGenerator".
  { re: /(^|[^a-z])dts($|[^a-z])/i, reason: "dts/codegen plugin — writes generated files into the target repo" },
  // Dev-tooling checkers: `vite-plugin-checker` spawned an ESLint worker
  // against OUR ui root and crashed the whole server process (excalidraw).
  // Also denies generic eslint/stylelint-named checker plugins.
  {
    re: /vite-plugin-checker|(^|[^a-z])eslint($|[^a-z])|(^|[^a-z])stylelint($|[^a-z])/i,
    reason: "dev-tooling checker plugin — runs its own linter/typechecker against the repo",
  },
  // Dev-server/middleware hijackers: `@hono/vite-dev-server` claims every
  // non-asset route, 404ing designbook's own workbench `/` (documenso). Also
  // denies generic `*-dev-server`-named plugins.
  {
    re: /@hono\/vite-dev-server|(^|[^a-z])dev-server($|[^a-z])/i,
    reason: "dev-server/middleware plugin — claims routes designbook's workbench needs",
  },
];

/**
 * @vitejs/plugin-react + -swc plugin names. babel emits `vite:react-babel`,
 * `vite:react-refresh`, `vite:react-refresh-fbm`, `vite:react-virtual-preamble`,
 * `vite:react:config-post`, `vite:react:refresh-wrapper`; swc emits
 * `vite:react-swc`, `vite:react-swc:resolve-runtime`, and the non-`vite:`-prefixed
 * `@vitejs/plugin-react-swc/preamble`.
 */
const REACT_PLUGIN_NAME = /^vite:react([-:]|$)|@vitejs\/plugin-react/i;

/** Reason a denied inherited plugin was dropped, or undefined if allowed. */
export function pluginDenyReason(name: string): string | undefined {
  for (const { re, reason } of PLUGIN_DENY) {
    if (re.test(name)) return reason;
  }
  return undefined;
}

/**
 * Recursively await + flatten a Vite `PluginOption[]` (which may contain
 * promises, nested arrays, and falsy holes) into a flat `Plugin[]`.
 */
export async function flattenPlugins(
  options: PluginOption[] | undefined,
): Promise<Plugin[]> {
  const out: Plugin[] = [];
  for (const opt of options ?? []) {
    const resolved = await opt;
    if (!resolved) continue;
    if (Array.isArray(resolved)) {
      out.push(...(await flattenPlugins(resolved)));
    } else {
      out.push(resolved as Plugin);
    }
  }
  return out;
}

export type InheritedPluginFilter = {
  /**
   * Inherited react-family plugins (theirs). Non-empty ⇒ the caller drops its
   * own `react()` and splices these into the same slot (their babel/swc config
   * — Lingui macros, Emotion — rides along). Empty ⇒ keep ours.
   */
  react: Plugin[];
  /** Non-react, non-denied, non-colliding inherited plugins to append. */
  kept: Plugin[];
  /** Dropped plugins with the reason (for debug logging). */
  denied: { name: string; reason: string }[];
};

/**
 * Split flattened inherited plugins into: react-family (theirs, for dedupe),
 * kept (allowed), and denied (framework/server plugins, or a name colliding
 * with one of designbook's own plugins — e.g. a second `vite-tsconfig-paths`
 * or `@tailwindcss/vite`). React plugins are extracted BEFORE the collision
 * check so our own react's names in `ourPluginNames` never drop theirs.
 */
export function filterInheritedPlugins(
  plugins: Plugin[],
  ourPluginNames: Set<string>,
): InheritedPluginFilter {
  const react: Plugin[] = [];
  const kept: Plugin[] = [];
  const denied: { name: string; reason: string }[] = [];
  for (const p of plugins) {
    const name = p?.name ?? "";
    if (REACT_PLUGIN_NAME.test(name)) {
      react.push(p);
      continue;
    }
    const deny = pluginDenyReason(name);
    if (deny) {
      denied.push({ name, reason: deny });
      continue;
    }
    if (ourPluginNames.has(name)) {
      denied.push({ name, reason: "collides with a designbook plugin" });
      continue;
    }
    kept.push(p);
  }
  return { react, kept, denied };
}

export type UserViteMerge = {
  /** Full, ordered alias array: designbook base first, then user sources. */
  alias: Alias[];
  /** Extra dedupe entries to append after designbook's own. */
  dedupe: string[];
  css?: CSSOptions;
  optimizeDeps: DepOptimizationOptions;
  define: Record<string, unknown>;
  /** Sidecar plugins only, appended AFTER designbook's own plugins. */
  plugins: PluginOption[];
  /**
   * Raw plugin array from the auto-detected repo vite config (unflattened,
   * unfiltered). server.ts flattens these, runs the deny-list + our-name
   * collision dedupe, and splices any inherited react plugin into react's
   * fixed slot. Empty when no repo config was detected. See
   * filterInheritedPlugins.
   */
  inheritedPlugins: PluginOption[];
  /** Diagnostics (for debug logging). */
  sidecarPath?: string;
  autoDetectedPath?: string;
  nextShimIds: string[];
  /**
   * True when the auto-detected repo vite config's `css.postcss` itself
   * carries a Tailwind PostCSS plugin (e.g. a v3 setup) — one of the signals
   * `repoUsesTailwind` (tailwind.ts) ORs in, since that repo may not declare
   * `tailwindcss` anywhere reachable by a package.json dependency scan.
   */
  autoDetectedPostcssTailwind: boolean;
};

/**
 * True when a (possibly already-loaded) `css.postcss` config carries a
 * Tailwind PostCSS plugin. Handles the common inline-object form (plugin
 * instances expose `.postcssPlugin`, or a bare function whose name mentions
 * tailwind) and, cheaply, a string path to a postcss config file (content
 * scan only — never executed).
 */
export function detectTailwindInPostcss(css: CSSOptions | undefined): boolean {
  const postcss = css?.postcss;
  if (!postcss) return false;
  if (typeof postcss === "string") {
    try {
      return /tailwindcss/.test(readFileSync(postcss, "utf8"));
    } catch {
      return false;
    }
  }
  const plugins = (postcss as { plugins?: unknown[] }).plugins ?? [];
  return plugins.some((p) => {
    if (!p) return false;
    const name = (p as { postcssPlugin?: unknown }).postcssPlugin;
    if (typeof name === "string" && /tailwind/i.test(name)) return true;
    if (typeof p === "function" && /tailwind/i.test((p as (...a: unknown[]) => unknown).name ?? "")) {
      return true;
    }
    return false;
  });
}

/** designbook's reserved aliases — these must win over anything the repo defines. */
export function designbookBaseAliases(opts: {
  uiRoot: string;
  packageRoot: string;
}): Alias[] {
  const { uiRoot, packageRoot } = opts;
  return [
    { find: "@designbook-ui", replacement: uiRoot },
    {
      find: "@designbookapp/designbook/config",
      replacement: resolve(packageRoot, "src/config/index.ts"),
    },
    {
      find: "@designbookapp/designbook/adapters",
      replacement: resolve(packageRoot, "src/ui/adapters/index.ts"),
    },
  ];
}

/** Normalize Vite's object- or array-form `resolve.alias` into an array. */
export function normalizeAlias(alias: UserConfig["resolve"]): Alias[] {
  const value = alias?.alias;
  if (!value) return [];
  if (Array.isArray(value)) return [...value];
  return Object.entries(value).map(([find, replacement]) => ({
    find,
    replacement,
  }));
}

/** Concatenate two optimizeDeps, unioning include/exclude arrays. */
export function mergeOptimizeDeps(
  base: DepOptimizationOptions | undefined,
  extra: DepOptimizationOptions | undefined,
): DepOptimizationOptions {
  if (!base && !extra) return {};
  const union = (a?: string[], b?: string[]) => {
    if (!a && !b) return undefined;
    return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
  };
  const include = union(base?.include, extra?.include);
  const exclude = union(base?.exclude, extra?.exclude);
  return {
    ...base,
    ...extra,
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

/** Ordered directories to search for the repo's own vite config, no fs. */
export function orderedSearchDirs(
  configDir: string,
  projectRoot: string,
  listSubdirs: (dir: string) => string[],
): string[] {
  const dirs: string[] = [configDir, projectRoot];
  // One-level scan: monorepo app/package dirs (e.g. excalidraw's real config
  // lives in excalidraw-app/, not the repo root).
  for (const parent of ["apps", "packages"]) {
    const parentDir = join(projectRoot, parent);
    for (const sub of listSubdirs(parentDir)) dirs.push(join(parentDir, sub));
  }
  for (const sub of listSubdirs(projectRoot)) dirs.push(join(projectRoot, sub));
  // De-dup while preserving order.
  return dirs.filter((d, i) => dirs.indexOf(d) === i);
}

export type AutoDetectDirPick = {
  /** Directories to try, in order (first found vite.config wins). */
  dirs: string[];
  /** Candidates seen but excluded (ambiguous or library-shaped) — for logging. */
  skipped: string[];
};

/**
 * Restricts `orderedSearchDirs`' one-level monorepo scan to plausible
 * candidates, fixing the "wrong-package vite-config fallback" bug (the old
 * alphabetical first-match picked unrelated packages like `create-twenty-app`
 * or `packages/embeds`). Eligibility, in order:
 *   (a) configDir + projectRoot — unchanged, always tried first.
 *   (b) a scanned dir whose package.json `name` is a dependency of the
 *       designbook config's own package — an explicit workspace-dep link.
 *   (c) otherwise, ONLY the scanned dirs that both have a vite.config AND
 *       look like an app (no `main`/`exports` in package.json — the
 *       heuristic that separates excalidraw-app, a real dev app, from
 *       library/CLI packages like `create-twenty-app` or `packages/embeds`
 *       that happen to also ship a vite.config). If exactly one remains,
 *       it's used (preserves the excalidraw zero-config win); if 0 or 2+,
 *       none are — ambiguity is reported via `skipped` so the caller can log
 *       a "use a sidecar" hint rather than guess.
 */
export function pickAutoDetectConfigDirs(opts: {
  configDir: string;
  projectRoot: string;
  listSubdirs: (dir: string) => string[];
  pkgNameOf: (dir: string) => string | undefined;
  hasViteConfig: (dir: string) => boolean;
  isAppPkg: (dir: string) => boolean;
  configPkgDeps: Set<string>;
}): AutoDetectDirPick {
  const all = orderedSearchDirs(opts.configDir, opts.projectRoot, opts.listSubdirs);
  const primary = [opts.configDir, opts.projectRoot].filter((d, i, a) => a.indexOf(d) === i);
  const scan = all.filter((d) => !primary.includes(d));

  const depCandidates = scan.filter((d) => {
    const name = opts.pkgNameOf(d);
    return !!name && opts.configPkgDeps.has(name);
  });

  const remaining = scan.filter((d) => !depCandidates.includes(d));
  const withConfig = remaining.filter((d) => opts.hasViteConfig(d));
  const appCandidates = withConfig.filter((d) => opts.isAppPkg(d));
  const fallback = appCandidates.length === 1 ? appCandidates : [];
  const skipped = withConfig.filter((d) => !fallback.includes(d));

  return { dirs: [...primary, ...depCandidates, ...fallback], skipped };
}

export function listSubdirsSafe(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function firstExisting(dir: string, names: string[]): string | undefined {
  for (const name of names) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Serializes every `loadConfigFromFile` call (sidecar, primary auto-detect,
 * and workspace-dep css collection all funnel through `loadViteFile`) via a
 * module-level promise-chain mutex. Concurrent calls raced Node's ESM loader
 * on twenty's workspace-dep configs: `ERR_INTERNAL_ASSERTION: Cannot
 * require() ES Module ... not yet fully loaded`. Each call waits for the
 * previous one to settle (success OR failure) before running; a rejection
 * still propagates to its own caller via the awaited `run` promise below.
 */
let viteConfigLoadMutex: Promise<void> = Promise.resolve();

async function loadViteFile(path: string): Promise<UserConfig | undefined> {
  const run = viteConfigLoadMutex.then(() =>
    loadConfigFromFile({ command: "serve", mode: "development" }, path, dirname(path)),
  );
  viteConfigLoadMutex = run.then(
    () => undefined,
    () => undefined,
  );
  const loaded = await run;
  return loaded?.config;
}

/**
 * Drop auto-merged `optimizeDeps.include` entries that don't actually resolve
 * from a root Vite's optimizer actually uses — e.g. a repo's own vite.config
 * listing deps (`prop-types`) that resolve fine from the DETECTED config's own
 * dir but not from where our embedded Vite instance actually runs, producing
 * pure "Failed to resolve dependency" warning noise (documenso). Vite's
 * optimizer resolves these from its `root` — designbook's own UI dir under
 * `packageRoot` — so that is the ONLY root that predicts resolvability;
 * entries reachable merely from projectRoot or the detected config's dir
 * still warn (verified live on documenso: prop-types installed at the target
 * repo's root was unresolvable for the optimizer). Sidecar `include` is
 * untouched (explicit user intent, never filtered).
 */
function filterResolvableIncludes(
  include: string[] | undefined,
  fromDirs: string[],
  log: (msg: string) => void,
): string[] | undefined {
  if (!include) return include;
  const requires = fromDirs.map((d) => createRequire(join(d, "package.json")));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of include) {
    const resolvable = requires.some((req) => {
      try {
        req.resolve(id);
        return true;
      } catch {
        return false;
      }
    });
    (resolvable ? kept : dropped).push(id);
  }
  if (dropped.length) {
    log(`[designbook] dropping unresolvable auto-detected optimizeDeps.include: ${dropped.join(", ")}`);
  }
  return kept;
}

function pkgDepNames(pkgPath: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

/** `name` field of a package.json, or undefined if missing/unreadable. */
function pkgName(pkgPath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name;
  } catch {
    return undefined;
  }
}

/**
 * A package with neither `main` nor `exports` is treated as "an app" rather
 * than a publishable library — used to disambiguate vite-config fallback
 * candidates (fix: wrong-package vite-config fallback). Missing/unreadable
 * package.json is conservatively NOT app-like (don't auto-pick it).
 */
function isAppPackage(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      main?: unknown;
      exports?: unknown;
    };
    return !pkg.main && !pkg.exports;
  } catch {
    return false;
  }
}

/** Extract `<dir>` from simple `<dir>/*` glob entries (no nesting/negation). */
function globDirPrefixes(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [];
  const dirs: string[] = [];
  for (const p of patterns) {
    if (typeof p !== "string") continue;
    const m = /^([^*!]+)\/\*$/.exec(p.trim());
    if (m) dirs.push(m[1]);
  }
  return dirs;
}

/**
 * Cheap, best-effort read of workspace-glob parent dirs beyond the hardcoded
 * `apps`/`packages` — scans `package.json#workspaces` and
 * `pnpm-workspace.yaml` for simple `<dir>/*` entries via regex (no YAML/glob
 * dependency). Nested or negated globs are ignored; callers still fall back to
 * the `apps`/`packages` defaults regardless.
 */
export function workspaceGlobParents(root: string): string[] {
  const parents = new Set(["apps", "packages"]);
  try {
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      for (const d of globDirPrefixes(list)) parents.add(d);
    }
  } catch {
    /* ignore */
  }
  try {
    const ymlPath = join(root, "pnpm-workspace.yaml");
    if (existsSync(ymlPath)) {
      const text = readFileSync(ymlPath, "utf8");
      const entries = [...text.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1]);
      for (const d of globDirPrefixes(entries)) parents.add(d);
    }
  } catch {
    /* ignore */
  }
  return [...parents];
}

/**
 * Package.json path of the first workspace-member package one level under
 * `${parent}/*` (e.g. `apps/*`, `packages/*`) that declares `depName`, or
 * undefined. Exposes the triggering path for traceable detection logging
 * (e.g. next-detection); `hasDependencyInWorkspaceMembers` is a boolean
 * wrapper kept for existing callers.
 */
export function findDependencyInWorkspaceMembers(
  depName: string,
  projectRoot: string,
  parents: string[] = ["apps", "packages"],
  listSubdirs: (dir: string) => string[] = listSubdirsSafe,
): string | undefined {
  for (const parent of parents) {
    const parentDir = join(projectRoot, parent);
    for (const sub of listSubdirs(parentDir)) {
      const pkgPath = join(parentDir, sub, "package.json");
      if (pkgDepNames(pkgPath).has(depName)) return pkgPath;
    }
  }
  return undefined;
}

/**
 * True when any workspace-member package one level under `${parent}/*` (e.g.
 * `apps/*`, `packages/*`) declares `depName`. Cheap (package.json reads only,
 * no deep walk) — used so a dep declared only in a nested app/package of a
 * monorepo (not the config's own chain or the workspace root) still counts.
 */
export function hasDependencyInWorkspaceMembers(
  depName: string,
  projectRoot: string,
  parents: string[] = ["apps", "packages"],
  listSubdirs: (dir: string) => string[] = listSubdirsSafe,
): boolean {
  return findDependencyInWorkspaceMembers(depName, projectRoot, parents, listSubdirs) !== undefined;
}

/** Nearest ancestor dir that looks like a workspace root, or undefined. */
function findWorkspaceRoot(from: string): string | undefined {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces) return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Package.json path of the first match testing each package.json from
 * `configDir` up to (and including) `projectRoot`, plus the nearest workspace
 * root, for `depName` — or undefined. The config file lives with the app that
 * owns the dependency (e.g. examples/demo declares Tailwind), which a
 * projectRoot-only check at the git root would miss. Exposes the triggering
 * path for traceable detection logging (e.g. next-detection);
 * `hasDependencyInTree` is a boolean wrapper kept for existing callers.
 */
export function findDependencyInTree(
  depName: string,
  configDir: string,
  projectRoot?: string,
): string | undefined {
  const root = projectRoot ?? configDir;
  let dir = configDir;
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (pkgDepNames(pkgPath).has(depName)) return pkgPath;
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return undefined;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const wsRoot = findWorkspaceRoot(root);
  if (wsRoot) {
    const pkgPath = join(wsRoot, "package.json");
    if (pkgDepNames(pkgPath).has(depName)) return pkgPath;
  }
  return undefined;
}

/**
 * Test each package.json from `configDir` up to (and including) `projectRoot`,
 * plus the nearest workspace root, for `depName`. The config file lives with
 * the app that owns the dependency (e.g. examples/demo declares Tailwind), which
 * a projectRoot-only check at the git root would miss.
 */
export function hasDependencyInTree(
  depName: string,
  configDir: string,
  projectRoot?: string,
): boolean {
  return findDependencyInTree(depName, configDir, projectRoot) !== undefined;
}

/**
 * Package.json path that triggered next-detection (see `detectNextDep`), or
 * undefined. Kept broad deliberately (cal.com relies on the workspace-member
 * scan) — this doesn't narrow detection, it just names which file fired it so
 * the log is honest/traceable instead of a bare "next detected".
 */
export function detectNextDepSource(configDir: string, projectRoot?: string): string | undefined {
  const root = projectRoot ?? configDir;
  const inTree = findDependencyInTree("next", configDir, projectRoot);
  if (inTree) return inTree;
  return findDependencyInWorkspaceMembers("next", root, workspaceGlobParents(root));
}

/**
 * True when the target repo DECLARES a dependency on `next` — in the
 * configDir→projectRoot chain, the workspace root, or a workspace member one
 * level under apps/packages/*. No longer checks for a bare `node_modules/next`
 * install: that fired on hoisted example/docs Next apps in monorepos that
 * don't actually use Next (excalidraw, documenso, twenty) — a false positive.
 */
export function detectNextDep(configDir: string, projectRoot?: string): boolean {
  return detectNextDepSource(configDir, projectRoot) !== undefined;
}

function nextShimAliases(uiRoot: string): Alias[] {
  const shimDir = join(uiRoot, "shims/next");
  return [
    { find: "next/link", replacement: join(shimDir, "link.tsx") },
    { find: "next/navigation", replacement: join(shimDir, "navigation.tsx") },
    { find: "next/image", replacement: join(shimDir, "image.tsx") },
    { find: "next/dynamic", replacement: join(shimDir, "dynamic.tsx") },
  ];
}

/**
 * Workspace-member dirs (one level under each `parent`) whose package `name`
 * is a DIRECT dependency of the config's package. Direct deps only — no
 * transitive walk. Used for css collection + source-alias synthesis (Item 8).
 */
export function workspaceDepDirs(opts: {
  configPkgDeps: Set<string>;
  projectRoot: string;
  parents?: string[];
  listSubdirs?: (dir: string) => string[];
  pkgNameOf?: (dir: string) => string | undefined;
}): { dir: string; name: string }[] {
  const parents = opts.parents ?? workspaceGlobParents(opts.projectRoot);
  const listSubdirs = opts.listSubdirs ?? listSubdirsSafe;
  const pkgNameOf =
    opts.pkgNameOf ?? ((d: string) => pkgName(join(d, "package.json")));
  const found: { dir: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const parent of parents) {
    const parentDir = join(opts.projectRoot, parent);
    for (const sub of listSubdirs(parentDir)) {
      const dir = join(parentDir, sub);
      const name = pkgNameOf(dir);
      if (name && opts.configPkgDeps.has(name) && !seen.has(dir)) {
        seen.add(dir);
        found.push({ dir, name });
      }
    }
  }
  return found;
}

/** Resolve a package.json's primary target (`exports["."]` → `main`), or undefined. */
function pkgMainTarget(pkg: Record<string, unknown>): string | undefined {
  const exp = pkg.exports;
  let target: unknown;
  if (typeof exp === "string") {
    target = exp;
  } else if (exp && typeof exp === "object") {
    const dot = (exp as Record<string, unknown>)["."] ?? exp;
    if (typeof dot === "string") {
      target = dot;
    } else if (dot && typeof dot === "object") {
      const cond = dot as Record<string, unknown>;
      target = cond.import ?? cond.default ?? cond.require ?? cond.node;
    }
  }
  if (typeof target !== "string") target = pkg.main;
  return typeof target === "string" ? target : undefined;
}

/**
 * Synthesize source aliases for a workspace dependency whose published entry
 * (`exports`/`main`) points at an unbuilt `dist/` (target missing on disk) but
 * whose `src/` exists — mirrors what twenty's sidecar did by hand
 * (`twenty-ui/navigation` → `../twenty-ui/src/navigation`). Returns regex
 * aliases: exact `^pkg$` → `src/index.{ts,tsx,js,jsx}` (probed) and subpath
 * `^pkg/(.+)$` → `src/$1` (Vite resolves the extension/index). Empty when the
 * dist target exists (built) or no `src/` is present.
 */
export function synthesizeSourceAliases(depDir: string, name: string): Alias[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(depDir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const target = pkgMainTarget(pkg);
  if (target && existsSync(join(depDir, target))) return []; // dist built — skip
  const srcDir = join(depDir, "src");
  if (!existsSync(srcDir)) return [];
  const aliases: Alias[] = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const indexFile = ["index.ts", "index.tsx", "index.js", "index.jsx"]
    .map((f) => join(srcDir, f))
    .find((p) => existsSync(p));
  if (indexFile) aliases.push({ find: new RegExp(`^${esc}$`), replacement: indexFile });
  aliases.push({ find: new RegExp(`^${esc}/(.+)$`), replacement: join(srcDir, "$1") });
  return aliases;
}

/**
 * Union `css.preprocessorOptions` across sources ordered FARTHEST→CLOSEST (so a
 * closer source wins on a conflicting option key). Merged per-preprocessor
 * (scss/less/…): closest wins on overlapping sub-keys, others accumulate.
 */
export function unionPreprocessorOptions(
  sources: (CSSOptions | undefined)[],
): NonNullable<CSSOptions["preprocessorOptions"]> | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  let any = false;
  for (const css of sources) {
    const p = css?.preprocessorOptions;
    if (!p) continue;
    for (const [key, val] of Object.entries(p)) {
      any = true;
      out[key] = { ...(out[key] ?? {}), ...(val as Record<string, unknown>) };
    }
  }
  return any ? out : undefined;
}

/** `css.modules` from the CLOSEST source that defines it (sources farthest→closest). */
export function pickClosestModules(
  sources: (CSSOptions | undefined)[],
): CSSOptions["modules"] | undefined {
  let modules: CSSOptions["modules"] | undefined;
  for (const css of sources) {
    if (css?.modules !== undefined) modules = css.modules;
  }
  return modules;
}

export type ResolveUserViteOptions = {
  configPath: string;
  projectRoot: string;
  uiRoot: string;
  packageRoot: string;
  log?: (msg: string) => void;
};

export async function resolveUserVite(
  opts: ResolveUserViteOptions,
): Promise<UserViteMerge> {
  const { configPath, projectRoot, uiRoot, packageRoot } = opts;
  const log = opts.log ?? (() => {});
  const configDir = dirname(configPath);

  const merge: UserViteMerge = {
    alias: designbookBaseAliases({ uiRoot, packageRoot }),
    dedupe: [],
    optimizeDeps: {},
    define: {},
    plugins: [],
    inheritedPlugins: [],
    nextShimIds: [],
    autoDetectedPostcssTailwind: false,
  };

  const sidecarAliases: Alias[] = [];
  const autoAliases: Alias[] = [];
  const sourceAliases: Alias[] = [];
  // css layers, collected FARTHEST→CLOSEST (dep configs, then primary, then
  // sidecar) and unioned at the end (Item 8). Only preprocessorOptions/modules
  // are taken from deps; primary/sidecar contribute their full (postcss-safe)
  // css as the base.
  let sidecarCss: CSSOptions | undefined;
  let primaryCss: CSSOptions | undefined;
  const depCss: CSSOptions[] = [];

  // 2. Sidecar (explicit, full trust).
  const sidecarPath = firstExisting(configDir, SIDECAR_NAMES);
  if (sidecarPath) {
    try {
      const cfg = await loadViteFile(sidecarPath);
      if (cfg) {
        merge.sidecarPath = sidecarPath;
        sidecarAliases.push(...normalizeAlias(cfg.resolve));
        if (cfg.resolve?.dedupe) merge.dedupe.push(...cfg.resolve.dedupe);
        if (cfg.css) sidecarCss = cfg.css; // full trust; unioned + overlaid last
        merge.optimizeDeps = mergeOptimizeDeps(merge.optimizeDeps, cfg.optimizeDeps);
        if (cfg.define) merge.define = { ...merge.define, ...cfg.define };
        if (cfg.plugins) merge.plugins.push(cfg.plugins);
        log(`[designbook] merged sidecar vite config: ${sidecarPath}`);
      }
    } catch (err) {
      console.warn(
        `[designbook] failed to load sidecar ${sidecarPath}: ${String(err)}`,
      );
    }
  }

  // 3. Auto-detected repo vite config (zero-config, safe allowlist only).
  const configPkgDeps = pkgDepNames(join(configDir, "package.json"));
  const { dirs: searchDirs, skipped } = pickAutoDetectConfigDirs({
    configDir,
    projectRoot,
    listSubdirs: listSubdirsSafe,
    pkgNameOf: (d) => pkgName(join(d, "package.json")),
    hasViteConfig: (d) => VITE_CONFIG_NAMES.some((n) => existsSync(join(d, n))),
    isAppPkg: isAppPackage,
    configPkgDeps,
  });
  if (skipped.length) {
    log(
      `[designbook] skipped ambiguous/library vite-config candidate(s): ${skipped.join(", ")} — add a designbook.vite sidecar to pick one`,
    );
  }
  for (const dir of searchDirs) {
    const candidate = firstExisting(dir, VITE_CONFIG_NAMES);
    if (!candidate) continue;
    try {
      const cfg = await loadViteFile(candidate);
      if (!cfg) continue;
      merge.autoDetectedPath = candidate;
      autoAliases.push(...normalizeAlias(cfg.resolve));
      // Inherit its plugins too (Storybook model); server.ts deny-filters +
      // dedupes + splices react. Captured raw here.
      if (cfg.plugins) merge.inheritedPlugins.push(cfg.plugins);
      // css/optimizeDeps/define only; sidecar wins on css/define conflicts.
      if (cfg.css) {
        // Detected BEFORE stripping — a repo's own postcss.config carrying a
        // Tailwind v3 plugin is a tailwind-detection signal even when we drop
        // it from the merge below (fix: css.postcss poisoning).
        merge.autoDetectedPostcssTailwind = detectTailwindInPostcss(cfg.css);
        // Strip css.postcss: an auto-detected postcss pipeline (e.g.
        // documenso's Tailwind v3 plugin) breaks our own v4 pipeline.
        // preprocessorOptions/modules/etc. are unioned in the css assembly
        // below. Sidecar (if any) still wins on conflicts.
        const { postcss: _postcss, ...restCss } = cfg.css;
        primaryCss = restCss;
      }
      const autoOptimizeDeps = cfg.optimizeDeps
        ? {
            ...cfg.optimizeDeps,
            include: filterResolvableIncludes(cfg.optimizeDeps.include, [packageRoot], log),
          }
        : cfg.optimizeDeps;
      merge.optimizeDeps = mergeOptimizeDeps(autoOptimizeDeps, merge.optimizeDeps);
      if (cfg.define) merge.define = { ...cfg.define, ...merge.define };
      log(`[designbook] auto-detected repo vite config: ${candidate}`);
      break;
    } catch (err) {
      console.warn(
        `[designbook] skipped repo vite config ${candidate} (failed to load): ${String(err)}`,
      );
    }
  }

  // 3b. Workspace deps of the config's package (Item 8): union their css
  // preprocessorOptions/modules, and synthesize source aliases for unbuilt
  // ones. Direct deps only; each load try/catch'd (twenty-front's own config
  // may fail to load while twenty-ui's must still be collected).
  for (const { dir, name } of workspaceDepDirs({ configPkgDeps, projectRoot })) {
    for (const a of synthesizeSourceAliases(dir, name)) {
      sourceAliases.push(a);
      log(
        `[designbook] synthesized source alias for unbuilt workspace dep: ${a.find} -> ${a.replacement}`,
      );
    }
    const depConfig = firstExisting(dir, VITE_CONFIG_NAMES);
    if (!depConfig) continue;
    try {
      const cfg = await loadViteFile(depConfig);
      if (cfg?.css) {
        depCss.push(cfg.css);
        log(`[designbook] collected css from workspace dep vite config: ${depConfig}`);
      }
    } catch (err) {
      log(
        `[designbook] skipped workspace-dep vite config ${depConfig} (failed to load): ${String(err)}`,
      );
    }
  }

  // css assembly (Item 8): base = sidecar (full trust) or primary (postcss
  // already stripped); then overlay preprocessorOptions unioned across
  // deps→primary→sidecar (closest wins) and the closest-defined `modules`.
  const cssLayers: (CSSOptions | undefined)[] = [...depCss, primaryCss, sidecarCss];
  let css: CSSOptions | undefined = sidecarCss
    ? { ...sidecarCss }
    : primaryCss
      ? { ...primaryCss }
      : undefined;
  const preproc = unionPreprocessorOptions(cssLayers);
  if (preproc) css = { ...(css ?? {}), preprocessorOptions: preproc };
  const modules = pickClosestModules(cssLayers);
  if (modules !== undefined) css = { ...(css ?? {}), modules };
  merge.css = css;

  // 4. Next.js shims, lowest precedence.
  let nextShims: Alias[] = [];
  const nextSource = detectNextDepSource(configDir, projectRoot);
  if (nextSource) {
    nextShims = nextShimAliases(uiRoot);
    merge.nextShimIds = NEXT_SHIM_IDS.filter(
      (id) => existsSync(join(uiRoot, "shims/next", id.split("/")[1] + ".tsx")),
    );
    const rel = relative(projectRoot, nextSource) || nextSource;
    log(
      `[designbook] next dependency found (${rel}) — registering fallback next/* shim aliases (lowest precedence)`,
    );
    // Next's bundler injects a `process.env` browser polyfill; client modules
    // reference it at module scope (`process.env.NEXT_PUBLIC_*`) and throw
    // ReferenceError under plain Vite. Longer user/repo keys (e.g.
    // `process.env.FOO`) still win — esbuild matches the most specific define.
    if (!("process.env" in merge.define)) {
      merge.define["process.env"] = {};
    }
  }

  // Precedence via order (first match wins): base → sidecar → auto →
  // synthesized source aliases → next-shims.
  merge.alias = [
    ...merge.alias,
    ...sidecarAliases,
    ...autoAliases,
    ...sourceAliases,
    ...nextShims,
  ];
  return merge;
}
