import { describe, expect, it } from "vitest";
import { replaceCssVar } from "./cssVarEdit";

const sample = `@theme inline {
  --color-primary: var(--primary);
}

:root {
  --primary: oklch(0.5 0.19 258);
  --primary-foreground: oklch(0.985 0 0);
  --radius: 0.625rem;
}

.dark {
  --primary: oklch(0.68 0.16 258);
}
`;

describe("replaceCssVar", () => {
  it("replaces an oklch value in :root with a one-line diff", () => {
    const result = replaceCssVar(
      sample,
      ":root",
      "primary",
      "oklch(0.6 0.2 30)",
    );
    expect(result).toBe(
      sample.replace(
        "--primary: oklch(0.5 0.19 258);",
        "--primary: oklch(0.6 0.2 30);",
      ),
    );
  });

  it("replaces the same var inside the .dark block only", () => {
    const result = replaceCssVar(
      sample,
      ".dark",
      "primary",
      "oklch(0.7 0.2 30)",
    );
    expect(result).toBe(
      sample.replace(
        "--primary: oklch(0.68 0.16 258);",
        "--primary: oklch(0.7 0.2 30);",
      ),
    );
    // The :root primary is untouched.
    expect(result).toContain("--primary: oklch(0.5 0.19 258);");
  });

  it("does not match a longer property name (--primary vs --primary-foreground)", () => {
    const result = replaceCssVar(sample, ":root", "primary", "red");
    expect(result).toContain("--primary: red;");
    expect(result).toContain("--primary-foreground: oklch(0.985 0 0);");
  });

  it("returns undefined for a missing selector", () => {
    expect(replaceCssVar(sample, ".light", "primary", "red")).toBeUndefined();
  });

  it("returns undefined for a missing property", () => {
    expect(replaceCssVar(sample, ":root", "nope", "red")).toBeUndefined();
  });

  it("ignores the @theme block when targeting :root", () => {
    const result = replaceCssVar(sample, ":root", "primary", "red");
    // The @theme alias must be preserved verbatim.
    expect(result).toContain("--color-primary: var(--primary);");
  });
});
