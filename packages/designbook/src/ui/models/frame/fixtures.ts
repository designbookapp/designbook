/**
 * Canonical `frame` model fixtures.
 *
 * ONE hardcoded dataset — a null iframe (no live app in a node/cell context), a
 * base generation, and a representative route — plus a component/DOM frame hit
 * for exercising the pure hit ops. Used by the model's unit tests AND (later) by
 * cells. `createFrameFixture` returns a fresh dataset each call whose
 * `open`/`ignoreNextNavigation` append to shared logs so a consumer can assert
 * routing.
 */

import type { FrameHit } from "./appFrameHit";
import type { FrameData } from "./frameModel";

type FrameFixture = {
  /** Feed straight into `<FrameProvider data={...}>` or `createFrameModel`. */
  data: FrameData;
  /** Every `open(path)` call, in order. */
  opens: string[];
  /** Count of `ignoreNextNavigation()` calls. */
  ignores: number;
  open: (path: string) => void;
  ignoreNextNavigation: () => void;
  /** A component-level frame hit (Go-to-component applies, prompt-prefill rich). */
  componentHit: FrameHit;
  /** A plain DOM frame hit (no Go-to-component; prompt-prefill degrades). */
  domHit: FrameHit;
};

function createFrameFixture(): FrameFixture {
  const opens: string[] = [];
  const fixture: FrameFixture = {
    data: { iframe: null, generation: 0, path: "/products" },
    opens,
    ignores: 0,
    open: (path) => opens.push(path),
    ignoreNextNavigation: () => {
      fixture.ignores += 1;
    },
    componentHit: {
      kind: "component",
      name: "ProductCard",
      entry: {
        id: "product.ProductCard",
        label: "ProductCard",
        sourcePath: "src/composite/product/ProductCard.tsx",
        key: "ProductCard",
      },
      codeTarget: {
        file: "src/pages/Products.tsx",
        ownerExportName: "ProductsPage",
        name: "ProductCard",
        kind: "component",
        className: "featured",
      },
    },
    domHit: {
      kind: "dom",
      name: "button",
      entry: {
        id: "product.ProductCard",
        label: "ProductCard",
        sourcePath: "src/composite/product/ProductCard.tsx",
        key: "ProductCard",
      },
      dom: { tag: "button", classes: ["cta"] },
    },
  };
  return fixture;
}

export { createFrameFixture };
export type { FrameFixture };
