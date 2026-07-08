import { describe, expect, it } from "vitest";
import { findDefinitionLine } from "@designbook-ui/models/selection/findDefinitionLine";

describe("findDefinitionLine", () => {
  it("finds a plain function declaration", () => {
    const source = ["import x from 'y';", "", "function Card() {}"].join("\n");
    expect(findDefinitionLine(source, "Card")).toBe(3);
  });

  it("finds an exported const arrow component", () => {
    const source = [
      "// header",
      "export const ProductCard = () => {",
      "};",
    ].join("\n");
    expect(findDefinitionLine(source, "ProductCard")).toBe(2);
  });

  it("finds an export default async function", () => {
    const source = ["", "export default async function Page() {}"].join("\n");
    expect(findDefinitionLine(source, "Page")).toBe(2);
  });

  it("finds a class declaration", () => {
    const source = ["class Boundary extends Component {}"].join("\n");
    expect(findDefinitionLine(source, "Boundary")).toBe(1);
  });

  it("skips usages before the definition", () => {
    const source = [
      "// Card is great",
      "type CardProps = {};",
      "function Card(props: CardProps) {}",
    ].join("\n");
    // Line 1 mentions "Card" but only line 3 declares it.
    expect(findDefinitionLine(source, "Card")).toBe(3);
  });

  it("falls back to the first occurrence when there is no declaration", () => {
    const source = [
      "import { Card } from './card';",
      "export { Card };",
    ].join("\n");
    expect(findDefinitionLine(source, "Card")).toBe(1);
  });

  it("falls back to line 1 when the name never appears", () => {
    const source = "const other = 1;\nexport { other };";
    expect(findDefinitionLine(source, "Missing")).toBe(1);
  });

  it("falls back to line 1 without an export name", () => {
    expect(findDefinitionLine("function Card() {}")).toBe(1);
  });

  it("does not match names that only share a prefix", () => {
    const source = [
      "function CardHeader() {}",
      "function Card() {}",
    ].join("\n");
    expect(findDefinitionLine(source, "Card")).toBe(2);
  });
});
