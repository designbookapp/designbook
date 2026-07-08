import { cn } from "@designbook-ui/lib/utils";
import { ChangedFileBadge } from "@designbook-ui/models/branch/atoms";
import { NodePreview } from "./NodeDetailView";
import { SelectionToolbar } from "@designbook-ui/components/SelectionToolbar";
import type { FlowScreen } from "@designbook-ui/models/catalog/flowSpec";
import { useCatalogModel } from "@designbook-ui/models/catalog/CatalogProvider";
import type { ViewportSize } from "@designbook-ui/models/catalog/viewports";

function FlowFrame({
  onOpen,
  onSelect,
  screen,
  selected,
  sourcePath,
  themeClassName,
  viewport,
}: {
  onOpen: () => void;
  onSelect: () => void;
  screen: FlowScreen;
  selected: boolean;
  /** The entry's source file — drives the "Edited" change badge. */
  sourcePath?: string;
  themeClassName?: string;
  viewport: ViewportSize;
}) {
  return (
    <div
      className="grid content-start gap-1.5"
      style={{ width: viewport.width }}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "w-fit cursor-default text-xs font-medium select-none",
            selected ? "text-primary" : "text-muted-foreground",
          )}
          onClick={onSelect}
          onDoubleClick={onOpen}
        >
          {screen.label}
        </span>
        <ChangedFileBadge sourcePath={sourcePath} />
      </span>
      <div
        role="button"
        tabIndex={0}
        aria-label={screen.label}
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onOpen();
          }
          if (event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "relative cursor-pointer bg-background shadow-md transition-shadow focus-visible:outline-none",
          themeClassName,
          selected
            ? "ring-2 ring-primary"
            : "hover:ring-1 hover:ring-primary/40",
        )}
      >
        <div className="pointer-events-none grid gap-6 p-6" aria-hidden>
          <NodePreview screen={screen} textEditMode={false} />
        </div>
      </div>
    </div>
  );
}

function FlowCanvas({
  onOpenScreen,
  onSelectScreen,
  screens,
  selectedScreenId,
  themeClassName,
  viewport,
}: {
  onOpenScreen: (screenId: string) => void;
  onSelectScreen: (screenId: string | undefined) => void;
  screens: FlowScreen[];
  selectedScreenId: string | undefined;
  themeClassName?: string;
  viewport: ViewportSize;
}) {
  const { getEntry, getSetEntries } = useCatalogModel();
  return (
    <div className="flex items-start gap-24">
      {screens.map((screen) => {
        const selected = selectedScreenId === screen.id;
        const entry = screen.registryId
          ? getEntry(screen.registryId)
          : undefined;

        return (
          <div key={screen.id} className="grid justify-items-start gap-3">
            <FlowFrame
              screen={screen}
              selected={selected}
              sourcePath={entry?.sourcePath}
              themeClassName={themeClassName}
              viewport={viewport}
              onSelect={() => onSelectScreen(screen.id)}
              onOpen={() => onOpenScreen(screen.id)}
            />
            {selected ? (
              <SelectionToolbar
                label={screen.label}
                variant={entry?.name}
                variants={
                  entry
                    ? getSetEntries(entry.setId).map((sibling) => sibling.name)
                    : undefined
                }
                onClear={() => onSelectScreen(undefined)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export { FlowCanvas };
