/**
 * Small self-contained UI atoms for the full-view prototype: a click-to-open
 * dropdown and a toggle switch. Kept local (not the shadcn primitives) so the
 * prototype's dark chrome is fully self-styled and portable across mounts.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

interface DropdownOption {
  id: string;
  label: string;
  sub?: string;
  /** Right-aligned badge/extra on the row (e.g. "current", agent status). */
  extra?: ReactNode;
}

export function Dropdown({
  label,
  prefix,
  options,
  value,
  onSelect,
  align = "left",
  mono = false,
  disabled = false,
  footer,
}: {
  label: string;
  prefix?: string;
  options: DropdownOption[];
  value: string;
  onSelect: (id: string) => void;
  align?: "left" | "right";
  /** Monospace trigger label (branch names). */
  mono?: boolean;
  disabled?: boolean;
  /** Extra content pinned under the option list (e.g. new-branch form). */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      // composedPath, not e.target: at the document level a shadow-DOM event
      // is retargeted to the overlay HOST, so `contains` would close the menu
      // on EVERY mousedown — item clicks included (live-run finding).
      if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="dbproto-dd" ref={ref}>
      <button
        className="dbproto-dd-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      >
        {prefix ? <span className="lbl-muted">{prefix}</span> : null}
        <span className={mono ? "lbl-mono" : undefined}>{label}</span>
        <ChevronDownIcon size={14} style={{ color: "var(--muted)" }} />
      </button>
      {open ? (
        <div className={`dbproto-dd-menu ${align === "right" ? "right" : ""}`}>
          {options.map((o) => (
            <button
              key={o.id}
              className={`dbproto-dd-item ${o.id === value ? "active" : ""}`}
              onClick={() => {
                onSelect(o.id);
                setOpen(false);
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span className={mono ? "lbl-mono" : undefined} style={{ display: "block" }}>
                  {o.label}
                </span>
                {o.sub ? <span className="sub">{o.sub}</span> : null}
              </span>
              {o.extra}
              {o.id === value ? (
                <span className="dbproto-dd-check">
                  <CheckIcon size={15} />
                </span>
              ) : null}
            </button>
          ))}
          {footer ? <div className="dbproto-dd-foot">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Switch({
  on,
  onToggle,
  disabled = false,
  title,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      className={`dbproto-switch ${on ? "on" : ""}`}
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      type="button"
      disabled={disabled}
      title={title}
    />
  );
}
