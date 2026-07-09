/**
 * Pure token↔Figma-variable sync logic for the figma integration (G2a
 * inversion): consumes the NEUTRAL TokenSource an adapter published and
 * applies the figma-specific naming/collection options. The UI (FigmaPanel's
 * variables section, FigmaSyncControls' push attribution) stays thin over
 * these functions so the inversion is unit-testable without DOM/fetch.
 *
 * Options precedence: `integrations: { figma: { tokens: {...} } }` (the
 * canonical home) → the `theme.figma` deprecation shim forwarded through
 * `TokenSource.meta.figma` → the source's own `collectionHint` → default.
 *
 */

import type {
  DerivedDimension,
  ThemeTokenModel,
} from "@designbookapp/designbook/config";
import {
  collectionToTokens,
  derivedDimensionsToVariables,
  tokensToCollection,
  type FigmaCollection,
  type NameMap,
} from "../shared/figmaTokens";
import type { TokenSource } from "@designbook-ui/integrations";

/** The figma integration's token options (`integrations.figma.tokens`). */
type FigmaTokensOptions = {
  /** Target variable collection name. Default "designbook/theme". */
  collection?: string;
  /** Token name → Figma variable name. Default identity. */
  nameRule?: (token: string) => string;
  /** Repo-relative JSON `{ tokenName: figmaName }`; overrides win. */
  nameMapFile?: string;
};

/** One value the pull flow should write back through `source.setToken`. */
type TokenWriteBack = { mode: string; name: string; value: string };

/** CSS-var → Figma-name attribution rows for the push serializer. */
type AttributionToken = {
  cssVar: string;
  figmaName: string;
  type: "color" | "dimension" | "number" | "string";
  cssValue?: string;
};

/**
 * Merge the configured options with the deprecation-shim passthrough
 * (`meta.figma`) and the source's hint. `configured` is the raw
 * `integrations.figma.tokens` value (unknown-shaped by design).
 */
function resolveTokenOptions(
  configured: unknown,
  source?: TokenSource,
): Required<Pick<FigmaTokensOptions, "collection">> &
  Omit<FigmaTokensOptions, "collection"> {
  const opts = (configured ?? {}) as FigmaTokensOptions;
  const legacy =
    (source?.meta?.figma as FigmaTokensOptions | undefined) ?? {};
  return {
    collection:
      opts.collection ??
      legacy.collection ??
      source?.collectionHint ??
      "designbook/theme",
    nameRule: opts.nameRule ?? legacy.nameRule,
    nameMapFile: opts.nameMapFile ?? legacy.nameMapFile,
  };
}

/**
 * Split a neutral source into the real token model + derived dimensions
 * (tokens carrying a `cssValue` expression, e.g. the Tailwind radius scale).
 */
function splitSource(source: TokenSource): {
  model: ThemeTokenModel;
  derived: DerivedDimension[];
} {
  const tokens = source.getTokens();
  return {
    model: {
      modes: [...source.modes],
      tokens: tokens
        .filter((token) => !token.cssValue)
        .map(({ name, type, valuesByMode }) => ({ name, type, valuesByMode })),
    },
    derived: tokens
      .filter((token) => token.cssValue)
      .map((token) => ({ name: token.name, expr: token.cssValue! })),
  };
}

/** The full collection to PUT to Figma (model tokens + derived px FLOATs). */
function collectionForPush(
  source: TokenSource,
  collection: string,
  nameMap: NameMap,
): FigmaCollection {
  const { model, derived } = splitSource(source);
  const out = tokensToCollection(model, { collection, nameMap });
  for (const variable of derivedDimensionsToVariables(derived, model, nameMap)) {
    if (!out.variables.some((v) => v.name === variable.name)) {
      out.variables.push(variable);
    }
  }
  return out;
}

/**
 * Diff a collection read from Figma against the source's current values:
 * the changed `(mode, token, value)` triples to write back, plus how many
 * Figma variables matched no token (skipped).
 */
function diffPulledCollection(
  source: TokenSource,
  raw: FigmaCollection,
  nameMap: NameMap,
): { changes: TokenWriteBack[]; skipped: number } {
  const { model } = splitSource(source);
  const next = collectionToTokens(raw, model, nameMap);
  const changes: TokenWriteBack[] = [];
  for (const token of next.tokens) {
    const current = model.tokens.find((t) => t.name === token.name);
    for (const mode of model.modes) {
      const nextValue = token.valuesByMode[mode];
      if (nextValue !== undefined && nextValue !== current?.valuesByMode[mode]) {
        changes.push({ mode, name: token.name, value: nextValue });
      }
    }
  }
  const tokenFigmaNames = new Set(
    model.tokens.map((token) => nameMap.toFigma(token.name)),
  );
  const skipped = raw.variables.filter(
    (variable) => !tokenFigmaNames.has(variable.name),
  ).length;
  return { changes, skipped };
}

/**
 * The serializer's token-attribution rows: every source token's CSS var (or
 * derived expression) mapped to its Figma variable name. Sources merge in
 * registration order; first token wins on name collisions downstream (the
 * serializer keeps the first probe hit per value).
 */
function attributionTokens(
  sources: TokenSource[],
  nameMap: NameMap,
): AttributionToken[] {
  return sources.flatMap((source) =>
    source.getTokens().map((token) => ({
      cssVar: token.cssVar ?? token.name,
      figmaName: nameMap.toFigma(token.name),
      type: token.type,
      ...(token.cssValue !== undefined ? { cssValue: token.cssValue } : {}),
    })),
  );
}

export {
  attributionTokens,
  collectionForPush,
  diffPulledCollection,
  resolveTokenOptions,
  splitSource,
};
export type { AttributionToken, FigmaTokensOptions, TokenWriteBack };
