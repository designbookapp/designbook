/**
 * Precise JSX-attribute editing at a component's USAGE site (props panel,
 * docs/specs/props-panel.md). Given the source of the file that RENDERS a
 * `<Component …>` element (the selection's codeTarget owner file), set /
 * replace / remove ONE attribute on that exact element — nothing else in the
 * file moves.
 *
 * The edit is AST-located, text-applied: `@babel/parser` gives every JSX
 * opening element and attribute a precise `[start, end)` span, and the edit
 * is a single `magic-string` splice over that span. The surrounding bytes are
 * preserved verbatim (formatting, comments, unrelated attributes), so a
 * committed edit reads as a minimal diff.
 *
 * Disambiguation mirrors `findUsageLine` (the code panel's highlight): match
 * the JSX name, prefer the element whose `className` contains the selection's
 * className, then the one nearest the reported usage line, then the first.
 *
 * SPREAD BAIL-OUT: an element carrying `{...spread}` is REFUSED
 * (`unresolvable`) — a spread can override the named attribute at runtime, so
 * a written value would silently not take. The panel shows read-only controls
 * for such an instance rather than guessing a write.
 *
 * Pure + dependency-light (only the parser + magic-string) so it unit-tests
 * without a repo, a server, or a live fiber.
 */

import { parse } from "@babel/parser";
import MagicString from "magic-string";

/** The new value for a set edit, discriminated by the control's kind so the
 * emitted JSX attribute is idiomatic (`prop="s"` / `prop={42}` / bare
 * `prop`). */
type JsxAttrValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  /** A raw JS expression placed inside `{…}` verbatim (enum member ref, etc.).
   * Callers vet the text — it is not re-parsed. */
  | { kind: "expression"; value: string };

type JsxAttrEditInput = {
  source: string;
  /** Export name of the component that RENDERS the target element (the
   * selection's codeTarget.ownerExportName) — scopes the search to its body. */
  ownerExportName?: string;
  /** The element's JSX name: a component name (`ProductCard`) or DOM tag
   * (`div`). */
  elementName: string;
  /** The element's className (codeTarget.className) — disambiguates repeats. */
  className?: string;
  /** 1-based usage line hint (the code panel's highlight) — final tiebreak. */
  usageLine?: number;
  /** The attribute to write. */
  prop: string;
  /** Set/replace the value, or remove the attribute (reset-to-default). */
  edit: { type: "set"; value: JsxAttrValue } | { type: "remove" };
};

type JsxAttrEditResult =
  | { updated: string }
  /** The file could not be edited safely (spread props, no matching element,
   * parse failure) — the panel falls back to read-only for this attribute. */
  | { unresolvable: string }
  /** A no-op: the attribute already holds this exact value / is already
   * absent. `updated` echoes the input unchanged. */
  | { updated: string; unchanged: true };

// ---------------------------------------------------------------------------
// Minimal structural AST typing (no @babel/types dependency).
// ---------------------------------------------------------------------------

type Node = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number }; end: { line: number } };
  [key: string]: unknown;
};

type JsxName = { type: string; name?: string; [key: string]: unknown };

type JsxAttribute = Node & {
  type: "JSXAttribute";
  name: { type: string; name: string };
  value: Node | null;
};

type JsxOpeningElement = Node & {
  type: "JSXOpeningElement";
  name: JsxName;
  attributes: Array<Node>;
  selfClosing: boolean;
};

/** Flatten a (possibly namespaced/member) JSX element name to its base text:
 * `Foo` → "Foo", `Foo.Bar` → "Foo.Bar", `div` → "div". */
function jsxNameText(name: JsxName): string {
  if (name.type === "JSXIdentifier") return String(name.name ?? "");
  if (name.type === "JSXMemberExpression") {
    const object = jsxNameText(name.object as JsxName);
    const property = jsxNameText(name.property as JsxName);
    return `${object}.${property}`;
  }
  if (name.type === "JSXNamespacedName") {
    const ns = jsxNameText(name.namespace as JsxName);
    const local = jsxNameText(name.name as unknown as JsxName);
    return `${ns}:${local}`;
  }
  return String(name.name ?? "");
}

/** Depth-first walk collecting every node the visitor matches (pre-order). */
function collectNodes(
  root: unknown,
  match: (node: Node) => boolean,
  out: Node[],
  seen: WeakSet<object>,
): void {
  if (!root || typeof root !== "object") return;
  if (Array.isArray(root)) {
    for (const item of root) collectNodes(item, match, out, seen);
    return;
  }
  if (seen.has(root)) return;
  seen.add(root);
  const node = root as Node;
  if (typeof node.type === "string" && match(node)) out.push(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") {
      continue;
    }
    collectNodes(node[key], match, out, seen);
  }
}

/** The static string a className attribute holds, or undefined when it is an
 * expression / template / absent (only string-literal classNames disambiguate,
 * matching findUsageLine's textual heuristic). */
function classNameOf(opening: JsxOpeningElement): string | undefined {
  for (const attr of opening.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    const jsxAttr = attr as JsxAttribute;
    if (jsxAttr.name.name !== "className") continue;
    const value = jsxAttr.value;
    if (value && value.type === "StringLiteral") {
      return String((value as { value?: unknown }).value ?? "");
    }
    if (
      value &&
      value.type === "JSXExpressionContainer" &&
      (value as { expression?: Node }).expression?.type === "StringLiteral"
    ) {
      return String(
        ((value as { expression?: { value?: unknown } }).expression)?.value ??
          "",
      );
    }
    return undefined;
  }
  return undefined;
}

