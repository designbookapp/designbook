/**
 * Pure row-model helpers for the props inspector (PropsInspector.tsx): merge
 * the typed schema (authoritative order + kinds) with the selection's live /
 * edited runtime values, infer a control kind from a raw value when no schema
 * is available, and format a safe preview string for read-only values.
 *
 * Kept React-free so the merge logic unit-tests in the node env.
 */

type PropKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "node"
  | "function"
  | "object";

type PropDescriptor = {
  name: string;
  typeText: string;
  kind: PropKind;
  options?: string[];
  required: boolean;
  defaultValue?: string;
  description?: string;
};

type SchemaState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; props: PropDescriptor[] }
  | { status: "unavailable"; reason: string };

/** A merged panel row: schema shape (when known) + live/edited value. */
type Row = {
  name: string;
  kind: PropKind;
  typeText?: string;
  options?: string[];
  required: boolean;
  defaultValue?: string;
  description?: string;
  /** Present at the instance (runtime value or a local edit). */
  passed: boolean;
  value: unknown;
};

/** Infer a control kind from a raw runtime value (schema-less fallback). */
function inferKind(value: unknown): PropKind {
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    default:
      if (value && typeof value === "object") {
        if ("$$typeof" in (value as Record<string, unknown>)) return "node";
        return "object";
      }
      return "object";
  }
}

/** A short, safe display string for a read-only (node/function/object) value. */
function formatPreview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") {
    const name = (value as { name?: string }).name;
    return name ? `ƒ ${name}()` : "ƒ ()";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("$$typeof" in record) {
      const type = record.type as unknown;
      const name =
        typeof type === "string"
          ? type
          : (type as { name?: string })?.name ?? "Element";
      return `<${name} />`;
    }
    if (Array.isArray(value)) return `[…] (${value.length})`;
    try {
      const json = JSON.stringify(value);
      return json.length > 60 ? `${json.slice(0, 59)}…` : json;
    } catch {
      return "{…}";
    }
  }
  return String(value);
}

/**
 * Merge the schema (authoritative order + kinds) with the live/edited values.
 * Falls back to the runtime keys when the schema is absent. `children` is never
 * a row (render structure, not data).
 */
function buildRows(
  schema: SchemaState,
  runtimeProps: Record<string, unknown> | undefined,
  edits: Record<string, unknown>,
): Row[] {
  const runtime = runtimeProps ?? {};
  const valueOf = (name: string) =>
    name in edits ? edits[name] : runtime[name];
  const isPassed = (name: string) =>
    name in edits || (name in runtime && runtime[name] !== undefined);

  if (schema.status === "ready") {
    const rows: Row[] = schema.props.map((prop) => ({
      name: prop.name,
      kind: prop.kind,
      typeText: prop.typeText,
      options: prop.options,
      required: prop.required,
      defaultValue: prop.defaultValue,
      description: prop.description,
      passed: isPassed(prop.name),
      value: valueOf(prop.name),
    }));
    // Extra runtime props not in the typed surface (e.g. passed-through) — show
    // them after, inferred + editable by name.
    const known = new Set(schema.props.map((prop) => prop.name));
    for (const [name, value] of Object.entries(runtime)) {
      if (name === "children" || known.has(name) || value === undefined) continue;
      rows.push({
        name,
        kind: inferKind(valueOf(name)),
        required: false,
        passed: true,
        value: valueOf(name),
      });
    }
    return rows;
  }

  // Schema absent/loading — render live values only.
  return Object.entries(runtime)
    .filter(([name, value]) => name !== "children" && value !== undefined)
    .map(([name]) => ({
      name,
      kind: inferKind(valueOf(name)),
      required: false,
      passed: true,
      value: valueOf(name),
    }));
}

export { buildRows, inferKind, formatPreview };
export type { PropDescriptor, PropKind, Row, SchemaState };
