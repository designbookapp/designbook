import {
  Component,
  Fragment,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { LayoutGridIcon, RowsIcon, TypeIcon } from "lucide-react";
import { Badge } from "@designbook-ui/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@designbook-ui/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@designbook-ui/components/ui/toggle-group";
import { useStageTransform } from "./stageContext";
import { cn } from "@designbook-ui/lib/utils";
import { ChangedFileBadge } from "@designbook-ui/models/branch/atoms";
import { PreviewCell } from "./PreviewCell";
import { Wireframe } from "./Wireframe";
import type { MatrixAxis } from "@designbook-ui/models/catalog/componentRegistry";
import { useCatalogModel } from "@designbook-ui/models/catalog/CatalogProvider";
import type { CanvasTool } from "./CanvasToolbar";
import type { FlowScreen } from "@designbook-ui/models/catalog/flowSpec";

const copy = {
  controlsLabel: "Canvas controls",
  datasetLabel: "Dataset",
  matrixLayout: "All variations grid",
  previewUnavailable:
    "This variant needs app context and can't be previewed from static data yet.",
  resizeHandleLabel: "Resize preview",
  singleLayout: "Single variant",
  textModeHint: "Content edit mode — highlighted strings come from i18n files.",
};

class PreviewBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          {copy.previewUnavailable}
        </div>
      );
    }
    return this.props.children;
  }
}

function combinations(axes: MatrixAxis[]): string[][] {
  return axes.reduce<string[][]>(
    (acc, axis) =>
      acc.flatMap((combo) => axis.values.map((v) => [...combo, v])),
    [[]],
  );
}

function MockButton({
  size,
  state,
  variant,
}: {
  size: string;
  state: string;
  variant: string;
}) {
  const primary = variant === "default";
  const small = size === "sm";

  const buttonCopy = { label: "Button" };

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-wide uppercase",
        small ? "h-6 px-2.5 text-[9px]" : "h-9 px-5 text-[11px]",
        primary
          ? "bg-blue-600 text-white"
          : "border border-foreground/60 text-foreground",
        state === "Disabled" && "pointer-events-none opacity-35",
      )}
    >
      {buttonCopy.label}
    </span>
  );
}

