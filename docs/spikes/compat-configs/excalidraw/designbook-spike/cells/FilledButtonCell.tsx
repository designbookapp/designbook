import React from "react";

import { FilledButton } from "../../packages/excalidraw/components/FilledButton";
import { ExportIcon } from "../../packages/excalidraw/components/icons";

export default function FilledButtonCell() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <FilledButton label="Save" color="primary" onClick={() => {}} />
      <FilledButton
        label="Delete"
        color="danger"
        variant="outlined"
        onClick={() => {}}
      />
      <FilledButton
        label="Export"
        icon={ExportIcon}
        variant="icon"
        onClick={() => {}}
      />
    </div>
  );
}
