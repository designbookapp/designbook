/**
 * Transform-time SOURCE STAMPING (exact-source spec): give every app component
 * an exact source identity so the runtime reads the precise definition file off
 * the fiber instead of guessing by name (the name index can't disambiguate two
 * genuinely-distinct components sharing a name — every `index.tsx` wrapper
 * pattern makes one).
 *
 * For each CLIENT-GRAPH module the designbook vite plugin transforms, we append
 * — at the END of the module, so no existing line number moves — a guarded
 * stamp per component the module DECLARES or ASSEMBLES:
 *
 *     try { X.__dbSource = "<repo-rel-file>"; } catch {}
 *
 * Three definition shapes are covered so the stamp always lands on the exact
 * object React uses as `fiber.type`:
 *   1. TOP-LEVEL BINDINGS — `export const/function/class X` (+ memo/forwardRef
 *      wrappers). The stamp lands on the declared binding object.
 *   2. OBJECT-LITERAL COMPOUND MEMBERS — `const NS = { Card: <compo>, ... }`.
 *      A compound / namespace component (`<NS.Card/>`) renders the PROPERTY
 *      VALUE as `fiber.type`, NOT the `NS` object — so the top-level `NS`
 *      binding stamp is useless. We stamp each PascalCase-keyed component-ish
 *      property (`NS.Card.__dbSource = "<file>"`) directly on the value React
 *      renders. Inline arrows/function-exprs/`memo(...)`/`forwardRef(...)` are
 *      DEFINED here (definition site → plain `=`); a bare-identifier value
 *      (`{ Card }` shorthand or `{ Card: Base }`) points at a binding stamped
 *      by ITS OWN module, so we use `??=` to avoid clobbering the origin's
 *      exact stamp (and the origin's later `=` re-transform wins regardless).
 *   3. MEMBER-EXPRESSION ASSIGNMENTS — `NS.Card = <compo>;` at top level.
 *      Same value/reference logic as (2): inline → `=`, identifier → `??=`.
 *
 * React sets `fiber.type` to the stamped object (a plain function, a memo/
 * forwardRef wrapper, or a compound member's value), so at runtime
 * `fiber.type.__dbSource` is the exact definition file (see `sourceFromFiber`
 * in fibers.ts). The try/catch guards frozen/proxied bindings — and any false
 * positive (a non-component property, an undefined member) — from throwing.
 *
 * Only DECLARED bindings are stamped for (1) — a re-exported / imported name is
 * stamped by ITS OWN defining module (import-awareness via
 * `collectImportedBindings`), so `import { X } from "./y"; export { X };` and
 * `export { X } from "./y"` are both left alone here. This mirrors
 * `scanComponentExports`'s definition/re-export distinction exactly.
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

/** Opening of a namespace object binding: `const NS = {` / `let` / `var`
 * (optionally `export`ed). The `{` position (end of match) starts the
 * balanced-scan that extracts the object's compound-member properties. */
const OBJECT_BINDING =
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;

/** Top-level (column-0) member-expression assignment: `NS.Card = <rhs>`.
 * Column-0 anchoring keeps it to module-scope statements — an assignment
 * nested in a function body is indented and skipped (and would be inert
 * anyway: the guard swallows a throw). */
const MEMBER_ASSIGN =
  /(?:^|\n)([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g;

/** A bare identifier reference (RHS or property value that just aliases another
 * binding) — its own module owns the exact stamp, so we only `??=` fall back. */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*\s*;?\s*$/;

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
 * From the opening `{` of an object literal (at `openBrace`), return its
 * balanced close index and the source text of each TOP-LEVEL property (split
 * on depth-0 commas). A small char-scanner tracks (){}[] nesting and skips
 * string / template / comment content so a comma or brace inside a value
 * (e.g. `jsx("div", { children })`) never mis-splits or mis-closes. Regex
 * literals are not specially detected — post-esbuild component modules rarely
 * hold them, and any resulting stray segment is inert (guarded, non-component).
 */
function readObjectSegments(
  code: string,
  openBrace: number,
): { end: number; segments: string[] } {
  const segments: string[] = [];
  let seg = "";
  let round = 0;
  let square = 0;
  let curly = 0;
  const n = code.length;
  const flush = (): void => {
    if (seg.trim()) segments.push(seg);
    seg = "";
  };

  let i = openBrace + 1;
  while (i < n) {
    const c = code[i];

    // String literal.
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n && code[i] !== c) {
        if (code[i] === "\\") i += 1;
        i += 1;
      }
      seg += code.slice(start, i + 1);
      i += 1;
      continue;
    }

    // Template literal (skip `${ ... }` interpolations wholesale).
    if (c === "`") {
      i += 1;
      while (i < n) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "`") {
          i += 1;
          break;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (code[i] === "{") depth += 1;
            else if (code[i] === "}") depth -= 1;
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      continue;
    }

    // Comments.
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    if (c === "(") round += 1;
    else if (c === ")") round -= 1;
    else if (c === "[") square += 1;
    else if (c === "]") square -= 1;
    else if (c === "{") curly += 1;
    else if (c === "}") {
      if (curly === 0) {
        flush();
        return { end: i, segments };
      }
      curly -= 1;
    } else if (c === "," && round === 0 && square === 0 && curly === 0) {
      flush();
      i += 1;
      continue;
    }

    seg += c;
    i += 1;
  }

  flush();
  return { end: n, segments };
}

