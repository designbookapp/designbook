/**
 * Framework-free design-token model shared by the theme adapter and a later
 * Figma-variables phase. Parses design tokens out of a CSS stylesheet (the
 * per-mode selector blocks, e.g. `:root` / `.dark`) or a JSON tokens object,
 * into a mode-indexed model, and infers a control type for each token.
 *
 * Deliberately free of React/DOM/Node imports so it can be unit-tested and
 * reused anywhere. The CSS `@theme` block (Tailwind var aliases) is never
 * parsed — only the selectors passed in `modeSelectors` are read.
 */

type TokenType = "color" | "dimension" | "number" | "string";

/** A single design token and its value in each mode. `name` omits the `--`. */
type ThemeToken = {
  name: string;
  type: TokenType;
  valuesByMode: Record<string, string>;
};

/** The parsed token model: the ordered mode list + the tokens. */
type ThemeTokenModel = {
  modes: string[];
  tokens: ThemeToken[];
};

/**
 * Sparse per-variant token overrides layered over a base model: keyed
 * `variant → mode → token → value`. A variant only carries the tokens it
 * changes; everything else falls back to the base model per token/mode. The
 * special variant `"default"` carries no overrides (base only).
 */
type VariantOverrides = Record<
  string,
  Record<string, Record<string, string>>
>;

/**
 * Infers a token's control type from its value:
 *   - `oklch(` / `rgb(` / `rgba(` / `hsl(` / `hsla(` / `#hex` → `color`
 *   - ends in `rem` / `px` / `em` / `%` → `dimension`
 *   - a bare number → `number`
 *   - anything else → `string`
 */
function inferTokenType(value: string): TokenType {
  const v = value.trim();
  if (/^(oklch|oklab|rgba?|hsla?|lab|lch|color)\(/i.test(v) || v.startsWith("#")) {
    return "color";
  }
  if (/(rem|px|em|%)$/.test(v)) return "dimension";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  return "string";
}

function stripLeadingDashes(name: string): string {
  return name.replace(/^--/, "");
}

/**
 * Finds the declaration body inside `<selector> { … }`, matching `selector` as
 * a whole selector token (so `.dark` doesn't match `.darker`, and the `@theme`
 * block is never confused for `:root`). Returns the text between the braces, or
 * undefined if the selector's block isn't present.
 */
function findSelectorBody(css: string, selector: string): string | undefined {
  let from = 0;
  while (from <= css.length) {
    const idx = css.indexOf(selector, from);
    if (idx === -1) return undefined;
    from = idx + selector.length;

    const before = idx === 0 ? "" : css[idx - 1];
    // Reject a match that's the tail of a longer identifier/selector.
    if (before && /[A-Za-z0-9_-]/.test(before)) continue;

    let i = idx + selector.length;
    while (i < css.length && /\s/.test(css[i])) i++;
    if (css[i] !== "{") continue;

    let depth = 0;
    const open = i;
    for (let j = i; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) return css.slice(open + 1, j);
      }
    }
    return undefined;
  }
  return undefined;
}

/** Reads `--name: value;` custom-property declarations from a block body. */
function readDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--([A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

/** Assembles a model from per-mode `{ name: value }` maps, preserving order. */
function assembleModel(
  modes: string[],
  declsByMode: Record<string, Record<string, string>>,
): ThemeTokenModel {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const mode of modes) {
    for (const name of Object.keys(declsByMode[mode] ?? {})) {
      if (!seen.has(name)) {
        seen.add(name);
        order.push(name);
      }
    }
  }

  const tokens: ThemeToken[] = order.map((name) => {
    const valuesByMode: Record<string, string> = {};
    for (const mode of modes) {
      const value = declsByMode[mode]?.[name];
      if (value !== undefined) valuesByMode[mode] = value;
    }
    const first =
      modes.map((mode) => valuesByMode[mode]).find((v) => v !== undefined) ?? "";
    return { name, type: inferTokenType(first), valuesByMode };
  });

  return { modes, tokens };
}

/**
 * Parses a CSS stylesheet's per-mode selector blocks into a token model.
 * `modeSelectors` maps a mode name to the CSS selector whose block holds that
 * mode's variables, e.g. `{ light: ":root", dark: ".dark" }`. Only those
 * blocks are read — the `@theme` alias block and everything else is ignored.
 */
function parseCssTokens(
  css: string,
  modeSelectors: Record<string, string>,
): ThemeTokenModel {
  const modes = Object.keys(modeSelectors);
  const declsByMode: Record<string, Record<string, string>> = {};
  for (const mode of modes) {
    const body = findSelectorBody(css, modeSelectors[mode]);
    declsByMode[mode] = body ? readDeclarations(body) : {};
  }
  return assembleModel(modes, declsByMode);
}

/**
 * Parses a JSON tokens object into a token model. The object is mode-keyed:
 * `{ light: { primary: "…", radius: "…" }, dark: { primary: "…" } }`. Only the
 * given `modes` are read; token names have any leading `--` stripped.
 */
function parseJsonTokens(obj: unknown, modes: string[]): ThemeTokenModel {
  const record = (obj && typeof obj === "object" ? obj : {}) as Record<
    string,
    unknown
  >;
  const declsByMode: Record<string, Record<string, string>> = {};
  for (const mode of modes) {
    const modeObj = (record[mode] && typeof record[mode] === "object"
      ? record[mode]
      : {}) as Record<string, unknown>;
    const decls: Record<string, string> = {};
    for (const [key, value] of Object.entries(modeObj)) {
      if (value === undefined || value === null) continue;
      decls[stripLeadingDashes(key)] = String(value);
    }
    declsByMode[mode] = decls;
  }
  return assembleModel(modes, declsByMode);
}

/**
 * Parses a variants JSON object into sparse `VariantOverrides`. Shape:
 * `{ forest: { light: { primary: "…" }, dark: { … } }, sunset: { … } }`.
 * Token names have any leading `--` stripped; values are stringified;
 * null/undefined entries are dropped. Non-object variants/modes are skipped.
 */
function parseVariantOverrides(obj: unknown): VariantOverrides {
  const record = (obj && typeof obj === "object" ? obj : {}) as Record<
    string,
    unknown
  >;
  const out: VariantOverrides = {};
  for (const [variant, byMode] of Object.entries(record)) {
    if (!byMode || typeof byMode !== "object") continue;
    const modes: Record<string, Record<string, string>> = {};
    for (const [mode, tokens] of Object.entries(
      byMode as Record<string, unknown>,
    )) {
      if (!tokens || typeof tokens !== "object") continue;
      const decls: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        tokens as Record<string, unknown>,
      )) {
        if (value === undefined || value === null) continue;
        decls[stripLeadingDashes(key)] = String(value);
      }
      modes[mode] = decls;
    }
    out[variant] = modes;
  }
  return out;
}

