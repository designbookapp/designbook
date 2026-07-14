/**
 * Dogfood cell for `models/catalog` (R spec item 4) — ISOLATED, loaded lazily.
 *
 * `CatalogProvider` statically imports `@designbook-ui/designbook`'s live
 * `sets` binding (via `componentRegistry.ts`/`flows.ts`/`viewports.ts`), each of
 * which computes an eager module-level singleton (`const registry =
 * buildRegistry()`, `const flows = …`) from whatever `sets`/`config` holds AT
 * IMPORT TIME. Those are the SAME module instances the real workbench uses to
 * render every cell/flow — so if this file were imported eagerly from
 * `designbook.config.tsx`, it would force that computation to run while
 * `main.tsx` is still evaluating the config module graph, BEFORE
 * `mountWorkbench` calls `initConfigStore` — freezing the registry/flows empty
 * for the whole dogfood workbench, not just this cell (self-host's one real
 * circularity hazard; see the file's `lazy()` registration in
 * designbook.config.tsx). Every OTHER model cell's Provider avoids this
 * import, so only this file needs to be lazy-loaded.
 *
 * Deferring the import via `lazy()`/`React.lazy` fixes it for free: the dynamic
 * `import()` only resolves at first render, well after `initConfigStore` has
 * already run.
 */
import { useMemo } from "react";
import { Badge } from "@designbook-ui/components/ui/badge";
import { CatalogProvider } from "@designbook-ui/models/catalog/CatalogProvider";
import { EntryLabel, ScreenRoute, SetTitle, useEntry } from "@designbook-ui/models/catalog/atoms";
import { createCatalogFixture, type CatalogFixture } from "@designbook-ui/models/catalog/fixtures";
import { ModelCellFrame } from "./ModelCellFrame";

function CatalogCellBody({ fixture }: { fixture: CatalogFixture }) {
  const productCard = useEntry(fixture.entries.productCard.id);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">via useEntry()</span>
        <span className="font-medium">
          {productCard ? <EntryLabel entry={productCard} /> : "not found"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {fixture.data.sets.map((set) => (
          <Badge key={set.id} variant="outline">
            <SetTitle set={set} />
          </Badge>
        ))}
      </div>
      <ul className="space-y-1 border-t pt-2">
        {fixture.data.flows.flatMap((flow) => flow.screens).map((screen) => (
          <li key={screen.id} className="flex items-center justify-between">
            <span>{screen.label}</span>
            <code className="font-mono text-xs text-muted-foreground">
              <ScreenRoute screen={screen} />
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CatalogModelCell() {
  const fixture = useMemo(() => createCatalogFixture(), []);
  return (
    <CatalogProvider data={fixture.data} navigate={fixture.navigate}>
      <ModelCellFrame title="Sets, entries & flows" model="models/catalog">
        <CatalogCellBody fixture={fixture} />
      </ModelCellFrame>
    </CatalogProvider>
  );
}

export default CatalogModelCell;
