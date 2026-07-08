/**
 * React binding for the `text` model.
 *
 * `TextProvider` builds a `TextModel` (see textModel.ts) and puts it on context
 * so the three text surfaces and the model's atoms consume ONE pipeline
 * declaratively:
 *   - normal use: no `data` — the provider reads the live adapter runtime
 *     (`getAdapterRuntime()`) and applies the surface's `decorateSave`;
 *   - tests / canvas cells: pass `data` (fixture claims) and the provider
 *     resolves against those with no adapters or DOM I/O.
 *
 * Keeping the runtime lookup HERE (not inside `createTextModel`) lets the pure
 * factory stay React- and singleton-free for unit tests.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { getAdapterRuntime } from "@designbook-ui/adapterRuntime";
import {
  createTextModel,
  type SaveDecorator,
  type TextData,
  type TextModel,
} from "./textModel";

const TextModelContext = createContext<TextModel | null>(null);

type TextProviderProps = {
  /** Fixture claims for tests/cells; when set, the live runtime is not read. */
  data?: TextData;
  /** Surface-specific save side effect (canvas: omit; page/frame: supply). */
  decorateSave?: SaveDecorator;
  children: ReactNode;
};

function TextProvider({ data, decorateSave, children }: TextProviderProps) {
  const model = useMemo(
    () =>
      createTextModel({
        data,
        decorateSave,
        // Passed as a THUNK, not called here: the page-tools layer mounts this
        // provider before the adapter runtime finishes initializing, so the
        // lookup is deferred to the first hover/click (see `createTextModel`).
        // A cell/test passes `data` instead, so this path never runs there.
        runtime: getAdapterRuntime,
      }),
    [data, decorateSave],
  );
  return (
    <TextModelContext.Provider value={model}>
      {children}
    </TextModelContext.Provider>
  );
}

/** Read the text model from context; throws if used outside a `TextProvider`. */
function useTextModel(): TextModel {
  const model = useContext(TextModelContext);
  if (!model) {
    throw new Error("useTextModel must be used within a <TextProvider>.");
  }
  return model;
}

export { TextProvider, useTextModel, TextModelContext };
export type { TextProviderProps };