type StampMode = "define" | "fallback";
interface MemberStamp {
  /** `NS.Prop` member path the stamp lands on. */
  target: string;
  /** `define` → plain `=` (value defined here); `fallback` → `??=` (aliases a
   * binding whose own module owns the exact stamp). */
  mode: StampMode;
}

/**
 * Classify one object-literal property segment into a compound-member stamp,
 * or undefined when it is not a stampable component member:
 *   - `Card: () => …` / `Card: memo(…)` / method `Card() {…}` → DEFINE (the
 *     value is a fresh function/wrapper defined right here; nothing else stamps
 *     it).
 *   - `Card` (shorthand) / `Card: Base` (identifier alias) → FALLBACK (the
 *     referenced binding is stamped by its own module; `??=` never clobbers).
 *   - lowercase/SCREAMING keys, spreads, computed/string keys, object/value
 *     literals → skipped.
 */
function classifyProperty(
  segment: string,
): { key: string; mode: StampMode } | undefined {
  const s = segment.trim();

  // Method shorthand: `Card() { … }`.
  const method = /^([A-Za-z_$][\w$]*)\s*\(/.exec(s);
  if (method) {
    return isComponentName(method[1]) ? { key: method[1], mode: "define" } : undefined;
  }

  // `Key: value`.
  const keyed = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(s);
  if (keyed) {
    const key = keyed[1];
    if (!isComponentName(key)) return undefined;
    const value = keyed[2].trimStart();
    if (COMPONENT_INITIALIZER.test(value)) return { key, mode: "define" };
    if (BARE_IDENTIFIER.test(value)) return { key, mode: "fallback" };
    return undefined;
  }

  // Shorthand: `Card`.
  const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(s);
  if (shorthand) {
    return isComponentName(shorthand[1])
      ? { key: shorthand[1], mode: "fallback" }
      : undefined;
  }

  return undefined;
}

/**
 * Compound-member stamps a module ASSEMBLES: object-literal namespace members
 * (`const NS = { Card: … }`) and top-level member-expression assignments
 * (`NS.Card = …`). Deduplicated by target (a `define` always beats a
 * `fallback`), sorted for stable output.
 */
function collectMemberStamps(code: string): MemberStamp[] {
  const byTarget = new Map<string, StampMode>();
  const record = (target: string, mode: StampMode): void => {
    const prev = byTarget.get(target);
    if (prev === "define") return;
    if (prev === undefined || mode === "define") byTarget.set(target, mode);
  };

  for (const match of code.matchAll(OBJECT_BINDING)) {
    const ns = match[1];
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    const { segments } = readObjectSegments(code, openBrace);
    for (const segment of segments) {
      const prop = classifyProperty(segment);
      if (prop) record(`${ns}.${prop.key}`, prop.mode);
    }
  }

  for (const match of code.matchAll(MEMBER_ASSIGN)) {
    const key = match[2];
    if (!isComponentName(key)) continue;
    const rhs = match[3].trimStart();
    if (COMPONENT_INITIALIZER.test(rhs)) record(`${match[1]}.${key}`, "define");
    else if (BARE_IDENTIFIER.test(rhs)) record(`${match[1]}.${key}`, "fallback");
  }

  return [...byTarget.entries()]
    .map(([target, mode]) => ({ target, mode }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/**
 * The stamp suffix to append to a module (or "" when it declares/assembles no
 * component). `repoRelFile` is the module's repo-relative path — the exact
 * identity the runtime reads back off `fiber.type.__dbSource`.
 */
function buildSourceStampSuffix(code: string, repoRelFile: string): string {
  const bindings = collectDeclaredComponentBindings(code);
  const members = collectMemberStamps(code);
  if (bindings.length === 0 && members.length === 0) return "";
  const file = JSON.stringify(repoRelFile);
  const lines = [
    ...bindings.map((name) => `try { ${name}.__dbSource = ${file}; } catch {}`),
    ...members.map(({ target, mode }) =>
      mode === "define"
        ? `try { ${target}.__dbSource = ${file}; } catch {}`
        : `try { ${target}.__dbSource ??= ${file}; } catch {}`,
    ),
  ];
  return `\n/* designbook:source-stamp (dev only) */\n${lines.join("\n")}\n`;
}

export {
  buildSourceStampSuffix,
  collectDeclaredComponentBindings,
  collectMemberStamps,
};