/**
 * Resolves a single token's value for a `(variant, mode)`: the variant's sparse
 * override when present, else the base model's value (per-token fallback). The
 * `"default"` variant — and any variant with no entry — resolves to base only.
 */
function resolveTokenValue(
  base: ThemeTokenModel,
  overrides: VariantOverrides,
  variant: string,
  mode: string,
  tokenName: string,
): string | undefined {
  const override = overrides[variant]?.[mode]?.[tokenName];
  if (override !== undefined) return override;
  return base.tokens.find((token) => token.name === tokenName)?.valuesByMode[
    mode
  ];
}

// ---------------------------------------------------------------------------
// Derived dimensions (the Tailwind radius scale)
// ---------------------------------------------------------------------------

/**
 * A dimension derived from other tokens by a CSS expression, e.g. the Tailwind
 * v4 radius scale: `--radius-xl: calc(var(--radius) * 1.4)`. These live in the
 * `@theme` block (which `parseCssTokens` deliberately skips), so they are not
 * model tokens — they are captured as expressions and evaluated per mode
 * against the model (see figmaTokens.ts `derivedDimensionsToVariables`).
 */
type DerivedDimension = { name: string; expr: string };

/** The Tailwind radius-scale custom properties published to Figma. */
const RADIUS_SCALE_NAMES = ["radius-sm", "radius-md", "radius-lg", "radius-xl"];

/**
 * Finds the radius-scale declarations (`--radius-sm|md|lg|xl`) anywhere in the
 * stylesheet — including the `@theme` block — keeping the FIRST declaration of
 * each name. Returns them in scale order; names that never appear are omitted.
 */
function parseRadiusScale(css: string): DerivedDimension[] {
  const out: DerivedDimension[] = [];
  for (const name of RADIUS_SCALE_NAMES) {
    const re = new RegExp(`--${name}\\s*:\\s*([^;}]+)[;}]`);
    const match = re.exec(css);
    if (match) out.push({ name, expr: match[1].trim() });
  }
  return out;
}

/**
 * Evaluates a CSS length expression to px: plain lengths (`10px`, `0.625rem`),
 * `var(--x[, fallback])` via `lookup` (recursive, depth-capped), and `calc()`
 * with `+ - * /` and parentheses. rem/em resolve against `remBase` (16 — the
 * CSS default root font-size; the pure model has no live document to probe).
 * Returns undefined for anything it cannot resolve to a finite number.
 */
