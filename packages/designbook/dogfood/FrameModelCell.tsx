/**
 * Dogfood cell for `models/frame` (R spec item 4). Wraps `FrameProvider` in
 * fixture mode (no live iframe — a representative route) and renders the
 * `FrameRoute` atom, which strips designbook's `?__designbook_frame` route
 * plumbing back off — the same piece the App page's route bar composes.
 */
import { useMemo } from "react";
import { FrameRoute } from "@designbook-ui/models/frame/atoms";
import { FrameProvider } from "@designbook-ui/models/frame/FrameProvider";
import { createFrameFixture } from "@designbook-ui/models/frame/fixtures";
import { ModelCellFrame } from "./ModelCellFrame";

function FrameModelCell() {
  const fixture = useMemo(() => createFrameFixture(), []);
  return (
    <FrameProvider data={fixture.data} open={fixture.open}>
      <ModelCellFrame title="App-page route" model="models/frame">
        <div className="text-sm">
          <span className="text-muted-foreground">route: </span>
          <span className="font-mono font-medium">
            <FrameRoute path={fixture.data.path ?? "/"} />
          </span>
        </div>
      </ModelCellFrame>
    </FrameProvider>
  );
}

export default FrameModelCell;
