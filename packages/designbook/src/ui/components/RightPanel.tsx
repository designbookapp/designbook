/**
 * The right-hand workbench panel: horizontal tabs (Chat / Props / Code) over a
 * scrollable body, with a collapse toggle that shrinks the panel to a slim
 * rail, and a drag handle on the left (inner) edge for resizing. Pure chrome —
 * the active tab, collapse state, width, and panel content are owned by the
 * Workbench (screens layer), mirroring how SideRail works. A collapsed panel
 * ignores its width (the slim rail is fixed) but keeps it for the next expand.
 */

import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "@designbook-ui/components/ui/button";
import { PanelResizeHandle } from "@designbook-ui/components/PanelResizeHandle";
import { cn } from "@designbook-ui/lib/utils";
import {
  RIGHT_PANEL_TABS,
  type RightPanelTab,
} from "@designbook-ui/workbenchTabs";

const copy = {
  chat: "Chat",
  code: "Code",
  collapse: "Collapse panel",
  expand: "Expand panel",
  props: "Props",
  tabsLabel: "Selection panels",
};

const tabLabels: Record<RightPanelTab, string> = {
  chat: copy.chat,
  props: copy.props,
  code: copy.code,
};

function RightPanel({
  activeTab,
  children,
  collapsed,
  onResizingChange,
  onSelectTab,
  onToggleCollapsed,
  onWidthChange,
  width,
}: {
  activeTab: RightPanelTab;
  children: ReactNode;
  collapsed: boolean;
  /** Resize drag started/ended (canvas pointer-events guard). */
  onResizingChange: (resizing: boolean) => void;
  onSelectTab: (tab: RightPanelTab) => void;
  onToggleCollapsed: () => void;
  onWidthChange: (width: number) => void;
  /** Panel width in px; ignored while collapsed. */
  width: number;
}) {
  if (collapsed) {
    return (
      <aside className="flex shrink-0 flex-col items-center border-l bg-muted/40 p-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copy.expand}
          title={copy.expand}
          onClick={onToggleCollapsed}
        >
          <PanelRightOpenIcon />
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l"
      style={{ width }}
    >
      <PanelResizeHandle
        edge="left"
        width={width}
        onWidthChange={onWidthChange}
        onResizingChange={onResizingChange}
      />
      <div className="flex items-center gap-1 border-b p-2">
        <nav
          aria-label={copy.tabsLabel}
          className="flex flex-1 items-center gap-1"
        >
          {RIGHT_PANEL_TABS.map((tab) => (
            <Button
              key={tab}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={activeTab === tab}
              onClick={() => onSelectTab(tab)}
              className={cn(
                activeTab === tab &&
                  "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
            >
              {tabLabels[tab]}
            </Button>
          ))}
        </nav>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copy.collapse}
          title={copy.collapse}
          onClick={onToggleCollapsed}
        >
          <PanelRightCloseIcon />
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

export { RightPanel };
