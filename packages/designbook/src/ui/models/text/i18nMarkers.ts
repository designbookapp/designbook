/**
 * Invisible-marker encoding for i18n string attribution on the design canvas.
 *
 * Every `t()` call in the design app passes through a postProcessor that appends
 * a zero-width marker to the resolved string. The marker encodes an index into a
 * runtime table (`markerTable`) that maps back to the namespace + resolved key.
 *
 * Encoding: base-4 digits over [U+200B, U+200C, U+200D, U+2064], wrapped in
 * U+2061 (start) / U+2062 (end) sentinels.
 *
 * The markers are visually invisible and exist only in the design app's rendered
 * output — they never appear in saved locale files.
 */

const SENTINEL_START = "⁡";
const SENTINEL_END = "⁢";
const DIGITS = ["​", "‌", "‍", "⁤"] as const;

const MARKER_CHARS = new Set([SENTINEL_START, SENTINEL_END, ...DIGITS]);

type MarkerEntry = {
  namespace: string;
  key: string;
  resolvedKey: string;
};

const markerTable: MarkerEntry[] = [];
const keyIndex = new Map<string, number>();

/**
 * Whether the marker postProcessor appends markers (default on).
 *
 * The canvas always wants attribution markers on its previewed strings, so this
 * defaults true and host mode never touches it. In injected PAGE mode the live
 * app renders through this same (adapter-owned) i18next instance, so its strings
 * would ALSO carry markers whenever the tool is off — the page-tools layer flips
 * this to gate the app's live markers on the text tool, restoring the default on
 * close (canvas and page tools are mutually exclusive there).
 */
let markingActive = true;

/** Toggle whether `designMarkerPostProcessor` appends markers. */
function setMarkingActive(active: boolean): void {
  markingActive = active;
}

function allocateMarker(entry: MarkerEntry): number {
  const lookupKey = `${entry.namespace}::${entry.resolvedKey}`;
  const existing = keyIndex.get(lookupKey);
  if (existing !== undefined) {
    return existing;
  }
  const index = markerTable.length;
  markerTable.push(entry);
  keyIndex.set(lookupKey, index);
  return index;
}

function encodeMarker(index: number): string {
  if (index < 0) return "";
  const encoded: string[] = [SENTINEL_START];
  if (index === 0) {
    encoded.push(DIGITS[0]);
  } else {
    let remaining = index;
    const parts: string[] = [];
    while (remaining > 0) {
      parts.push(DIGITS[remaining % 4]);
      remaining = Math.floor(remaining / 4);
    }
    parts.reverse();
    encoded.push(...parts);
  }
  encoded.push(SENTINEL_END);
  return encoded.join("");
}

function decodeMarker(text: string): number | undefined {
  const startIdx = text.lastIndexOf(SENTINEL_START);
  if (startIdx === -1) return undefined;
  const endIdx = text.indexOf(SENTINEL_END, startIdx);
  if (endIdx === -1) return undefined;

  const body = text.slice(startIdx + 1, endIdx);
  if (body.length === 0) return undefined;

  let value = 0;
  for (const ch of body) {
    const digit = DIGITS.indexOf(ch as (typeof DIGITS)[number]);
    if (digit === -1) return undefined;
    value = value * 4 + digit;
  }
  return value;
}

function stripMarkers(text: string): string {
  let result = "";
  let inMarker = false;
  for (const ch of text) {
    if (ch === SENTINEL_START) {
      inMarker = true;
      continue;
    }
    if (ch === SENTINEL_END) {
      inMarker = false;
      continue;
    }
    if (inMarker && MARKER_CHARS.has(ch)) {
      continue;
    }
    if (inMarker) {
      inMarker = false;
    }
    result += ch;
  }
  return result;
}

function containsMarkerChars(text: string): boolean {
  for (const ch of text) {
    if (MARKER_CHARS.has(ch)) return true;
  }
  return false;
}

function getMarkerEntry(index: number): MarkerEntry | undefined {
  return markerTable[index];
}

/**
 * i18next postProcessor that appends invisible markers to every resolved string.
 * Register via `i18next.use(designMarkerPostProcessor)` before init.
 */
const designMarkerPostProcessor = {
  type: "postProcessor" as const,
  name: "designMarker",
  process(
    value: string,
    key: string | string[],
    options: Record<string, unknown>,
    translator?: {
      resourceStore?: {
        getResource?: (lng: string, ns: string, key: string) => unknown;
      };
    },
  ) {
    if (!markingActive) return value;

    let namespace =
      typeof options.ns === "string"
        ? options.ns
        : Array.isArray(options.ns)
          ? (options.ns[0] as string)
          : "cruises";

    let baseKey = Array.isArray(key) ? key[0] : key;
    if (!baseKey) return value;

    const nsSeparatorIndex = baseKey.indexOf(":");
    if (nsSeparatorIndex > -1) {
      namespace = baseKey.slice(0, nsSeparatorIndex);
      baseKey = baseKey.slice(nsSeparatorIndex + 1);
    }

    if (!baseKey || baseKey.startsWith("@")) return value;

    let resolvedKey = baseKey;
    if (typeof options.count === "number") {
      const suffixed = `${baseKey}_${new Intl.PluralRules("en-US").select(options.count)}`;
      const exists =
        typeof translator?.resourceStore?.getResource?.(
          "en-US",
          namespace,
          suffixed,
        ) === "string";
      if (exists) {
        resolvedKey = suffixed;
      }
    }

    const index = allocateMarker({ namespace, key: baseKey, resolvedKey });
    return value + encodeMarker(index);
  },
};

export {
  allocateMarker,
  containsMarkerChars,
  decodeMarker,
  designMarkerPostProcessor,
  encodeMarker,
  getMarkerEntry,
  markerTable,
  setMarkingActive,
  stripMarkers,
};
export type { MarkerEntry };
