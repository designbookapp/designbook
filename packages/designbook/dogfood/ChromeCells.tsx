/**
 * Dogfood cells for two PROMOTED PURE workbench components (R spec target
 * tree: `components/` = pure, no data/models/adapters). Both take their state
 * as props with no context dependency, so a cell just supplies representative
 * sample props — same shape as the demo config's composite variants.
 */
import { useState } from "react";
import { SelectionToolbar } from "@designbook-ui/components/SelectionToolbar";
import { SideRail, type PanelTab } from "@designbook-ui/components/SideRail";

function SelectionToolbarCell() {
  const [variant, setVariant] = useState("default");
  return (
    <div className="flex w-full max-w-sm justify-center p-6">
      <SelectionToolbar
        label="ProductCard › Card"
        onClear={() => {}}
        variant={variant}
        variants={["default", "compact"]}
        onVariantChange={setVariant}
      />
    </div>
  );
}

function SideRailCell() {
  const [activeTab, setActiveTab] = useState<PanelTab>("chat");
  return (
    <div className="h-64 w-fit">
      <SideRail
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        adapterTabs={[{ id: "theme", label: "Theme", icon: "palette" }]}
      />
    </div>
  );
}

export { SelectionToolbarCell, SideRailCell };
