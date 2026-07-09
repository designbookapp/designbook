/**
 * Integration import-lint (C1 — figma-integration-plugin spec). Enforces the
 * plugin boundary over src/**:
 *
 *  1. OUTSIDE src/plugins/: nothing may import from src/plugins/** — except
 *     the two whitelisted builtin-registration files, and those may import
 *     ONLY a plugin's entry module (plugins/<name>/node/index.ts or
 *     plugins/<name>/ui/index.tsx).
 *  2. INSIDE src/plugins/figma/: files may import only
 *       - their own plugin's files,
 *       - the public seam: src/integration/**, src/node/integration/**,
 *         `@designbook-ui/integrations`, `@designbook-ui/previewHost`,
 *       - shared UI primitives: `@designbook-ui/components/**`,
 *         `@designbook-ui/lib/**`,
 *       - the public config entry (`@designbookapp/designbook/config`) and
 *         the core token/color modules it re-exports (src/config/**),
 *       - bare npm / node builtins.
 *     Any other `@designbook-ui/*` (models, screens, adapterRuntime, …) or
 *     relative escape into core is a violation.
 *
 * Test files are exempt (they may reach across for fixtures), matching
 * layer-lint. Dependency-free scanner in the layer-lint house style; asserted
 * by src/integrationLint.test.ts and runnable standalone.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const UI_ALIAS = "@designbook-ui/";

/** Files (relative to src/) allowed to import a plugin's entry module. */
const REGISTRATION_WHITELIST = new Set([
  "node/integrations/builtins.ts",
  "ui/integrations/builtins.ts",
]);

/** Entry-module paths (relative to src/) importable by the whitelist. */
function isPluginEntry(relPath) {
  return /^plugins\/[^/]+\/(node\/index\.ts|ui\/index\.tsx?)$/.test(relPath);
}

/** UI-alias prefixes plugin code may import (the curated seam surface). */
const PLUGIN_ALLOWED_UI_PREFIXES = [
  "@designbook-ui/integrations",
  "@designbook-ui/previewHost",
  "@designbook-ui/components/",
  "@designbook-ui/lib/",
];

/** Core dirs (relative to src/) plugin code may reach via relative imports. */
const PLUGIN_ALLOWED_CORE_DIRS = ["integration/", "node/integration/", "config/"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT_RE =
  /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function extractSpecifiers(src) {
  const specs = [];
  let m;
  while ((m = IMPORT_RE.exec(src))) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

/** Resolve a specifier to a src-relative path (posix slashes), or null. */
function resolveToSrcRel(fromFile, spec) {
  let base;
  if (spec.startsWith(UI_ALIAS)) base = join(SRC_ROOT, "ui", spec.slice(UI_ALIAS.length));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // bare package import — handled separately
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  let target = base;
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      target = c;
      break;
    }
  }
  const rel = relative(SRC_ROOT, target);
  if (rel.startsWith("..")) return null; // outside src — out of scope
  return rel.split(sep).join("/");
}

export function findViolations() {
  const violations = [];
  for (const file of walk(SRC_ROOT)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const fileRel = relative(SRC_ROOT, file).split(sep).join("/");
    const inPlugin = fileRel.startsWith("plugins/");
    const pluginName = inPlugin ? fileRel.split("/")[1] : undefined;
    const source = readFileSync(file, "utf8");

    for (const spec of extractSpecifiers(source)) {
      const targetRel = resolveToSrcRel(file, spec);

      if (!inPlugin) {
        // Rule 1: core must not reach into plugins, except the whitelisted
        // registration files importing a plugin ENTRY module.
        if (targetRel && targetRel.startsWith("plugins/")) {
          if (!REGISTRATION_WHITELIST.has(fileRel)) {
            violations.push(
              `${fileRel} → ${spec} (only the builtins registration files may import src/plugins/**)`,
            );
          } else if (!isPluginEntry(targetRel)) {
            violations.push(
              `${fileRel} → ${spec} (builtins may import only a plugin's entry module)`,
            );
          }
        }
        continue;
      }

      // Rule 2: plugin code imports only the public seam.
      if (spec.startsWith(UI_ALIAS)) {
        const allowed = PLUGIN_ALLOWED_UI_PREFIXES.some(
          (prefix) => spec === prefix.replace(/\/$/, "") || spec.startsWith(prefix),
        );
        if (!allowed) {
          violations.push(
            `${fileRel} → ${spec} (plugin code may import only the integration seam, previewHost, components/, lib/)`,
          );
        }
        continue;
      }
      if (spec.startsWith(".")) {
        if (!targetRel) continue;
        const ownPrefix = `plugins/${pluginName}/`;
        const allowed =
          targetRel.startsWith(ownPrefix) ||
          PLUGIN_ALLOWED_CORE_DIRS.some((dir) => targetRel.startsWith(dir));
        if (!allowed) {
          violations.push(
            `${fileRel} → ${spec} (plugin code may not reach into core beyond src/integration, src/node/integration, src/config)`,
          );
        }
        continue;
      }
      // Bare imports (react, lucide-react, node:*, @designbookapp/designbook/config,
      // pi SDK, typebox, …) are allowed.
    }
  }
  return violations;
}

// Standalone entry (node scripts/integration-lint.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  const v = findViolations();
  if (v.length) {
    console.error(
      `Integration import-lint: ${v.length} violation(s):\n  ${v.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log("Integration import-lint: clean.");
}
