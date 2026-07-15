/**
 * Transform-time SOURCE STAMPING (exact-source spec): give every app component
 * an exact source identity so the runtime reads the precise definition file off
 * the fiber instead of guessing by name (the name index can't disambiguate two
 * genuinely-distinct components sharing a name — every `index.tsx` wrapper
 * pattern makes one).
 *
 * For each CLIENT-GRAPH module the designbook vite plugin transforms, we append
 * — at the END of the module, so no existing line number moves — a guarded
 * stamp per top-level component binding the module DECLARES:
 *
 *     try { X.__dbSource = "<repo-rel-file>"; } catch {}
 *
 * The stamp lands on the component's function/class/memo/forwardRef binding
 * object. React sets `fiber.type` to that same binding, so at runtime
 * `fiber.type.__dbSource` is the exact definition file (see `sourceFromFiber`
 * in fibers.ts). The try/catch guards frozen/proxied bindings from throwing.
 *
 * Only DECLARED bindings are stamped — a re-exported / imported name is stamped
 * by ITS OWN defining module (import-awareness via `collectImportedBindings`),
 * so `import { X } from "./y"; export { X };` and `export { X } from "./y"` are
 * both left alone here. This mirrors `scanComponentExports`'s definition/re-
 * export distinction exactly.
 *
 * Dev-only: the whole designbook plugin is `apply: "serve"`, so this never runs
 * during a production build. Append-only + idempotent under HMR (a re-transform
 * re-runs the same guarded assignment; Vite always transforms the original
 * source, so suffixes never accumulate).
 */

import { collectImportedBindings, isComponentName } from "./exportIndex.ts";

/** `function X` / `export function X` / `export default function X`, async or
 * generator. Captures the declared name (anonymous `export default function()`
 * has no capture → skipped). */
const FUNCTION_DECL =
  /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/g;

/** `class X` / `export class X` / `export default class X` (+ abstract). */
const CLASS_DECL =
  /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;

/** `const X = <rhs>` / `let` / `var`, optionally `export`ed. Captures the name
 * and the START of the initializer so it can be classified as component-ish.
 * (Types are already stripped — this runs post-esbuild — so no `: Type`
 * annotation stands between the name and `=`.) */
const VARIABLE_DECL =
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g;

/** A variable initializer that produces a component: an arrow, a function
 * expression, or a `memo(...)` / `forwardRef(...)` wrapper (optionally
 * `React.`-qualified). Deliberately conservative — a PascalCase constant bound
 * to a plain value (config object, number) is NOT a component and stays
 * unstamped, so the stamp never lands on a non-render binding. */
const COMPONENT_INITIALIZER =
  /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^(?:async\s+)?function\b|^(?:React\.)?(?:memo|forwardRef)\s*\(/;

/**
 * The PascalCase component bindings a module DECLARES (not re-exports / imports).
 * Returns a sorted, de-duplicated list.
 */
function collectDeclaredComponentBindings(code: string): string[] {
  const imported = collectImportedBindings(code);
  const names = new Set<string>();

  const add = (name: string | undefined): void => {
    if (!name || !isComponentName(name) || imported.has(name)) return;
    names.add(name);
  };

  for (const match of code.matchAll(FUNCTION_DECL)) add(match[1]);
  for (const match of code.matchAll(CLASS_DECL)) add(match[1]);
  for (const match of code.matchAll(VARIABLE_DECL)) {
    const rhs = match[2].trimStart();
    if (COMPONENT_INITIALIZER.test(rhs)) add(match[1]);
  }

  return [...names].sort();
}

/**
 * The stamp suffix to append to a module (or "" when it declares no component).
 * `repoRelFile` is the module's repo-relative path — the exact identity the
 * runtime reads back off `fiber.type.__dbSource`.
 */
function buildSourceStampSuffix(code: string, repoRelFile: string): string {
  const bindings = collectDeclaredComponentBindings(code);
  if (bindings.length === 0) return "";
  const file = JSON.stringify(repoRelFile);
  const lines = bindings.map(
    (name) => `try { ${name}.__dbSource = ${file}; } catch {}`,
  );
  return `\n/* designbook:source-stamp (dev only) */\n${lines.join("\n")}\n`;
}

export { buildSourceStampSuffix, collectDeclaredComponentBindings };
