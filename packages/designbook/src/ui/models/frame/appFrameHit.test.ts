import { describe, expect, it } from "vitest";
import {
  buildFramePromptPrefill,
  canGoToFrameComponent,
  domLabel,
  type FrameHit,
} from "@designbook-ui/models/frame/appFrameHit";

const componentHit: FrameHit = {
  kind: "component",
  name: "ProductCard",
  entry: {
    id: "product.ProductCard",
    label: "Product · ProductCard",
    sourcePath: "src/composite/product/variants/Card.tsx",
    key: "ProductCard",
  },
};

const domHit: FrameHit = {
  kind: "dom",
  name: "span",
  entry: componentHit.entry,
  dom: { tag: "span", classes: ["price"] },
};

describe("canGoToFrameComponent", () => {
  it("is true for a component-level hit", () => {
    expect(canGoToFrameComponent(componentHit)).toBe(true);
  });

  it("is false for a plain DOM drill level", () => {
    expect(canGoToFrameComponent(domHit)).toBe(false);
  });
});

describe("domLabel", () => {
  it("prefers an id", () => {
    expect(domLabel({ tag: "div", id: "hero" })).toBe("div#hero");
  });

  it("falls back to the first class", () => {
    expect(domLabel({ tag: "span", classes: ["price", "muted"] })).toBe(
      "span.price",
    );
  });

  it("falls back to the bare tag", () => {
    expect(domLabel({ tag: "section" })).toBe("section");
  });
});

describe("buildFramePromptPrefill", () => {
  it("uses the usage-line codeTarget when the hit is drilled", () => {
    const hit: FrameHit = {
      ...componentHit,
      codeTarget: {
        file: "src/pages/Trips.tsx",
        ownerExportName: "Trips",
        name: "ProductCard",
        kind: "component",
        className: "featured",
      },
    };
    expect(buildFramePromptPrefill(hit)).toBe(
      'Re: Product · ProductCard\nUsed in src/pages/Trips.tsx as <ProductCard className="featured">\n\n',
    );
  });

  it("falls back to the source path for a fresh (non-drilled) component hit", () => {
    expect(buildFramePromptPrefill(componentHit)).toBe(
      "Re: Product · ProductCard (src/composite/product/variants/Card.tsx)\n\n",
    );
  });

  it("describes a plain DOM hit by its owning component", () => {
    expect(buildFramePromptPrefill(domHit)).toBe(
      "Re: span.price element inside <Product · ProductCard> (not a registered component)\n\n",
    );
  });
});
