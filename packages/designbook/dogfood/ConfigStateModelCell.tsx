/**
 * Dogfood cell for `models/configState` (R spec item 4). Wraps
 * `ConfigStateProvider` in fixture mode (a theme preset + mode/locale
 * dimensions) and renders the `DimensionValue` atom over each — the same piece
 * the canvas settings bar composes.
 */
import { useMemo } from "react";
import { DimensionValue } from "@designbook-ui/models/configState/atoms";
import { ConfigStateProvider } from "@designbook-ui/models/configState/ConfigStateProvider";
import { createConfigStateFixture } from "@designbook-ui/models/configState/fixtures";
import { ModelCellFrame } from "./ModelCellFrame";

function ConfigStateModelCell() {
  const fixture = useMemo(() => createConfigStateFixture(), []);
  return (
    <ConfigStateProvider
      data={fixture.data}
      setTheme={fixture.setTheme}
      setContext={fixture.setContext}
      setDataset={fixture.setDataset}
      toggleDarkMode={fixture.toggleDarkMode}
    >
      <ModelCellFrame title="Context dimensions" model="models/configState">
        <ul className="space-y-1.5 text-sm">
          {fixture.data.dimensions.map((dimension) => (
            <li key={dimension.id} className="flex items-center justify-between">
              <span className="text-muted-foreground">{dimension.label}</span>
              <span className="font-medium">
                <DimensionValue dimension={dimension} />
              </span>
            </li>
          ))}
        </ul>
      </ModelCellFrame>
    </ConfigStateProvider>
  );
}

export default ConfigStateModelCell;
