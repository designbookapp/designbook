/**
 * Info-panel presenters (PREVIEW — docs/specs/selection-context.md): the pure
 * reshapers that turn a contributor's public `facts` into the per-section
 * layouts. Pinned against the exact value strings the built-in contributors
 * emit (contributors.ts), with a plain-row fallback for unknown shapes.
 */

import { describe, expect, it } from "vitest";
import {
  contextScopeSummary,
  toContextEntry,
  toI18nRow,
  toRenderChip,
} from "./infoPresenters";

describe("toRenderChip", () => {
  it("keeps a plain dimension value as-is", () => {
    expect(toRenderChip({ label: "Locale", value: "en-US" })).toEqual({
      text: "en-US",
      follows: false,
    });
  });

  it("strips the follows-app suffix and flags it", () => {
    expect(toRenderChip({ label: "Theme", value: "light (follows app)" })).toEqual(
      { text: "light", follows: true },
    );
  });
});

describe("toI18nRow", () => {
  it("splits a rendered key's provenance from its value", () => {
    expect(
      toI18nRow({ label: "app:product.badge.deal", value: '"Deal" · rendered' }),
    ).toEqual({
      kind: "key",
      key: "app:product.badge.deal",
      value: '"Deal"',
      provenance: "rendered",
    });
  });

  it("marks declared-only and dynamic keys", () => {
    expect(
      toI18nRow({ label: "app:x", value: "declared in source, not rendered" }),
    ).toMatchObject({ kind: "key", provenance: "declared" });
    expect(
      toI18nRow({ label: "t(`a.${x}`)", value: "dynamic key — not enumerable" }),
    ).toMatchObject({ kind: "key", provenance: "dynamic" });
  });

  it("routes the hardcoded count to its own summary row", () => {
    expect(
      toI18nRow({
        label: "Hardcoded",
        value: "3 rendered string(s) without i18n markers",
      }),
    ).toEqual({
      kind: "hardcoded",
      text: "3 rendered string(s) without i18n markers",
    });
  });

  it("falls back to a plain keyed row for an unknown value", () => {
    expect(toI18nRow({ label: "app:y", value: '"Hi"' })).toEqual({
      kind: "key",
      key: "app:y",
      value: '"Hi"',
    });
  });
});

describe("context scope", () => {
  it("parses name, flags, sampled value and origin", () => {
    expect(
      toContextEntry({
        label: "ThemeContext (consumed, shadowed)",
        value: '{ mode: "dark" } — from AppShell (src/App.tsx)',
      }),
    ).toEqual({
      name: "ThemeContext",
      flags: ["consumed", "shadowed"],
      sampled: '{ mode: "dark" }',
      origin: "AppShell (src/App.tsx)",
    });
  });

  it("handles an unflagged entry with no origin", () => {
    expect(toContextEntry({ label: "LocaleContext", value: '"en-US"' })).toEqual({
      name: "LocaleContext",
      flags: [],
      sampled: '"en-US"',
      origin: undefined,
    });
  });

  it("counts total providers and consumed reads", () => {
    const facts = [
      { label: "A (consumed)", value: "1" },
      { label: "B", value: "2" },
      { label: "C (consumed, shadowed)", value: "3" },
    ];
    expect(contextScopeSummary(facts)).toEqual({ total: 3, reads: 2 });
  });
});
