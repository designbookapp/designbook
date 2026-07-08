/**
 * Canonical `selection` model fixtures.
 *
 * ONE hardcoded scenario — a drilled selection of `<Card className="relative">`
 * inside a `ProductCard` page — expressed as the three shapes the pipeline
 * consumes: an interleaved drill `chain` (dom leaf → Card → ProductCard root),
 * the attributable `links` for code-target resolution, a `source` string for
 * definition/usage-line resolution, and the resolved `CanvasNodeSelection` an
 * atom/cell renders. Fed straight into `<SelectionProvider data={...}>` or the
 * model operations.
 */

import type { CanvasCodeTarget, CanvasNodeSelection } from "@designbook-ui/types";
import type { ChainLink } from "./drillSelection";
import type { AttributableLink } from "./codeTargets";
import type { RegistryEntry } from "../catalog/componentRegistry";

type SelectionFixture = {
  /** Interleaved chain, innermost → outermost (drillSelection input). */
  chain: ChainLink[];
  /** The same levels as attributable links (codeTargets input). */
  links: AttributableLink[];
  /** ProductCard's source, for definition/usage-line resolution. */
  source: string;
  /** The resolved drilled selection an atom renders. */
  selection: CanvasNodeSelection;
  /** A non-drilled selection (component's own definition — no codeTarget). */
  definitionSelection: CanvasNodeSelection;
};

function entry(id: string, key: string, sourcePath: string): RegistryEntry {
  return {
    id,
    name: key,
    label: key,
    key,
    setId: id.split(".")[0],
    sourcePath,
    component: () => null,
  };
}

const SOURCE = `export function ProductCard() {
  return (
    <Card className="relative">
      <div className="relative">hi</div>
    </Card>
  );
}
`;

function createSelectionFixture(): SelectionFixture {
  const root = entry("product.ProductCard", "ProductCard", "src/product/ProductCard.tsx");
  const card = entry("product.Card", "Card", "src/product/Card.tsx");

  // Innermost → outermost. No owner metadata on the drill chain, so it is fully
  // (adjacently) drillable — indices [0,1,2].
  const chain: ChainLink[] = [
    { instanceId: "leaf", kind: "dom" },
    { instanceId: "card", kind: "component", componentId: card.id },
    { instanceId: "root", kind: "component", componentId: root.id },
  ];

  const links: AttributableLink[] = [
    { kind: "dom", name: "div", className: "relative", ownerEntry: root },
    { kind: "component", name: "Card", entry: card, ownerEntry: root },
    { kind: "component", name: "ProductCard", entry: root },
  ];

  const codeTarget: CanvasCodeTarget = {
    file: root.sourcePath,
    ownerExportName: root.key,
    name: "Card",
    kind: "component",
    className: "relative",
  };

  const selection: CanvasNodeSelection = {
    label: "Card",
    description: `Card inside ${root.label}`,
    exportName: card.key,
    path: card.sourcePath,
    codeTarget,
  };

  const definitionSelection: CanvasNodeSelection = {
    label: "ProductCard",
    description: root.sourcePath,
    exportName: root.key,
    path: root.sourcePath,
  };

  return { chain, links, source: SOURCE, selection, definitionSelection };
}

export { createSelectionFixture };
export type { SelectionFixture };
