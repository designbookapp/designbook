/**
 * Public config API for designbook consumers. A repo describes what the
 * workbench needs in a `designbook.config.tsx` file — the SLIM shape
 * (config-slim spec): adapters and a title. Component registration is GONE:
 * the vite plugin auto-indexes every exported component in the app's module
 * graph, so hit-testing, drill, labels and code attribution are derived, not
 * configured. Previews run in the live app, which brings its own providers
 * and data.
 *
 * ```tsx
 * import { defineConfig } from "@designbookapp/designbook/config";
 * import { themeAdapter } from "@designbookapp/designbook/adapters";
 *
 * export default defineConfig({
 *   title: "My app",
 *   adapters: [themeAdapter({ source: "./src/index.css", modes: { light: ":root" } })],
 *   i18n: {
 *     resources: import.meta.glob("./locales/*\/app.json", { eager: true, import: "default" }),
 *   },
 * });
 * ```
 *
 * Everything filesystem-shaped (locale files) is evaluated inside the config
 * file via `import.meta.glob`, relative to it — designbook itself contains no
 * repo-specific paths.
 *
 * DEPRECATED (still honored this release, ignored in the next): `sets`,
 * `flows`, `sourceModules`, `providers`, `datasets`, and the `fromGlob`
 * helper. The workbench warns loudly (console + one-time UI notice) when a
 * config still passes them. `useDataset`/`DatasetContext` remain supported as
 * an APP-side API — provide the context in your app (see the demo's App.tsx).
 */

import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type {
  Adapter,
  AdapterLocaleSetup,
  AdapterSetup,
  AdapterTab,
  AdapterTabAction,
  ContextDimension,
  ContextState,
  EditableField,
  PlaceholderMeta,
  PluralForm,
  TextAdapter,
  TextClaim,
  TextNodeHit,
} from "./adapters.ts";
import {
  evaluateCssDimension,
  inferTokenType,
  parseCssTokens,
  parseJsonTokens,
  parseRadiusScale,
  parseVariantOverrides,
  resolveTokenValue,
  resolveVariantModel,
  type DerivedDimension,
  type ThemeToken,
  type ThemeTokenModel,
  type TokenType,
  type VariantOverrides,
} from "./themeTokens.ts";
import {
  formatOklch,
  hexToRgb,
  oklchToHex,
  oklchToRgb,
  parseCssColor,
  parseOklch,
  rgbToHex,
  rgbToOklch,
  type Oklch,
  type Rgba,
} from "./color.ts";

type MatrixAxis = {
  name: string;
  values: string[];
};

type EditableProp =
  | { name: string; kind: "enum"; values: string[] }
  | { name: string; kind: "boolean" }
  | { name: string; kind: "text" };

type EntryOverride = {
  label?: string;
  matrixAxes?: MatrixAxis[];
  editableProps?: EditableProp[];
  /** Fixed preview width in px; previews are auto-width and user-resizable otherwise. */
  previewWidth?: number;
  /**
   * Repo-relative source file for the code panel. Needed when the registered
   * component is a local demo wrapper (sample props) — the wrapper lives in
   * the config file, so `sourceModules` can't attribute it to the real file.
   */
  sourcePath?: string;
  /**
   * Force which export of a lazy component module renders for this entry.
   * Default resolution prefers the export matching the entry key, then the
   * default export, then the module's sole component export.
   */
  exportName?: string;
};

/**
 * A group of components shown together on the canvas, Storybook-style. The
 * optional wrapper provides whatever context/data the components need to
 * render; it can read the active dataset via `useDataset()`.
 */
type ComponentSet = {
  id: string;
  /** `/`-delimited title used to derive folder structure, e.g. "Shop/Product". */
  title: string;
  components: Record<string, unknown>;
  wrapper?: ComponentType<{ children: ReactNode }>;
  overrides?: Record<string, EntryOverride>;
};

type WireframeKind = "hero" | "list" | "cards" | "form" | "summary" | "bar";

type FlowPreview = {
  rendererId?: string;
  wireframeKind?: WireframeKind;
  wireframeStrings?: string[];
};

/** A screen in a flow; `registryId` ("setId.ComponentKey") renders the real component, otherwise a wireframe. */
type FlowScreen = {
  id: string;
  label: string;
  description: string;
  registryId?: string;
  previews?: FlowPreview[];
  wireframeKind?: WireframeKind;
  wireframeStrings?: string[];
};

type Flow = {
  id: string;
  title: string;
  screens: FlowScreen[];
};

type PreviewDataset<Data = unknown> = {
  id: string;
  label: string;
  data: Data;
};

type LanguageOption = {
  id: string;
  label: string;
};

