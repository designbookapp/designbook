/**
 * Maps the framework-free `ThemeTokenModel` (see themeTokens.ts) to and from a
 * Figma variable collection. Pure — no React/DOM/Node — so the browser Sync UI,
 * the server, and tests can all import it.
 *
 * Type mapping:
 *   - `color`     ↔ `COLOR`  (CSS oklch/hex ↔ `{ r, g, b, a }` gamma sRGB)
 *   - `dimension` ↔ `FLOAT`  in **px** (rem/em × 16 on the way in, ÷ 16 back;
 *     `%` and unknown units pass through as raw numbers). Figma FLOAT
 *     variables bind to px node fields (cornerRadius, itemSpacing, …), so a
 *     rem-valued float (`--radius: 0.625rem` → 0.625) would render a 0.625px
 *     radius when bound — the px projection is the bug-free choice. 16 is the
 *     CSS default root font-size (this pure module has no document to probe);
 *     the original unit is re-attached (and rescaled) on pull.
 *   - `number`    ↔ `FLOAT`
 *   - `string`    ↔ `STRING`
 *
 * The pull (`collectionToTokens`) is non-destructive: it only produces values
 * for tokens already present in the model (matched by name via the `NameMap`),
 * never invents or deletes tokens. Figma variables with no matching token are
 * ignored by the mapper (the caller can diff/report them).
 */

import {
  formatOklch,
  hexToRgb,
  oklchToRgb,
  parseOklch,
  rgbToOklch,
  type Rgba,
} from "./color.ts";
import { evaluateCssDimension } from "./themeTokens.ts";
import type {
  DerivedDimension,
  ThemeToken,
  ThemeTokenModel,
} from "./themeTokens.ts";

/** CSS default root font-size: the rem↔px base for dimension FLOATs. */
const REM_BASE_PX = 16;

type FigmaVarType = "COLOR" | "FLOAT" | "STRING";
type FigmaVarValue = Rgba | number | string;

type FigmaVariable = {
  name: string;
  type: FigmaVarType;
  valuesByMode: Record<string, FigmaVarValue>;
};

type FigmaCollection = {
  name: string;
  modes: string[];
  variables: FigmaVariable[];
};

/** Bidirectional token-name ↔ Figma-variable-name mapping. */
type NameMap = {
  toFigma: (token: string) => string;
  toToken: (figma: string) => string;
};

/**
 * Builds a `NameMap` from an optional naming `rule` (default identity) plus
 * optional `overrides` (`{ tokenName: figmaName }`). Overrides win in both
 * directions; the rule is applied when no override matches.
 */
function buildNameMap(opts: {
  rule?: (token: string) => string;
  overrides?: Record<string, string>;
}): NameMap {
  const rule = opts.rule ?? ((token: string) => token);
  const overrides = opts.overrides ?? {};
  const reverse: Record<string, string> = {};
  for (const [token, figma] of Object.entries(overrides)) {
    reverse[figma] = token;
  }
  return {
    toFigma: (token) => overrides[token] ?? rule(token),
    toToken: (figma) => reverse[figma] ?? figma,
  };
}

/** Extracts the trailing unit (e.g. `rem`, `px`, `%`) from a CSS value. */
function extractUnit(value: string): string {
  const match = /[-\d.]+([a-z%]*)\s*$/i.exec(value.trim());
  return match ? match[1] : "";
}

/** Parses a CSS color string (oklch or hex) to `{ r, g, b, a }`, or null. */
function cssColorToRgb(value: string): Rgba | null {
  const oklch = parseOklch(value);
  if (oklch) return oklchToRgb(oklch);
  if (value.trim().startsWith("#")) return hexToRgb(value);
  return null;
}

function figmaTypeForToken(token: ThemeToken): FigmaVarType {
  if (token.type === "color") return "COLOR";
  if (token.type === "string") return "STRING";
  return "FLOAT"; // dimension | number
}

function tokenValueToFigma(
  token: ThemeToken,
  value: string,
): FigmaVarValue | undefined {
  if (token.type === "color") {
    const rgba = cssColorToRgb(value);
    return rgba ?? undefined;
  }
  if (token.type === "string") return value;
  // dimension | number → FLOAT. Dimensions project to px (see module doc):
  // rem/em scale by REM_BASE_PX; px/%/unknown keep the raw number.
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return undefined;
  if (token.type === "dimension") {
    const unit = extractUnit(value);
    if (unit === "rem" || unit === "em") return num * REM_BASE_PX;
  }
  return num;
}

/**
 * Projects the token model into a Figma collection. Each token becomes a
 * variable of the mapped type, keeping the model's mode list and per-mode
 * values (colors as `{ r, g, b, a }`, dimensions/numbers as unit-less floats).
 */
