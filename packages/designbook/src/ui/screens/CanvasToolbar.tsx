import { MousePointer2Icon, TypeIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@designbook-ui/components/ui/toggle-group";
import type { ViewportSize } from "@designbook-ui/models/catalog/viewports";

type CanvasTool = "preview" | "select" | "text";

const copy = {
  selectTool: "Select components",
  textTool: "Edit text content",
  toolbarLabel: "Canvas tools",
};

function CanvasToolbar({
  onToolChange,
  tool,
}: {
  onToolChange: (tool: CanvasTool) => void;
  tool: CanvasTool;
}) {
  return (
    <div
      role="toolbar"
      aria-label={copy.toolbarLabel}
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-2 py-1.5 shadow-lg"
    >
      <ToggleGroup
        type="single"
        value={tool === "preview" ? "" : tool}
        onValueChange={(value) => {
          if (value === "select" || value === "text") {
            onToolChange(value);
          } else {
            onToolChange("preview");
          }
        }}
        spacing={1}
      >
        <ToggleGroupItem
          value="select"
          size="sm"
          aria-label={copy.selectTool}
          title={copy.selectTool}
          className="rounded-full"
        >
          <MousePointer2Icon />
        </ToggleGroupItem>
        <ToggleGroupItem
          value="text"
          size="sm"
          aria-label={copy.textTool}
          title={copy.textTool}
          className="rounded-full"
        >
          <TypeIcon />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export { CanvasToolbar };
export type { CanvasTool, ViewportSize };
