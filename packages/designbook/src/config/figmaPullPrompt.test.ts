import { describe, expect, it } from "vitest";
import { formatPullPrompt } from "./figmaPullPrompt.ts";

describe("formatPullPrompt", () => {
  const html = '<span data-slot="price">$49.99</span>';

  it("is short: task line + target + footer, no inlined legend or source", () => {
    const prompt = formatPullPrompt({
      componentId: "product.ProductCard",
      sourcePath: "src/product/Card.tsx",
      html,
    });
    expect(prompt).toContain(
      "Update src/product/Card.tsx (component product.ProductCard) to match the TARGET below",
    );
    // The static boilerplate lives in the figma-pull skill now.
    expect(prompt).toContain("figma-pull skill");
    expect(prompt).toContain("read the current source before editing");
    expect(prompt).toContain("TARGET (annotated HTML from Figma):");
    expect(prompt).toContain(html);
    // Confirm footer.
    expect(prompt).toContain("ask before editing");
    // Dropped: legend + inlined source.
    expect(prompt).not.toContain("Annotation legend:");
    expect(prompt).not.toContain("CURRENT SOURCE:");
  });

  it("falls back to the component id when no source path is known", () => {
    const prompt = formatPullPrompt({ componentId: "product.ProductCard", html });
    expect(prompt).toContain(
      "Update component product.ProductCard to match the TARGET below",
    );
  });

  it("includes the render-context line when the marker carried one", () => {
    const prompt = formatPullPrompt({
      componentId: "product.ProductCard",
      sourcePath: "src/product/Card.tsx",
      html,
      render: {
        locale: "en-US",
        theme: "default",
        mode: "light",
        dimensions: { "flags:tenant": "acme", "flags:density": "compact" },
      },
    });
    expect(prompt).toContain(
      "Target was rendered with: locale en-US, theme default, mode light, flags:tenant=acme, flags:density=compact.",
    );
    // The context line explains what is NOT a design edit.
    expect(prompt).toContain("are NOT design edits");
  });

  it("renders partial context (only the fields the marker had)", () => {
    const prompt = formatPullPrompt({
      componentId: "product.ProductCard",
      html,
      render: { locale: "de-DE" },
    });
    expect(prompt).toContain("Target was rendered with: locale de-DE.");
    expect(prompt).not.toContain("theme");
  });

  it("omits the context line for old pushes without a marker context", () => {
    for (const render of [undefined, {}]) {
      const prompt = formatPullPrompt({
        componentId: "product.ProductCard",
        html,
        render,
      });
      expect(prompt).not.toContain("Target was rendered with");
    }
  });
});
