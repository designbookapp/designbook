/**
 * Sampled serialization for selection-context values (spec: depth/size-capped,
 * functions listed by name only, cycles cut). Used wherever a contributor
 * shows a LIVE runtime value — fiber props, context provider values — so a
 * huge dataset or a store object can't blow up the panel or the prompt.
 *
 * Dev-mode-only assumptions are fine here (designbook never runs in prod
 * builds): React elements and DOM nodes are recognized structurally.
 */

type SampleOptions = {
  /** Object/array nesting depth before eliding to `…`. */
  maxDepth?: number;
  /** Entries rendered per object/array level. */
  maxEntries?: number;
  /** Longest rendered string literal before ellipsizing. */
  maxString?: number;
};

const DEFAULTS: Required<SampleOptions> = {
  maxDepth: 3,
  maxEntries: 8,
  maxString: 80,
};

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isReactElement(value: object): boolean {
  return "$$typeof" in (value as Record<string, unknown>);
}

function isDomNode(value: object): value is { nodeName: string } {
  return typeof (value as { nodeType?: unknown }).nodeType === "number";
}

function sample(
  value: unknown,
  depth: number,
  options: Required<SampleOptions>,
  seen: WeakSet<object>,
): string {
  if (typeof value === "string") {
    return JSON.stringify(truncateText(value, options.maxString));
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") {
    const name = (value as { name?: string }).name;
    return name ? `ƒ ${name}()` : "ƒ()";
  }

  // Objects from here on.
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (isReactElement(obj)) return "<element>";
  if (isDomNode(obj)) return `<${String(obj.nodeName).toLowerCase()}>`;
  if (obj instanceof Map) return `Map(${obj.size})`;
  if (obj instanceof Set) return `Set(${obj.size})`;
  if (obj instanceof Date) return obj.toISOString();

  if (depth >= options.maxDepth) return Array.isArray(obj) ? "[…]" : "{…}";
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const shown = obj
        .slice(0, options.maxEntries)
        .map((item) => sample(item, depth + 1, options, seen));
      if (obj.length > options.maxEntries) shown.push("…");
      return `[${shown.join(", ")}]`;
    }
    const entries = Object.entries(obj as Record<string, unknown>);
    const shown = entries
      .slice(0, options.maxEntries)
      .map(([key, item]) => `${key}: ${sample(item, depth + 1, options, seen)}`);
    if (entries.length > options.maxEntries) shown.push("…");
    return `{${shown.join(", ")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Render any runtime value as a bounded one-line string. Never throws. */
function sampleValue(value: unknown, options?: SampleOptions): string {
  const resolved = { ...DEFAULTS, ...options };
  try {
    return sample(value, 0, resolved, new WeakSet());
  } catch {
    return "[unserializable]";
  }
}

export { sampleValue };
export type { SampleOptions };
