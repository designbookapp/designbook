import { describe, expect, it } from "vitest";
import { compareHtml, normalizeHtml, parseHtml } from "./normalize.ts";

describe("parseHtml", () => {
  it("parses a nested tree with attributes and text", () => {
    const tree = parseHtml(
      '<div data-list><span data-slot="price">$49.99</span></div>',
    );
    expect(tree.tag).toBe("div");
    expect(tree.attrs["data-list"]).toBe("");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].tag).toBe("span");
    expect(tree.children[0].attrs["data-slot"]).toBe("price");
    expect(tree.children[0].text).toBe("$49.99");
  });

  it("handles void img elements", () => {
    const tree = parseHtml('<div><img src="a.png" /></div>');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].tag).toBe("img");
    expect(tree.children[0].attrs.src).toBe("a.png");
  });

  it("decodes entities in text and attributes", () => {
    const tree = parseHtml("<span>Hello &lt;b&gt; &amp; co</span>");
    expect(tree.text).toBe("Hello <b> & co");
  });

  it("throws on empty input", () => {
    expect(() => parseHtml("   ")).toThrow();
  });
});

describe("compareHtml", () => {
  it("treats attribute order as irrelevant", () => {
    const a = '<div data-list data-component="x"></div>';
    const b = '<div data-component="x" data-list></div>';
    expect(compareHtml(a, b).equal).toBe(true);
  });

  it("accepts equivalent colors across hex/rgb/rgba", () => {
    const exp = '<div style="background-color: #2563eb"></div>';
    const act = '<div style="background-color: rgb(37, 99, 235)"></div>';
    expect(compareHtml(exp, act).equal).toBe(true);
  });

  it("accepts sub-pixel length drift within ±1px", () => {
    const exp = '<div style="width: 200px"></div>';
    const act = '<div style="width: 200.4px"></div>';
    expect(compareHtml(exp, act).equal).toBe(true);
  });

  it("flags a length difference beyond tolerance", () => {
    const exp = '<div style="width: 200px"></div>';
    const act = '<div style="width: 210px"></div>';
    const result = compareHtml(exp, act);
    expect(result.equal).toBe(false);
    expect(result.mismatches[0]).toMatch(/style\.width/);
  });

  it("collapses whitespace in text", () => {
    expect(compareHtml("<span>Add   to\n cart</span>", "<span>Add to cart</span>").equal).toBe(
      true,
    );
  });

  it("detects a differing token binding", () => {
    const exp = '<div data-token-background="color/primary"></div>';
    const act = '<div data-token-background="color/secondary"></div>';
    const result = compareHtml(exp, act);
    expect(result.equal).toBe(false);
    expect(result.mismatches[0]).toMatch(/data-token-background/);
  });

  it("detects a missing attribute", () => {
    const exp = '<div data-component="product.Card"></div>';
    const act = "<div></div>";
    const result = compareHtml(exp, act);
    expect(result.equal).toBe(false);
    expect(result.mismatches[0]).toMatch(/missing attribute "data-component"/);
  });

  it("detects a tag mismatch and stops recursing", () => {
    const result = compareHtml("<div><span>x</span></div>", "<div><p>x</p></div>");
    expect(result.equal).toBe(false);
    expect(result.mismatches.some((m) => /span> vs <p>/.test(m))).toBe(true);
  });

  it("detects a child-count difference", () => {
    const exp = "<div><span>a</span><span>b</span></div>";
    const act = "<div><span>a</span></div>";
    const result = compareHtml(exp, act);
    expect(result.equal).toBe(false);
    expect(result.mismatches[0]).toMatch(/child\(ren\) expected/);
  });

  it("matches multi-token style values (shadows) per token with tolerance", () => {
    const exp = '<div style="box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.25)"></div>';
    const act = '<div style="box-shadow: 0px 2.3px 4px rgba(0, 0, 0, 0.25)"></div>';
    expect(compareHtml(exp, act).equal).toBe(true);
  });
});

describe("normalizeHtml", () => {
  it("sorts attributes and re-serializes stably", () => {
    const out = normalizeHtml('<div data-list data-component="x"></div>');
    expect(out).toBe('<div data-component="x" data-list></div>');
  });
});
