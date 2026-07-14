import React from "react";

import { Card } from "../../packages/excalidraw/components/Card";
import { FilledButton } from "../../packages/excalidraw/components/FilledButton";
import { ExportIcon } from "../../packages/excalidraw/components/icons";

// Mirrors the real usage in JSONExportDialog.tsx (icon + h2 + details + button)
// so the styled .Card-icon / .Card-details / .Card-button slots are exercised.
export default function CardCell() {
  return (
    <Card color="primary">
      <div className="Card-icon">{ExportIcon}</div>
      <h2>Save to disk</h2>
      <div className="Card-details">
        Export the scene data to a file from which you can import later.
      </div>
      <FilledButton className="Card-button" label="Export to file" onClick={() => {}} />
    </Card>
  );
}