function MatrixView({ axes }: { axes: MatrixAxis[] }) {
  const [columnAxis, ...rowAxes] = axes;
  const columnCombos = combinations([columnAxis]);
  const rowCombos = combinations(rowAxes);

  return (
    <div className="overflow-x-auto rounded-xl border bg-background p-6 shadow-sm">
      <div
        className="grid items-center gap-x-8 gap-y-4"
        style={{
          gridTemplateColumns: `repeat(${rowAxes.length}, max-content) repeat(${columnCombos.length}, max-content)`,
        }}
      >
        {rowAxes.map((axis) => (
          <span key={axis.name} />
        ))}
        {columnCombos.map((combo) => (
          <span
            key={combo.join("-")}
            className="text-xs font-medium text-muted-foreground"
          >
            {combo.join(" · ")}
          </span>
        ))}
        {rowCombos.map((rowCombo, rowIndex) => (
          <Fragment key={rowCombo.join("-")}>
            {rowCombo.map((value, axisIndex) => {
              const previous = rowCombos[rowIndex - 1];
              const repeated = previous?.[axisIndex] === value;
              return (
                <span
                  key={`${rowAxes[axisIndex].name}-${value}`}
                  className={cn(
                    "text-xs font-medium text-muted-foreground",
                    repeated && "opacity-0",
                  )}
                >
                  {value}
                </span>
              );
            })}
            {columnCombos.map((columnCombo) => (
              <MockButton
                key={columnCombo.join("-")}
                variant={columnCombo[0]}
                size={rowCombo[0] ?? "default"}
                state={rowCombo[1] ?? "Default"}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function EntryPreview({ entryId }: { entryId: string }) {
  const entry = useCatalogModel().getEntry(entryId);
  if (!entry) return null;
  // PreviewCell owns the data-db-entry serializer root, LightDomSlot isolation,
  // lazy loading (Suspense), and the per-cell red error boundary (C4.1).
  return <PreviewCell entry={entry} />;
}

function NodePreview({
  screen,
  textEditMode,
}: {
  screen: FlowScreen;
  textEditMode: boolean;
}) {
  const { getEntry } = useCatalogModel();
  if (screen.previews) {
    return (
      <>
        {screen.previews.map((preview, index) => {
          if (preview.rendererId) {
            return (
              <PreviewBoundary key={preview.rendererId}>
                <EntryPreview entryId={preview.rendererId} />
              </PreviewBoundary>
            );
          }

          if (preview.wireframeKind) {
            return (
              <Wireframe
                key={`${preview.wireframeKind}-${index}`}
                kind={preview.wireframeKind}
                strings={preview.wireframeStrings ?? []}
                textEditMode={textEditMode}
              />
            );
          }

          return null;
        })}
      </>
    );
  }

  const entry = getEntry(screen.registryId ?? screen.id);

  if (entry) {
    return (
      <PreviewBoundary key={entry.id}>
        <EntryPreview entryId={entry.id} />
      </PreviewBoundary>
    );
  }

  if (screen.wireframeKind) {
    return (
      <Wireframe
        kind={screen.wireframeKind}
        strings={screen.wireframeStrings ?? []}
        textEditMode={textEditMode}
      />
    );
  }

  return null;
}

type DetailLayout = "single" | "matrix";

function NodeDetailHeader({
  layout,
  nodePath,
  onLayoutChange,
  textEditMode,
}: {
  layout: DetailLayout | undefined;
  nodePath: FlowScreen[];
  onLayoutChange: (nodeId: string, layout: DetailLayout) => void;
  textEditMode: boolean;
}) {
  const { getEntry } = useCatalogModel();
  const screen = nodePath[nodePath.length - 1];
  const entry = screen.registryId ? getEntry(screen.registryId) : undefined;
  const resolvedLayout = layout ?? (entry?.matrixAxes ? "matrix" : "single");
  const showControls = Boolean(entry?.matrixAxes);

  if (!showControls && !textEditMode) return null;

  return (
    <div className="absolute top-16 left-3 z-10 grid justify-items-start gap-2">
      {showControls ? (
        <nav
          aria-label={copy.controlsLabel}
          className="flex items-center gap-1 rounded-lg border bg-background p-1 shadow-md"
        >
          {entry?.matrixAxes ? (
            <ToggleGroup
              type="single"
              value={resolvedLayout}
              onValueChange={(value) => {
                if (value === "single" || value === "matrix") {
                  onLayoutChange(screen.id, value);
                }
              }}
              spacing={1}
            >
              <ToggleGroupItem
                value="single"
                size="sm"
                aria-label={copy.singleLayout}
                title={copy.singleLayout}
              >
                <RowsIcon />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="matrix"
                size="sm"
                aria-label={copy.matrixLayout}
                title={copy.matrixLayout}
              >
                <LayoutGridIcon />
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
        </nav>
      ) : null}
      {textEditMode ? (
        <Badge variant="secondary">
          <TypeIcon data-icon="inline-start" />
          {copy.textModeHint}
        </Badge>
      ) : null}
    </div>
  );
}

const PREVIEW_WIDTH_STORAGE_PREFIX = "design.previewWidth.";
const MIN_PREVIEW_WIDTH = 320;

function ResizablePreview({
  children,
  configWidth,
  screenId,
}: {
  children: ReactNode;
  configWidth: number | undefined;
  screenId: string;
}) {
  const transform = useStageTransform();
  const containerRef = useRef<HTMLDivElement>(null);
  const storageKey = `${PREVIEW_WIDTH_STORAGE_PREFIX}${screenId}`;
  const [width, setWidth] = useState<number | undefined>(() => {
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? parsed : configWidth;
  });
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startWidth: number;
  }>(undefined);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: containerRef.current?.offsetWidth ?? MIN_PREVIEW_WIDTH,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = (event.clientX - drag.startClientX) / transform.scale;
    setWidth(Math.max(MIN_PREVIEW_WIDTH, Math.round(drag.startWidth + delta)));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const finalWidth = containerRef.current?.offsetWidth;
    if (finalWidth) {
      window.localStorage.setItem(storageKey, String(Math.round(finalWidth)));
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      style={width === undefined ? undefined : { width }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={copy.resizeHandleLabel}
        title={copy.resizeHandleLabel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="absolute top-1/2 -right-4 h-16 w-1.5 -translate-y-1/2 cursor-ew-resize touch-none rounded-full bg-border hover:bg-primary active:bg-primary"
      />
    </div>
  );
}

type DatasetOption = { id: string; label: string };

function NodeDetailView({
  datasetId,
  datasets,
  layout,
  nodePath,
  onDatasetChange,
  themeClassName,
  tool,
}: {
  datasetId: string;
  datasets: DatasetOption[];
  layout: DetailLayout | undefined;
  nodePath: FlowScreen[];
  onDatasetChange: (datasetId: string) => void;
  themeClassName?: string;
  tool: CanvasTool;
}) {
  const { getEntry } = useCatalogModel();
  const screen = nodePath[nodePath.length - 1];
  const textEditMode = tool === "text";
  const entry = screen.registryId ? getEntry(screen.registryId) : undefined;
  const resolvedLayout = layout ?? (entry?.matrixAxes ? "matrix" : "single");
  const matrix = Boolean(entry?.matrixAxes) && resolvedLayout === "matrix";

  return (
    <div className="grid content-start justify-items-start gap-1.5">
      <div className="flex w-full items-center justify-between gap-6">
        <span className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground select-none">
            {screen.label}
          </span>
          <ChangedFileBadge sourcePath={entry?.sourcePath} />
        </span>
        <div className="flex items-center gap-4">
          {/* Figma sync moved to the left-rail Figma tab (FigmaPanel) — the
              on-canvas header keeps only the dataset selector. */}
          <Select value={datasetId} onValueChange={onDatasetChange}>
            <SelectTrigger
              size="sm"
              aria-label={copy.datasetLabel}
              className="h-auto gap-1 rounded-none border-0 bg-transparent p-0 text-xs font-medium text-primary underline-offset-2 shadow-none hover:underline"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {datasets.map((datasetOption) => (
                <SelectItem key={datasetOption.id} value={datasetOption.id}>
                  {datasetOption.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {matrix && entry?.matrixAxes ? (
        <div className={themeClassName}>
          <MatrixView axes={entry.matrixAxes} />
        </div>
      ) : (
        <ResizablePreview
          screenId={screen.id}
          configWidth={entry?.previewWidth}
        >
          <div
            className={cn(
              "grid w-full place-items-center bg-background p-6 shadow-md",
              themeClassName,
            )}
          >
            <div className="w-full">
              <NodePreview screen={screen} textEditMode={textEditMode} />
            </div>
          </div>
        </ResizablePreview>
      )}
    </div>
  );
}

export { NodeDetailHeader, NodeDetailView, NodePreview };
export type { DetailLayout };