type I18nConfig = {
  /**
   * `import.meta.glob` result over locale JSON files, eager, `import: "default"`.
   * Keys must match `…locales/<locale>/<namespace>.json`.
   */
  resources: Record<string, unknown>;
  /** Languages offered in the canvas settings bar. Defaults to the locales found in `resources`. */
  languages?: LanguageOption[];
  /** Locale used at startup and as fallback. Default "en-US". */
  defaultLocale?: string;
  /** Default i18next namespace. Defaults to the first namespace found in `resources`. */
  defaultNamespace?: string;
  /**
   * Where the text tool writes edits back, relative to the config file.
   * `{locale}` and `{namespace}` are substituted. Default
   * "./locales/{locale}/{namespace}.json".
   */
  localePath?: string;
};

type ThemeOption = {
  id: string;
  label: string;
  /** CSS custom properties injected scoped to the canvas, so only the preview re-themes. */
  cssVars?: {
    root?: Record<string, string>;
    dark?: Record<string, string>;
  };
};

type ViewportSize = {
  id: string;
  label: string;
  width: number;
};

/**
 * A live source of truth in the HOST app for a context dimension (C4.3). In
 * injected mode the config is compiled into the app's build, so these getters
 * run in the app's realm and can read its singletons directly (e.g.
 * `locale: { get: () => i18n.language }`). The workbench's matching dimension
 * then "follows the app": the switcher shows the app's live value (an "App"
 * mode) until the designer explicitly picks a value, which overrides it. Host
 * mode (designbook's own server) ignores `hostContext` entirely.
 */
type HostContextSource = {
  /** Current app value for the dimension, or `undefined` if unavailable. */
  get: () => string | undefined;
  /**
   * Subscribe to app-side changes; call `cb` on each change, return an
   * unsubscribe. Optional — without it the switcher polls `get()` (~2s) while
   * the overlay is open.
   */
  subscribe?: (cb: () => void) => () => void;
};

/**
 * Live-page text editing hooks (M spec, M2). In injected mode the LIVE app
 * renders i18n strings through the APP's own instance (not the workbench's), so
 * the text tool needs a way to (a) force a re-render when it arms/disarms — so
 * strings re-resolve through the marker-instrumented `t()` — and (b) reflect a
 * saved edit into the app instance so the page updates without a reload. Both
 * default to the shared default i18next singleton when omitted.
 */
type PageTextConfig = {
  /**
   * Force the app to re-render (so `t()` re-runs) when the text tool toggles.
   * Default: emit `languageChanged` on the shared default i18next instance.
   */
  refresh?: () => void;
  /**
   * The app's live i18n instance. Used to reflect saved edits live (page updates
   * without reload) and, when the build transform is off, to instrument marker
   * attribution directly. Default: the shared default i18next singleton.
   */
  i18n?: () => unknown;
};

type DesignbookConfig = {
  /** Shown in the browser tab and workbench chrome. */
  title?: string;
  /**
   * @deprecated Components are auto-indexed from your source exports
   * (config-slim); `sets` still works this release and is ignored in the next.
   */
  sets?: ComponentSet[];
  /**
   * @deprecated The flows page is retired; `flows` still works this release
   * and is ignored in the next.
   */
  flows?: Flow[];
  /**
   * @deprecated The component canvas is retired; previews run in your live
   * app. `useDataset()`/`DatasetContext` remain supported app-side — provide
   * the context in your app instead.
   */
  datasets?: PreviewDataset[];
  /**
   * `import.meta.glob` result (eager) over component source files, used to
   * attribute canvas components back to their file for agent prompts.
   * @deprecated Source attribution comes from the auto export index
   * (config-slim); still works this release, ignored in the next.
   */
  sourceModules?: Record<string, unknown>;
  /**
   * @deprecated The component canvas is retired; previews run in your live
   * app, which brings its own providers (adapter Providers come from the
   * adapters themselves). Still accepted this release, ignored in the next.
   */
  providers?: ComponentType<{ children: ReactNode }>[];
  i18n?: I18nConfig;
  /**
   * Text adapters for the canvas text tool, run as an ordered chain (first
   * claim wins). When `i18n` is set and no i18next adapter is listed here, an
   * `i18nextAdapter(i18n)` is prepended automatically. A built-in
   * `sourceLiteralAdapter` fallback is always appended last. Import shipped
   * adapters from `@designbookapp/designbook/adapters`. Adapters may contribute context
   * dimensions, editable-field tabs, and a provider in addition to (or instead
   * of) claiming text; a plain `TextAdapter` is a valid `Adapter`.
   */
  adapters?: Adapter[];
  themes?: ThemeOption[];
  viewports?: ViewportSize[];
  /**
   * Live app-state sources for context dimensions (C4.3), keyed by dimension id
   * — either the adapter-local id (e.g. `"locale"`) or the namespaced
   * `"<adapter>:<id>"` form for disambiguation. In injected mode the matching
   * dimension follows the app's value until the designer overrides it; host mode
   * ignores this. See {@link HostContextSource}.
   */
  hostContext?: Record<string, HostContextSource>;
  /** Live-page text editing hooks. See {@link PageTextConfig}. */
  pageText?: PageTextConfig;
  /**
   * Integration plugins (EXPERIMENTAL), keyed by integration name. Built-ins
   * (currently `figma`) are default-ON; `false` disables one, an object
   * passes its options — e.g.
   * `integrations: { figma: { tokens: { collection, nameRule, nameMapFile } } }`
   * or `integrations: { figma: false }`. Third-party integrations (later) are
   * always explicit. Node-side, built-in opt-out is read via a literal
   * source scan (the config never evaluates in node) — keep toggles literal.
   */
  integrations?: Record<string, boolean | Record<string, unknown>>;
};

