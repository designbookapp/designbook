/**
 * React binding for the `configState` model.
 *
 * `ConfigStateProvider` builds a `ConfigStateModel` (see configStateModel.ts)
 * and puts it on context so the canvas settings bar + adapter panel read the
 * active dimensions and their setters declaratively:
 *   - live use: `Workbench` computes every value against the adapter runtime +
 *     its local theme/dark/dataset state (the stateful pieces stay in the
 *     composition root — confirmed altitude) and feeds them as `data` plus the
 *     bound setters;
 *   - tests / cells: pass `data` (fixture dimensions); the setters default to
 *     no-ops.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createConfigStateModel,
  type ConfigStateActions,
  type ConfigStateData,
  type ConfigStateModel,
} from "./configStateModel";

const ConfigStateModelContext = createContext<ConfigStateModel | null>(null);

type ConfigStateProviderProps = Partial<ConfigStateActions> & {
  /** The computed dimension values (live) or fixture data (cells/tests). */
  data?: ConfigStateData;
  children: ReactNode;
};

function ConfigStateProvider({
  data,
  setTheme,
  setContext,
  toggleDarkMode,
  setDataset,
  children,
}: ConfigStateProviderProps) {
  const model = useMemo(
    () =>
      createConfigStateModel({
        data,
        setTheme,
        setContext,
        toggleDarkMode,
        setDataset,
      }),
    [data, setTheme, setContext, toggleDarkMode, setDataset],
  );
  return (
    <ConfigStateModelContext.Provider value={model}>
      {children}
    </ConfigStateModelContext.Provider>
  );
}

/** Read the configState model from context; throws if used outside a provider. */
function useConfigStateModel(): ConfigStateModel {
  const model = useContext(ConfigStateModelContext);
  if (!model) {
    throw new Error(
      "useConfigStateModel must be used within a <ConfigStateProvider>.",
    );
  }
  return model;
}

export { ConfigStateProvider, useConfigStateModel, ConfigStateModelContext };
export type { ConfigStateProviderProps };
