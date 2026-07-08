/**
 * The workbench React tree: the App wrapped in each adapter's Provider.
 *
 * Imported dynamically by `mountWorkbench` AFTER the config store is
 * initialized, so this module's transitive imports (flows, themes, viewports,
 * the component registry, …) read the populated config at evaluation time.
 */

import { type ReactNode } from "react";
import { App } from "./App";
import { useAdapterSnapshot, type AdapterRuntime } from "./adapterRuntime";

/**
 * Wraps `<App />` in each adapter's Provider (first adapter outermost), feeding
 * every provider the live canvas context + per-adapter resolved values so the
 * preview re-renders on a locale switch, tenant change, or flag edit.
 */
function WorkbenchRoot({ runtime }: { runtime: AdapterRuntime }) {
  const { context, values } = useAdapterSnapshot();
  return runtime.providers.reduceRight<ReactNode>(
    (wrapped, Provider) => (
      <Provider context={context} values={values}>
        {wrapped}
      </Provider>
    ),
    <App />,
  );
}

export { WorkbenchRoot };
