/**
 * `designbook init` — scaffold the injected-mode files into a Vite app.
 *
 * Detects the app's Vite config, package manager, and a components directory,
 * then writes `.designbook/config.tsx` (a `fromGlob` template), a
 * `vite.designbook.config.<ext>` variant (wrap-their-config + checker-drop), and
 * the `design` / `dev:designbook` scripts. Idempotent: refuses to overwrite
 * existing files without `--force`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

const HELP = `designbook init — scaffold injected-mode files into a Vite app

Detects your Vite config, package manager, and a components directory, then
writes .designbook/config.tsx, a vite.designbook.config.<ext> variant, and the
"design" / "dev:designbook" scripts. Safe to re-run: won't overwrite existing
files unless you pass --force.

Usage:
  designbook init [options]

Options:
      --dir <path>        Components directory to register (default: detected)
      --app-port <port>   Port the app's dev server listens on (default: 3013)
      --port <port>       Stable sidecar port you connect to (default: 8787)
      --force             Overwrite existing files / scripts
  -h, --help              Show this help
`;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
];

/** Pick a package manager from the lockfiles present in a directory. */
function detectPackageManagerFrom(files: readonly string[]): PackageManager {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun";
  // package-lock.json or nothing → npm (the safe default).
  return "npm";
}

/** The `run` prefix for invoking a package.json script with this PM. */
function pmRun(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm";
    case "yarn":
      return "yarn";
    case "bun":
      return "bun run";
    default:
      return "npm run";
  }
}

/** The install-dev-dependency command for this PM (for next-steps output). */
function pmAddDev(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm add -D";
    case "yarn":
      return "yarn add -D";
    case "bun":
      return "bun add -d";
    default:
      return "npm i -D";
  }
}

/** Map a vite config filename to the variant extension to write. */
function variantExtFor(viteConfigName: string): string {
  const m = /\.(c|m)?[jt]s$/.exec(viteConfigName);
  return m ? m[0].slice(1) : "ts";
}

