/**
 * Inline editor popover for keyed template strings on the design canvas.
 *
 * Opens anchored to a text node rect, loads the raw template (placeholders
 * visible) for the claimed key via the adapter, and renders `{{placeholder}}`
 * tokens as non-editable chips. Saving delegates persistence + optimistic
 * preview to the claim's adapter. Adapter-agnostic: everything it needs comes
 * from the `TextClaim` it is handed.
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { PlaceholderMeta, TextClaim } from "@designbookapp/designbook/config";
import type { OverlayRect } from "./CanvasOverlay";

const copy = {
  cancelButton: "Cancel",
  saveButton: "Save",
  placeholderTrayLabel: "Placeholders",
  singularLabel: "Singular",
  pluralLabel: "Plural",
  saveError: "Failed to save translation",
};

const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];

function parseTemplate(
  template: string,
): Array<{ type: "text" | "placeholder"; value: string }> {
  const parts: Array<{ type: "text" | "placeholder"; value: string }> = [];
  const regex = /\{\{(\w+)\}\}/g;
  let lastIndex = 0;
  let match = regex.exec(template);
  while (match) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        value: template.slice(lastIndex, match.index),
      });
    }
    parts.push({ type: "placeholder", value: match[1] });
    lastIndex = regex.lastIndex;
    match = regex.exec(template);
  }
  if (lastIndex < template.length) {
    parts.push({ type: "text", value: template.slice(lastIndex) });
  }
  return parts;
}

function serializeParts(
  parts: Array<{ type: "text" | "placeholder"; value: string }>,
): string {
  return parts
    .map((p) => (p.type === "placeholder" ? `{{${p.value}}}` : p.value))
    .join("");
}

function getPlaceholderNames(template: string): string[] {
  const names: string[] = [];
  const regex = /\{\{(\w+)\}\}/g;
  let match = regex.exec(template);
  while (match) {
    if (!names.includes(match[1])) {
      names.push(match[1]);
    }
    match = regex.exec(template);
  }
  return names;
}

function TemplateEditor({
  label,
  parts,
  onPartsChange,
  allPlaceholders,
  inputRef,
}: {
  label?: string;
  parts: Array<{ type: "text" | "placeholder"; value: string }>;
  onPartsChange: (
    next: Array<{ type: "text" | "placeholder"; value: string }>,
  ) => void;
  allPlaceholders: PlaceholderMeta[];
  inputRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const editorRef = useRef<HTMLDivElement>(null);

  const combinedRef = (el: HTMLDivElement | null) => {
    (editorRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (inputRef) {
      (inputRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  };

  function readPartsFromDom(): Array<{
    type: "text" | "placeholder";
    value: string;
  }> {
    const el = editorRef.current;
    if (!el) return parts;
    const result: Array<{ type: "text" | "placeholder"; value: string }> = [];
    for (const child of Array.from(el.childNodes)) {
      if (child instanceof HTMLElement && child.dataset.placeholder) {
        result.push({ type: "placeholder", value: child.dataset.placeholder });
      } else if (child.textContent) {
        result.push({ type: "text", value: child.textContent });
      }
    }
    return result;
  }

  function handleInput() {
    onPartsChange(readPartsFromDom());
  }

  const activePlaceholderNames = new Set(
    parts.filter((p) => p.type === "placeholder").map((p) => p.value),
  );
  const removedPlaceholders = allPlaceholders.filter(
    (ph) => !activePlaceholderNames.has(ph.name),
  );

  function insertPlaceholder(name: string) {
    onPartsChange([...parts, { type: "placeholder", value: name }]);
  }

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    el.innerHTML = "";
    for (const part of parts) {
      if (part.type === "placeholder") {
        const chip = document.createElement("span");
        chip.contentEditable = "false";
        chip.dataset.placeholder = part.value;
        chip.className =
          "mx-0.5 inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary select-none";
        chip.textContent = `{{${part.value}}}`;
        el.appendChild(chip);
      } else {
        el.appendChild(document.createTextNode(part.value));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync DOM only on mount
  }, []);

  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      ) : null}
      <div
        ref={combinedRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        className="min-h-8 rounded border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      {removedPlaceholders.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {removedPlaceholders.map((ph) => (
            <button
              key={ph.name}
              type="button"
              onClick={() => insertPlaceholder(ph.name)}
              className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/80"
              title={ph.description ?? ph.example}
            >
              {`+ {{${ph.name}}}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type TextEditPopoverProps = {
  /** The keyed claim being edited (carries templates, plurals, placeholders, save). */
  claim: TextClaim;
  anchorRect: OverlayRect;
  stageTransform: { x: number; y: number; scale: number };
  /** Draft values keyed by full resource key, overriding stored templates (e.g. an inline edit awaiting its plural counterpart). */
  initialValues?: Record<string, string>;
  onClose: () => void;
  onSaveError?: (message: string) => void;
};

