import { MessageSquareIcon, XIcon } from "lucide-react";
import { Button } from "@designbook-ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@designbook-ui/components/ui/select";
import { Separator } from "@designbook-ui/components/ui/separator";

const copy = {
  clearSelection: "Clear selection",
  editElement: "Edit element",
  variantLabel: "Variant",
};

function SelectionToolbar({
  label,
  onClear,
  onVariantChange,
  variant,
  variants,
}: {
  label: string;
  onClear: () => void;
  onVariantChange?: (variant: string) => void;
  variant?: string;
  variants?: string[];
}) {
  return (
    <div className="flex w-fit items-center gap-1 rounded-lg border bg-background px-2 py-1 shadow-md">
      <span className="max-w-40 truncate px-1 text-xs font-medium">
        {label}
      </span>
      {variants && variants.length > 0 && variant && onVariantChange ? (
        <>
          <Separator orientation="vertical" className="mx-1 h-4!" />
          <Select value={variant} onValueChange={onVariantChange}>
            <SelectTrigger size="sm" aria-label={copy.variantLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {variants.map((variantOption) => (
                <SelectItem key={variantOption} value={variantOption}>
                  {variantOption}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : null}
      <Button type="button" variant="ghost" size="sm">
        <MessageSquareIcon />
        {copy.editElement}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={copy.clearSelection}
        onClick={onClear}
      >
        <XIcon />
      </Button>
    </div>
  );
}

export { SelectionToolbar };
