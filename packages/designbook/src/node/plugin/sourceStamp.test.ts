import { describe, expect, it } from "vitest";
import {
  buildSourceStampSuffix,
  collectDeclaredComponentBindings,
  collectMemberStamps,
} from "./sourceStamp.ts";

describe("collectDeclaredComponentBindings", () => {
  it("detects each declaration form (function/const-arrow/const-fn/class/default)", () => {
    const code = [
      "export function ProductCard() {}",
      "export async function AsyncCard() {}",
      "function LocalCard() {}",
      "export const Badges = () => null;",
      "export const AsyncArrow = async () => null;",
      "const Local = (props) => null;",
      "export const Fancy = function () { return null; };",
      "export class ClassCard extends Component {}",
      "export default function DefaultCard() {}",
    ].join("\n");
    expect(collectDeclaredComponentBindings(code)).toEqual([
      "AsyncArrow",
      "AsyncCard",
      "Badges",
      "ClassCard",
      "DefaultCard",
      "Fancy",
      "Local",
      "LocalCard",
      "ProductCard",
    ]);
  });

  it("detects memo/forwardRef component bindings (React-qualified too)", () => {
    const code = [
      "const Memoed = memo(function Inner() { return null; });",
      "export const Reffed = forwardRef((props, ref) => null);",
      "const Qtip = React.memo(() => null);",
      "export const Rbox = React.forwardRef(function (p, ref) { return null; });",
    ].join("\n");
    expect(collectDeclaredComponentBindings(code)).toEqual([
      "Memoed",
      "Qtip",
      "Rbox",
      "Reffed",
    ]);
  });

  it("does NOT stamp a re-export (`export { X } from`)", () => {
    const code = 'export { PromoCard } from "./component";';
    expect(collectDeclaredComponentBindings(code)).toEqual([]);
  });

  it("does NOT stamp an import-then-export (imported binding re-exported)", () => {
    // The exact `index.tsx` wrapper collision: import the twin under an alias,
    // declare a LOCAL same-name component, re-export the local. Only the local
    // declaration is a definition site.
    const code = [
      'import { PromoCard as PromoCardComponent } from "./component";',
      "const PromoCard = () => null;",
      "export { PromoCard };",
    ].join("\n");
    expect(collectDeclaredComponentBindings(code)).toEqual(["PromoCard"]);
  });

  it("does NOT stamp a bare imported-then-re-exported name with no local decl", () => {
    const code = [
      'import { Card } from "./card";',
      "export { Card };",
    ].join("\n");
    expect(collectDeclaredComponentBindings(code)).toEqual([]);
  });

  it("skips non-component bindings (values, SCREAMING_CASE, lowercase)", () => {
    const code = [
      "export const API_URL = 'x';",
      "export const config = { a: 1 };",
      "export const Count = 42;",
      "export const Theme = { color: 'red' };",
      "const helper = () => null;",
    ].join("\n");
    expect(collectDeclaredComponentBindings(code)).toEqual([]);
  });

  it("skips an anonymous default export (no binding to stamp)", () => {
    expect(collectDeclaredComponentBindings("export default () => null;")).toEqual(
      [],
    );
    expect(
      collectDeclaredComponentBindings("export default memo(() => null);"),
    ).toEqual([]);
  });
});

