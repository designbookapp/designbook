/**
 * Remaining mock data for the full-view prototype (#/proto/full-view).
 *
 * Everything else was replaced by REAL interfaces (threads/sandbox model,
 * changes model, branch model, adapter panels, CodePanel, and now the props
 * inspector — see PropsInspector.tsx). The only mock left is the variant-card
 * gradient swatches the chat's variant previews use.
 */

/** Deterministic gradient pairs for the variant-card previews (the proto's
 * swatch look applied to REAL variants — indexed by variant order). */
export const variantSwatches: [string, string][] = [
  ["#4c8dff", "#1f6feb"],
  ["#3fb950", "#238636"],
  ["#db61a2", "#bf4b8a"],
  ["#d29922", "#9e6a03"],
  ["#8957e5", "#6639ba"],
  ["#39c5cf", "#1b7c83"],
];
