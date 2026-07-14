/**
 * Adapter-data change classification (sandbox overrides §Adapter data).
 *
 * Given the BEFORE and AFTER text of one adapter-data file, mechanically
 * separate the keys a write ADDED (new key/msgid/token) from the ones it
 * MUTATED (an existing value changed). The sandbox turn path uses this to
 * RECORD additions on the owning changeset (GC'd on discard) and to WARN when
 * a variant mutated an existing shared value — additive-only is the rule
 * (want different text → new key; changing a shared token = a global edit).
 *
 * Pure and format-aware (json / gettext-po / css custom properties). A file
 * that fails to parse on either side yields no classification (empty) — never
 * a false positive that would mis-record or mis-warn.
 */

import { unescapePo } from "./poEdit.ts";

type DataFormat = "json" | "po" | "cssvar";

/** Repo-relative key paths a change added vs. mutated (leaf-level). */
type DataChange = { added: string[]; mutated: string[] };

/** The classifier for a data file, by extension. `undefined` = not an
 * adapter-data file this layer understands (e.g. a `.tsx` variant). */
function dataFormatFor(relPath: string): DataFormat | undefined {
  if (relPath.endsWith(".po")) return "po";
  if (relPath.endsWith(".css")) return "cssvar";
  if (relPath.endsWith(".json")) return "json";
  return undefined;
}

/** Best-effort adapter label for a data file (informational — the discard GC
 * keys off the file/keyPath, not this). */
function adapterIdForFile(relPath: string): string {
  if (relPath.endsWith(".po")) return "lingui";
  if (relPath.endsWith(".css")) return "theme";
  const lower = relPath.toLowerCase();
  if (lower.includes("locale") || lower.includes("i18n")) return "i18next";
  if (lower.includes("theme")) return "theme";
  if (lower.includes("flag")) return "flags";
  return "json";
}

// --- JSON -------------------------------------------------------------------

/** Flatten a JSON object to dot-path → serialized leaf value. Arrays and
 * primitives are leaves (serialized for a stable equality test); nested
 * objects recurse. Non-object roots yield an empty map. */
function flattenJson(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // Leaf reached at the prefix itself (only for a non-object root call the
    // prefix is "" — handled by the caller, which skips the empty key).
    if (prefix) out.set(prefix, JSON.stringify(value));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      flattenJson(child, path, out);
    } else {
      out.set(path, JSON.stringify(child));
    }
  }
}

function jsonLeaves(text: string): Map<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const out = new Map<string, string>();
  flattenJson(parsed, "", out);
  return out;
}

// --- gettext PO -------------------------------------------------------------

/** msgid → msgstr for every translated entry (plural entries skipped — Lingui
 * does not use them). The msgid is the key path. */
function poEntries(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  const quoted = /"((?:[^"\\]|\\.)*)"/;
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("msgid ") || trimmed === "msgid") {
      let msgid = unescapePo(lines[i].match(quoted)?.[1] ?? "");
      let j = i + 1;
      while (j < lines.length && lines[j].trimStart().startsWith('"')) {
        msgid += unescapePo(lines[j].match(quoted)?.[1] ?? "");
        j++;
      }
      const strLine = j < lines.length ? lines[j].trimStart() : "";
      if (strLine.startsWith("msgstr")) {
        let msgstr = unescapePo(lines[j].match(quoted)?.[1] ?? "");
        let k = j + 1;
        while (k < lines.length && lines[k].trimStart().startsWith('"')) {
          msgstr += unescapePo(lines[k].match(quoted)?.[1] ?? "");
          k++;
        }
        if (msgid) map.set(msgid, msgstr);
        i = k;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return map;
}

// --- CSS custom properties --------------------------------------------------

/** `<selector> --<prop>` → value for every custom property inside a selector
 * block. The composite is the key path (a token is scoped to its selector). */
function cssVars(text: string): Map<string, string> {
  const map = new Map<string, string>();
  // Strip comments so a declaration inside /* … */ never registers.
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(src)) !== null) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    if (!selector) continue;
    const decl = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let d: RegExpExecArray | null;
    while ((d = decl.exec(match[2])) !== null) {
      map.set(`${selector} ${d[1]}`, d[2].trim());
    }
  }
  return map;
}

// --- Classification ---------------------------------------------------------

function diffMaps(
  before: Map<string, string>,
  after: Map<string, string>,
): DataChange {
  const added: string[] = [];
  const mutated: string[] = [];
  for (const [key, value] of after) {
    if (!before.has(key)) added.push(key);
    else if (before.get(key) !== value) mutated.push(key);
  }
  return { added, mutated };
}

/**
 * Classify one adapter-data file change. Returns the leaf key paths ADDED and
 * MUTATED between `before` and `after`. Removals are ignored (a variant never
 * needs to delete shared data). Unparseable input on either side → empty.
 */
function classifyDataChange(
  format: DataFormat,
  before: string,
  after: string,
): DataChange {
  const empty: DataChange = { added: [], mutated: [] };
  if (format === "json") {
    const b = jsonLeaves(before);
    const a = jsonLeaves(after);
    return b && a ? diffMaps(b, a) : empty;
  }
  if (format === "po") return diffMaps(poEntries(before), poEntries(after));
  return diffMaps(cssVars(before), cssVars(after));
}

export {
  adapterIdForFile,
  classifyDataChange,
  cssVars,
  dataFormatFor,
  jsonLeaves,
  poEntries,
  type DataChange,
  type DataFormat,
};
