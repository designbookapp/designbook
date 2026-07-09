import {
  FileDiffIcon,
  FilesIcon,
  FlagIcon,
  PaletteIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@designbook-ui/components/ui/button";
import { cn } from "@designbook-ui/lib/utils";

/** A tab id — base tabs are fixed strings; integration tabs use the plugin
 * name; adapter tabs use namespaced ids. */
type PanelTab = string;

type RailTab = { id: string; label: string; icon?: string };

/** A left-rail tab contributed by an integration plugin (icon component). */
type IntegrationRailTab = { id: string; label: string; Icon?: ComponentType };

const copy = {
  changes: "Changes",
  files: "Files",
  railLabel: "Workbench panels",
};

// Chat / props / code live in the right-hand panel (see RightPanel.tsx); the
// rail hosts only the catalog-ish left tabs plus integration-plugin tabs
// (e.g. Figma) and adapter-contributed ones.
const baseItems: Array<{ tab: PanelTab; label: string; icon: LucideIcon }> = [
  { tab: "files", label: copy.files, icon: FilesIcon },
  { tab: "changes", label: copy.changes, icon: FileDiffIcon },
];

/** Maps an adapter tab's icon name to a lucide icon (default: sliders). */
const iconByName: Record<string, LucideIcon> = {
  palette: PaletteIcon,
  flag: FlagIcon,
  sliders: SlidersHorizontalIcon,
};

function iconFor(name?: string): LucideIcon {
  return (name && iconByName[name]) || SlidersHorizontalIcon;
}

function SideRail({
  activeTab,
  onSelectTab,
  integrationTabs = [],
  adapterTabs = [],
}: {
  activeTab: PanelTab;
  onSelectTab: (tab: PanelTab) => void;
  /** Tabs contributed by integration plugins (rendered after the base set). */
  integrationTabs?: IntegrationRailTab[];
  adapterTabs?: RailTab[];
}) {
  const items = [
    ...baseItems,
    ...integrationTabs.map((tab) => ({
      tab: tab.id,
      label: tab.label,
      icon: (tab.Icon ?? PlugIcon) as LucideIcon,
    })),
    ...adapterTabs.map((tab) => ({
      tab: tab.id,
      label: tab.label,
      icon: iconFor(tab.icon),
    })),
  ];

  return (
    <nav
      aria-label={copy.railLabel}
      className="flex flex-col items-center gap-1 border-r bg-muted/40 p-2"
    >
      {items.map(({ tab, label, icon: Icon }) => (
        <Button
          key={tab}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={activeTab === tab}
          title={label}
          onClick={() => onSelectTab(tab)}
          className={cn(
            activeTab === tab &&
              "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
          )}
        >
          <Icon />
        </Button>
      ))}
    </nav>
  );
}

export { SideRail };
export type { IntegrationRailTab, PanelTab, RailTab };
