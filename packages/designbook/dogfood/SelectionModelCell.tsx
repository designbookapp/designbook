/**
 * Dogfood cell for `models/selection` (R spec item 4). Wraps `SelectionProvider`
 * with the fixture's resolved drilled selection (`<Card className="relative">`
 * inside `ProductCard`) and renders the `SelectionLabel`/`TargetFile`/
 * `TargetLine` atoms — the same pieces the code panel composes, with no canvas
 * pointer input.
 */
import { useMemo } from "react";
import {
  SelectionLabel,
  TargetFile,
  TargetLine,
} from "@designbook-ui/models/selection/atoms";
import { createSelectionFixture } from "@designbook-ui/models/selection/fixtures";
import { SelectionProvider } from "@designbook-ui/models/selection/SelectionProvider";
import { ModelCellFrame } from "./ModelCellFrame";

function SelectionModelCell() {
  const fixture = useMemo(() => createSelectionFixture(), []);
  const { selection, source } = fixture;
  return (
    <SelectionProvider data={{ selection }}>
      <ModelCellFrame title="Drilled selection" model="models/selection">
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">
              <SelectionLabel selection={selection} />
            </span>
            <span className="text-xs text-muted-foreground">
              line <TargetLine selection={selection} source={source} />
            </span>
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            <TargetFile selection={selection} />
          </div>
        </div>
      </ModelCellFrame>
    </SelectionProvider>
  );
}

export default SelectionModelCell;
