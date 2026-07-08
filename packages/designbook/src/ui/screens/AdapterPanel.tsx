/**
 * Renders an adapter-contributed tab: resolves the tab's editable fields for
 * the active context and lists them with shadcn controls. Edits are optimistic
 * — the control updates immediately and the adapter's `save` re-renders the
 * canvas preview — then confirmed by re-fetching the fields, or rolled back
 * with an inline error on failure.
 */

import { useEffect, useRef, useState } from "react";
import type {
  AdapterTab,
  AdapterTabAction,
  EditableField,
} from "@designbookapp/designbook/config";
import { useConfigStateModel } from "@designbook-ui/models/configState/ConfigStateProvider";
import {
  formatOklch,
  hexToRgb,
  oklchToHex,
  parseOklch,
  rgbToHex,
  rgbToOklch,
} from "@designbookapp/designbook/config";
import { Button } from "@designbook-ui/components/ui/button";
import { Input } from "@designbook-ui/components/ui/input";
import { Label } from "@designbook-ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@designbook-ui/components/ui/select";
import { Toggle } from "@designbook-ui/components/ui/toggle";
import { PanelSection } from "./panels";

const copy = {
  loading: "Loading…",
  empty: "No editable fields for the current context.",
  saveError: "Couldn't save that change.",
  on: "On",
  off: "Off",
};

const ACTION_ENABLED_POLL_MS = 3000;

function AdapterPanel({ tab }: { tab: AdapterTab }) {
  const { context } = useConfigStateModel();
  const [fields, setFields] = useState<EditableField[] | null>(null);
  const [overrides, setOverrides] = useState<
    Record<string, string | boolean>
  >({});
  const [error, setError] = useState<string | null>(null);

  // Re-fetch fields when the tab or the active context changes (e.g. a tenant
  // switch): the resolved values are context-scoped.
  useEffect(() => {
    let active = true;
    setFields(null);
    setOverrides({});
    setError(null);
    Promise.resolve(tab.fields(context)).then((resolved) => {
      if (active) setFields(resolved);
    });
    return () => {
      active = false;
    };
  }, [tab, context]);

  async function commit(field: EditableField, next: string | boolean) {
    setOverrides((current) => ({ ...current, [field.id]: next }));
    setError(null);
    try {
      await field.save(next);
      const resolved = await Promise.resolve(tab.fields(context));
      setFields(resolved);
      setOverrides((current) => {
        const { [field.id]: _dropped, ...rest } = current;
        return rest;
      });
    } catch (caught) {
      // Roll the control back to the last confirmed value.
      setOverrides((current) => {
        const { [field.id]: _dropped, ...rest } = current;
        return rest;
      });
      setError(caught instanceof Error ? caught.message : copy.saveError);
    }
  }

  if (fields === null) {
    return (
      <PanelSection title={tab.label}>
        <p className="text-xs text-muted-foreground">{copy.loading}</p>
      </PanelSection>
    );
  }

  return (
    <PanelSection title={tab.label}>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        <div className="grid gap-3">
          {fields.map((field) => {
            const value = overrides[field.id] ?? field.value;
            return (
              <FieldControl
                key={field.id}
                field={field}
                value={value}
                onCommit={(next) => void commit(field, next)}
              />
            );
          })}
        </div>
      )}
      {tab.actions && tab.actions.length > 0 ? (
        <TabActions actions={tab.actions} />
      ) : null}
    </PanelSection>
  );
}

/** Renders an adapter tab's action buttons, polling `isEnabled` to gate them. */
function TabActions({ actions }: { actions: AdapterTabAction[] }) {
  return (
    <div className="mt-3 grid gap-2 border-t pt-3">
      {actions.map((action) => (
        <ActionButton key={action.id} action={action} />
      ))}
    </div>
  );
}