function defineConfig(config: DesignbookConfig): DesignbookConfig {
  return config;
}

// ---------------------------------------------------------------------------
// Lazy component sources + glob auto-registration (C4).
//
// A set's `components` value may be a lazy thunk `() => Promise<Module>` (a raw
// `import.meta.glob` entry) instead of an imported component. The owning bundler
// compiles the dynamic import per cell, so one broken component is one red cell,
// never a dead workbench. `fromGlob` turns a whole non-eager `import.meta.glob`
// record into a `components` record with derived keys and free source-path
// attribution.
//
// The brand is a GLOBAL symbol (`Symbol.for`) so it survives the module-instance
// split between the user's build (their copy of this module) and the prebuilt
// workbench bundle (its own copy) — the registry reads it via `readLazyMeta`.
// ---------------------------------------------------------------------------

/** Metadata carried on a lazy component source thunk. */
type LazySourceMeta = {
  /** Glob key (config-file-relative path) — becomes the code-panel source path. */
  globKey?: string;
  /** Force which export renders (overrides key/default/sole resolution). */
  exportName?: string;
};

const LAZY_SOURCE = Symbol.for("designbook.lazySource");

/** A lazy component source: a dynamic-import thunk branded with its origin. */
type LazyComponentSource = (() => Promise<unknown>) & {
  [LAZY_SOURCE]: LazySourceMeta;
};

/** A non-eager `import.meta.glob` record. */
type GlobRecord = Record<string, () => Promise<unknown>>;

function markLazy(
  load: () => Promise<unknown>,
  meta: LazySourceMeta,
): LazyComponentSource {
  const branded = load as LazyComponentSource;
  branded[LAZY_SOURCE] = meta;
  return branded;
}

/**
 * Read the lazy-source brand off a `components` value. Returns the metadata for
 * a branded thunk (from `fromGlob` or `lazy()`), else `undefined`. The registry
 * additionally sniffs raw, unbranded `() => import(...)` thunks.
 */
function readLazyMeta(value: unknown): LazySourceMeta | undefined {
  if (typeof value === "function") {
    const meta = (value as Partial<LazyComponentSource>)[LAZY_SOURCE];
    if (meta && typeof meta === "object") return meta;
  }
  return undefined;
}

/**
 * Brand a single dynamic-import thunk as a lazy component source. Rarely needed
 * — `fromGlob` is the recommended path — but useful for a one-off lazy entry
 * whose export name must be pinned: `lazy(() => import("./X"), { exportName })`.
 */
function lazy(
  load: () => Promise<unknown>,
  meta: Omit<LazySourceMeta, "globKey"> = {},
): LazyComponentSource {
  return markLazy(load, meta);
}

type FromGlobMatcher = string | RegExp;

type FromGlobOptions = {
  /** Only keep paths matching (substring for strings). Default: keep all. */
  include?: FromGlobMatcher | FromGlobMatcher[];
  /** Drop paths matching (substring for strings). Applied after the default test/spec/stories exclusion. */
  exclude?: FromGlobMatcher | FromGlobMatcher[];
  /** Map a glob path to a component key. Return "" / undefined to skip the file. */
  key?: (path: string) => string | undefined;
};

/** `*.test.*`, `*.spec.*`, `*.stories.*` — eager-glob execution of these was a real incident. */
const DEFAULT_GLOB_EXCLUDE = /\.(test|spec|stories)\.[cm]?[jt]sx?$/;

function toMatchers(input: FromGlobMatcher | FromGlobMatcher[] | undefined): {
  test: (path: string) => boolean;
}[] {
  if (input === undefined) return [];
  const list = Array.isArray(input) ? input : [input];
  return list.map((m) =>
    typeof m === "string"
      ? { test: (path: string) => path.includes(m) }
      : { test: (path: string) => m.test(path) },
  );
}