function tokensToCollection(
  model: ThemeTokenModel,
  opts: { collection: string; nameMap: NameMap },
): FigmaCollection {
  const variables: FigmaVariable[] = [];
  for (const token of model.tokens) {
    const type = figmaTypeForToken(token);
    const valuesByMode: Record<string, FigmaVarValue> = {};
    for (const mode of model.modes) {
      const raw = token.valuesByMode[mode];
      if (raw === undefined) continue;
      const mapped = tokenValueToFigma(token, raw);
      if (mapped !== undefined) valuesByMode[mode] = mapped;
    }
    variables.push({
      name: opts.nameMap.toFigma(token.name),
      type,
      valuesByMode,
    });
  }
  return { name: opts.collection, modes: [...model.modes], variables };
}

/**
 * Projects derived dimensions (the radius scale — see themeTokens.ts
 * `parseRadiusScale`) into FLOAT variables in **px**, one per derived name,
 * with each mode's value evaluated against that mode's model token values
 * (`var(--radius)` etc. resolve per mode; rem/em × REM_BASE_PX). Names pass
 * through the same NameMap as real tokens. Derived names that collide with a
 * model token's Figma name are skipped (the model is the source of truth), as
 * are expressions that resolve in no mode.
 */
function derivedDimensionsToVariables(
  derived: DerivedDimension[],
  model: ThemeTokenModel,
  nameMap: NameMap,
): FigmaVariable[] {
  const modelNames = new Set(
    model.tokens.map((token) => nameMap.toFigma(token.name)),
  );
  const out: FigmaVariable[] = [];
  for (const dim of derived) {
    const figmaName = nameMap.toFigma(dim.name);
    if (modelNames.has(figmaName)) continue;
    const valuesByMode: Record<string, FigmaVarValue> = {};
    for (const mode of model.modes) {
      const lookup = (name: string): string | undefined =>
        model.tokens.find((token) => token.name === name)?.valuesByMode[mode];
      const px = evaluateCssDimension(dim.expr, lookup, REM_BASE_PX);
      if (px === undefined) continue;
      valuesByMode[mode] = Math.round(px * 100) / 100;
    }
    if (Object.keys(valuesByMode).length === 0) continue;
    out.push({ name: figmaName, type: "FLOAT", valuesByMode });
  }
  return out;
}

function isRgba(value: FigmaVarValue): value is Rgba {
  return typeof value === "object" && value !== null && "r" in value;
}

/** Converts a Figma variable value back to the CSS string for `token`. */
function figmaValueToTokenString(
  token: ThemeToken,
  value: FigmaVarValue,
  unit: string,
): string | undefined {
  if (token.type === "color") {
    if (!isRgba(value)) return undefined;
    return formatOklch(rgbToOklch(value));
  }
  if (token.type === "string") {
    return typeof value === "string" ? value : String(value);
  }
  // dimension | number
  if (typeof value !== "number") return undefined;
  if (token.type !== "dimension") return String(value);
  // Dimension FLOATs are px in Figma (see module doc): rescale back to the
  // token's original unit before re-attaching it.
  const scaled =
    unit === "rem" || unit === "em" ? value / REM_BASE_PX : value;
  // Trim float noise from the division (0.6249999… → 0.625).
  const rounded = Math.round(scaled * 10000) / 10000;
  return `${rounded}${unit}`;
}

/**
 * Pulls a Figma collection back onto the existing model, non-destructively.
 * Returns a new model with the same shape (modes + tokens) as `model`; only
 * tokens that match a variable in `col` (by name via `nameMap`) get updated
 * values, and only for modes the variable provides. FLOAT dimension values get
 * the unit re-attached from the existing token. Figma variables with no
 * matching token are ignored.
 */
function collectionToTokens(
  col: FigmaCollection,
  model: ThemeTokenModel,
  nameMap: NameMap,
): ThemeTokenModel {
  const varsByName = new Map<string, FigmaVariable>();
  for (const variable of col.variables) varsByName.set(variable.name, variable);

  const tokens: ThemeToken[] = model.tokens.map((token) => {
    const variable = varsByName.get(nameMap.toFigma(token.name));
    if (!variable) return { ...token, valuesByMode: { ...token.valuesByMode } };

    // Unit to re-attach for dimensions: taken from an existing mode value.
    const existing = Object.values(token.valuesByMode)[0] ?? "";
    const unit = extractUnit(existing);

    const valuesByMode: Record<string, string> = { ...token.valuesByMode };
    for (const mode of model.modes) {
      const figmaValue = variable.valuesByMode[mode];
      if (figmaValue === undefined) continue;
      const next = figmaValueToTokenString(token, figmaValue, unit);
      if (next !== undefined) valuesByMode[mode] = next;
    }
    return { ...token, valuesByMode };
  });

  return { modes: [...model.modes], tokens };
}

export {
  buildNameMap,
  collectionToTokens,
  derivedDimensionsToVariables,
  tokensToCollection,
};
export type {
  FigmaCollection,
  FigmaVarType,
  FigmaVarValue,
  FigmaVariable,
  NameMap,
};