function hasSpread(opening: JsxOpeningElement): boolean {
  return opening.attributes.some((attr) => attr.type === "JSXSpreadAttribute");
}

/**
 * Pick the target opening element among same-named candidates, mirroring
 * findUsageLine: className containment wins, then proximity to the usage line,
 * then source order.
 */
function pickTarget(
  candidates: JsxOpeningElement[],
  input: JsxAttrEditInput,
): JsxOpeningElement | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (input.className) {
    const byClass = candidates.filter((opening) =>
      (classNameOf(opening) ?? "").includes(input.className!),
    );
    if (byClass.length === 1) return byClass[0];
    if (byClass.length > 1) candidates = byClass;
  }
  if (typeof input.usageLine === "number") {
    let best: JsxOpeningElement | undefined;
    let bestDistance = Infinity;
    for (const opening of candidates) {
      const line = opening.loc?.start.line ?? 0;
      const distance = Math.abs(line - input.usageLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = opening;
      }
    }
    if (best) return best;
  }
  return candidates[0];
}

/** The JSX attribute text for a set value (right of the `=`, or "" for a bare
 * boolean-true). Returns `{ bare: true }` to signal a valueless attribute. */
function attributeInitializer(
  value: JsxAttrValue,
): { text: string } | { bare: true } {
  switch (value.kind) {
    case "boolean":
      // `prop` is `prop={true}`; false must be explicit.
      return value.value ? { bare: true } : { text: "{false}" };
    case "number":
      return { text: `{${value.value}}` };
    case "expression":
      return { text: `{${value.value}}` };
    case "string": {
      // A double-quoted JSX string attribute when the value is quote/newline
      // free; otherwise a JS string expression (JSON-encoded) so any content
      // round-trips.
      if (!/["\n\r\\]/.test(value.value)) return { text: `"${value.value}"` };
      return { text: `{${JSON.stringify(value.value)}}` };
    }
  }
}

/** The full attribute source (`prop="x"` / `prop={1}` / `prop`). */
function fullAttribute(prop: string, value: JsxAttrValue): string {
  const init = attributeInitializer(value);
  return "bare" in init ? prop : `${prop}=${init.text}`;
}

function editJsxAttribute(input: JsxAttrEditInput): JsxAttrEditResult {
  let ast: { program?: unknown } & Node;
  try {
    ast = parse(input.source, {
      sourceType: "module",
      // Broad plugin set: the owner file is app TSX. `estree` is NOT used so
      // spans stay babel-native.
      plugins: ["jsx", "typescript", "decorators-legacy", "classProperties"],
    }) as unknown as { program?: unknown } & Node;
  } catch (error) {
    return {
      unresolvable: `could not parse the source file (${
        error instanceof Error ? error.message : String(error)
      }).`,
    };
  }

  const openings: JsxOpeningElement[] = [];
  collectNodes(
    ast.program,
    (node) => node.type === "JSXOpeningElement",
    openings as unknown as Node[],
    new WeakSet(),
  );

  const named = openings.filter(
    (opening) => jsxNameText(opening.name) === input.elementName,
  );
  if (named.length === 0) {
    return {
      unresolvable: `no <${input.elementName}> usage found in the file.`,
    };
  }

  const target = pickTarget(named, input);
  if (!target) {
    return {
      unresolvable: `no <${input.elementName}> usage found in the file.`,
    };
  }
  if (hasSpread(target)) {
    return {
      unresolvable:
        "the element passes spread props ({...props}), which can override " +
        "this attribute — edit the source directly.",
    };
  }

  const existing = target.attributes.find(
    (attr): attr is JsxAttribute =>
      attr.type === "JSXAttribute" &&
      (attr as JsxAttribute).name.name === input.prop,
  );

  const magic = new MagicString(input.source);

  if (input.edit.type === "remove") {
    if (!existing) return { updated: input.source, unchanged: true };
    // Remove the attribute AND the whitespace that precedes it (back to the
    // previous non-space char) so no double space / trailing space is left.
    let from = existing.start;
    while (from > 0 && /\s/.test(input.source[from - 1])) from -= 1;
    magic.remove(from, existing.end);
    return { updated: magic.toString() };
  }

  const value = input.edit.value;
  if (existing) {
    const nextText = fullAttribute(input.prop, value);
    const currentText = input.source.slice(existing.start, existing.end);
    if (currentText === nextText) {
      return { updated: input.source, unchanged: true };
    }
    magic.overwrite(existing.start, existing.end, nextText);
    return { updated: magic.toString() };
  }

  // Unpassed attribute — insert after the element name (before any existing
  // attributes / the closing `>` or `/>`), so it reads `<El newProp=… …>`.
  const insertAt = (target.name as unknown as Node).end;
  magic.appendLeft(insertAt, ` ${fullAttribute(input.prop, value)}`);
  return { updated: magic.toString() };
}

export { editJsxAttribute };
export type { JsxAttrEditInput, JsxAttrEditResult, JsxAttrValue };
