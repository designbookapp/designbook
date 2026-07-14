/**
 * The REAL props panel (docs/specs/props-panel.md). Renders IMMEDIATELY from
 * the selection's live runtime prop values (fiber capture), then UPGRADES when
 * the typed schema lands (`GET /api/props-schema`): enum/union → select,
 * boolean → switch, string → input, number → stepper, node/function/object →
 * read-only value badges. Unpassed optional props show greyed with their
 * default.
 *
 * Editing a control writes the JSX attribute at the SELECTED INSTANCE's usage
 * site through `POST /api/props-edit` (the changeset engine routes it — active
 * conversation → the direct-edits layer, else the real file). Rapid changes
 * (typing / stepper) debounce into one write per settle. A usage site that
 * can't be edited safely (no codeTarget, spread props) renders read-only with
 * an explanatory note — writes are never guessed.
 *
 * Plugin sections (the section registry) render AFTER the core controls,
 * collapsible, matching the panel's visual language.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import { apiUrl } from "@designbook-ui/designbook";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import type {
  PropsPanelSectionContext,
  PropsPanelSectionSpec,
} from "@designbook-ui/integrations";
import { getPropsPanelSections } from "@designbook-ui/models/propsPanel/sectionRegistry";
import {
  buildRows,
  formatPreview,
  type PropDescriptor,
  type PropKind,
  type Row,
  type SchemaState,
} from "./propsRows";
import { Switch } from "./ui";

const READONLY_KINDS = new Set<PropKind>(["node", "function", "object"]);
const WRITE_DEBOUNCE_MS = 320;

function ModLabel({
  name,
  required,
  modified,
  typeText,
}: {
  name: string;
  required: boolean;
  modified: boolean;
  typeText?: string;
}) {
  return (
    <div className="dbproto-field-label">
      <span>{name}</span>
      {required ? (
        <span className="dbproto-prop-req" title="Required">
          *
        </span>
      ) : null}
      {modified ? <span className="dbproto-mod-dot" title="Modified" /> : null}
      {typeText ? <span className="dbproto-prop-type">{typeText}</span> : null}
    </div>
  );
}

function PluginSection({
  section,
  context,
}: {
  section: PropsPanelSectionSpec;
  context: PropsPanelSectionContext;
}) {
  const [open, setOpen] = useState(false);
  const Body = section.Component;
  return (
    <div className="dbproto-section">
      <button className="dbproto-section-head" onClick={() => setOpen((o) => !o)}>
        <ChevronRightIcon
          size={14}
          style={{
            transition: "transform .15s",
            transform: open ? "rotate(90deg)" : "none",
          }}
        />
        {section.title}
      </button>
      {open ? (
        <div className="dbproto-section-body">
          <Body context={context} />
        </div>
      ) : null}
    </div>
  );
}

function PropsInspector({
  selection,
  runtimeProps,
  live,
  openChat,
}: {
  selection?: CanvasNodeSelection;
  runtimeProps?: Record<string, unknown>;
  /** Live selection handles handed to plugin sections (Figma push serialize).
   *  Absent for DOM/restored selections. */
  live?: PropsPanelSectionContext["live"];
  /** Draft a prompt into the chat composer (plugin sections, e.g. Figma pull). */
  openChat?: (draft: string) => void;
}) {
  const [schema, setSchema] = useState<SchemaState>({ status: "idle" });
  /** Local, optimistic value overrides (name → value). Reset on selection. */
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  /** Props the server refused to write (name → reason) — forced read-only. */
  const [readOnlyProps, setReadOnlyProps] = useState<Record<string, string>>({});
  const debouncers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const schemaFile = selection?.path;
  const schemaExport = selection?.exportName;
  const isComponent = Boolean(schemaFile && schemaExport && !selection?.dom);

  // Reset transient state whenever the selection changes.
  const selectionKey = `${schemaFile ?? ""}::${schemaExport ?? ""}::${
    selection?.label ?? ""
  }`;
  useEffect(() => {
    setEdits({});
    setReadOnlyProps({});
    for (const timer of debouncers.current.values()) clearTimeout(timer);
    debouncers.current.clear();
  }, [selectionKey]);

  // Fetch the typed schema (cache makes repeats instant). Values render before
  // this resolves; controls upgrade when it lands.
  useEffect(() => {
    if (!isComponent || !schemaFile || !schemaExport) {
      setSchema({ status: "idle" });
      return;
    }
    let cancelled = false;
    setSchema({ status: "loading" });
    void fetch(
      apiUrl(
        `/api/props-schema?file=${encodeURIComponent(
          schemaFile,
        )}&export=${encodeURIComponent(schemaExport)}`,
      ),
    )
      .then((response) => response.json())
      .then((payload: { props?: PropDescriptor[]; unavailable?: string }) => {
        if (cancelled) return;
        if (payload.props) {
          setSchema({ status: "ready", props: payload.props });
        } else {
          setSchema({
            status: "unavailable",
            reason: payload.unavailable ?? "schema unavailable",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSchema({ status: "unavailable", reason: "request failed" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isComponent, schemaFile, schemaExport]);

  const usageSite = selection?.codeTarget;
  const canWrite = Boolean(usageSite?.file);

  const rows = useMemo(
    () => buildRows(schema, runtimeProps, edits),
    [schema, runtimeProps, edits],
  );

  const sections = useMemo(() => getPropsPanelSections(), [selectionKey]);
  const sectionContext: PropsPanelSectionContext = useMemo(
    () => ({
      ...(schemaFile ? { file: schemaFile } : {}),
      ...(schemaExport ? { exportName: schemaExport } : {}),
      componentName: schemaExport ?? selection?.label,
      props: rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        ...(row.typeText ? { typeText: row.typeText } : {}),
        required: row.required,
        ...(row.passed ? { value: row.value } : {}),
      })),
      apiUrl,
      ...(openChat ? { openChat } : {}),
      ...(live ? { live } : {}),
    }),
    [schemaFile, schemaExport, selection?.label, rows, openChat, live],
  );

  /** Queue a debounced usage-site write for one prop. */
  function scheduleWrite(row: Row, nextValue: unknown) {
    if (!canWrite || !usageSite?.file) return;
    const timers = debouncers.current;
    const existing = timers.get(row.name);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(row.name);
      const isDefault =
        row.defaultValue !== undefined &&
        String(nextValue) === row.defaultValue;
      const kind: string =
        row.kind === "enum" ? "enum" : row.kind;
      const body = {
        file: usageSite.file,
        ownerExportName: usageSite.ownerExportName,
        elementName: usageSite.name,
        ...(usageSite.className ? { className: usageSite.className } : {}),
        prop: row.name,
        kind,
        ...(isDefault ? { reset: true } : { value: nextValue }),
      };
      void fetch(apiUrl("/api/props-edit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((response) => response.json())
        .then((result: { ok?: boolean; unresolvable?: string; error?: string }) => {
          if (result.unresolvable || result.error) {
            setReadOnlyProps((prev) => ({
              ...prev,
              [row.name]: result.unresolvable ?? result.error ?? "not editable",
            }));
          }
        })
        .catch(() => {
          setReadOnlyProps((prev) => ({
            ...prev,
            [row.name]: "write failed",
          }));
        });
    }, WRITE_DEBOUNCE_MS);
    timers.set(row.name, timer);
  }

  function setValue(row: Row, nextValue: unknown) {
    setEdits((prev) => ({ ...prev, [row.name]: nextValue }));
    scheduleWrite(row, nextValue);
  }

  if (!selection) {
    return (
      <div className="dbproto-props-empty">
        Select a component on the canvas to inspect its props.
      </div>
    );
  }

  const noUsageSite = !canWrite;

  return (
    <div className="dbproto-props">
      {schema.status === "loading" && rows.length === 0 ? (
        <div className="dbproto-props-status">Loading props…</div>
      ) : null}

      {noUsageSite ? (
        <div className="dbproto-props-note">
          {selection.dom
            ? "This is a DOM element. Select its owning component to edit typed props."
            : "No editable usage site for this selection — values are read-only."}
        </div>
      ) : null}

      {rows.length === 0 && schema.status !== "loading" ? (
        <div className="dbproto-props-empty">
          No props found for this selection.
        </div>
      ) : null}

      {rows.map((row) => {
        const forcedReadOnly =
          noUsageSite ||
          READONLY_KINDS.has(row.kind) ||
          row.name in readOnlyProps;
        const modified =
          row.name in edits ||
          (row.passed &&
            row.defaultValue !== undefined &&
            String(row.value) !== row.defaultValue);
        const warn = readOnlyProps[row.name];

        if (forcedReadOnly) {
          return (
            <div
              key={row.name}
              className={`dbproto-field ${row.passed ? "" : "unpassed"}`}
            >
              <ModLabel
                name={row.name}
                required={row.required}
                modified={false}
                typeText={row.typeText}
              />
              <div className="dbproto-prop-ro" title={String(row.value)}>
                <span className="dbproto-prop-badge">{row.kind}</span>
                <span>
                  {row.passed
                    ? formatPreview(row.value)
                    : row.defaultValue ?? "—"}
                </span>
              </div>
              {warn ? <div className="dbproto-prop-warn">{warn}</div> : null}
            </div>
          );
        }

        if (row.kind === "boolean") {
          const on = Boolean(
            row.passed ? row.value : row.defaultValue === "true",
          );
          return (
            <div
              key={row.name}
              className={`dbproto-bool ${row.passed ? "" : "unpassed"}`}
            >
              <ModLabel
                name={row.name}
                required={row.required}
                modified={modified}
                typeText={row.typeText}
              />
              <Switch on={on} onToggle={() => setValue(row, !on)} />
            </div>
          );
        }

        if (row.kind === "enum" && row.options && row.options.length > 0) {
          const current = String(
            row.passed ? row.value ?? "" : row.defaultValue ?? "",
          );
          return (
            <div
              key={row.name}
              className={`dbproto-field ${row.passed ? "" : "unpassed"}`}
            >
              <ModLabel
                name={row.name}
                required={row.required}
                modified={modified}
                typeText={row.typeText}
              />
              <select
                className="dbproto-select"
                value={current}
                onChange={(event) => setValue(row, event.target.value)}
              >
                {row.options.includes(current) ? null : (
                  <option value={current}>{current || "—"}</option>
                )}
                {row.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (row.kind === "number") {
          const numeric =
            typeof row.value === "number"
              ? row.value
              : Number(row.value ?? row.defaultValue ?? 0) || 0;
          return (
            <div
              key={row.name}
              className={`dbproto-field ${row.passed ? "" : "unpassed"}`}
            >
              <ModLabel
                name={row.name}
                required={row.required}
                modified={modified}
                typeText={row.typeText}
              />
              <div className="dbproto-stepper">
                <button
                  className="dbproto-step-btn"
                  onClick={() => setValue(row, numeric - 1)}
                >
                  <MinusIcon size={14} />
                </button>
                <input
                  className="dbproto-input"
                  value={String(row.passed ? row.value ?? "" : numeric)}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setValue(row, Number.isFinite(next) ? next : 0);
                  }}
                />
                <button
                  className="dbproto-step-btn"
                  onClick={() => setValue(row, numeric + 1)}
                >
                  <PlusIcon size={14} />
                </button>
              </div>
            </div>
          );
        }

        // string / enum-without-options / everything editable-as-text.
        const text = String(row.passed ? row.value ?? "" : "");
        return (
          <div
            key={row.name}
            className={`dbproto-field ${row.passed ? "" : "unpassed"}`}
          >
            <ModLabel
              name={row.name}
              required={row.required}
              modified={modified}
              typeText={row.typeText}
            />
            <input
              className="dbproto-input"
              value={text}
              placeholder={row.defaultValue ?? ""}
              onChange={(event) => setValue(row, event.target.value)}
            />
            {!row.passed && row.defaultValue !== undefined ? (
              <div className="dbproto-prop-default">
                default: {row.defaultValue}
              </div>
            ) : null}
          </div>
        );
      })}

      {schema.status === "unavailable" ? (
        <div className="dbproto-props-status" title={schema.reason}>
          Typed schema unavailable — showing live values only.
        </div>
      ) : null}

      {sections.map((section) => (
        <PluginSection
          key={section.id}
          section={section}
          context={sectionContext}
        />
      ))}
    </div>
  );
}

export { PropsInspector };
