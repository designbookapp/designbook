/**
 * Structured DATA-FILE merge for changeset layers
 * (docs/specs/changeset-layers.md §Data merge).
 *
 * Data files (locale JSON / gettext PO / css custom properties) layer by
 * STRUCTURED MERGE, not shadowing: serve-time resolution merges the current
 * real file + each active layer's ADDITIONS (leaf keys present in the
 * layer's data alternative but not in its base snapshot). Additions only —
 * two layers adding DIFFERENT keys both land; the SAME key added twice with
 * different values is a changeset conflict (surfaced, topmost-first wins in
 * the merged output so the page still renders).
 *
 * The same machinery runs at bake (additions merge into the real file) —
 * shared here so serve and bake can never disagree. Pure text-in/text-out;
 * parsing rides the dataClassify leaf extractors.
 */

import { cssVars, jsonLeaves, poEntries, type DataFormat } from "./dataClassify.ts";
import { escapePo, replacePoMsgstr } from "./poEdit.ts";
import { replaceCssVar } from "./cssVarEdit.ts";

/** keyPath → serialized leaf value (JSON text / po msgstr / css value). */
type DataAdditions = Map<string, string>;

/** One same-key-different-value collision across two active layers. */
type DataKeyConflict = { file: string; key: string; changesetIds: string[] };

/** The leaf map of one data text, by format (undefined = unparseable). */
function leavesOf(format: DataFormat, text: string): Map<string, string> | undefined {
  if (format === "json") return jsonLeaves(text);
  if (format === "po") return poEntries(text);
  return cssVars(text);
}

/**
 * The keys `layered` ADDED over `base` (leaf-level), with their serialized
 * values. Mutations of existing keys are NOT additions (additive-only rule);
 * unparseable input on either side yields no additions — never a false
 * positive.
 */
function computeDataAdditions(
  format: DataFormat,
  base: string,
  layered: string,
): DataAdditions {
  const out: DataAdditions = new Map();
  const baseLeaves = leavesOf(format, base);
  const layerLeaves = leavesOf(format, layered);
  if (!baseLeaves || !layerLeaves) return out;
  for (const [key, value] of layerLeaves) {
    if (!baseLeaves.has(key)) out.set(key, value);
  }
  return out;
}

/**
 * The keys `layered` CHANGED over `base` (leaf-level): additions PLUS
 * value mutations of existing keys, with the layered values. L3: a
 * conversation's DIRECT-EDITS layer legitimately carries mutations (a manual
 * text-tool/theme edit IS a change to a shared value by intent) — for
 * additive-only layers (variant explorations) the alt file never contains a
 * mutation, so changes == additions there by construction. Unparseable input
 * on either side yields no changes.
 */
function computeDataChanges(
  format: DataFormat,
  base: string,
  layered: string,
): DataAdditions {
  const out: DataAdditions = new Map();
  const baseLeaves = leavesOf(format, base);
  const layerLeaves = leavesOf(format, layered);
  if (!baseLeaves || !layerLeaves) return out;
  for (const [key, value] of layerLeaves) {
    if (!baseLeaves.has(key) || baseLeaves.get(key) !== value) {
      out.set(key, value);
    }
  }
  return out;
}

/** Set one dot-path into a JSON object tree (objects created as needed; an
 * existing non-object node on the path keeps the file untouched for that
 * key — conservative). */
function setJsonPath(
  root: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const segments = keyPath.split(".").filter(Boolean);
  if (segments.length === 0) return;
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (next === undefined) {
      const child: Record<string, unknown> = {};
      node[segment] = child;
      node = child;
    } else if (next && typeof next === "object" && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      return; // Path shape conflict — keep the existing value.
    }
  }
  const leaf = segments.at(-1)!;
  if (!(leaf in node)) node[leaf] = value;
}

function applyJsonAdditions(current: string, additions: DataAdditions): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    parsed = undefined;
  }
  const root =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  for (const [keyPath, serialized] of additions) {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      value = serialized;
    }
    setJsonPath(root, keyPath, value);
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

function applyPoAdditions(current: string, additions: DataAdditions): string {
  const existing = poEntries(current);
  const blocks: string[] = [];
  for (const [msgid, msgstr] of additions) {
    if (existing.has(msgid)) continue;
    blocks.push(`msgid "${escapePo(msgid)}"\nmsgstr "${escapePo(msgstr)}"\n`);
  }
  if (blocks.length === 0) return current;
  const body = current.replace(/\n*$/, "\n");
  return `${body}\n${blocks.join("\n")}`;
}