describe("collectMemberStamps — compound / namespace sub-components", () => {
  it("stamps inline-object-arrow properties as DEFINE (defined here)", () => {
    // Michael's exact shape: a namespace object of inline arrows. The arrows
    // are NOT top-level bindings — only the property values React renders.
    const code = [
      "const Product = {",
      "  FromSearchResults: (props) => jsx('div', { children: props.children }),",
      "  Card: () => jsx('div', { children: 'card' }),",
      "};",
    ].join("\n");
    expect(collectMemberStamps(code)).toEqual([
      { target: "Product.Card", mode: "define" },
      { target: "Product.FromSearchResults", mode: "define" },
    ]);
  });

  it("stamps memo/forwardRef-wrapped inline properties as DEFINE", () => {
    const code = [
      "const NS = {",
      "  Card: memo(CardBase),",
      "  Row: React.forwardRef((p, ref) => null),",
      "  Fn: function () { return null; },",
      "};",
    ].join("\n");
    expect(collectMemberStamps(code)).toEqual([
      { target: "NS.Card", mode: "define" },
      { target: "NS.Fn", mode: "define" },
      { target: "NS.Row", mode: "define" },
    ]);
  });

  it("stamps method-shorthand properties as DEFINE", () => {
    const code = ["const NS = {", "  Card() { return null; },", "};"].join("\n");
    expect(collectMemberStamps(code)).toEqual([
      { target: "NS.Card", mode: "define" },
    ]);
  });

  it("stamps shorthand / identifier-alias properties as FALLBACK (don't clobber origin)", () => {
    const code = [
      'import { Card } from "./card";',
      "const NS = { Card, Row: RowBase };",
    ].join("\n");
    expect(collectMemberStamps(code)).toEqual([
      { target: "NS.Card", mode: "fallback" },
      { target: "NS.Row", mode: "fallback" },
    ]);
  });

  it("stamps top-level member-expression assignments (inline=define, alias=fallback)", () => {
    const code = [
      "Product.Card = () => jsx('div', {});",
      "Product.Row = RowBase;",
      "Product.Wrapped = memo(() => null);",
    ].join("\n");
    expect(collectMemberStamps(code)).toEqual([
      { target: "Product.Card", mode: "define" },
      { target: "Product.Row", mode: "fallback" },
      { target: "Product.Wrapped", mode: "define" },
    ]);
  });

  it("does NOT split on commas/braces inside a property value", () => {
    const code = [
      "const NS = {",
      "  Card: (props) => jsx('div', { className: 'a', style: { color: 'red' }, children: props.x }),",
      "};",
    ].join("\n");
    expect(collectMemberStamps(code)).toEqual([
      { target: "NS.Card", mode: "define" },
    ]);
  });

  it("skips non-component properties (lowercase keys, SCREAMING, non-function values)", () => {
    const code = [
      "const NS = {",
      "  card: () => null,",
      "  API_URL: 'x',",
      "  Theme: { color: 'red' },",
      "  Count: 42,",
      "  ...spread,",
      "};",
    ].join("\n");
    expect(collectMemberStamps(code)).toEqual([]);
  });

  it("a define beats a fallback for the same target", () => {
    const code = ["const NS = { Card };", "NS.Card = () => null;"].join("\n");
    expect(collectMemberStamps(code)).toEqual([
      { target: "NS.Card", mode: "define" },
    ]);
  });
});

describe("buildSourceStampSuffix", () => {
  it("emits a guarded, idempotent stamp per declared component", () => {
    const suffix = buildSourceStampSuffix(
      "export function ProductCard() {}\nexport const Badges = () => null;",
      "examples/demo/src/product/ProductCard.tsx",
    );
    expect(suffix).toContain(
      'try { Badges.__dbSource = "examples/demo/src/product/ProductCard.tsx"; } catch {}',
    );
    expect(suffix).toContain(
      'try { ProductCard.__dbSource = "examples/demo/src/product/ProductCard.tsx"; } catch {}',
    );
    // Append-only: leads with a newline so it never joins the last line.
    expect(suffix.startsWith("\n")).toBe(true);
  });

  it("returns '' for a module that declares no component", () => {
    expect(
      buildSourceStampSuffix('export { X } from "./y";', "src/barrel.ts"),
    ).toBe("");
  });

  it("stamps the two twin PromoCards to their OWN files", () => {
    const componentFile = buildSourceStampSuffix(
      "export const PromoCard = () => null;",
      "src/wrap/component.tsx",
    );
    const indexFile = buildSourceStampSuffix(
      [
        'import { PromoCard as PromoCardComponent } from "./component";',
        "const PromoCard = () => null;",
        "export { PromoCard };",
      ].join("\n"),
      "src/wrap/index.tsx",
    );
    expect(componentFile).toContain(
      'PromoCard.__dbSource = "src/wrap/component.tsx"',
    );
    expect(indexFile).toContain('PromoCard.__dbSource = "src/wrap/index.tsx"');
  });

  it("emits compound-member stamps: inline as `=`, alias as `??=`", () => {
    const suffix = buildSourceStampSuffix(
      [
        'import { Card } from "./card";',
        "const Product = {",
        "  FromSearchResults: (props) => jsx('div', { children: props.children }),",
        "  Card,",
        "};",
      ].join("\n"),
      "src/product/ns.tsx",
    );
    expect(suffix).toContain(
      'try { Product.FromSearchResults.__dbSource = "src/product/ns.tsx"; } catch {}',
    );
    // Alias to an imported binding: guarded so the origin module's stamp wins.
    expect(suffix).toContain(
      'try { Product.Card.__dbSource ??= "src/product/ns.tsx"; } catch {}',
    );
  });

  it("returns '' for a namespace of only non-component members", () => {
    expect(
      buildSourceStampSuffix(
        "const routes = { home: '/', About: '/about' };",
        "src/routes.ts",
      ),
    ).toBe("");
  });
});
