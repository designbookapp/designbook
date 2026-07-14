import React from "react";

import { Island } from "../../packages/excalidraw/components/Island";
import { ButtonIcon } from "../../packages/excalidraw/components/ButtonIcon";
import {
  ExportIcon,
  TrashIcon,
  DuplicateIcon,
} from "../../packages/excalidraw/components/icons";

export default function IslandCell() {
  return (
    <Island padding={2}>
      <div
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minWidth: 160,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>Shape properties</div>
        <div style={{ display: "flex", gap: 4 }}>
          <ButtonIcon icon={DuplicateIcon} title="Duplicate" onClick={() => {}} standalone />
          <ButtonIcon icon={ExportIcon} title="Export" onClick={() => {}} standalone />
          <ButtonIcon icon={TrashIcon} title="Delete" onClick={() => {}} standalone />
        </div>
      </div>
    </Island>
  );
}
