import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findUsageLine } from "@designbook-ui/models/selection/findUsageLine";

// The user's normative example, verbatim.
const productCardSource = `import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "../../../components/ui/card";
import {
  ProductBadges,
  ProductDuration,
  ProductImage,
  ProductPrice,
  ProductRating,
  ProductTagline,
  ProductTitle,
} from "../atoms";

/** Compact product card used in result grids. */
function ProductCard() {
  const { t } = useTranslation();
  return (
    <Card className="w-80 gap-3">
      <div className="relative">
        <ProductImage />
        <ProductBadges className="absolute top-2 left-2" />
      </div>
      <CardHeader className="pt-0">
        <ProductTitle />
        <ProductTagline />
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <ProductRating />
        <ProductDuration />
      </CardContent>
      <CardFooter className="justify-between">
        <ProductPrice />
        <Button size="sm">{t("product.viewTrip")}</Button>
      </CardFooter>
    </Card>
  );
}

export { ProductCard };
`;

describe("findUsageLine — ProductCard example", () => {
  it("finds the <Card> usage line by className", () => {
    expect(
      findUsageLine(productCardSource, "ProductCard", "Card", "w-80 gap-3"),
    ).toBe(18);
  });

  it("finds the <div className=\"relative\"> line", () => {
    expect(
      findUsageLine(productCardSource, "ProductCard", "div", "relative"),
    ).toBe(19);
  });

  it("finds the <ProductBadges> self-closing usage line", () => {
    expect(
      findUsageLine(
        productCardSource,
        "ProductCard",
        "ProductBadges",
        "absolute top-2 left-2",
      ),
    ).toBe(21);
  });

  it("disambiguates same-tag divs by className", () => {
    const source = [
      "function Grid() {",
      "  return (",
      '    <div className="outer">',
      '      <div className="inner">',
      "        <span />",
      "      </div>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(findUsageLine(source, "Grid", "div", "inner")).toBe(4);
    expect(findUsageLine(source, "Grid", "div", "outer")).toBe(3);
    // No className -> first occurrence.
    expect(findUsageLine(source, "Grid", "div")).toBe(3);
    // className not present anywhere -> first occurrence.
    expect(findUsageLine(source, "Grid", "div", "nope")).toBe(3);
  });

  it("matches a className that spans a multiline opening tag", () => {
    const source = [
      "function Badges() {",
      "  return (",
      "    <ProductBadges",
      '      className="absolute top-2 left-2"',
      "    />",
      "  );",
      "}",
    ].join("\n");
    expect(
      findUsageLine(source, "Badges", "ProductBadges", "absolute top-2 left-2"),
    ).toBe(3);
  });

  it("does not match a longer tag name (word boundary)", () => {
    const source = [
      "function Wrap() {",
      "  return (",
      "    <Divider />",
      '    <div className="x" />',
      "  );",
      "}",
    ].join("\n");
    // Searching for "div" must not match "<Divider".
    expect(findUsageLine(source, "Wrap", "div", "x")).toBe(4);
  });

  it("falls back to the owner definition line when the tag is absent", () => {
    expect(
      findUsageLine(productCardSource, "ProductCard", "Nonexistent"),
    ).toBe(15);
  });
});

describe("findUsageLine — real ProductCard source", () => {
  const cardPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../../examples/demo/src/composite/product/variants/Card.tsx",
  );
  const content = readFileSync(cardPath, "utf8");
  const lines = content.split("\n");

  // The demo source is a living file (the workbench text/theme tools edit it),
  // so anchor on structure, not frozen class strings: derive each element's
  // current className from the source itself, then assert findUsageLine lands
  // on that exact line.
  function classNameOf(tag: string): string {
    const match = content.match(
      new RegExp(`<${tag}[^>]*className="([^"]*)"`),
    );
    if (!match) throw new Error(`no <${tag} className=…> in Card.tsx`);
    return match[1];
  }

  it("highlights the Card, div, and ProductBadges usage lines", () => {
    const cardLine = findUsageLine(
      content,
      "ProductCard",
      "Card",
      classNameOf("Card"),
    );
    const divLine = findUsageLine(
      content,
      "ProductCard",
      "div",
      classNameOf("div"),
    );
    const badgesLine = findUsageLine(
      content,
      "ProductCard",
      "ProductBadges",
      classNameOf("ProductBadges"),
    );

    expect(lines[cardLine - 1]).toContain("<Card");
    expect(lines[divLine - 1]).toContain("<div");
    expect(lines[badgesLine - 1]).toContain("<ProductBadges");
    // The three usage lines are distinct and in source order.
    expect(cardLine).toBeLessThan(divLine);
    expect(divLine).toBeLessThan(badgesLine);
  });
});
