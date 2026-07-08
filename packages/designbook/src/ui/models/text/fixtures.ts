/**
 * Canonical `text` model fixtures.
 *
 * ONE hardcoded dataset — a simple keyed claim, a pluralized keyed claim, and a
 * literal claim, plus the locale values and marker entries behind them — used
 * by the model's unit tests AND (later) by canvas cells that render the text
 * model without a live app. Persistence is in-memory: every `save`/`saveEntries`
 * appends to a shared `writes` log so a consumer can assert routing.
 *
 * `createTextFixture()` returns a fresh, isolated dataset each call (its own
 * `writes` log), so tests never share mutable state.
 */

import type { TextClaim, TextNodeHit } from "@designbookapp/designbook/config";
import type { TextData, TextEntry } from "./textModel";

type FixtureWrite = {
  kind: "save" | "saveEntries";
  /** The claim's key (keyed) or editPath (literal), for assertions. */
  claim: string;
  entries: TextEntry[];
};

type TextFixture = {
  /** Feed straight into `<TextProvider data={...}>` or `createTextModel`. */
  data: TextData;
  /** Every persisted write, in order (both `save` and `saveEntries`). */
  writes: FixtureWrite[];
  /** The three claims by role, for direct assertions. */
  claims: {
    keyed: TextClaim;
    plural: TextClaim;
    literal: TextClaim;
  };
  /** Active locale of the fixture catalog. */
  locale: string;
  /** Flat key→value catalog the claims resolve against. */
  localeValues: Record<string, string>;
  /**
   * A synthetic hit whose `text` equals a claim's display value, so the model's
   * default `matchClaim` resolves it without a DOM.
   */
  hitFor: (claim: TextClaim) => TextNodeHit;
};

const LOCALE = "en-US";

const LOCALE_VALUES: Record<string, string> = {
  "app.title": "Dashboard",
  "results.count_one": "{{count}} result",
  "results.count_other": "{{count}} results",
};

function createTextFixture(): TextFixture {
  const writes: FixtureWrite[] = [];

  const keyed: TextClaim = {
    adapter: "i18next",
    kind: "keyed",
    key: "app.title",
    namespace: "app",
    value: "Dashboard",
    editPath: "locales/en-US/app.json",
    label: "app.title",
    getTemplate: (key) => LOCALE_VALUES[key],
    save: async (next) => {
      writes.push({ kind: "save", claim: "app.title", entries: [{ key: "app.title", value: next }] });
    },
  };

  const pluralForms = [
    { key: "results.count_one", suffix: "_one", value: "{{count}} result" },
    { key: "results.count_other", suffix: "_other", value: "{{count}} results" },
  ];
  const plural: TextClaim = {
    adapter: "i18next",
    kind: "keyed",
    key: "results.count_other",
    namespace: "app",
    value: "3 results",
    editPath: "locales/en-US/app.json",
    label: "results.count",
    placeholders: [{ name: "count", example: "3" }],
    // Non-null stub: `planInlineCommit` escalates a plural claim to the popover
    // only when it has an anchor element (the surface computes its rect); a real
    // resolved claim always has one. No DOM in this env, so a bare object suffices.
    element: {} as HTMLElement,
    pluralForms,
    getTemplate: (key) => LOCALE_VALUES[key],
    save: async (next) => {
      writes.push({ kind: "save", claim: "results.count", entries: [{ key: "results.count_other", value: next }] });
    },
    saveEntries: async (entries) => {
      writes.push({ kind: "saveEntries", claim: "results.count", entries });
    },
  };

  const literal: TextClaim = {
    adapter: "sourceLiteral",
    kind: "literal",
    value: "Click me",
    editPath: "src/components/Button.tsx",
    line: 12,
    save: async (next) => {
      writes.push({ kind: "save", claim: "src/components/Button.tsx", entries: [{ key: "Click me", value: next }] });
    },
  };

  return {
    data: { claims: [keyed, plural, literal] },
    writes,
    claims: { keyed, plural, literal },
    locale: LOCALE,
    localeValues: { ...LOCALE_VALUES },
    hitFor: (claim) =>
      ({
        element: null as unknown as HTMLElement,
        boundary: null,
        node: null,
        text: claim.value,
        rect: { x: 0, y: 0, width: 0, height: 0 } as DOMRect,
      }) satisfies TextNodeHit,
  };
}

export { createTextFixture };
export type { FixtureWrite, TextFixture };
