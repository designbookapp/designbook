/**
 * `configState` model atoms: the small, declarative pieces the
 * settings bar or a cell composes over the active dimensions. Thin — the
 * configState model's substance is the injected setters + the adapter-runtime
 * interplay that stays in `Workbench` (configStateModel.ts) — so these exist
 * only so a cell can label a dimension's current value without reaching into the
 * settings bar, and so that labeling has ONE home.
 *
 * `useConfigStateModel` (re-exported from ConfigStateProvider) is the context
 * hook the settings bar + adapter panel use to reach the values + setters.
 */

import type { ContextDimension } from "@designbookapp/designbook/config";
import { useConfigStateModel } from "./ConfigStateProvider";

/** Human label for a dimension's current value, falling back to the raw value. */
function DimensionValue({ dimension }: { dimension: ContextDimension }) {
  const { context } = useConfigStateModel();
  const value = context[dimension.id] ?? dimension.defaultValue;
  const label = dimension.options.find((option) => option.value === value)
    ?.label;
  return <>{label ?? value ?? ""}</>;
}

/** The active adapter context (dimension id → value) on the provider. */
function useContextState() {
  return useConfigStateModel().context;
}

export { DimensionValue, useContextState, useConfigStateModel };
