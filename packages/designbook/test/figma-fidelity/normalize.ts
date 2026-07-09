/**
 * Tier 1 — deterministic annotated-HTML equality (docs/specs/figma-sync-testing.md).
 * Pure: parse both the pulled HTML and the approved `expected.html` into a
 * forgiving tree, then compare structurally with numeric + color tolerance so
 * Figma's float coordinates and color round-tripping don't cause false
 * failures. No DOM — the inputs are the lean output of `htmlNodeToString`
 * (src/config/figmaHtml.ts), so a small tolerant parser is enough.
 *
 * Tolerances (spec): attribute order ignored, colors → canonical rgba, lengths
 * compared within ±1px, text whitespace-collapsed.
 */

type HtmlEl = {
  tag: string;
  attrs: Record<string, string>;
  /** Concatenated direct text (whitespace-collapsed). */
  text: string;
  children: HtmlEl[];
};

/** Default length tolerance in px (Figma writes float coordinates). */
const PX_TOLERANCE = 1;
/** Color channel tolerance (0–1 space would be 1/255; here 0–255). */
const COLOR_TOLERANCE = 1.5;

const VOID_TAGS = new Set(["img", "br", "hr", "input"]);

// --- Parser ---------------------------------------------------------------

/** Collapses runs of whitespace to a single space and trims. */
function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Parses a tag's attribute list: `name="value"` pairs and bare booleans. */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    if (!name) continue;
    attrs[name] = match[2] !== undefined ? decodeEntities(match[2]) : "";
  }
  return attrs;
}

/**
 * Forgiving parse of the annotated-HTML target into a single root element.
 * Throws on empty input or when no element is found — the caller reports that
 * as a tier-1 failure.
 */
function parseHtml(html: string): HtmlEl {
  const tokens = html.match(/<[^>]+>|[^<]+/g) ?? [];
  const root: HtmlEl = { tag: "#root", attrs: {}, text: "", children: [] };
  const stack: HtmlEl[] = [root];

  for (const raw of tokens) {
    const top = stack[stack.length - 1];
    if (raw[0] !== "<") {
      const text = collapseWs(decodeEntities(raw));
      if (text) top.text = top.text ? `${top.text} ${text}` : text;
      continue;
    }
    if (raw.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = /\/>$/.test(raw);
    const inner = raw.replace(/^<\s*/, "").replace(/\s*\/?>$/, "");
    const space = inner.search(/\s/);
    const tag = (space === -1 ? inner : inner.slice(0, space)).toLowerCase();
    const attrs = parseAttrs(space === -1 ? "" : inner.slice(space + 1));
    const el: HtmlEl = { tag, attrs, text: "", children: [] };
    top.children.push(el);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
  }

  if (root.children.length === 1) return root.children[0];
  if (root.children.length === 0) {
    throw new Error("parseHtml: no element found");
  }
  return root; // Multiple roots: compare under the synthetic wrapper.
}

// --- Value canonicalization ----------------------------------------------

/** Parses a hex / rgb() / rgba() color to [r,g,b,a] (0–255, a 0–1), else null. */
function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1];
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => p.trim());
    if (parts.length < 3) return null;
    const r = Number.parseFloat(parts[0]);
    const g = Number.parseFloat(parts[1]);
    const b = Number.parseFloat(parts[2]);
    const a = parts[3] !== undefined ? Number.parseFloat(parts[3]) : 1;
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
    return [r, g, b, a];
  }
  return null;
}

/** Parses a `<number><unit>` length, else null. */
function parseLength(value: string): { n: number; unit: string } | null {
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(value.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  return { n, unit: m[2].toLowerCase() };
}

/** Whether two scalar tokens match under color/length/string rules. */
function tokenMatches(a: string, b: string, pxTol: number): boolean {
  if (a === b) return true;
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca && cb) {
    return (
      Math.abs(ca[0] - cb[0]) <= COLOR_TOLERANCE &&
      Math.abs(ca[1] - cb[1]) <= COLOR_TOLERANCE &&
      Math.abs(ca[2] - cb[2]) <= COLOR_TOLERANCE &&
      Math.abs(ca[3] - cb[3]) <= 0.02
    );
  }
  const la = parseLength(a);
  const lb = parseLength(b);
  if (la && lb && la.unit === lb.unit) {
    const tol = la.unit === "px" || la.unit === "" ? pxTol : 0.01;
    return Math.abs(la.n - lb.n) <= tol;
  }
  return false;
}

/**
 * Splits a value into tokens on top-level whitespace/commas, keeping
 * parenthesized groups (`rgb(37, 99, 235)`, `linear-gradient(…)`) intact so
 * their internal separators don't fragment a single color/function.
 */