function TextEditPopover({
  claim,
  anchorRect,
  stageTransform,
  initialValues,
  onClose,
  onSaveError,
}: TextEditPopoverProps) {
  const resolvedKey = claim.key ?? "";
  const pluralForms = claim.pluralForms ?? [];
  const isPluralKey = pluralForms.length > 0;
  const getTemplate = claim.getTemplate ?? (() => undefined);

  const initialEntries = isPluralKey
    ? pluralForms.map((form) => ({ ...form }))
    : [{ key: resolvedKey, suffix: "", value: "" }];

  for (const entry of initialEntries) {
    const override = initialValues?.[entry.key];
    if (typeof override === "string") {
      entry.value = override;
    } else if (!entry.value) {
      entry.value = getTemplate(entry.key) ?? "";
    }
  }

  const [drafts, setDrafts] = useState(() =>
    initialEntries.map((entry) => ({
      key: entry.key,
      suffix: entry.suffix,
      parts: parseTemplate(entry.value),
      original: entry.value,
    })),
  );

  const baseKey = resolvedKey.replace(
    new RegExp(`(${PLURAL_SUFFIXES.join("|")})$`),
    "",
  );
  const metaPlaceholders = claim.placeholders ?? [];

  const allPlaceholderNames = new Set<string>();
  for (const d of drafts) {
    for (const name of getPlaceholderNames(d.original)) {
      allPlaceholderNames.add(name);
    }
  }
  for (const ph of metaPlaceholders) {
    allPlaceholderNames.add(ph.name);
  }
  const allPlaceholders: PlaceholderMeta[] = Array.from(
    allPlaceholderNames,
  ).map((name) => metaPlaceholders.find((ph) => ph.name === name) ?? { name });

  const firstInputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      firstInputRef.current?.focus();
    });
  }, []);

  function updateDraft(
    index: number,
    parts: Array<{ type: "text" | "placeholder"; value: string }>,
  ) {
    setDrafts((current) =>
      current.map((d, i) => (i === index ? { ...d, parts } : d)),
    );
  }

  async function save() {
    const entries = drafts.map((d) => ({
      key: d.key,
      value: serializeParts(d.parts),
    }));

    try {
      if (claim.saveEntries) {
        await claim.saveEntries(entries);
      } else if (entries.length === 1) {
        await claim.save(entries[0].value);
      }
    } catch (error) {
      onSaveError?.(error instanceof Error ? error.message : copy.saveError);
    }

    onClose();
  }

  function cancel() {
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  const popoverLeft = anchorRect.x * stageTransform.scale + stageTransform.x;
  const popoverTop =
    (anchorRect.y + anchorRect.height) * stageTransform.scale +
    stageTransform.y +
    8;

  const pluralLabels: Record<string, string> = {
    _one: copy.singularLabel,
    _other: copy.pluralLabel,
    _zero: "Zero",
    _two: "Two",
    _few: "Few",
    _many: "Many",
  };

  return (
    <div
      className="bg-popover absolute z-50 w-80 rounded-lg border p-3 shadow-lg"
      style={{ left: popoverLeft, top: popoverTop }}
      onKeyDown={handleKeyDown}
    >
      <div className="flex flex-col gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {baseKey}
        </span>
        {drafts.map((draft, index) => (
          <TemplateEditor
            key={draft.key}
            label={
              isPluralKey
                ? (pluralLabels[draft.suffix] ?? draft.suffix)
                : undefined
            }
            parts={draft.parts}
            onPartsChange={(next) => updateDraft(index, next)}
            allPlaceholders={allPlaceholders}
            inputRef={index === 0 ? firstInputRef : undefined}
          />
        ))}
        {allPlaceholders.length > 0 ? (
          <div className="border-t pt-2">
            <span className="text-xs font-medium text-muted-foreground">
              {copy.placeholderTrayLabel}
            </span>
            <div className="mt-1 flex flex-wrap gap-1">
              {allPlaceholders.map((ph) => (
                <span
                  key={ph.name}
                  className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                  title={
                    [ph.description, ph.example ? `e.g. ${ph.example}` : ""]
                      .filter(Boolean)
                      .join(" — ") || undefined
                  }
                >
                  {`{{${ph.name}}}`}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex justify-end gap-2 border-t pt-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {copy.cancelButton}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
          >
            {copy.saveButton}
          </button>
        </div>
      </div>
    </div>
  );
}

export { TextEditPopover };
export type { TextEditPopoverProps };
