/**
 * Surgical JSON string replacement: swaps the string value at a dot-separated
 * key path inside raw JSON text without reformatting anything else. Canvas
 * i18n edits use this so a one-string change produces a one-line diff.
 */

type ValueRange = { start: number; end: number };

function skipWhitespace(raw: string, index: number): number {
  let i = index;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  return i;
}

/** `raw[index]` must be `"`; returns the index just past the closing quote. */
function scanString(raw: string, index: number): number {
  let i = index + 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === '"') {
      return i + 1;
    } else {
      i++;
    }
  }
  throw new Error("Unterminated string in JSON");
}

/** Returns the index just past the value starting at `index`. */
function scanValue(raw: string, index: number): number {
  let i = skipWhitespace(raw, index);
  const ch = raw[i];

  if (ch === '"') return scanString(raw, i);

  if (ch === "{" || ch === "[") {
    const open = ch;
    const close = ch === "{" ? "}" : "]";
    let depth = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') {
        i = scanString(raw, i);
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error("Unterminated container in JSON");
  }

  while (i < raw.length && !/[,}\]\s]/.test(raw[i])) i++;
  return i;
}

function findInObject(
  raw: string,
  index: number,
  path: string[],
): ValueRange | undefined {
  let i = skipWhitespace(raw, index);
  if (raw[i] !== "{") return undefined;
  i = skipWhitespace(raw, i + 1);

  while (i < raw.length && raw[i] !== "}") {
    if (raw[i] !== '"') return undefined;
    const keyStart = i;
    const keyEnd = scanString(raw, i);
    const key = JSON.parse(raw.slice(keyStart, keyEnd)) as string;

    i = skipWhitespace(raw, keyEnd);
    if (raw[i] !== ":") return undefined;
    i = skipWhitespace(raw, i + 1);

    if (key === path[0]) {
      if (path.length === 1) {
        return { start: i, end: scanValue(raw, i) };
      }
      return findInObject(raw, i, path.slice(1));
    }

    i = scanValue(raw, i);
    i = skipWhitespace(raw, i);
    if (raw[i] !== ",") break;
    i = skipWhitespace(raw, i + 1);
  }

  return undefined;
}

/**
 * Replaces the value at `keyPath` (dot-separated, e.g. "acme.newCheckout") in
 * raw JSON text, serializing `value` with `JSON.stringify` (so booleans,
 * numbers, strings, and enums all work). Returns the updated text, or undefined
 * when the path doesn't resolve to an existing value. Only the target value's
 * span is rewritten, so a one-field change stays a one-line diff.
 */
function replaceJsonValue(
  raw: string,
  keyPath: string,
  value: unknown,
): string | undefined {
  const range = findInObject(raw, 0, keyPath.split("."));
  if (!range) return undefined;
  return (
    raw.slice(0, range.start) + JSON.stringify(value) + raw.slice(range.end)
  );
}

/**
 * Like `replaceJsonValue`, but only when the existing value is a string —
 * used by the i18n text tool, which must never turn a non-string into a string.
 * Returns undefined when the path is missing or resolves to a non-string.
 */
function replaceJsonStringValue(
  raw: string,
  keyPath: string,
  value: string,
): string | undefined {
  const range = findInObject(raw, 0, keyPath.split("."));
  if (!range || raw[range.start] !== '"') return undefined;
  return (
    raw.slice(0, range.start) + JSON.stringify(value) + raw.slice(range.end)
  );
}

/**
 * Sets the value at `keyPath`, creating any missing intermediate objects — used
 * when an adapter writes a value that may not exist yet (e.g. the first override
 * for a theme variant). An existing key is rewritten surgically (one-line diff);
 * a new key falls back to a full re-serialize (2-space) since inserting can't be
 * a pure span replacement. Returns undefined only when `raw` isn't a JSON object
 * or a path segment collides with a non-object value.
 */
function setJsonValue(
  raw: string,
  keyPath: string,
  value: unknown,
): string | undefined {
  const surgical = replaceJsonValue(raw, keyPath, value);
  if (surgical !== undefined) return surgical;

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return undefined;
  }

  const parts = keyPath.split(".");
  let node = root as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const child = node[key];
    if (child === undefined) {
      node[key] = {};
    } else if (
      child === null ||
      typeof child !== "object" ||
      Array.isArray(child)
    ) {
      // A path segment points at a non-object; can't descend without clobbering.
      return undefined;
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;

  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(root, null, 2)}${trailingNewline}`;
}

export { replaceJsonStringValue, replaceJsonValue, setJsonValue };
