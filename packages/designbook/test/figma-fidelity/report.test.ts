import { describe, expect, it } from "vitest";
import {
  renderReport,
  summarize,
  escapeHtml,
  type CaseOutcome,
  type RunReport,
} from "./report.ts";

function outcome(partial: Partial<CaseOutcome> & { id: string }): CaseOutcome {
  return { status: "pass", warnings: [], ...partial };
}

describe("summarize", () => {
  it("tallies each status and total", () => {
    const s = summarize([
      outcome({ id: "a", status: "pass" }),
      outcome({ id: "b", status: "fail" }),
      outcome({ id: "c", status: "new" }),
      outcome({ id: "d", status: "error" }),
      outcome({ id: "e", status: "skip" }),
    ]);
    expect(s).toEqual({ pass: 1, fail: 1, new: 1, error: 1, skip: 1, total: 5 });
  });
});

describe("escapeHtml", () => {
  it("escapes markup metacharacters", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

describe("renderReport", () => {
  const base: RunReport = {
    meta: {
      file: "Test File",
      page: "Page 1",
      commit: "abc1234",
      port: 8791,
      startedAt: "2026-07-08T00:00:00.000Z",
      durationMs: 12_300,
    },
    cases: [
      outcome({
        id: "solid-bg",
        note: "n",
        status: "pass",
        tier1: { equal: true, mismatches: [], baseline: "approved" },
        browserPng: "solid-bg/browser.png",
        figmaPng: "solid-bg/figma.png",
      }),
      outcome({
        id: "text-basic",
        status: "fail",
        tier1: {
          equal: false,
          mismatches: ["div @style.color: expected x, got y", "second"],
          baseline: "approved",
        },
      }),
      outcome({
        id: "token-colors",
        status: "new",
        tier1: { equal: false, mismatches: [], baseline: "missing" },
      }),
    ],
  };

  it("produces a self-contained HTML doc with the summary and rows", () => {
    const html = renderReport(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("1 pass");
    expect(html).toContain("1 fail");
    expect(html).toContain("1 new");
    expect(html).toContain("solid-bg");
    expect(html).toContain("Test File");
    expect(html).toContain("abc1234");
    // No external resource references (CSP-clean, offline).
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("shows the first mismatch and a +more indicator for a failure", () => {
    const html = renderReport(base);
    expect(html).toContain("div @style.color: expected x, got y");
    expect(html).toContain("+1 more");
  });

  it("prompts approve for a missing baseline", () => {
    const html = renderReport(base);
    expect(html).toContain("--approve token-colors");
  });
});
