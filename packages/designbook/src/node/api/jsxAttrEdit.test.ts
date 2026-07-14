/**
 * Usage-site JSX attribute edits: add / replace / remove precision, multiline
 * openings, disambiguation (className / usage line), and the spread bail-out.
 */

import { describe, expect, it } from "vitest";
import { editJsxAttribute } from "./jsxAttrEdit.ts";

const OWNER = `
export function Page() {
  return (
    <div className="wrap">
      <ProductCard title="Old" price={10} featured className="card gap-3" />
    </div>
  );
}
`;

function expectUpdated(result: ReturnType<typeof editJsxAttribute>): string {
  if (!("updated" in result)) {
    throw new Error(`expected updated, got ${JSON.stringify(result)}`);
  }
  return result.updated;
}

describe("editJsxAttribute", () => {
  it("replaces an existing string attribute in place", () => {
    const updated = expectUpdated(
      editJsxAttribute({
        source: OWNER,
        elementName: "ProductCard",
        prop: "title",
        edit: { type: "set", value: { kind: "string", value: "New Title" } },
      }),
    );
    expect(updated).toContain('title="New Title"');
    expect(updated).not.toContain('title="Old"');
    // Untouched siblings preserved byte-for-byte.
    expect(updated).toContain("price={10}");
    expect(updated).toContain('className="card gap-3"');
  });

  it("replaces a numeric attribute with a brace expression", () => {
    const updated = expectUpdated(
      editJsxAttribute({
        source: OWNER,
        elementName: "ProductCard",
        prop: "price",
        edit: { type: "set", value: { kind: "number", value: 42 } },
      }),
    );
    expect(updated).toContain("price={42}");
  });

  it("sets a bare boolean-true and an explicit boolean-false", () => {
    const t = expectUpdated(
      editJsxAttribute({
        source: '<X a="1" />',
        elementName: "X",
        prop: "featured",
        edit: { type: "set", value: { kind: "boolean", value: true } },
      }),
    );
    expect(t).toContain("<X featured a=\"1\" />");
    const f = expectUpdated(
      editJsxAttribute({
        source: "<X featured />",
        elementName: "X",
        prop: "featured",
        edit: { type: "set", value: { kind: "boolean", value: false } },
      }),
    );
    expect(f).toContain("featured={false}");
  });

  it("adds an unpassed attribute after the element name", () => {
    const updated = expectUpdated(
      editJsxAttribute({
        source: '<ProductCard title="x" />',
        elementName: "ProductCard",
        prop: "variant",
        edit: { type: "set", value: { kind: "string", value: "compact" } },
      }),
    );
    expect(updated).toBe('<ProductCard variant="compact" title="x" />');
  });

  it("removes an attribute (reset to default) and its leading space", () => {
    const updated = expectUpdated(
      editJsxAttribute({
        source: '<ProductCard title="x" featured price={3} />',
        elementName: "ProductCard",
        prop: "featured",
        edit: { type: "remove" },
      }),
    );
    expect(updated).toBe('<ProductCard title="x" price={3} />');
  });

  it("is a no-op when the value already matches", () => {
    const result = editJsxAttribute({
      source: '<X title="same" />',
      elementName: "X",
      prop: "title",
      edit: { type: "set", value: { kind: "string", value: "same" } },
    });
    expect(result).toMatchObject({ unchanged: true });
  });

  it("edits a multiline opening tag", () => {
    const source = `
<ProductCard
  title="Old"
  price={10}
/>
`;
    const updated = expectUpdated(
      editJsxAttribute({
        source,
        elementName: "ProductCard",
        prop: "price",
        edit: { type: "set", value: { kind: "number", value: 99 } },
      }),
    );
    expect(updated).toContain("price={99}");
    expect(updated).toContain('title="Old"');
  });

  it("disambiguates repeats by className", () => {
    const source = `
const tree = <><Card className="a" title="first" />
<Card className="b" title="second" /></>;
`;
    const updated = expectUpdated(
      editJsxAttribute({
        source,
        elementName: "Card",
        className: "b",
        prop: "title",
        edit: { type: "set", value: { kind: "string", value: "edited" } },
      }),
    );
    expect(updated).toContain('<Card className="b" title="edited" />');
    expect(updated).toContain('title="first"');
  });

  it("disambiguates repeats by usage line when className is absent", () => {
    const source = [
      "const tree = (",
      "  <>",
      '    <Card title="one" />',
      '    <Card title="two" />',
      "  </>",
      ");",
    ].join("\n");
    const updated = expectUpdated(
      editJsxAttribute({
        source,
        elementName: "Card",
        usageLine: 4,
        prop: "title",
        edit: { type: "set", value: { kind: "string", value: "hit" } },
      }),
    );
    expect(updated).toContain('<Card title="one" />');
    expect(updated).toContain('<Card title="hit" />');
    expect(updated).not.toContain('title="two"');
  });

  it("bails out (unresolvable) on spread props", () => {
    const result = editJsxAttribute({
      source: "<ProductCard {...props} title=\"x\" />",
      elementName: "ProductCard",
      prop: "title",
      edit: { type: "set", value: { kind: "string", value: "y" } },
    });
    expect(result).toHaveProperty("unresolvable");
  });

  it("reports unresolvable when the element is absent", () => {
    const result = editJsxAttribute({
      source: "<div />",
      elementName: "ProductCard",
      prop: "title",
      edit: { type: "set", value: { kind: "string", value: "y" } },
    });
    expect(result).toHaveProperty("unresolvable");
  });

  it("escapes a string that contains quotes via a brace expression", () => {
    const updated = expectUpdated(
      editJsxAttribute({
        source: '<X title="a" />',
        elementName: "X",
        prop: "title",
        edit: {
          type: "set",
          value: { kind: "string", value: 'has "quotes"' },
        },
      }),
    );
    expect(updated).toContain('title={"has \\"quotes\\""}');
  });
});
