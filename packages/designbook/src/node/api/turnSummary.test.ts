/**
 * Agent-supplied turn summaries + branch titles (turnSummary.ts): the
 * working turn ends its reply with `Summary:` (+ optional `Title:`) —
 * parsed at turn end, stripped from display, fork names derive from the
 * creating prompt.
 */

import { describe, expect, it } from "vitest";
import {
  forkTitleFromPrompt,
  parseTurnSummary,
  SUMMARY_PROMPT_INSTRUCTION,
} from "./turnSummary.ts";

describe("parseTurnSummary", () => {
  it("parses + strips a trailing Summary line", () => {
    const parsed = parseTurnSummary(
      "Made the card red.\n\nSummary: made the product card red",
    );
    expect(parsed.summary).toBe("made the product card red");
    expect(parsed.title).toBeUndefined();
    expect(parsed.cleaned).toBe("Made the card red.");
  });

  it("parses Summary + optional Title in either order", () => {
    const parsed = parseTurnSummary(
      "Done.\nTitle: Red card\nSummary: reworked the palette",
    );
    expect(parsed.summary).toBe("reworked the palette");
    expect(parsed.title).toBe("Red card");
    expect(parsed.cleaned).toBe("Done.");
  });

  it("only reads the reply's TAIL — a quoted mid-text 'Summary:' stays", () => {
    const body = [
      "The doc says:",
      "Summary: this is quoted content",
      ...Array.from({ length: 10 }, (_, i) => `line ${i}`),
    ].join("\n");
    const parsed = parseTurnSummary(body);
    expect(parsed.summary).toBeUndefined();
    expect(parsed.cleaned).toBe(body);
  });

  it("caps runaway metadata to one line", () => {
    const parsed = parseTurnSummary(
      `ok\nSummary: ${"very long ".repeat(40)}`,
    );
    expect(parsed.summary!.length).toBeLessThanOrEqual(160);
    expect(parsed.summary!.endsWith("…")).toBe(true);
  });

  it("no metadata = untouched reply", () => {
    const parsed = parseTurnSummary("Just an answer, no changes.");
    expect(parsed.summary).toBeUndefined();
    expect(parsed.cleaned).toBe("Just an answer, no changes.");
  });

  it("the prompt instruction asks for Summary and marks Title optional", () => {
    expect(SUMMARY_PROMPT_INSTRUCTION).toContain("Summary:");
    expect(SUMMARY_PROMPT_INSTRUCTION).toContain("Title:");
    expect(SUMMARY_PROMPT_INSTRUCTION.toLowerCase()).toContain("optionally");
  });
});

describe("forkTitleFromPrompt", () => {
  it("truncates the creating prompt to 10 chars", () => {
    expect(forkTitleFromPrompt("Make the hero section bigger")).toBe(
      "Make the h…",
    );
  });
  it("keeps short prompts whole and flattens whitespace", () => {
    expect(forkTitleFromPrompt("Fix nav")).toBe("Fix nav");
    expect(forkTitleFromPrompt("  Fix\n nav  ")).toBe("Fix nav");
  });
  it("empty prompt = undefined (caller keeps the id fallback)", () => {
    expect(forkTitleFromPrompt("")).toBeUndefined();
    expect(forkTitleFromPrompt(undefined)).toBeUndefined();
  });
});
