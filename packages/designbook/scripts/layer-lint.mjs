/**
 * UI layer-lint (R spec — UI re-org). Enforces the import layering of
 * `src/ui` so the three-layer split cannot silently rot:
 *
 *   - components/  PURE — must import nothing from models/screens/adapters.
 *   - models/      data + logic — may import components/lib/previewHost + each
 *                  other, but NEVER screens/ or adapters/.
 *   - adapters/    may import models/, but NEVER screens/.
 *   - screens/     the composition layer — may import anything.
 *   - nothing imports models/figma EXCEPT screens/ (figma is an integration,
 *     hard-isolated behind its own screens' wiring — see spec Decisions).
 *
 * Test files (`*.test.*`) are exempt: integration tests legitimately render
 * across layers. This is a source-layering rule, not a test rule.
 *
 * No new toolchain: a tiny dependency-free scanner. Exported `findViolations()`
 * is asserted-empty by `src/ui/layerLint.test.ts` (runs in `pnpm test:run`) and
 * also run standalone via `pnpm lint:layers`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/ui");
const ALIAS = "@designbook-ui/";

/** Forbidden target layers per source layer. */
const RULES = {
  components: ["models", "screens", "adapters"],
  models: ["screens", "adapters"],
  adapters: ["screens"],
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** First path segment (the layer) of a path relative to src/ui. */
function layerOf(absPath) {
  const rel = relative(UI_ROOT, absPath);
  if (rel.startsWith("..")) return null;
  return rel.split("/")[0];
}

const IMPORT_RE = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function extractSpecifiers(src) {
  const specs = [];
  let m;
  while ((m = IMPORT_RE.exec(src))) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

/** Resolve an import specifier to an absolute file path under src/ui, or null. */
function resolveTarget(fromFile, spec) {
  let base;
  if (spec.startsWith(ALIAS)) base = join(UI_ROOT, spec.slice(ALIAS.length));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // bare package / @designbookapp/designbook/config / react / node: — out of scope
  const cands = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  // Unresolved (e.g. .css or a dir without index) — classify by prefix anyway.
  return base;
}

export function findViolations() {
  const violations = [];
  for (const file of walk(UI_ROOT)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const srcLayer = layerOf(file);
    const rules = RULES[srcLayer];
    const src = readFileSync(file, "utf8");
    for (const spec of extractSpecifiers(src)) {
      const target = resolveTarget(file, spec);
      if (!target) continue;
      const rel = relative(UI_ROOT, target);
      if (rel.startsWith("..")) continue;
      const targetLayer = rel.split("/")[0];
      const targetSecond = rel.split("/")[1];

      // Rule: only screens/ may import models/figma.
      if (
        targetLayer === "models" &&
        targetSecond === "figma" &&
        srcLayer !== "screens"
      ) {
        violations.push(
          `${relative(UI_ROOT, file)} → ${spec} (only screens/ may import models/figma)`,
        );
      }

      if (rules && rules.includes(targetLayer)) {
        violations.push(
          `${relative(UI_ROOT, file)} (${srcLayer}) → ${spec} (${srcLayer}/ must not import ${targetLayer}/)`,
        );
      }
    }
  }
  return violations;
}

// Standalone entry (pnpm lint:layers).
if (import.meta.url === `file://${process.argv[1]}`) {
  const v = findViolations();
  if (v.length) {
    console.error(`UI layer-lint: ${v.length} violation(s):\n  ${v.join("\n  ")}`);
    process.exit(1);
  }
  console.log("UI layer-lint: clean.");
}
