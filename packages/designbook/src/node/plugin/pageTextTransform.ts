/**
 * Dev-only source transform for in-place page text editing (M spec, M2).
 *
 * Rewrites i18n translation call sites in the TARGET app's own source so their
 * resolved strings can carry designbook's invisible attribution marker when the
 * page text tool is active. Each matched call
 *
 *   t("greeting.title", opts)   →   __dbMark(t("greeting.title", opts), "greeting.title")
 *   i18n._(msgid, values)       →   __dbMark(i18n._(msgid, values), msgid)
 *
 * is wrapped with `__dbMark(value, keyExpr)` where `keyExpr` is the VERBATIM
 * source of the call's first argument — so dynamic keys (`t(varKey)`) attribute
 * correctly at runtime. `__dbMark` (from the `virtual:designbook-mark` module) is
 * a passthrough unless `window.__designbook.textToolActive`, so production and
 * normal dev are untouched; markers only appear while the tool is armed.
 *
 * ## Matcher heuristic (deliberate about false positives)
 * A call is wrapped when its callee is:
 *   - a bare `Identifier` named `t`         → i18next `t()` (from useTranslation /
 *     getFixedT), or the Lingui `t` macro's compiled form;
 *   - a non-computed member `.t`            → `i18n.t(...)`, `i18next.t(...)`;
 *   - a non-computed member `._`            → Lingui `i18n._(...)` (the runtime
 *     form the `t`/`msg` macros compile to; the macros run in the app's babel
 *     pipeline BEFORE this post-order transform, so only `_` is ever seen here).
 * A local function that merely happens to be named `t` and is NOT i18n will be
 * wrapped too; `__dbMark` only marks STRING return values and only while the
 * tool is active, so the worst case is an unmarked (or, if it returns a string,
 * spuriously marked-then-unclaimed) value — never a crash. Accepted trade-off:
 * exact key attribution with a real parser beats a fragile allow-list.
 *
 * ## Parser choice
 * `@babel/parser` (already in the graph via @vitejs/plugin-react; pinned as an
 * explicit dep) parses to an AST so call sites and their first-argument spans are
 * found precisely; `magic-string` does surgical, sourcemap-preserving inserts so
 * only the wrapped spans change (no full reprint / no @babel/generator+traverse).
 */

import { parse } from "@babel/parser";
import MagicString from "magic-string";

const VIRTUAL_MARK_ID = "virtual:designbook-mark";
// The transform runs at `order: "post"`, i.e. AFTER Vite's import-analysis has
// already rewritten every specifier to a browser URL — so a bare
// `virtual:designbook-mark` here would reach the browser unresolved and fail the
// module. Inject the pre-resolved `/@id/` dev URL (the same form the boot script
// uses) so the browser fetches it directly; the plugin's resolveId/load serve it.
const MARK_IMPORT = `import { __dbMark } from "/@id/${VIRTUAL_MARK_ID}";\n`;

/**
 * The runtime body of `virtual:designbook-mark`, served by the plugin.
 *
 * Frame fallback: an App-page frame cell's own
 * `window.__designbook` never exists (the boot module's recursion guard bails
 * before installing it), so a local miss falls back to `window.top.__designbook`
 * (same-origin try/catch) and uses ITS `.mark` hook — mirrors the pure predicate
 * unit-tested in `src/node/markRuntime.ts` (`resolveMarkHost`); duplicated here
 * by hand since this ships as raw JS to the browser. Only ever READS
 * `window.top` — never assigns to the frame's own `window.__designbook`, so a
 * half-booted frame can't write shared per-origin state.
 */
const MARK_MODULE_SOURCE = `export function __dbMark(value, key, ns) {
  var g = typeof window !== "undefined" ? window.__designbook : undefined;
  if (!(g && g.mark)) {
    var top;
    try {
      top = window.top !== window.self ? window.top.__designbook : undefined;
    } catch (e) {
      top = undefined;
    }
    g = top && top.mark ? top : undefined;
  }
  return g && g.mark ? g.mark(value, key, ns) : value;
}
`;

/** Minimal structural view of a babel AST node (dep-free walking). */
type Node = {
  type?: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

/** Keys never worth descending into (spans/comments), skipped while walking. */
const SKIP_KEYS = new Set([
  "type",
  "start",
  "end",
  "loc",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "extra",
  "tokens",
]);

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const record = node as Node;
  if (typeof record.type === "string") visit(record);
  for (const key in record) {
    if (SKIP_KEYS.has(key)) continue;
    walk(record[key], visit);
  }
}

/** Whether a call's callee is an i18next/Lingui translate function we wrap. */
function isTranslateCallee(callee: unknown): boolean {
  const node = callee as Node | undefined;
  if (!node || typeof node.type !== "string") return false;
  if (node.type === "Identifier" && node.name === "t") return true;
  if (node.type === "MemberExpression" && node.computed !== true) {
    const property = node.property as Node | undefined;
    if (
      property?.type === "Identifier" &&
      (property.name === "t" || property.name === "_")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Transform a single module's source. Returns the rewritten code + sourcemap, or
 * `null` when nothing matched (so the caller can pass the original through).
 */
function transformPageText(
  code: string,
  id: string,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  // Cheap pre-filter: skip files with no plausible `t(` / `._(` call.
  if (!/\bt\s*\(|\._\s*\(/.test(code)) return null;

  let ast: { program: unknown };
  try {
    ast = parse(code, {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ["typescript", "jsx"],
    });
  } catch {
    // Unparseable (exotic syntax / already-lowered edge): leave it untouched.
    return null;
  }

  const magic = new MagicString(code);
  let wrapped = 0;

  walk(ast.program, (node) => {
    if (node.type !== "CallExpression") return;
    if (!isTranslateCallee(node.callee)) return;
    const args = node.arguments as Node[] | undefined;
    if (!args || args.length === 0) return;
    const first = args[0];
    // Can't attribute a spread first-arg (`t(...keys)`).
    if (!first || first.type === "SpreadElement") return;
    if (
      typeof node.start !== "number" ||
      typeof node.end !== "number" ||
      typeof first.start !== "number" ||
      typeof first.end !== "number"
    ) {
      return;
    }
    const keyExpr = code.slice(first.start, first.end);
    magic.appendLeft(node.start, "__dbMark(");
    magic.appendRight(node.end, `, ${keyExpr})`);
    wrapped += 1;
  });

  if (wrapped === 0) return null;
  magic.prepend(MARK_IMPORT);
  return {
    code: magic.toString(),
    map: magic.generateMap({ source: id, hires: true }),
  };
}

export {
  MARK_MODULE_SOURCE,
  VIRTUAL_MARK_ID,
  isTranslateCallee,
  transformPageText,
};
