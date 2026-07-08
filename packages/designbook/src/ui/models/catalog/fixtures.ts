/**
 * Canonical `catalog` model fixtures.
 *
 * ONE hardcoded config — two component sets, a few registry entries (one with
 * matrix axes), and the flows/viewports around them — fed straight into
 * `<CatalogProvider data={...}>` or `createCatalogModel`. Used by the model's
 * unit test AND (later) by canvas cells that render the catalog model without a
 * live compiled config.
 *
 * `createCatalogFixture()` returns a fresh dataset each call, plus a `navigate`
 * spy (`navigated`) so a consumer can assert the routing action fired.
 */

import type { ComponentSet, Flow, ViewportSize } from "@designbookapp/designbook/config";
import type { CatalogData } from "./catalogModel";
import type { RegistryEntry } from "./componentRegistry";

type NavigateCall = { nodeIds: string[]; flowId?: string };

type CatalogFixture = {
  /** Feed straight into `<CatalogProvider data={...}>` or `createCatalogModel`. */
  data: CatalogData;
  /** A navigate spy — every `navigate(nodeIds, flowId)` call, in order. */
  navigated: NavigateCall[];
  navigate: (nodeIds: string[], flowId?: string) => void;
  /** The entries by role, for direct assertions. */
  entries: {
    shipDetail: RegistryEntry;
    shipSummary: RegistryEntry;
    productCard: RegistryEntry;
  };
};

function entry(partial: Partial<RegistryEntry> & Pick<RegistryEntry, "id" | "name" | "label" | "setId" | "key" | "sourcePath">): RegistryEntry {
  return { component: () => null, ...partial };
}

function createCatalogFixture(): CatalogFixture {
  const navigated: NavigateCall[] = [];
  const navigate = (nodeIds: string[], flowId?: string) =>
    void navigated.push({ nodeIds, flowId });

  const shipDetail = entry({
    id: "ship.Detail",
    name: "Detail",
    label: "Ship · Detail",
    setId: "ship",
    key: "Detail",
    sourcePath: "src/ship/Detail.tsx",
  });
  const shipSummary = entry({
    id: "ship.Summary",
    name: "Summary",
    label: "Ship · Summary",
    setId: "ship",
    key: "Summary",
    sourcePath: "src/ship/Summary.tsx",
  });
  const productCard = entry({
    id: "product.Card",
    name: "Card",
    label: "Product · Card",
    setId: "product",
    key: "Card",
    sourcePath: "src/product/Card.tsx",
    previewWidth: 320,
    matrixAxes: [{ name: "variant", values: ["default", "compact"] }],
  });

  const entries = [shipDetail, shipSummary, productCard];

  const sets: ComponentSet[] = [
    { id: "ship", title: "Cruises/Ship", components: {} },
    { id: "product", title: "Product", components: {} },
  ];

  const flows: Flow[] = [
    {
      id: "ship",
      title: "Cruises/Ship",
      screens: [
        {
          id: shipDetail.id,
          label: shipDetail.name,
          description: shipDetail.sourcePath,
          registryId: shipDetail.id,
        },
        {
          id: shipSummary.id,
          label: shipSummary.name,
          description: shipSummary.sourcePath,
          registryId: shipSummary.id,
        },
      ],
    },
    {
      id: "product",
      title: "Product",
      screens: [
        {
          id: productCard.id,
          label: productCard.name,
          description: productCard.sourcePath,
          registryId: productCard.id,
        },
      ],
    },
  ];

  const viewports: ViewportSize[] = [
    { id: "desktop", label: "Desktop · 1280", width: 1280 },
    { id: "mobile", label: "Mobile · 390", width: 390 },
  ];

  return {
    data: { sets, entries, flows, viewports },
    navigated,
    navigate,
    entries: { shipDetail, shipSummary, productCard },
  };
}

export { createCatalogFixture };
export type { CatalogFixture, NavigateCall };