function pascalSegment(segment: string): string {
  return segment
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Component key from a file basename: drop dir + extension, PascalCase (preserving existing caps). */
function keyFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.[^.]+$/, "");
  return pascalSegment(stem);
}

/** Immediate parent directory of a path, or "" at the root. */
function parentDir(path: string): string {
  const parts = path.split("/").filter((p) => p && p !== ".");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

let fromGlobDeprecationWarned = false;

/**
 * Turn a non-eager `import.meta.glob` record into a `components` record of lazy
 * sources. Keys derive from the file basename (PascalCase); collisions across
 * directories are disambiguated by prefixing the parent-dir name, then a numeric
 * suffix as a last resort — deterministic. `*.{test,spec,stories}.*` are excluded
 * by default.
 *
 * @deprecated `sets`/`fromGlob` registration is replaced by the auto export
 * index (config-slim). Still works this release; ignored in the next.
 */
function fromGlob(
  glob: GlobRecord,
  options: FromGlobOptions = {},
): Record<string, LazyComponentSource> {
  if (!fromGlobDeprecationWarned) {
    fromGlobDeprecationWarned = true;
    console.warn(
      "[designbook] fromGlob() is deprecated: components are auto-indexed from your source exports — remove `sets`/`fromGlob` from designbook.config. Still honored this release.",
    );
  }
  const include = toMatchers(options.include);
  const exclude = toMatchers(options.exclude);

  const paths = Object.keys(glob)
    .filter((path) => !DEFAULT_GLOB_EXCLUDE.test(path))
    .filter((path) => !exclude.some((m) => m.test(path)))
    .filter((path) => include.length === 0 || include.some((m) => m.test(path)))
    .sort();

  // Base keys first, to detect cross-directory collisions.
  const baseKeys = new Map<string, string>();
  for (const path of paths) {
    const key = options.key ? options.key(path) : keyFromPath(path);
    if (key) baseKeys.set(path, key);
  }
  const counts = new Map<string, number>();
  for (const key of baseKeys.values()) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const record: Record<string, LazyComponentSource> = {};
  for (const [path, baseKey] of baseKeys) {
    let key = baseKey;
    if ((counts.get(baseKey) ?? 0) > 1) {
      key = `${pascalSegment(parentDir(path))}${baseKey}`;
    }
    let unique = key;
    let n = 2;
    while (unique in record) unique = `${key}${n++}`;
    record[unique] = markLazy(glob[path], { globKey: path });
  }
  return record;
}

const defaultDataset: PreviewDataset = {
  id: "default",
  label: "Default",
  data: undefined,
};

const DatasetContext = createContext<PreviewDataset>(defaultDataset);

/**
 * The dataset selected in the canvas toolbar. Component-set wrappers and
 * compositions read from this instead of receiving data through props —
 * the Storybook-decorator model.
 */
function useDataset<Data = unknown>(): PreviewDataset<Data> {
  return useContext(DatasetContext) as PreviewDataset<Data>;
}

export {
  DatasetContext,
  defaultDataset,
  defineConfig,
  evaluateCssDimension,
  fromGlob,
  lazy,
  formatOklch,
  hexToRgb,
  inferTokenType,
  oklchToHex,
  oklchToRgb,
  parseCssColor,
  parseCssTokens,
  parseJsonTokens,
  parseOklch,
  parseRadiusScale,
  parseVariantOverrides,
  readLazyMeta,
  resolveTokenValue,
  resolveVariantModel,
  rgbToHex,
  rgbToOklch,
  useDataset,
};
export type {
  SelectionContextContribution,
  SelectionContextContributor,
  SelectionContextFact,
  SelectionContextRunCtx,
  SelectionContextSelection,
} from "./selectionContext.ts";
export type {
  Adapter,
  AdapterLocaleSetup,
  AdapterSetup,
  AdapterTab,
  AdapterTabAction,
  ComponentSet,
  ContextDimension,
  ContextState,
  EditableField,
  DerivedDimension,
  DesignbookConfig,
  EditableProp,
  EntryOverride,
  Flow,
  FlowPreview,
  FlowScreen,
  FromGlobOptions,
  HostContextSource,
  I18nConfig,
  LanguageOption,
  LazyComponentSource,
  MatrixAxis,
  Oklch,
  PageTextConfig,
  PlaceholderMeta,
  PluralForm,
  PreviewDataset,
  Rgba,
  TextAdapter,
  TextClaim,
  TextNodeHit,
  ThemeOption,
  ThemeToken,
  ThemeTokenModel,
  TokenType,
  VariantOverrides,
  ViewportSize,
  WireframeKind,
};
