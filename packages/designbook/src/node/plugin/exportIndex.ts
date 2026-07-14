/**
 * Auto export index (config-slim spec): the vite plugin scans every CLIENT-GRAPH
 * app module it transforms and records `repo-relative file → exported component
 * names`. The index replaces the config registry (`sets` / `sourceModules`) as
 * the source of component identity:
 *   - the workbench fetches it (GET /api/export-index) and synthesizes
 *     registry entries for hit-testing/drill/labels;
 *   - the sidecar keeps a copy (POST /api/export-index) so the sandbox
 *     export-scan ladder becomes an index lookup with the scan as fallback.
 *
 * The scan is a fast, line-oriented regex pass over the module source (the
 * TRANSFORMED output — post-esbuild ESM keeps every `export` form textual, no
 * TS types left to confuse it). It is intentionally conservative: names must
 * look like component identifiers (leading capital, not SCREAMING_CASE), and a
 * non-component that slips through (e.g. an exported context object) is inert —
 * it never matches a fiber name, and the node-side ladder re-verifies against
 * the real file before trusting it.
 *
 * Incremental by construction: the index grows as vite transforms modules
 * (lazy growth — a page not yet visited is not yet indexed; the node-side
 * bounded scan fallback covers pins there) and updates on re-transform of a
 * changed file.
 */

/** `PascalCase`-ish identifier check: leading capital + at least one lowercase
 * letter (drops SCREAMING_CASE constants like `API_URL`). */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) && /[a-z]/.test(name);
}

/** PascalCase a file basename: `product-card.tsx` → `ProductCard`. */
function nameFromFile(filePath: string): string {
  const base = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]*$/, "");
  const stem = base === "index" ? filePath.split("/").slice(-2, -1)[0] ?? base : base;
  return stem
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const DECLARATION_EXPORT =
  /(?:^|\n)\s*export\s+(?:async\s+)?(?:function\*?|const|class|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

const DEFAULT_FUNCTION_EXPORT =
  /(?:^|\n)\s*export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)?/;

const DEFAULT_IDENTIFIER_EXPORT =
  /(?:^|\n)\s*export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?\s*(?:\n|$)/;

const DEFAULT_ANY_EXPORT = /(?:^|\n)\s*export\s+default\b/;

// Captures an optional trailing `from "specifier"` clause so re-exports
// (`export { X } from "./y"`) can be told apart from local list exports
// (`export { X }`) — a re-export is not a definition site; the real file
// gets indexed when IT is transformed (or by the scan fallback).
const LIST_EXPORT = /(?:^|\n)\s*export\s*\{([^}]*)\}\s*(from\s*['"][^'"]*['"])?/g;

/**
 * Exported component-ish names of one module. `filePath` names the module for
 * default-export inference (an anonymous `export default` is indexed under the
 * PascalCased basename — the convention glob entries already rely on).
 */
function scanComponentExports(code: string, filePath: string): string[] {
  const names = new Set<string>();

  for (const match of code.matchAll(DECLARATION_EXPORT)) {
    if (isComponentName(match[1])) names.add(match[1]);
  }

  for (const match of code.matchAll(LIST_EXPORT)) {
    // `export { X } from "./y"` / `export { X as Y } from "./y"` re-exports a
    // binding DEFINED elsewhere — not a definition site in this file. Skip it
    // here; the barrel would otherwise look like it defines every component
    // it re-exports, and the resolver sees the same name in 2 files.
    if (match[2]) continue;
    // `export { A, b as C, D as default }` — the EXPORTED (post-`as`) name is
    // the identity consumers import; `default` falls through to inference.
    for (const piece of match[1].split(",")) {
      const parts = piece.trim().split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0]).trim();
      if (!exported) continue;
      if (exported === "default") {
        const local = parts[0].trim();
        const name = isComponentName(local) ? local : nameFromFile(filePath);
        if (isComponentName(name)) names.add(name);
        continue;
      }
      if (isComponentName(exported)) names.add(exported);
    }
  }

  const namedDefault = code.match(DEFAULT_FUNCTION_EXPORT);
  if (namedDefault) {
    const name =
      namedDefault[1] && isComponentName(namedDefault[1])
        ? namedDefault[1]
        : nameFromFile(filePath);
    if (isComponentName(name)) names.add(name);
  } else {
    const identifierDefault = code.match(DEFAULT_IDENTIFIER_EXPORT);
    if (identifierDefault) {
      const name = isComponentName(identifierDefault[1])
        ? identifierDefault[1]
        : nameFromFile(filePath);
      if (isComponentName(name)) names.add(name);
    } else if (DEFAULT_ANY_EXPORT.test(code)) {
      // `export default memo(...)` / object / call — infer from the filename.
      const name = nameFromFile(filePath);
      if (isComponentName(name)) names.add(name);
    }
  }

  return [...names].sort();
}

type IndexableIdContext = {
  /** POSIX project root (repo root) — files outside it are unindexable. */
  projectRoot: string;
  /** POSIX designbook package root — the prebuilt lib is not app code. */
  packageRoot: string;
  /** POSIX absolute path of the user's config file — config exports are not components. */
  configPath: string;
};

/**
 * Whether a vite module id belongs to the CLIENT app graph the index covers:
 * a real on-disk .js/.ts(x) file inside the project, excluding node_modules,
 * virtual modules, `.designbook/` generated files, the designbook package
 * itself, and the config file.
 */
function isIndexableModuleId(id: string, ctx: IndexableIdContext): boolean {
  const clean = id.split("?")[0];
  if (clean.startsWith("\0") || clean.includes("virtual:")) return false;
  if (clean.includes("/node_modules/")) return false;
  if (!/\.[cm]?[jt]sx?$/.test(clean)) return false;
  const posix = clean.split("\\").join("/");
  if (!posix.startsWith(`${ctx.projectRoot}/`)) return false;
  if (posix === ctx.configPath) return false;
  if (posix === ctx.packageRoot || posix.startsWith(`${ctx.packageRoot}/`)) return false;
  if (posix.includes("/.designbook/")) return false;
  return true;
}

/** file → exported component names, JSON-shaped for the API. */
type ExportIndexFiles = Record<string, string[]>;

type ExportIndexSnapshot = {
  version: number;
  files: ExportIndexFiles;
};

type ExportIndex = {
  /** Record a (re-)transformed module's exports. Returns true when changed. */
  update(repoRelFile: string, names: string[]): boolean;
  /** Drop a deleted module. Returns true when it existed. */
  remove(repoRelFile: string): boolean;
  snapshot(): ExportIndexSnapshot;
};

/** In-memory incremental index (one per plugin instance / dev-server run). */
function createExportIndex(): ExportIndex {
  const files = new Map<string, string[]>();
  let version = 0;

  return {
    update(repoRelFile, names) {
      const next = [...names].sort();
      const prev = files.get(repoRelFile);
      if (prev && prev.length === next.length && prev.every((n, i) => n === next[i])) {
        return false;
      }
      if (next.length === 0) {
        if (!prev) return false;
        files.delete(repoRelFile);
      } else {
        files.set(repoRelFile, next);
      }
      version += 1;
      return true;
    },
    remove(repoRelFile) {
      if (!files.delete(repoRelFile)) return false;
      version += 1;
      return true;
    },
    snapshot() {
      const out: ExportIndexFiles = {};
      for (const [file, names] of [...files.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        out[file] = names;
      }
      return { version, files: out };
    },
  };
}

export {
  createExportIndex,
  isComponentName,
  isIndexableModuleId,
  nameFromFile,
  scanComponentExports,
};
export type { ExportIndex, ExportIndexFiles, ExportIndexSnapshot };
