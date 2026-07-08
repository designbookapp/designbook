/**
 * Pure formatting behind the Props panel: turns a component instance's raw
 * `memoizedProps` record into displayable rows. React internals are elided
 * (`children` is structure, not a prop the designer set), functions and
 * elements are shown as opaque markers, and object values are JSON-ellipsized
 * so a huge dataset prop can't blow up the panel.
 */

/** Longest rendered value before ellipsizing (keeps rows single-purpose). */
const MAX_VALUE_LENGTH = 120;

type PropRow = {
  name: string;
  /** Display string for the value (already truncated). */
  value: string;
  /** Coarse kind — drives muted styling for opaque values in the panel. */
  kind: "primitive" | "opaque";
};

function truncate(text: string): string {
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : text;
}

function isReactElement(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in (value as Record<string, unknown>)
  );
}

function formatValue(value: unknown): { value: string; kind: PropRow["kind"] } {
  if (typeof value === "string") {
    return { value: truncate(JSON.stringify(value)), kind: "primitive" };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { value: String(value), kind: "primitive" };
  }
  if (value === null) return { value: "null", kind: "primitive" };
  if (value === undefined) return { value: "undefined", kind: "primitive" };
  if (typeof value === "function") return { value: "ƒ()", kind: "opaque" };
  if (isReactElement(value)) return { value: "<element>", kind: "opaque" };
  if (Array.isArray(value) && value.some(isReactElement)) {
    return { value: "<elements>", kind: "opaque" };
  }
  try {
    return { value: truncate(JSON.stringify(value) ?? "{…}"), kind: "opaque" };
  } catch {
    // Circular / unserializable — still show the row, just opaquely.
    return { value: Array.isArray(value) ? "[…]" : "{…}", kind: "opaque" };
  }
}

/** Displayable rows for a props record, in the component's own prop order. */
function summarizeProps(props: Record<string, unknown>): PropRow[] {
  return Object.entries(props)
    .filter(([name]) => name !== "children")
    .map(([name, raw]) => ({ name, ...formatValue(raw) }));
}

export { summarizeProps };
export type { PropRow };
