/**
 * The dataset selected in the canvas toolbar. Re-exported from the public
 * config API so component-set wrappers in user config files read the same
 * context via `useDataset()` — the Storybook-decorator model.
 */

export { DatasetContext, useDataset } from "@designbookapp/designbook/config";
export type { PreviewDataset } from "@designbookapp/designbook/config";
