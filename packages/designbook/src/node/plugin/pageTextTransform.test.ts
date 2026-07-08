import { describe, expect, it } from "vitest";
import { isTranslateCallee, transformPageText } from "./pageTextTransform";

/** Run the transform and return the rewritten code (or the input when null). */
function run(code: string): string {
  const result = transformPageText(code, "/app/src/File.tsx");
  return result ? result.code : code;
}

describe("transformPageText — call-site wrapping", () => {
  it("wraps a bare i18next t() call, carrying the literal key expression", () => {
    const out = run(`const s = t("greeting.title");`);
    expect(out).toContain(`__dbMark(t("greeting.title"), "greeting.title")`);
    expect(out).toContain(
      `import { __dbMark } from "/@id/virtual:designbook-mark";`,
    );
  });

  it("keeps the full call (options preserved) but attributes only the key", () => {
    const out = run(`t("k", { count: n, ns: "app" })`);
    expect(out).toContain(`__dbMark(t("k", { count: n, ns: "app" }), "k")`);
  });

  it("wraps member calls i18n.t() and i18next.t()", () => {
    expect(run(`i18n.t("a")`)).toContain(`__dbMark(i18n.t("a"), "a")`);
    expect(run(`i18next.t("b")`)).toContain(`__dbMark(i18next.t("b"), "b")`);
  });

  it("wraps the Lingui compiled form i18n._()", () => {
    const out = run(`const label = i18n._("Hello world");`);
    expect(out).toContain(`__dbMark(i18n._("Hello world"), "Hello world")`);
  });

  it("attributes a DYNAMIC key by copying the first-arg expression verbatim", () => {
    const out = run(`t(varKey)`);
    expect(out).toContain(`__dbMark(t(varKey), varKey)`);
  });

  it("handles a computed/member dynamic key expression", () => {
    const out = run(`t(keys[locale] + suffix)`);
    expect(out).toContain(`__dbMark(t(keys[locale] + suffix), keys[locale] + suffix)`);
  });

  it("wraps nested t() calls independently", () => {
    const out = run(`t("outer", { defaultValue: t("inner") })`);
    expect(out).toContain(`__dbMark(t("inner"), "inner")`);
    expect(out).toContain(`__dbMark(`);
    // The outer wrap's key is the literal "outer" (not the nested call).
    expect(out).toMatch(/__dbMark\(t\("outer",[\s\S]*\), "outer"\)/);
  });

  it("only injects the import once", () => {
    const out = run(`t("a"); t("b");`);
    expect(out.match(/virtual:designbook-mark/g)).toHaveLength(1);
  });
});

describe("transformPageText — non-matches", () => {
  it("returns null when there is nothing to wrap", () => {
    expect(transformPageText(`const x = 1;`, "/app/src/x.ts")).toBeNull();
    expect(transformPageText(`foo("a")`, "/app/src/x.ts")).toBeNull();
  });

  it("skips a spread first argument (can't attribute a key)", () => {
    const out = run(`t(...keys)`);
    expect(out).toBe(`t(...keys)`);
  });

  it("skips a zero-arg call", () => {
    // `t()` has no key; pre-filter still parses but nothing is wrapped.
    const result = transformPageText(`t()`, "/app/src/x.ts");
    expect(result).toBeNull();
  });

  it("does not choke on a computed member `._` lookalike via bracket", () => {
    // `obj["_"](x)` is computed → not matched.
    const out = run(`obj["_"]("a")`);
    expect(out).toBe(`obj["_"]("a")`);
  });

  it("returns null on unparseable input rather than throwing", () => {
    expect(transformPageText(`t( "a" @@@ `, "/app/src/x.ts")).toBeNull();
  });
});

describe("isTranslateCallee", () => {
  it("matches bare t, member .t and ._; rejects others", () => {
    expect(isTranslateCallee({ type: "Identifier", name: "t" })).toBe(true);
    expect(isTranslateCallee({ type: "Identifier", name: "translate" })).toBe(false);
    expect(
      isTranslateCallee({
        type: "MemberExpression",
        computed: false,
        property: { type: "Identifier", name: "t" },
      }),
    ).toBe(true);
    expect(
      isTranslateCallee({
        type: "MemberExpression",
        computed: false,
        property: { type: "Identifier", name: "_" },
      }),
    ).toBe(true);
    expect(
      isTranslateCallee({
        type: "MemberExpression",
        computed: true,
        property: { type: "Identifier", name: "t" },
      }),
    ).toBe(false);
  });
});
