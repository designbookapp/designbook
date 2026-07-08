import { CodePanel } from "./CodePanel";

function PanelSection({
  children,
  fill,
  hint,
  title,
}: {
  children: React.ReactNode;
  /** Fill the panel body's height (flex column with min-w-0/min-h-0) so a
   * child editor can own its scrolling, instead of the default
   * content-sized grid. */
  fill?: boolean;
  hint?: string;
  title: string;
}) {
  return (
    <div
      className={
        fill
          ? "flex h-full min-h-0 min-w-0 flex-col gap-3 p-4"
          : "grid content-start gap-3 p-4"
      }
    >
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

export { CodePanel, PanelSection };
