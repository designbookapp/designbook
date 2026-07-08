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
