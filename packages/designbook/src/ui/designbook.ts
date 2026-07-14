/**
 * Normalized access to the user's designbook config.
 *
 * The config is no longer imported at module scope from
 * `virtual:designbook-config`; instead `mountWorkbench` (src/ui/mount.tsx)
 * passes it in and calls `initConfigStore` before the workbench renders. The
 * named exports below are plain `let` bindings — ESM live bindings, so every
 * consumer that does `import { sets } from "@designbook-ui/designbook"` sees
 * the populated value once the store is initialized. `mountWorkbench` sets the
 * store and then dynamically imports the App graph, so even consumers that read
 * these at module scope observe the initialized values.
 */

import {
  defaultDataset,
  type ComponentSet,
  type DesignbookConfig,
  type PreviewDataset,
  type ThemeOption,
} from "@designbookapp/designbook/config";
import type { ComponentType, ReactNode } from "react";

let config: DesignbookConfig = {} as DesignbookConfig;
let configDir = ".";
let title = "Designbook";
let sets: ComponentSet[] = [];
let datasets: PreviewDataset[] = [defaultDataset];
let themes: ThemeOption[] = [];
let providers: ComponentType<{ children: ReactNode }>[] = [];
let sourceModules: Record<string, unknown> = {};
/** Base URL of the designbook API server, when mounted against a live server. */
let serverUrl: string | undefined;
/**
 * Router mode. "hash" (host mode) reads/writes `location.hash` exactly as
 * before; "memory" (injected mode) keeps route state in memory + sessionStorage
 * and NEVER touches the app's URL. Defaults to "hash".
 */
let routing: "hash" | "memory" = "hash";

/**
 * Config fields REMOVED in the slim config (config-slim spec): the auto
 * export index derives everything they configured. They still function this
 * release (deprecate-warn, never crash — client repos still pass them) and
 * will be ignored in the next.
 */
const DEPRECATED_CONFIG_FIELDS = [
  ["sets", "component registration — components are auto-indexed from your source"],
  ["flows", "the flows page is retired"],
  ["sourceModules", "source attribution comes from the auto export index"],
  [
    "providers",
    "previews run in your live app, which brings its own providers; adapter Providers come from the adapters themselves",
  ],
  [
    "datasets",
    "the component canvas is retired; provide DatasetContext in your app if you use useDataset()",
  ],
] as const;

/** Deprecated field names present in the loaded config (UI notice source). */
let deprecatedConfigFields: string[] = [];
let deprecationWarned = false;

function warnDeprecatedConfigFields(rawConfig: DesignbookConfig): void {
  const record = rawConfig as unknown as Record<string, unknown>;
  deprecatedConfigFields = DEPRECATED_CONFIG_FIELDS.filter(([field]) => {
    const value = record[field];
    if (value === undefined || value === null) return false;
    return !(Array.isArray(value) && value.length === 0);
  }).map(([field]) => field);
  if (deprecatedConfigFields.length === 0 || deprecationWarned) return;
  deprecationWarned = true;
  const lines = DEPRECATED_CONFIG_FIELDS.filter(([field]) =>
    deprecatedConfigFields.includes(field),
  ).map(([field, why]) => `  - \`${field}\`: ${why}`);
  console.warn(
    `[designbook] DEPRECATED designbook.config fields — they still work this release but will be ignored in the next:\n${lines.join(
      "\n",
    )}\nSlim config shape: { title?, adapters, i18n?, … } — components, drill boundaries and code attribution are now derived automatically from your source exports.`,
  );
}

/**
 * Populate the config store. Must run before any consumer of the exports below
 * renders (or is imported). `mountWorkbench` guarantees this ordering.
 */
function initConfigStore(
  rawConfig: DesignbookConfig,
  rawConfigDir: string,
  rawServerUrl?: string,
  rawRouting: "hash" | "memory" = "hash",
): void {
  config = rawConfig;
  configDir = rawConfigDir;
  serverUrl = rawServerUrl;
  routing = rawRouting;
  title = rawConfig.title ?? "Designbook";
  sets = rawConfig.sets ?? [];
  datasets = rawConfig.datasets?.length ? rawConfig.datasets : [defaultDataset];
  themes = rawConfig.themes ?? [];
  providers = rawConfig.providers ?? [];
  sourceModules = rawConfig.sourceModules ?? {};
  warnDeprecatedConfigFields(rawConfig);
}

/** Deprecated config fields the loaded config still uses (empty = clean). */
function getDeprecatedConfigFields(): string[] {
  return deprecatedConfigFields;
}

/**
 * Resolve an `/api/*` path against the configured server. In host mode
 * `serverUrl` is unset, so the path is returned unchanged (same-origin relative
 * fetch, unchanged behavior). In injected mode `serverUrl` points at
 * the cross-origin sidecar, so we prefix it. Every `/api/*` fetch/EventSource in
 * the UI MUST route through here (guarded by previewHostSeam-style test).
 */
function apiUrl(path: string): string {
  if (!serverUrl) return path;
  return `${serverUrl.replace(/\/+$/, "")}${path}`;
}

/** Joins the config-file-relative glob key onto the repo-relative config dir. */
function repoPathFromGlobKey(globKey: string): string {
  const parts: string[] = [];
  for (const segment of `${configDir}/${globKey}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export {
  apiUrl,
  config,
  configDir,
  datasets,
  getDeprecatedConfigFields,
  initConfigStore,
  providers,
  repoPathFromGlobKey,
  routing,
  serverUrl,
  sets,
  sourceModules,
  themes,
  title,
};