function applyCssVarAdditions(current: string, additions: DataAdditions): string {
  const existing = cssVars(current);
  /** selector → declarations to add. */
  const bySelector = new Map<string, Array<{ prop: string; value: string }>>();
  for (const [key, value] of additions) {
    if (existing.has(key)) continue;
    const split = key.lastIndexOf(" --");
    if (split === -1) continue;
    const selector = key.slice(0, split);
    const prop = key.slice(split + 1);
    const list = bySelector.get(selector) ?? [];
    list.push({ prop, value });
    bySelector.set(selector, list);
  }
  if (bySelector.size === 0) return current;
  let out = current;
  const appendedBlocks: string[] = [];
  for (const [selector, decls] of bySelector) {
    const lines = decls.map((decl) => `  ${decl.prop}: ${decl.value};`).join("\n");
    // Insert into the FIRST block whose normalized selector matches; append
    // a new block otherwise. Textual-conservative — no css parse.
    const block = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    let inserted = false;
    while ((match = block.exec(out)) !== null) {
      const found = match[1].trim().replace(/\s+/g, " ");
      if (found !== selector) continue;
      const insertAt = match.index + match[0].length - 1; // before "}"
      const bodyEndsWithNewline = /\n\s*$/.test(match[2]);
      out = `${out.slice(0, insertAt)}${bodyEndsWithNewline ? "" : "\n"}${lines}\n${out.slice(insertAt)}`;
      inserted = true;
      break;
    }
    if (!inserted) appendedBlocks.push(`${selector} {\n${lines}\n}\n`);
  }
  if (appendedBlocks.length > 0) {
    out = `${out.replace(/\n*$/, "\n")}\n${appendedBlocks.join("\n")}`;
  }
  return out;
}

/** Apply one additions map to the current text of a data file. Keys already
 * present in `current` keep their current value (base wins over a stale
 * layer copy of an existing key). */
function applyDataAdditions(
  format: DataFormat,
  current: string,
  additions: DataAdditions,
): string {
  if (additions.size === 0) return current;
  if (format === "json") return applyJsonAdditions(current, additions);
  if (format === "po") return applyPoAdditions(current, additions);
  return applyCssVarAdditions(current, additions);
}

/** Set one dot-path in a JSON tree, OVERRIDING an existing leaf (the changes
 * variant of setJsonPath; path-shape conflicts stay conservative). */
function setJsonPathOverride(
  root: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const segments = keyPath.split(".").filter(Boolean);
  if (segments.length === 0) return;
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (next === undefined) {
      const child: Record<string, unknown> = {};
      node[segment] = child;
      node = child;
    } else if (next && typeof next === "object" && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      return; // Path shape conflict — keep the existing value.
    }
  }
  node[segments.at(-1)!] = value;
}

/**
 * Apply one CHANGES map (additions + mutations) to the current text of a
 * data file — the layer's value WINS for keys it changed (unlike
 * applyDataAdditions, where current wins). New keys land exactly like
 * additions; existing keys are rewritten in place, format-preserving where
 * the format allows (po msgstr / css declaration span; JSON re-serializes
 * like the additions path does).
 */
function applyDataChanges(
  format: DataFormat,
  current: string,
  changes: DataAdditions,
): string {
  if (changes.size === 0) return current;
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      parsed = undefined;
    }
    const root =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    for (const [keyPath, serialized] of changes) {
      let value: unknown;
      try {
        value = JSON.parse(serialized);
      } catch {
        value = serialized;
      }
      setJsonPathOverride(root, keyPath, value);
    }
    return `${JSON.stringify(root, null, 2)}\n`;
  }
  const existing = leavesOf(format, current) ?? new Map<string, string>();
  const additions: DataAdditions = new Map();
  let out = current;
  for (const [key, value] of changes) {
    if (!existing.has(key)) {
      additions.set(key, value);
      continue;
    }
    if (existing.get(key) === value) continue;
    if (format === "po") {
      out = replacePoMsgstr(out, key, value) ?? out;
      continue;
    }
    // cssvar: the key is `<selector> --<prop>`.
    const split = key.lastIndexOf(" --");
    if (split === -1) continue;
    out =
      replaceCssVar(out, key.slice(0, split), key.slice(split + 3), value) ??
      out;
  }
  return applyDataAdditions(format, out, additions);
}

/**
 * Merge SEVERAL layers' additions into the current text, bottom→top. The
 * same key added by two layers with the SAME value is fine (lands once);
 * with DIFFERENT values it is a conflict — recorded, and the BOTTOM-most
 * value stays in the output (deterministic; the conflict drives the UI).
 */
function mergeDataLayers(params: {
  format: DataFormat;
  file: string;
  current: string;
  layers: Array<{ changesetId: string; additions: DataAdditions }>;
}): { content: string; conflicts: DataKeyConflict[] } {
  const merged: DataAdditions = new Map();
  const owners = new Map<string, { changesetId: string; value: string }>();
  const conflicts: DataKeyConflict[] = [];
  for (const layer of params.layers) {
    for (const [key, value] of layer.additions) {
      const owner = owners.get(key);
      if (!owner) {
        owners.set(key, { changesetId: layer.changesetId, value });
        merged.set(key, value);
        continue;
      }
      if (owner.value === value || owner.changesetId === layer.changesetId) {
        continue;
      }
      const existing = conflicts.find((conflict) => conflict.key === key);
      if (existing) {
        if (!existing.changesetIds.includes(layer.changesetId)) {
          existing.changesetIds.push(layer.changesetId);
        }
      } else {
        conflicts.push({
          file: params.file,
          key,
          changesetIds: [owner.changesetId, layer.changesetId],
        });
      }
    }
  }
  return {
    // Changes-apply (L3): a layer's value wins for keys it CHANGED — pure
    // additions behave as before (key absent from current), and direct-edit
    // mutations override the current value, which is the point of the edit.
    content: applyDataChanges(params.format, params.current, merged),
    conflicts,
  };
}

export {
  applyDataAdditions,
  applyDataChanges,
  computeDataAdditions,
  computeDataChanges,
  mergeDataLayers,
};
export type { DataAdditions, DataKeyConflict };