function tokenizeValue(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (depth === 0 && /[\s,]/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Compares one attribute value. Compound values (shadows, gradients,
 * multi-part paddings) are tokenized and matched pairwise, so per-token
 * color/length tolerance still applies.
 */
function valueMatches(a: string, b: string, pxTol: number): boolean {
  if (a === b) return true;
  const ta = tokenizeValue(a);
  const tb = tokenizeValue(b);
  if (ta.length !== tb.length) return false;
  return ta.every((token, i) => tokenMatches(token, tb[i], pxTol));
}

/** Parses a `style` attribute into a prop→value map. */
function parseStyle(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of value.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (prop) out[prop] = val;
  }
  return out;
}

// --- Comparison -----------------------------------------------------------

type CompareOptions = { pxTolerance?: number };
type CompareResult = { equal: boolean; mismatches: string[] };

function styleMismatches(
  path: string,
  exp: string,
  act: string,
  pxTol: number,
): string[] {
  const e = parseStyle(exp);
  const a = parseStyle(act);
  const out: string[] = [];
  for (const prop of Object.keys(e)) {
    if (!(prop in a)) {
      out.push(`${path} style: missing "${prop}" (expected "${e[prop]}")`);
    } else if (!valueMatches(e[prop], a[prop], pxTol)) {
      out.push(
        `${path} style.${prop}: expected "${e[prop]}", got "${a[prop]}"`,
      );
    }
  }
  for (const prop of Object.keys(a)) {
    if (!(prop in e)) {
      out.push(`${path} style: unexpected "${prop}: ${a[prop]}"`);
    }
  }
  return out;
}

function attrMismatches(
  path: string,
  exp: HtmlEl,
  act: HtmlEl,
  pxTol: number,
): string[] {
  const out: string[] = [];
  const names = new Set([
    ...Object.keys(exp.attrs),
    ...Object.keys(act.attrs),
  ]);
  for (const name of names) {
    const e = exp.attrs[name];
    const a = act.attrs[name];
    if (e === undefined) {
      out.push(`${path}: unexpected attribute "${name}"`);
      continue;
    }
    if (a === undefined) {
      out.push(`${path}: missing attribute "${name}"`);
      continue;
    }
    if (name === "style") {
      out.push(...styleMismatches(path, e, a, pxTol));
    } else if (!valueMatches(e, a, pxTol)) {
      out.push(`${path} @${name}: expected "${e}", got "${a}"`);
    }
  }
  return out;
}

function compareNodes(
  path: string,
  exp: HtmlEl,
  act: HtmlEl,
  pxTol: number,
  out: string[],
): void {
  if (exp.tag !== act.tag) {
    out.push(`${path}: tag <${exp.tag}> vs <${act.tag}>`);
    return; // Divergent tag: subtree comparison is meaningless.
  }
  out.push(...attrMismatches(path, exp, act, pxTol));
  if (exp.text !== act.text) {
    out.push(`${path}: text "${exp.text}" vs "${act.text}"`);
  }
  if (exp.children.length !== act.children.length) {
    out.push(
      `${path}: ${exp.children.length} child(ren) expected, got ${act.children.length}`,
    );
    return;
  }
  for (let i = 0; i < exp.children.length; i++) {
    compareNodes(
      `${path}/${act.children[i].tag}[${i}]`,
      exp.children[i],
      act.children[i],
      pxTol,
      out,
    );
  }
}

/**
 * Compares the approved `expected.html` against the freshly pulled HTML.
 * `equal` gates the run's exit code; `mismatches[0]` is the report's diff
 * snippet.
 */
function compareHtml(
  expected: string,
  actual: string,
  options: CompareOptions = {},
): CompareResult {
  const pxTol = options.pxTolerance ?? PX_TOLERANCE;
  let expTree: HtmlEl;
  let actTree: HtmlEl;
  try {
    expTree = parseHtml(expected);
  } catch (error) {
    return { equal: false, mismatches: [`expected.html: ${String(error)}`] };
  }
  try {
    actTree = parseHtml(actual);
  } catch (error) {
    return { equal: false, mismatches: [`pulled html: ${String(error)}`] };
  }
  const out: string[] = [];
  compareNodes(actTree.tag, expTree, actTree, pxTol, out);
  return { equal: out.length === 0, mismatches: out };
}

/** Canonical, sorted-attribute re-serialization (stable for snapshots/diffs). */
function normalizeHtml(html: string): string {
  function ser(node: HtmlEl, depth: number): string {
    const pad = "  ".repeat(depth);
    const attrs = Object.keys(node.attrs)
      .sort()
      .map((name) =>
        node.attrs[name] === "" ? name : `${name}="${node.attrs[name]}"`,
      );
    const open = attrs.length > 0 ? `${node.tag} ${attrs.join(" ")}` : node.tag;
    if (VOID_TAGS.has(node.tag)) return `${pad}<${open} />`;
    if (node.children.length === 0) {
      return `${pad}<${open}>${node.text}</${node.tag}>`;
    }
    const inner = node.children
      .map((child) => ser(child, depth + 1))
      .join("\n");
    const lead = node.text ? `${pad}  ${node.text}\n` : "";
    return `${pad}<${open}>\n${lead}${inner}\n${pad}</${node.tag}>`;
  }
  return ser(parseHtml(html), 0);
}

export { compareHtml, normalizeHtml, parseHtml };
export type { HtmlEl, CompareResult, CompareOptions };
