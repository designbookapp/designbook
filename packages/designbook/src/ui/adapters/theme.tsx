/**
 * Theme adapter: teaches the canvas to read + write design tokens from the
 * app's stylesheet (or a JSON tokens object) and edit them live. Contributes a
 * `mode` context dimension (light/dark, …), a `Theme` tab of editable token
 * fields (color / dimension / number), and drives the canvas light/dark
 * preview through that dimension.
 *
 * The token model (`ThemeTokenModel`) is a framework-free module (`designbook/
 * config`) reused by a later Figma-variables phase. This file is the browser
 * glue: it fetches the source once, keeps a mutable in-memory copy, edits are
 * optimistic (mutate + inject a scoped `<style>` so the canvas recolors
 * immediately) then persisted — CSS via `POST /api/style`, JSON via
 * `POST /api/json` — rolling back on failure.
 */

import type {
  Adapter,
  AdapterSetup,
  AdapterTabAction,
  ContextDimension,
  ContextState,
  FigmaCollection,
  NameMap,
} from "@designbookapp/designbook/config";
import {
  buildNameMap,
  collectionToTokens,
  derivedDimensionsToVariables,
  parseCssTokens,
  parseJsonTokens,
  parseRadiusScale,
  parseVariantOverrides,
  resolveTokenValue,
  resolveVariantModel,
  tokensToCollection,
} from "@designbookapp/designbook/config";
import type {
  DerivedDimension,
  ThemeToken,
  ThemeTokenModel,
  TokenType,
  VariantOverrides,
} from "@designbookapp/designbook/config";
import { apiUrl, repoPathFromGlobKey } from "@designbook-ui/designbook";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";
import { getAdapterRuntime, setFigmaTokenSource } from "@designbook-ui/adapterRuntime";
import { CANVAS_THEME_CLASS } from "@designbook-ui/models/configState/themeConstants";

type ThemeAdapterOptions = {
  /** Adapter name + dimension namespace. Default "theme". */
  id?: string;
  /** Tab label. Default "Theme". */
  label?: string;
  /** Tab/side-rail icon name. Default "palette". */
  icon?: string;
  /**
   * The token source of truth. Either a config-relative `.css` path string
   * (e.g. `"./src/index.css"`) whose per-mode selector blocks are parsed, or a
   * mode-keyed JSON tokens object (e.g. `{ light: { primary: "…" }, dark: {} }`).
   */
  source: string | Record<string, unknown>;
  /**
   * CSS: mode name → the selector whose block holds that mode's vars.
   * JSON: mode name → itself is the object key (selector value is ignored).
   * Default `{ light: ":root", dark: ".dark" }`.
   */
  modes?: Record<string, string>;
  /** Config-relative `.json` write target when `source` is a JSON object. */
  sourcePath?: string;
  /**
   * Editable preset "variants" layered over the base `source` as sparse
   * per-mode token overrides. Each variant becomes a value of a `variant`
   * context dimension (rendered as the canvas "Theme" selector); the Theme tab
   * shows and edits the ACTIVE variant, resolving each token to its override or
   * the base value. The base is the built-in `"default"` variant (no
   * overrides). Omit to keep the adapter single-variant (base only).
   */
  variants?: {
    /**
     * The overrides source: a writable JSON `{ variant: { mode: { token:
     * value } } }`. Either an `import.meta.glob` result / plain object (parsed
     * directly), or a config-relative `.json` path string (fetched at setup).
     */
    source: string | Record<string, unknown>;
    /**
     * Config-relative `.json` write target. Required when `source` is a glob /
     * object; defaults to `source` itself when it's a path string.
     */
    sourcePath?: string;
    /** Variant key → display label. Missing keys are capitalized. */
    labels?: Record<string, string>;
    /** Label for the built-in base variant. Default "Default". */
    defaultLabel?: string;
  };
  /** Optional per-token control-type overrides, keyed by token name. */
  tokens?: Record<string, { type?: TokenType }>;
  /**
   * Figma variable sync. Adds "Sync to Figma" / "Sync from Figma" actions to
   * the Theme tab (enabled only while the plugin is connected). Token↔variable
   * naming is `nameRule` (default identity), overlaid by an optional
   * `nameMapFile` (repo-relative JSON `{ tokenName: figmaName }`).
   */
  figma?: {
    /** Target collection name. Default "designbook/theme". */
    collection?: string;
    /** Token name → Figma variable name. Default identity. */
    nameRule?: (token: string) => string;
    /** Repo-relative JSON `{ tokenName: figmaName }`; overrides win. */
    nameMapFile?: string;
  };
};