function ActionButton({ action }: { action: AdapterTabAction }) {
  const [enabled, setEnabled] = useState<boolean>(!action.isEnabled);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!action.isEnabled) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await action.isEnabled!();
        if (active) setEnabled(next);
      } catch {
        if (active) setEnabled(false);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), ACTION_ENABLED_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [action]);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await action.run());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.saveError);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!enabled || running}
        onClick={() => void run()}
      >
        {running ? `${action.label}…` : action.label}
      </Button>
      {action.description ? (
        <p className="text-[11px] text-muted-foreground">
          {action.description}
        </p>
      ) : null}
      {result ? (
        <p className="text-[11px] text-muted-foreground" role="status">
          {result}
        </p>
      ) : null}
      {error ? (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function FieldControl({
  field,
  value,
  onCommit,
}: {
  field: EditableField;
  value: string | boolean;
  onCommit: (next: string | boolean) => void;
}) {
  if (field.control === "toggle") {
    const pressed = Boolean(value);
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border p-2">
        <span className="min-w-0 flex-1 truncate text-xs">{field.label}</span>
        <Toggle
          size="sm"
          variant="outline"
          pressed={pressed}
          aria-label={field.label}
          onPressedChange={(next) => onCommit(next)}
          className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {pressed ? copy.on : copy.off}
        </Toggle>
      </div>
    );
  }

  if (field.control === "select") {
    return (
      <div className="grid gap-1.5">
        <Label className="text-xs">{field.label}</Label>
        <Select value={String(value)} onValueChange={(next) => onCommit(next)}>
          <SelectTrigger size="sm" aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.control === "color") {
    return (
      <ColorFieldControl
        field={field}
        value={String(value)}
        onCommit={onCommit}
      />
    );
  }

  // text | number — live-commit while typing (debounced), immediate on
  // blur/Enter.
  return (
    <TextFieldControl field={field} value={String(value)} onCommit={onCommit} />
  );
}

/** Debounce window for live commits while typing / dragging a picker. */
const COMMIT_DEBOUNCE_MS = 400;

/**
 * Commit plumbing shared by the token controls: `queue` schedules a debounced
 * commit (skipping values `isValid` rejects — a half-typed `oklch(0.5` never
 * hits the stylesheet), `flush` commits immediately (blur/Enter — explicit
 * intent commits even "invalid" values, matching the old blur behavior).
 * Inputs stay UNCONTROLLED so live commits never remount the input under the
 * user's cursor (or under an open native color picker); `syncWhenIdle` writes
 * externally-changed values into the input only while it is not focused.
 */
function useDebouncedCommit(value: string, onCommit: (next: string) => void) {
  const timer = useRef<number | undefined>(undefined);
  const lastSent = useRef(value);

  useEffect(() => {
    lastSent.current = value;
  }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function flush(next: string) {
    window.clearTimeout(timer.current);
    if (next === lastSent.current) return;
    lastSent.current = next;
    onCommit(next);
  }

  function queue(next: string, isValid: boolean) {
    window.clearTimeout(timer.current);
    if (!isValid) return;
    timer.current = window.setTimeout(() => flush(next), COMMIT_DEBOUNCE_MS);
  }

  function syncWhenIdle(el: HTMLInputElement | null, next: string) {
    if (el && document.activeElement !== el) el.value = next;
  }

  return { flush, queue, syncWhenIdle };
}

/** Is this a value the browser would accept for a color property? */
function isCommittableColor(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return true;
  }
  return CSS.supports("color", trimmed);
}

function TextFieldControl({
  field,
  value,
  onCommit,
}: {
  field: EditableField;
  value: string;
  onCommit: (next: string | boolean) => void;
}) {
  const type = field.control === "number" ? "number" : "text";
  const inputRef = useRef<HTMLInputElement>(null);
  const { flush, queue, syncWhenIdle } = useDebouncedCommit(value, onCommit);

  useEffect(() => {
    syncWhenIdle(inputRef.current, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function isValid(next: string): boolean {
    if (type === "number") {
      return next.trim() !== "" && !Number.isNaN(Number(next));
    }
    return next.trim() !== "";
  }

  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{field.label}</Label>
      <Input
        ref={inputRef}
        type={type}
        defaultValue={value}
        aria-label={field.label}
        onChange={(event) => {
          const next = event.currentTarget.value;
          queue(next, isValid(next));
        }}
        onBlur={(event) => flush(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") flush(event.currentTarget.value);
        }}
      />
    </div>
  );
}

/**
 * Color control that understands OKLCH (and hex). The native swatch needs a
 * `#rrggbb`, so an oklch token is converted for display and — on pick —
 * converted back to `oklch(...)` (preserving the original alpha) so the source
 * stylesheet stays in oklch. Hex tokens keep hex round-tripping. A companion
 * text field always exposes the exact CSS value for precise edits.
 */
function ColorFieldControl({
  field,
  value,
  onCommit,
}: {
  field: EditableField;
  value: string;
  onCommit: (next: string | boolean) => void;
}) {
  const oklch = parseOklch(value);
  const isHex = !oklch && value.trim().startsWith("#");
  const hexValue = isHex ? hexToRgb(value) : null;
  const swatchHex = oklch
    ? oklchToHex(oklch)
    : hexValue
      ? rgbToHex(hexValue)
      : "#000000";
  const canSwatch = oklch !== null || hexValue !== null;

  const textRef = useRef<HTMLInputElement>(null);
  const swatchRef = useRef<HTMLInputElement>(null);
  const { flush, queue, syncWhenIdle } = useDebouncedCommit(value, onCommit);

  useEffect(() => {
    syncWhenIdle(textRef.current, value);
    syncWhenIdle(swatchRef.current, swatchHex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, swatchHex]);

  /** Picker hex → the committed CSS value (oklch tokens stay oklch). */
  function pickedValue(hex: string): string | undefined {
    if (oklch) {
      const rgb = hexToRgb(hex);
      if (!rgb) return undefined;
      const next = rgbToOklch(rgb);
      next.a = oklch.a; // preserve the token's original alpha
      return formatOklch(next);
    }
    return hex;
  }

  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{field.label}</Label>
      <div className="flex items-center gap-2">
        {canSwatch ? (
          <input
            ref={swatchRef}
            type="color"
            defaultValue={swatchHex}
            aria-label={field.label}
            className="h-8 w-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
            onChange={(event) => {
              const next = pickedValue(event.currentTarget.value);
              if (next) queue(next, true);
            }}
            onBlur={(event) => {
              const next = pickedValue(event.currentTarget.value);
              if (next) flush(next);
            }}
          />
        ) : null}
        <Input
          ref={textRef}
          type="text"
          defaultValue={value}
          aria-label={`${field.label} value`}
          className="flex-1"
          onChange={(event) => {
            const next = event.currentTarget.value;
            queue(next, isCommittableColor(next));
          }}
          onBlur={(event) => flush(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") flush(event.currentTarget.value);
          }}
        />
      </div>
    </div>
  );
}

export { AdapterPanel };