function evaluateCssDimension(
  expr: string,
  lookup: (name: string) => string | undefined,
  remBase = 16,
): number | undefined {
  const value = evalExpr(expr.trim(), lookup, remBase, 0);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

const MAX_VAR_DEPTH = 8;

function evalExpr(
  expr: string,
  lookup: (name: string) => string | undefined,
  remBase: number,
  depth: number,
): number | undefined {
  if (depth > MAX_VAR_DEPTH) return undefined;
  const tokens = tokenizeExpr(expr, remBase);
  if (!tokens) return undefined;
  const state = { tokens, pos: 0, lookup, remBase, depth };
  const value = parseSum(state);
  return state.pos === tokens.length ? value : undefined;
}

type ExprToken =
  | { kind: "num"; value: number }
  | { kind: "op"; op: "+" | "-" | "*" | "/" | "(" | ")" }
  | { kind: "var"; body: string };

/**
 * Splits an expression into numbers (units already resolved to px via
 * `remBase`), operators, and var() calls. `calc(` reduces to plain grouping.
 */
function tokenizeExpr(expr: string, remBase: number): ExprToken[] | undefined {
  const out: ExprToken[] = [];
  const text = expr.replace(/calc\(/g, "(");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (text.startsWith("var(", i)) {
      // Find the matching close paren of var(...).
      let d = 0;
      let j = i + 3;
      for (; j < text.length; j++) {
        if (text[j] === "(") d++;
        else if (text[j] === ")") {
          d--;
          if (d === 0) break;
        }
      }
      if (j >= text.length) return undefined;
      out.push({ kind: "var", body: text.slice(i + 4, j) });
      i = j + 1;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "*" || ch === "/") {
      out.push({ kind: "op", op: ch });
      i++;
      continue;
    }
    // `+` / `-` are operators only when preceded by a value/close-paren;
    // otherwise they sign the next number (e.g. `-4px`).
    const prev = out[out.length - 1];
    const isOperand = prev && (prev.kind !== "op" || prev.op === ")");
    if ((ch === "+" || ch === "-") && isOperand) {
      out.push({ kind: "op", op: ch });
      i++;
      continue;
    }
    const match = /^[-+]?\d*\.?\d+(px|rem|em|%)?/.exec(text.slice(i));
    if (!match || match[0] === "") return undefined;
    const raw = Number.parseFloat(match[0]);
    if (!Number.isFinite(raw)) return undefined;
    const unit = match[1] ?? "";
    if (unit === "%") return undefined; // no px meaning without a reference
    const value = unit === "rem" || unit === "em" ? raw * remBase : raw;
    out.push({ kind: "num", value });
    i += match[0].length;
  }
  return out;
}

type ExprState = {
  tokens: ExprToken[];
  pos: number;
  lookup: (name: string) => string | undefined;
  remBase: number;
  depth: number;
};

function parseSum(state: ExprState): number | undefined {
  let left = parseProduct(state);
  if (left === undefined) return undefined;
  while (state.pos < state.tokens.length) {
    const token = state.tokens[state.pos];
    if (token.kind !== "op" || (token.op !== "+" && token.op !== "-")) break;
    state.pos++;
    const right = parseProduct(state);
    if (right === undefined) return undefined;
    left = token.op === "+" ? left + right : left - right;
  }
  return left;
}

function parseProduct(state: ExprState): number | undefined {
  let left = parsePrimary(state);
  if (left === undefined) return undefined;
  while (state.pos < state.tokens.length) {
    const token = state.tokens[state.pos];
    if (token.kind !== "op" || (token.op !== "*" && token.op !== "/")) break;
    state.pos++;
    const right = parsePrimary(state);
    if (right === undefined) return undefined;
    if (token.op === "/" && right === 0) return undefined;
    left = token.op === "*" ? left * right : left / right;
  }
  return left;
}

function parsePrimary(state: ExprState): number | undefined {
  const token = state.tokens[state.pos];
  if (!token) return undefined;
  if (token.kind === "num") {
    state.pos++;
    return token.value;
  }
  if (token.kind === "var") {
    state.pos++;
    const comma = topLevelComma(token.body);
    const name = (comma === -1 ? token.body : token.body.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : token.body.slice(comma + 1).trim();
    const resolved = state.lookup(stripLeadingDashes(name));
    const source = resolved !== undefined ? resolved : fallback;
    if (source === undefined) return undefined;
    return evalExpr(source, state.lookup, state.remBase, state.depth + 1);
  }
  if (token.kind === "op" && token.op === "(") {
    state.pos++;
    const value = parseSum(state);
    if (value === undefined) return undefined;
    const close = state.tokens[state.pos];
    if (!close || close.kind !== "op" || close.op !== ")") return undefined;
    state.pos++;
    return value;
  }
  return undefined;
}

/** Index of the first top-level comma in a var() body, or -1. */
function topLevelComma(body: string): number {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

/**
 * Builds a fully-resolved token model for a variant: every base token, with its
 * per-mode value replaced by the variant's override where one exists. The
 * `"default"` variant (or any variant with no overrides) returns the base model
 * unchanged.
 */
function resolveVariantModel(
  base: ThemeTokenModel,
  overrides: VariantOverrides,
  variant: string,
): ThemeTokenModel {
  const variantOverrides = overrides[variant];
  if (!variantOverrides) return base;
  return {
    modes: base.modes,
    tokens: base.tokens.map((token) => {
      const valuesByMode: Record<string, string> = {};
      for (const mode of base.modes) {
        const value = variantOverrides[mode]?.[token.name] ??
          token.valuesByMode[mode];
        if (value !== undefined) valuesByMode[mode] = value;
      }
      return { name: token.name, type: token.type, valuesByMode };
    }),
  };
}

export {
  evaluateCssDimension,
  inferTokenType,
  parseCssTokens,
  parseJsonTokens,
  parseRadiusScale,
  parseVariantOverrides,
  resolveTokenValue,
  resolveVariantModel,
};
export type {
  DerivedDimension,
  ThemeToken,
  ThemeTokenModel,
  TokenType,
  VariantOverrides,
};