const OVERRIDE_STYLE_ID = "designbook-theme-overrides";
const MODE_LABELS: Record<string, string> = {
  light: "Light",
  dark: "Dark",
};

function isCssSource(source: ThemeAdapterOptions["source"]): source is string {
  return typeof source === "string" && source.endsWith(".css");
}

/** True for an `import.meta.glob` result: an object keyed by `.json` paths. */
function looksLikeGlob(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((key) => key.endsWith(".json"));
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/** Applies `tokens` type overrides onto the parsed model in place. */
function applyTypeOverrides(
  model: ThemeTokenModel,
  overrides?: Record<string, { type?: TokenType }>,
): void {
  if (!overrides) return;
  for (const token of model.tokens) {
    const override = overrides[token.name];
    if (override?.type) token.type = override.type;
  }
}

/** The canvas-scoped selector that previews a given mode's tokens. */
function canvasSelectorForMode(mode: string, index: number): string {
  if (index === 0) return `.${CANVAS_THEME_CLASS}`;
  return `.${CANVAS_THEME_CLASS}.${mode}`;
}

/** CSS control type → editable-field control. */
function controlForType(type: TokenType): "color" | "number" | "text" {
  if (type === "color") return "color";
  if (type === "number") return "number";
  return "text";
}

/**
 * Rebuilds the `<style id="designbook-theme-overrides">` element so the canvas
 * reflects the in-memory (edited) token values. Layered after the preset theme
 * style (`useCanvasTheme`) with the same selectors, so edits win.
 */
function injectOverrides(model: ThemeTokenModel): void {
  if (typeof document === "undefined") return;

  const blocks = model.modes.map((mode, index) => {
    const selector = canvasSelectorForMode(mode, index);
    const decls = model.tokens
      .filter((token) => token.valuesByMode[mode] !== undefined)
      .map((token) => `  --${token.name}: ${token.valuesByMode[mode]};`)
      .join("\n");
    return `${selector} {\n${decls}\n}`;
  });
  const css = blocks.join("\n\n");

  let styleEl = document.getElementById(OVERRIDE_STYLE_ID);
  if (!(styleEl instanceof HTMLStyleElement)) {
    styleEl = document.createElement("style");
    styleEl.id = OVERRIDE_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

async function fetchCssModel(
  repoPath: string,
  modeSelectors: Record<string, string>,
): Promise<{ model: ThemeTokenModel; css: string }> {
  const response = await fetch(
    apiUrl(`/api/file?path=${encodeURIComponent(repoPath)}`),
  );
  if (!response.ok) {
    throw new Error(`Failed to load theme source: ${repoPath}`);
  }
  const payload = (await response.json()) as { content?: string };
  const css = payload.content ?? "";
  return { model: parseCssTokens(css, modeSelectors), css };
}

/**
 * Creates a theme adapter. Contributes a `mode` dimension, a `Theme` tab, and
 * live-preview token editing over a CSS or JSON token source.
 */
function themeAdapter(options: ThemeAdapterOptions): Adapter {
  const name = options.id ?? "theme";
  const label = options.label ?? "Theme";
  const icon = options.icon ?? "palette";
  const modeSelectors = options.modes ?? { light: ":root", dark: ".dark" };
  const modes = Object.keys(modeSelectors);
  const modeKey = `${name}:mode`;
  const variantKey = `${name}:variant`;
  const variantsConfig = options.variants;
  const hasVariants = Boolean(variantsConfig);

  // Populated by setup(); mutated in place on each save.
  let model: ThemeTokenModel = { modes, tokens: [] };
  // Derived radius-scale expressions (CSS sources only): `--radius-sm|md|lg|xl`
  // live in the `@theme` block that parseCssTokens skips, so they are captured
  // as expressions and evaluated per mode at sync time (Figma gets them as
  // px FLOAT variables; push attribution probes them for radius binding).
  let radiusScale: DerivedDimension[] = [];
  // Sparse per-variant overrides over `model` (mutated on each variant save).
  let overrides: VariantOverrides = {};
  // The variant the canvas currently previews; tracked from context so the
  // Figma actions + re-injection know which variant is resolved. `"default"`
  // is base only.
  let activeVariant = "default";

  const figmaCollection = options.figma?.collection ?? "designbook/theme";
  // Built during setup() (may fetch a name-map file); identity default.
  let nameMap: NameMap = buildNameMap({ rule: options.figma?.nameRule });

  async function loadNameMap(): Promise<void> {
    let overrides: Record<string, string> | undefined;
    if (options.figma?.nameMapFile) {
      try {
        const response = await fetch(
          apiUrl(
            `/api/file?path=${encodeURIComponent(
              repoPathFromGlobKey(options.figma.nameMapFile),
            )}`,
          ),
        );
        if (response.ok) {
          const payload = (await response.json()) as { content?: string };
          const parsed = JSON.parse(payload.content ?? "{}") as unknown;
          if (parsed && typeof parsed === "object") {
            overrides = parsed as Record<string, string>;
          }
        }
      } catch {
        // Missing/invalid map file falls back to the rule-only name map.
      }
    }
    nameMap = buildNameMap({ rule: options.figma?.nameRule, overrides });
  }

  /**
   * Publishes the token list (CSS var ↔ Figma variable name) for the Figma
   * component-push serializer's token attribution. Values are probed live per
   * push, so re-registering on variant/mode change just keeps names current.
   */
  function registerFigmaTokenSource(): void {
    setFigmaTokenSource({
      collection: figmaCollection,
      tokens: [
        ...model.tokens.map((token) => ({
          cssVar: token.name,
          figmaName: nameMap.toFigma(token.name),
          type: token.type,
        })),
        // Derived radius scale AFTER the model tokens (first-token-wins on
        // px collisions, so a real token like `radius` keeps priority). The
        // expression rides along for probing (`@theme` vars may not exist in
        // the document).
        ...radiusScale
          .filter((dim) => !model.tokens.some((token) => token.name === dim.name))
          .map((dim) => ({
            cssVar: dim.name,
            figmaName: nameMap.toFigma(dim.name),
            type: "dimension" as const,
            cssValue: dim.expr,
          })),
      ],
    });
  }

  async function figmaConnected(): Promise<boolean> {
    try {
      const response = await fetch(apiUrl("/api/figma/status"));
      if (!response.ok) return false;
      const payload = (await response.json()) as { connected?: boolean };
      return Boolean(payload.connected);
    } catch {
      return false;
    }
  }

  async function syncToFigma(): Promise<string> {
    // Push the ACTIVE variant's resolved model (what the Theme tab shows).
    const active = resolveVariantModel(model, overrides, activeVariant);
    const collection = tokensToCollection(active, {
      collection: figmaCollection,
      nameMap,
    });
    // Publish the derived radius scale (px FLOATs, evaluated against the
    // active variant's token values) alongside the real tokens.
    for (const variable of derivedDimensionsToVariables(
      radiusScale,
      active,
      nameMap,
    )) {
      if (!collection.variables.some((v) => v.name === variable.name)) {
        collection.variables.push(variable);
      }
    }
    const response = await fetch(apiUrl("/api/figma/variables"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collection),
    });
    if (response.status === 409) {
      throw new Error("No Figma plugin connected.");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(payload.error ?? "Failed to push variables to Figma.");
    }
    const result = (await response.json()) as {
      created?: number;
      updated?: number;
      skippedModes?: string[];
    };
    const skipped = result.skippedModes ?? [];
    const note =
      skipped.length > 0
        ? ` This Figma plan limits collections to one mode, so ${skipped.join(", ")} ${skipped.length === 1 ? "was" : "were"} not synced.`
        : "";
    return `Pushed "${figmaCollection}": ${result.created ?? 0} created, ${result.updated ?? 0} updated.${note}`;
  }

  async function syncFromFigma(): Promise<string> {
    const response = await fetch(apiUrl("/api/figma/variables"), { method: "POST" });
    if (response.status === 409) {
      throw new Error("No Figma plugin connected.");
    }
    if (!response.ok) {
      throw new Error("Failed to read variables from Figma.");
    }
    const payload = (await response.json()) as {
      collections?: Array<{
        name: string;
        modes: string[];
        variables: Array<{
          name: string;
          resolvedType: FigmaCollection["variables"][number]["type"];
          valuesByMode: Record<string, unknown>;
        }>;
      }>;
    };
    const collections = payload.collections ?? [];
    const raw =
      collections.find((collection) => collection.name === figmaCollection) ??
      collections[0];
    if (!raw) throw new Error("Figma returned no variable collections.");

    const collection: FigmaCollection = {
      name: raw.name,
      modes: raw.modes,
      variables: raw.variables.map((variable) => ({
        name: variable.name,
        type: variable.resolvedType,
        valuesByMode:
          variable.valuesByMode as FigmaCollection["variables"][number]["valuesByMode"],
      })),
    };

    // Merge onto the active variant's resolved model, and write each changed
    // value back through saveToken (routing to base or the active variant).
    const active = resolveVariantModel(model, overrides, activeVariant);
    const next = collectionToTokens(collection, active, nameMap);
    let changed = 0;
    for (const token of next.tokens) {
      for (const mode of model.modes) {
        const nextValue = token.valuesByMode[mode];
        const current = resolveTokenValue(
          model,
          overrides,
          activeVariant,
          mode,
          token.name,
        );
        if (nextValue !== undefined && nextValue !== current) {
          await saveToken(activeVariant, mode, token.name, nextValue);
          changed++;
        }
      }
    }

    const tokenFigmaNames = new Set(
      model.tokens.map((token) => nameMap.toFigma(token.name)),
    );
    const skipped = collection.variables.filter(
      (variable) => !tokenFigmaNames.has(variable.name),
    ).length;

    return `Pulled "${raw.name}": ${changed} value(s) updated${skipped ? `, ${skipped} unmatched var(s) skipped` : ""}.`;
  }

  const figmaActions: AdapterTabAction[] = [
    {
      id: "sync-to-figma",
      label: "Sync to Figma",
      description: `Push theme tokens to the "${figmaCollection}" variable collection.`,
      isEnabled: figmaConnected,
      run: syncToFigma,
    },
    {
      id: "sync-from-figma",
      label: "Sync from Figma",
      description: "Pull matching variable values back into the theme source.",
      isEnabled: figmaConnected,
      run: syncFromFigma,
    },
  ];

  function currentMode(ctx: ContextState): string {
    return ctx[modeKey] ?? modes[0] ?? "";
  }

  function currentVariant(ctx: ContextState): string {
    return hasVariants ? (ctx[variantKey] ?? "default") : "default";
  }

  function tokenByName(tokenName: string): ThemeToken | undefined {
    return model.tokens.find((token) => token.name === tokenName);
  }

  /** Repo-relative write target for variant overrides, or undefined. */
  function variantsWritePath(): string | undefined {
    if (!variantsConfig) return undefined;
    if (variantsConfig.sourcePath) {
      return repoPathFromGlobKey(variantsConfig.sourcePath);
    }
    if (typeof variantsConfig.source === "string") {
      return repoPathFromGlobKey(variantsConfig.source);
    }
    return undefined;
  }

  /** Loads the variant overrides from the configured source (glob/object/path). */
  async function loadOverrides(): Promise<VariantOverrides> {
    if (!variantsConfig) return {};
    const source = variantsConfig.source;
    if (typeof source === "string") {
      try {
        const response = await fetch(
          apiUrl(`/api/file?path=${encodeURIComponent(repoPathFromGlobKey(source))}`),
        );
        if (response.ok) {
          const payload = (await response.json()) as { content?: string };
          return parseVariantOverrides(JSON.parse(payload.content ?? "{}"));
        }
      } catch {
        // Missing/invalid overrides file → no variants beyond base.
      }
      return {};
    }
    const raw = looksLikeGlob(source)
      ? Object.assign({}, ...Object.values(source))
      : source;
    return parseVariantOverrides(raw);
  }

  /** Rebuilds the canvas override `<style>` for the given variant's resolved model. */
  function reinject(variant: string): void {
    injectOverrides(resolveVariantModel(model, overrides, variant));
  }

  async function persist(
    mode: string,
    tokenName: string,
    next: string,
  ): Promise<void> {
    if (isCssSource(options.source)) {
      const repoPath = repoPathFromGlobKey(options.source);
      const response = await fetch(apiUrl("/api/style"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: repoPath,
          selector: modeSelectors[mode],
          prop: tokenName,
          value: next,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "Failed to save token");
      }
      notifyFileWritten(repoPath);
      return;
    }

    // JSON source: surgical one-field write against the JSON tokens file.
    if (!options.sourcePath) {
      throw new Error("No JSON write target configured (set `sourcePath`).");
    }
    const response = await fetch(apiUrl("/api/json"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: repoPathFromGlobKey(options.sourcePath),
        keyPath: `${mode}.${tokenName}`,
        value: next,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(payload.error ?? "Failed to save token");
    }
    notifyFileWritten(repoPathFromGlobKey(options.sourcePath));
  }

  /** Surgical one-field write of a variant override to the variants JSON. */
  async function persistVariant(
    variant: string,
    mode: string,
    tokenName: string,
    next: string,
  ): Promise<void> {
    const path = variantsWritePath();
    if (!path) {
      throw new Error(
        "No variants write target configured (set `variants.sourcePath`).",
      );
    }
    const response = await fetch(apiUrl("/api/json"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path,
        keyPath: `${variant}.${mode}.${tokenName}`,
        value: next,
        // A variant may not override this token yet — create the key.
        create: true,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(payload.error ?? "Failed to save token");
    }
    notifyFileWritten(path);
  }

  /**
   * Optimistically edits a token for `(variant, mode)`, recolors the canvas, and
   * persists. `default` writes the base model + source; any other variant writes
   * a sparse override into the variants JSON. Rolls back on failure.
   */
  async function saveToken(
    variant: string,
    mode: string,
    tokenName: string,
    next: string,
  ): Promise<void> {
    if (variant === "default" || !hasVariants) {
      const token = tokenByName(tokenName);
      if (!token) throw new Error(`Unknown token: ${tokenName}`);
      const previous = token.valuesByMode[mode];

      token.valuesByMode[mode] = next;
      reinject(variant);
      getAdapterRuntime().notifyValuesChanged();

      try {
        await persist(mode, tokenName, next);
      } catch (error) {
        if (previous === undefined) delete token.valuesByMode[mode];
        else token.valuesByMode[mode] = previous;
        reinject(variant);
        getAdapterRuntime().notifyValuesChanged();
        throw asError(error, "Failed to save token");
      }
      return;
    }

    // Variant override: mutate the sparse store, then persist to the JSON.
    const variantStore = (overrides[variant] ??= {});
    const modeStore = (variantStore[mode] ??= {});
    const had = Object.prototype.hasOwnProperty.call(modeStore, tokenName);
    const previous = modeStore[tokenName];

    modeStore[tokenName] = next;
    reinject(variant);
    getAdapterRuntime().notifyValuesChanged();

    try {
      await persistVariant(variant, mode, tokenName, next);
    } catch (error) {
      if (had) modeStore[tokenName] = previous;
      else delete modeStore[tokenName];
      reinject(variant);
      getAdapterRuntime().notifyValuesChanged();
      throw asError(error, "Failed to save token");
    }
  }

  return {
    name,
    async setup(): Promise<AdapterSetup> {
      if (isCssSource(options.source)) {
        const fetched = await fetchCssModel(
          repoPathFromGlobKey(options.source),
          modeSelectors,
        );
        model = fetched.model;
        radiusScale = parseRadiusScale(fetched.css);
      } else {
        // JSON sources: any radius-scale tokens are real tokens already.
        model = parseJsonTokens(options.source, modes);
      }
      applyTypeOverrides(model, options.tokens);
      await loadNameMap();

      overrides = await loadOverrides();
      // Start the canvas consistent with the default variant (base values).
      reinject(activeVariant);
      registerFigmaTokenSource();

      const modeDimension: ContextDimension = {
        id: "mode",
        label: "Mode",
        control: "segmented",
        options: modes.map((mode) => ({
          value: mode,
          label: MODE_LABELS[mode] ?? mode,
        })),
        defaultValue: modes[0] ?? "",
      };

      const dimensions: ContextDimension[] = [];
      if (hasVariants) {
        const labels = variantsConfig?.labels ?? {};
        dimensions.push({
          id: "variant",
          label,
          options: [
            {
              value: "default",
              label: variantsConfig?.defaultLabel ?? "Default",
            },
            ...Object.keys(overrides).map((key) => ({
              value: key,
              label: labels[key] ?? capitalize(key),
            })),
          ],
          defaultValue: "default",
        });
      }
      dimensions.push(modeDimension);

      return {
        dimensions,
        onContextChange: (id, value) => {
          if (hasVariants) {
            if (id === "variant") activeVariant = value;
            // Re-color the canvas for the (possibly new) active variant; the
            // override style carries every mode's block, so a mode switch is
            // covered too.
            reinject(activeVariant);
          }
          // Token names don't change with context, but re-register so the
          // Figma serializer always sees a current source.
          registerFigmaTokenSource();
        },
        tabs: [
          {
            id: "theme",
            label,
            icon,
            fields: (ctx) => {
              const mode = currentMode(ctx);
              const variant = currentVariant(ctx);
              return model.tokens.map((token) => ({
                id: token.name,
                label: token.name,
                control: controlForType(token.type),
                value:
                  resolveTokenValue(
                    model,
                    overrides,
                    variant,
                    mode,
                    token.name,
                  ) ?? "",
                save: (next: string | boolean) =>
                  saveToken(variant, mode, token.name, String(next)),
              }));
            },
            actions: figmaActions,
          },
        ],
      };
    },
  };
}

export { themeAdapter };
export type { ThemeAdapterOptions };