/** "client-app" / "@scope/my-ui" → "Client App" / "My Ui" (config title). */
function titleFromPackageName(name: string | undefined): string {
  if (!name) return "My App";
  const bare = name.replace(/^@[^/]+\//, "");
  const words = bare.split(/[-_./\s]+/).filter(Boolean);
  if (words.length === 0) return "My App";
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Convert an app-root-relative components dir to a glob relative to the config
 * file. The config now lives in `.designbook/` (one level below the app root),
 * so every path gets an extra leading `../`.
 */
function globForDir(dirRelToRoot: string): string {
  const norm = dirRelToRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return `../${norm}/*.tsx`;
}

/**
 * Choose the best components directory from a set of scanned candidates.
 * `preferred` dirs (in priority order) win if they have any component files;
 * otherwise the dir with the most component files, ties broken by shortest path.
 */
function chooseComponentsDir(
  candidates: readonly { dir: string; componentFiles: number }[],
  preferred: readonly string[],
): string | undefined {
  const byDir = new Map(candidates.map((c) => [c.dir, c.componentFiles]));
  for (const p of preferred) {
    if ((byDir.get(p) ?? 0) > 0) return p;
  }
  const ranked = candidates
    .filter((c) => c.componentFiles > 0)
    .sort(
      (a, b) =>
        b.componentFiles - a.componentFiles ||
        a.dir.length - b.dir.length ||
        a.dir.localeCompare(b.dir),
    );
  return ranked[0]?.dir;
}

/** Detect the indentation (string) used by a raw JSON document. */
function detectIndent(raw: string): string {
  const m = /\n([ \t]+)"/.exec(raw);
  return m ? m[1] : "  ";
}

/**
 * Merge scripts into a parsed package.json object (mutates a shallow copy).
 * Returns the new object plus which keys were added/skipped/conflicting.
 */
function mergeScripts(
  pkg: Record<string, unknown>,
  additions: Record<string, string>,
  force: boolean,
): {
  pkg: Record<string, unknown>;
  added: string[];
  skipped: string[];
  conflicts: string[];
} {
  const scripts: Record<string, string> = {
    ...((pkg.scripts as Record<string, string> | undefined) ?? {}),
  };
  const added: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(additions)) {
    const existing = scripts[key];
    if (existing === undefined) {
      scripts[key] = value;
      added.push(key);
    } else if (existing === value) {
      skipped.push(key); // already exactly right
    } else if (force) {
      scripts[key] = value;
      added.push(key);
    } else {
      conflicts.push(key);
    }
  }
  return { pkg: { ...pkg, scripts }, added, skipped, conflicts };
}

/** Render the designbook.config.tsx template. */
function renderConfigTemplate(opts: { title: string; glob: string }): string {
  return `import { defineConfig, fromGlob } from "@designbookapp/designbook/config";

export default defineConfig({
  title: ${JSON.stringify(opts.title)},

  sets: [
    {
      id: "primitives",
      title: "Primitives",
      // Register every component file lazily. Each cell code-splits through the
      // app's own bundler, so one broken component is one red cell; the code
      // panel's source path comes free from the glob key (nothing to register
      // manually for these entries).
      components: fromGlob(import.meta.glob(${JSON.stringify(opts.glob)})),
      // overrides: {
      //   Button: {
      //     matrixAxes: [
      //       { name: "Variant", values: ["primary", "secondary", "danger"] },
      //     ],
      //   },
      // },
    },
  ],
});
`;
}

/** Render the vite.designbook.config.<ext> variant. */
function renderViteVariant(opts: {
  baseImport: string;
  sidecarPort: number;
}): string {
  return `import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import { designbookPlugin } from "@designbookapp/designbook";
import baseConfig from ${JSON.stringify(opts.baseImport)};

// Runs the app's REAL vite config plus designbookPlugin(), which injects the
// designbook toolbar + workbench overlay into the app's own dev server. Only
// used by the "design" script; the normal build is untouched.
export default defineConfig((env: ConfigEnv): UserConfig => {
  const base = (
    typeof baseConfig === "function" ? baseConfig(env) : baseConfig
  ) as UserConfig;

  // Drop any vite-plugin-checker (it can crash the dev server; pure dev noise).
  const plugins = (base.plugins ?? []).filter((p) => {
    const name = (p as { name?: string })?.name ?? "";
    return !String(name).includes("checker");
  });

  plugins.push(
    designbookPlugin({
      config: "./.designbook/config.tsx",
      // Must match the sidecar port from \`designbook dev --port\`.
      serverUrl: "http://localhost:${opts.sidecarPort}",
    }),
  );

  return { ...base, plugins, server: { ...(base.server ?? {}), open: false } };
});
`;
}

// ── Filesystem scan (impure) ─────────────────────────────────────────────────

const PREFERRED_DIRS = ["src/components", "src/ui", "components", "src"];
const SCAN_IGNORE = new Set([
  "node_modules",
  "dist",
  ".git",
  "public",
  "build",
  "coverage",
]);

/** Count .tsx files in a dir whose basename looks like a component (Capital). */
function countComponentFiles(dir: string): number {
  let n = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.endsWith(".tsx")) continue;
    if (/\.(test|spec|stories)\.tsx$/.test(e)) continue;
    if (/^[A-Z]/.test(e)) n += 1;
    else {
      // lowercase-named file: peek for an exported Capitalized component.
      try {
        const src = readFileSync(join(dir, e), "utf8");
        if (
          /export\s+(default\s+)?(function|const|class)\s+[A-Z]/.test(src) ||
          /export\s+default\s+[A-Z]/.test(src)
        ) {
          n += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}

/** Walk under root (depth-capped) collecting component-file counts per dir. */
function scanComponentDirs(
  root: string,
): { dir: string; componentFiles: number }[] {
  const out: { dir: string; componentFiles: number }[] = [];
  const walk = (abs: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    const count = countComponentFiles(abs);
    if (count > 0) {
      const rel = relative(root, abs) || ".";
      out.push({ dir: rel.replace(/\\/g, "/"), componentFiles: count });
    }
    for (const e of entries) {
      if (SCAN_IGNORE.has(e) || e.startsWith(".")) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(abs, e));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(join(abs, e), depth + 1);
    }
  };
  const srcDir = join(root, "src");
  walk(existsSync(srcDir) ? srcDir : root, 0);
  return out;
}

// ── Runner ───────────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.error(`designbook init: ${message}`);
  process.exit(1);
}

async function runInit(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      dir: { type: "string" },
      "app-port": { type: "string" },
      port: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const root = process.cwd();
  const force = values.force ?? false;

  // 1. Preconditions: must be a Vite app with a package.json.
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`no package.json in ${root} — run this from your app's root.`);
  }
  const rootFiles = readdirSync(root);
  const viteConfigName = VITE_CONFIG_NAMES.find((n) => rootFiles.includes(n));
  if (!viteConfigName) {
    fail(
      "no vite.config.{ts,js,mts,mjs} found. designbook injects into a Vite " +
        "dev server; non-Vite apps (incl. Next.js) aren't supported yet.",
    );
  }

  const rawPkg = readFileSync(pkgPath, "utf8");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(rawPkg) as Record<string, unknown>;
  } catch {
    return fail(`could not parse ${pkgPath}`);
  }

  const pm = detectPackageManagerFrom(rootFiles);
  const appPort = Number(values["app-port"] ?? 3013);
  const sidecarPort = Number(values.port ?? 8787);
  if (!Number.isInteger(appPort) || appPort <= 0 || appPort > 65535) {
    fail(`invalid --app-port: ${values["app-port"]}`);
  }
  if (
    !Number.isInteger(sidecarPort) ||
    sidecarPort <= 0 ||
    sidecarPort > 65535
  ) {
    fail(`invalid --port: ${values.port}`);
  }

  // 2. Components dir: explicit --dir, else detect.
  let componentsDir = values.dir?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (componentsDir) {
    if (!existsSync(join(root, componentsDir))) {
      fail(`--dir does not exist: ${componentsDir}`);
    }
  } else {
    componentsDir = chooseComponentsDir(
      scanComponentDirs(root),
      PREFERRED_DIRS,
    );
    if (!componentsDir) {
      // Nothing detected — fall back to src/components and warn.
      componentsDir = "src/components";
      console.warn(
        "designbook init: no component directory detected; defaulting the " +
          "glob to ../src/components/*.tsx — edit .designbook/config.tsx to point " +
          "at your components (paths are relative to .designbook/).",
      );
    }
  }

  const title = titleFromPackageName(pkg.name as string | undefined);
  const glob = globForDir(componentsDir);
  const variantExt = variantExtFor(viteConfigName);
  const viteVariantName = `vite.designbook.config.${variantExt}`;
  const baseImport = `./${viteConfigName.replace(/\.[^.]+$/, "")}`;

  const written: string[] = [];
  const skippedFiles: string[] = [];

  // 3a. .designbook/config.tsx — `.designbook/` is THE designbook folder per
  // host app (it also holds the figma push baselines). Globs are relative to
  // this file, hence the extra `../` in globForDir.
  const configRel = ".designbook/config.tsx";
  const configPath = join(root, configRel);
  if (existsSync(configPath) && !force) {
    skippedFiles.push(configRel);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, renderConfigTemplate({ title, glob }));
    written.push(configRel);
  }

  // 3b. vite.designbook.config.<ext>
  const variantPath = join(root, viteVariantName);
  if (existsSync(variantPath) && !force) {
    skippedFiles.push(viteVariantName);
  } else {
    writeFileSync(
      variantPath,
      renderViteVariant({ baseImport, sidecarPort }),
    );
    written.push(viteVariantName);
  }

  // 3c. package.json scripts (preserve formatting).
  const run = pmRun(pm);
  const additions: Record<string, string> = {
    "dev:designbook": `vite --config ${viteVariantName} --port ${appPort}`,
    design: `designbook dev --port ${sidecarPort} --target-cmd "${run} dev:designbook" --target-port ${appPort}`,
  };
  const merged = mergeScripts(pkg, additions, force);
  let scriptsNote: string;
  if (merged.added.length > 0) {
    const indent = detectIndent(rawPkg);
    const hasTrailingNewline = rawPkg.endsWith("\n");
    writeFileSync(
      pkgPath,
      JSON.stringify(merged.pkg, null, indent) +
        (hasTrailingNewline ? "\n" : ""),
    );
    scriptsNote = `updated package.json scripts: ${merged.added.join(", ")}`;
  } else if (merged.conflicts.length > 0) {
    scriptsNote = `package.json scripts already present (kept yours; --force to replace): ${merged.conflicts.join(", ")}`;
  } else {
    scriptsNote = "package.json scripts already up to date";
  }

  // 4. Report.
  const lines: string[] = [];
  lines.push("");
  lines.push("designbook init");
  lines.push(`  package manager   ${pm}`);
  lines.push(`  vite config       ${viteConfigName}`);
  lines.push(`  components dir     ${componentsDir}  (glob ${glob})`);
  lines.push("");
  if (written.length > 0) lines.push(`  wrote   ${written.join(", ")}`);
  if (skippedFiles.length > 0) {
    lines.push(
      `  kept    ${skippedFiles.join(", ")}  (exists; --force to overwrite)`,
    );
  }
  lines.push(`  ${scriptsNote}`);
  lines.push("");
  lines.push("Next steps:");
  let step = 1;
  if (!existsSync(join(root, ".git"))) {
    lines.push(
      `  ${step}. This isn't a git repo yet — designbook uses git for branch`,
    );
    lines.push(`     instances, so initialize one: git init && git add -A && git commit`);
    step += 1;
  }
  lines.push(`  ${step}. Install designbook as a dev dependency if you haven't:`);
  lines.push(`       ${pmAddDev(pm)} @designbookapp/designbook`);
  step += 1;
  lines.push(`  ${step}. Point the glob in .designbook/config.tsx at your components`);
  lines.push(`     (currently ${glob}; it is relative to .designbook/, so paths`);
  lines.push(`     start with ../ — in a monorepo, ../../<pkg>/... reaches a workspace lib).`);
  step += 1;
  lines.push(`  ${step}. Start the workbench:`);
  lines.push(`       ${run} design`);
  lines.push(
    `     → open http://localhost:${sidecarPort}/  (the sidecar proxy, NOT the app port)`,
  );
  lines.push("");
  lines.push(
    `  The Pi chat tab needs ANTHROPIC_API_KEY in the shell that runs "${run} design";`,
  );
  lines.push(
    `  the canvas, code panel, and deep links all work without it.`,
  );
  lines.push(
    `  Ports: --app-port (app dev server, now ${appPort}) and --port (sidecar, now ${sidecarPort}).`,
  );
  lines.push("");
  console.log(lines.join("\n"));
}

export {
  runInit,
  // Pure helpers (exported for unit tests):
  detectPackageManagerFrom,
  pmRun,
  pmAddDev,
  variantExtFor,
  titleFromPackageName,
  globForDir,
  chooseComponentsDir,
  detectIndent,
  mergeScripts,
  renderConfigTemplate,
  renderViteVariant,
};
