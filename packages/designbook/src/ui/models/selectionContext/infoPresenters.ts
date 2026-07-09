/**
 * Display-only presenters for the Info panel (PREVIEW — docs/specs/
 * selection-context.md). Pure functions that reshape a contributor's public
 * `facts` into the wireframe's per-section layouts WITHOUT touching the
 * contribution data shape or the model `prompt`: render-context → chips, i18n →
 * keyed rows with a provenance suffix, context-scope → a summary + provider
 * rows with sampled values behind a disclosure.
 *
 * The parsers key off the exact value strings the built-in contributors emit
 * (contributors.ts); unknown shapes fall back to a plain key/value row so a
 * plugin section still renders. Kept React-free so it can be unit-tested
 * directly (see infoPresenters.test.ts).
 */

import type { SelectionContextFact } from "./types";

// --- render context: value → chip ------------------------------------------

/** A render-context dimension rendered as a pill. */
type RenderChip = {
  /** The dimension value, e.g. "en-US" / "light" / "acme". */
  text: string;
  /** True when the value tracks the running app ("(follows app)" suffix). */
  follows: boolean;
};

const FOLLOWS_SUFFIX = " (follows app)";

function toRenderChip(fact: SelectionContextFact): RenderChip {
  if (fact.value.endsWith(FOLLOWS_SUFFIX)) {
    return { text: fact.value.slice(0, -FOLLOWS_SUFFIX.length), follows: true };
  }
  return { text: fact.value, follows: false };
}

// --- i18n: keyed row + provenance suffix -----------------------------------

/** Provenance tag rendered as a faint suffix on an i18n row. */
type I18nProvenance = "rendered" | "declared" | "dynamic";

/** A parsed i18n row: either the hardcoded-strings summary or a keyed row. */
type I18nRow =
  | { kind: "hardcoded"; text: string }
  | {
      kind: "key";
      key: string;
      value: string;
      provenance?: I18nProvenance;
    };

const RENDERED_SUFFIX = " · rendered";
const DECLARED_VALUE = "declared in source, not rendered";
const DYNAMIC_VALUE = "dynamic key — not enumerable";

function toI18nRow(fact: SelectionContextFact): I18nRow {
  if (fact.label === "Hardcoded") {
    return { kind: "hardcoded", text: fact.value };
  }
  if (fact.value.endsWith(RENDERED_SUFFIX)) {
    return {
      kind: "key",
      key: fact.label,
      value: fact.value.slice(0, -RENDERED_SUFFIX.length),
      provenance: "rendered",
    };
  }
  if (fact.value === DECLARED_VALUE) {
    return { kind: "key", key: fact.label, value: "—", provenance: "declared" };
  }
  if (fact.value === DYNAMIC_VALUE) {
    return { kind: "key", key: fact.label, value: "—", provenance: "dynamic" };
  }
  return { kind: "key", key: fact.label, value: fact.value };
}

// --- context scope: summary + provider rows --------------------------------

/** A parsed context-scope provider row. */
type ContextEntry = {
  /** Context display name, e.g. "ThemeContext". */
  name: string;
  /** Suffix markers, e.g. ["consumed", "shadowed"]. */
  flags: string[];
  /** Sampled provider value (collapsed behind the section disclosure). */
  sampled: string;
  /** Where the provider comes from, e.g. "AppShell (src/App.tsx)". */
  origin?: string;
};

const ORIGIN_SEP = " — from ";

function toContextEntry(fact: SelectionContextFact): ContextEntry {
  const flagsMatch = fact.label.match(/^(.*?)\s+\(([^)]*)\)\s*$/);
  const name = flagsMatch ? flagsMatch[1] : fact.label;
  const flags = flagsMatch ? flagsMatch[2].split(", ").filter(Boolean) : [];

  const sepIndex = fact.value.indexOf(ORIGIN_SEP);
  const sampled = sepIndex >= 0 ? fact.value.slice(0, sepIndex) : fact.value;
  const origin =
    sepIndex >= 0 ? fact.value.slice(sepIndex + ORIGIN_SEP.length) : undefined;

  return { name, flags, sampled, origin };
}

/** Providers-in-scope count + how many the selection consumes. */
function contextScopeSummary(facts: SelectionContextFact[]): {
  total: number;
  reads: number;
} {
  const reads = facts.filter((fact) => /\bconsumed\b/.test(fact.label)).length;
  return { total: facts.length, reads };
}

export { contextScopeSummary, toContextEntry, toI18nRow, toRenderChip };
export type { ContextEntry, I18nProvenance, I18nRow, RenderChip };
