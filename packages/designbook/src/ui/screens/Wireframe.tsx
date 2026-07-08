import { cn } from "@designbook-ui/lib/utils";
import type { WireframeKind } from "@designbook-ui/models/catalog/flowSpec";

function Block({ className }: { className?: string }) {
  return <div className={cn("rounded bg-muted-foreground/15", className)} />;
}

function TextLine({
  children,
  editable,
  width,
}: {
  children?: string;
  editable?: boolean;
  width?: string;
}) {
  if (children) {
    return (
      <span
        className={cn(
          "w-fit truncate text-xs text-muted-foreground",
          editable &&
            "cursor-text rounded-sm outline-1 outline-primary/60 outline-dashed",
        )}
      >
        {children}
      </span>
    );
  }

  return <Block className={cn("h-2", width ?? "w-2/3")} />;
}

function Wireframe({
  kind,
  strings,
  textEditMode,
}: {
  kind: WireframeKind;
  strings: string[];
  textEditMode?: boolean;
}) {
  const [first, second, third] = strings;

  switch (kind) {
    case "hero":
      return (
        <div className="grid gap-2">
          <Block className="h-16 w-full" />
          <TextLine editable={textEditMode}>{first}</TextLine>
          <TextLine editable={textEditMode}>{second}</TextLine>
        </div>
      );
    case "bar":
      return (
        <div className="flex items-center gap-2">
          <TextLine editable={textEditMode}>{first}</TextLine>
          <Block className="h-6 w-16" />
          <Block className="h-6 w-16" />
          <span className="flex-1" />
          <TextLine editable={textEditMode}>{second}</TextLine>
        </div>
      );
    case "cards":
      return (
        <div className="grid gap-2">
          {[0, 1].map((cardIndex) => (
            <div key={cardIndex} className="flex gap-2 rounded border p-2">
              <Block className="h-12 w-16 shrink-0" />
              <div className="grid min-w-0 flex-1 content-start gap-1.5">
                <TextLine editable={textEditMode}>{first}</TextLine>
                <TextLine editable={textEditMode}>{second}</TextLine>
                <TextLine editable={textEditMode}>{third}</TextLine>
              </div>
            </div>
          ))}
        </div>
      );
    case "list":
      return (
        <div className="grid gap-2">
          {strings.map((line) => (
            <div key={line} className="flex items-center gap-2">
              <Block className="size-3 shrink-0 rounded-full" />
              <TextLine editable={textEditMode}>{line}</TextLine>
            </div>
          ))}
        </div>
      );
    case "form":
      return (
        <div className="grid gap-2">
          {strings.map((line) => (
            <div key={line} className="grid gap-1">
              <TextLine editable={textEditMode}>{line}</TextLine>
              <Block className="h-7 w-full" />
            </div>
          ))}
        </div>
      );
    case "summary":
      return (
        <div className="grid gap-2 rounded border p-2">
          {strings.map((line) => (
            <div key={line} className="flex items-center justify-between">
              <TextLine editable={textEditMode}>{line}</TextLine>
              <Block className="h-2 w-10" />
            </div>
          ))}
        </div>
      );
  }
}

export { Wireframe };
