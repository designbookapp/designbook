/**
 * The `configState` model — the canvas "dimensions": the active theme preset,
 * the adapter-contributed context dimensions + their current values and
 * host-context follow state ("flags"), the light/dark mode, and the selected
 * preview dataset.
 *
 * This is the model behind the canvas settings bar (theme / dimension / dark
 * pickers) and the adapter panel (which reads the active `context`). Together
 * these drive the live-apply loop: a theme-token edit, a dimension switch, or a
 * flag toggle re-renders the canvas preview immediately.
 *
 * ## Confirmed altitude (Michael 2026-07-07) — sensitive
 * The adapter runtime (`getAdapterRuntime`/`useAdapterSnapshot`) and the local
 * theme/dark/dataset React state STAY in the composition root (`Workbench`):
 * this pass injects their CURRENT VALUES + the SETTERS as actions onto the
 * provider context, it does NOT absorb the runtime or the hooks. The
 * adapter-runtime interplay (theme/flags/dataset live-apply) must stay
 * behavior-identical — so the derivations that touch the runtime (which
 * dimension is `mode`/`variant`, how `toggleDarkMode` routes) remain in
 * `Workbench`; only their already-computed results (`hideDarkToggle`,
 * `hideThemePreset`, `darkMode`) are forwarded here.
 *
 * `createConfigStateModel` is a pure factory (no React, no globals): live use
 * feeds `data` (the computed values) + the bound setters; fixture/cell/test use
 * feeds canonical `data` and the setters default to no-ops. The only logic here
 * is the pure `dataset` lookup (current id → dataset), so a consumer/cell reads
 * it consistently.
 */

import type {
  ContextDimension,
  ContextState,
  PreviewDataset,
  ThemeOption,
} from "@designbookapp/designbook/config";
import type { FollowState } from "@designbook-ui/hostContext";

/** The dimension values fed via the provider's `data` prop (live or fixture). */
type ConfigStateData = {
  /** Active theme-preset id (the `themes` config Select). */
  themeId: string;
  /** Available theme presets (empty hides the preset Select). */
  themeOptions: ThemeOption[];
  /** Adapter-contributed context dimensions (locale, tenant, mode, …). */
  dimensions: ContextDimension[];
  /** Current value per dimension id. */
  context: ContextState;
  /** Per-dimension host-context follow status (C4.3); empty for normal dims. */
  follow: Record<string, FollowState>;
  /** Effective light/dark for the preview (a `mode` dimension or the local toggle). */
  darkMode: boolean;
  /** Hide the standalone dark toggle (a `mode` dimension already drives it). */
  hideDarkToggle: boolean;
  /** Hide the standalone theme-preset Select (a `variant` dimension replaces it). */
  hideThemePreset: boolean;
  /** Available preview datasets. */
  datasets: PreviewDataset[];
  /** Active dataset id. */
  datasetId: string;
};

/** The dimension setters, injected from `Workbench` (adapter-runtime + state). */
type ConfigStateActions = {
  /** Select a theme preset. */
  setTheme: (id: string) => void;
  /** Set an adapter dimension's value (drives the live re-render). */
  setContext: (id: string, value: string) => void;
  /** Toggle light/dark (routes through the `mode` dimension when present). */
  toggleDarkMode: () => void;
  /** Select a preview dataset. */
  setDataset: (id: string) => void;
};

/** The configState model surface exposed on context and returned by the factory. */
type ConfigStateModel = ConfigStateData &
  ConfigStateActions & {
    /** The active dataset (current id → dataset, else the first). */
    dataset: PreviewDataset | undefined;
  };

type CreateConfigStateModelOptions = Partial<ConfigStateActions> & {
  /** The dimension values; omitted defaults to an empty, single-light set. */
  data?: ConfigStateData;
};

const EMPTY_DATA: ConfigStateData = {
  themeId: "",
  themeOptions: [],
  dimensions: [],
  context: {},
  follow: {},
  darkMode: false,
  hideDarkToggle: false,
  hideThemePreset: false,
  datasets: [],
  datasetId: "",
};

const noop = () => {};

/**
 * Build a configState model. Pure — no React, no globals. See the module doc for
 * the (sensitive) live vs. fixture split.
 */
function createConfigStateModel(
  options: CreateConfigStateModelOptions = {},
): ConfigStateModel {
  const data = options.data ?? EMPTY_DATA;
  return {
    ...data,
    dataset:
      data.datasets.find((candidate) => candidate.id === data.datasetId) ??
      data.datasets[0],
    setTheme: options.setTheme ?? noop,
    setContext: options.setContext ?? noop,
    toggleDarkMode: options.toggleDarkMode ?? noop,
    setDataset: options.setDataset ?? noop,
  };
}

export { createConfigStateModel };
export type {
  ConfigStateActions,
  ConfigStateData,
  ConfigStateModel,
  CreateConfigStateModelOptions,
};
