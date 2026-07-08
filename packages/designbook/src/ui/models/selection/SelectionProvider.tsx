/**
 * React binding for the `selection` model.
 *
 * `SelectionProvider` builds a `SelectionModel` (see selectionModel.ts) and puts
 * it on context so screens (the code panel, canvas surfaces) consume the drill /
 * attribution / source-resolution operations declaratively. The operations are
 * pure and identical in every mode, so the provider only forwards an optional
 * `data` (a canonical selection) for fixture/cell rendering — there is no live
 * runtime to read (contrast the text/catalog providers).
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createSelectionModel,
  type SelectionData,
  type SelectionModel,
} from "./selectionModel";

const SelectionModelContext = createContext<SelectionModel | null>(null);

type SelectionProviderProps = {
  /** Canonical selection for tests/cells; omitted in live pointer-driven use. */
  data?: SelectionData;
  children: ReactNode;
};

function SelectionProvider({ data, children }: SelectionProviderProps) {
  const model = useMemo(() => createSelectionModel({ data }), [data]);
  return (
    <SelectionModelContext.Provider value={model}>
      {children}
    </SelectionModelContext.Provider>
  );
}

/** Read the selection model from context; throws if used outside a provider. */
function useSelectionModel(): SelectionModel {
  const model = useContext(SelectionModelContext);
  if (!model) {
    throw new Error(
      "useSelectionModel must be used within a <SelectionProvider>.",
    );
  }
  return model;
}

export { SelectionProvider, useSelectionModel, SelectionModelContext };
export type { SelectionProviderProps };
