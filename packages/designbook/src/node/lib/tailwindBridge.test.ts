import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBridgeCss,
  darkVariantBody,
  detectTailwindMajor,
  findTailwindConfigCandidates,
  findTailwindDeclarer,
  parseMajor,
  resolveTailwindMajorFromDir,
  stripAlphaValue,
  stripTailwindDirectives,
} from "./tailwindBridge";

describe("stripAlphaValue", () => {
  it("removes ` / <alpha-value>` from rgb/hsl values", () => {
    expect(stripAlphaValue("rgb(255 255 255 / <alpha-value>)")).toBe("rgb(255 255 255)");
    expect(stripAlphaValue("hsl(var(--primary) / <alpha-value>)")).toBe("hsl(var(--primary))");
  });
  it("leaves values without the placeholder untouched", () => {
    expect(stripAlphaValue("hsl(var(--primary))")).toBe("hsl(var(--primary))");
    expect(stripAlphaValue("#a2e771")).toBe("#a2e771");
  });
});

describe("buildBridgeCss — @theme synthesis", () => {
  it("maps nested colors, DEFAULT -> parent, and numeric-key scales", () => {
    const css = buildBridgeCss({
      colors: {
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        documenso: { DEFAULT: "#A2E771", 500: "#A2E771" },
        border: "hsl(var(--border))",
      },
    });
    expect(css).toContain("--color-primary: hsl(var(--primary));");
    expect(css).toContain("--color-primary-foreground: hsl(var(--primary-foreground));");
    expect(css).toContain("--color-documenso: #A2E771;");
    expect(css).toContain("--color-documenso-500: #A2E771;");
    expect(css).toContain("--color-border: hsl(var(--border));");
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain("@theme inline {");
  });

  it("strips <alpha-value> from color leaves (cal.com preset style)", () => {
    const css = buildBridgeCss({
      colors: {
        attention: "hsl(var(--cal-bg-attention) / <alpha-value>)",
        subtle: "rgb(var(--cal-text-subtle) / <alpha-value>)",
      },
    });
    expect(css).toContain("--color-attention: hsl(var(--cal-bg-attention));");
    expect(css).toContain("--color-subtle: rgb(var(--cal-text-subtle));");
    expect(css).not.toContain("<alpha-value>");
  });

  it("skips non-string leaves (functions, numbers, null)", () => {
    const css = buildBridgeCss({
      colors: {
        good: "hsl(var(--good))",
        fn: () => "nope",
        num: 42,
        nothing: null,
      },
    });
    expect(css).toContain("--color-good: hsl(var(--good));");
    expect(css).not.toContain("--color-fn");
    expect(css).not.toContain("--color-num");
    expect(css).not.toContain("--color-nothing");
  });

  it("emits borderRadius (DEFAULT -> --radius) and fontFamily (array -> comma list)", () => {
    const css = buildBridgeCss({
      borderRadius: { DEFAULT: "0.25rem", lg: "0.5rem" },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui"],
        mono: "ui-monospace",
      },
    });
    expect(css).toContain("--radius: 0.25rem;");
    expect(css).toContain("--radius-lg: 0.5rem;");
    expect(css).toContain("--font-sans: var(--font-sans), ui-sans-serif, system-ui;");
    expect(css).toContain("--font-mono: ui-monospace;");
  });

  it("filters a trailing options object out of a fontFamily array", () => {
    const css = buildBridgeCss({
      fontFamily: { sans: [["Inter", "sans-serif"], { fontFeatureSettings: '"cv11"' }] as never },
    });
    // The nested array is not a string leaf; the options object is filtered.
    expect(css).not.toContain("fontFeatureSettings");
  });

  it("emits @source when a sourceRoot is given", () => {
    const css = buildBridgeCss({
      colors: { primary: "hsl(var(--primary))" },
      sourceRoot: "/repo/root",
    });
    expect(css).toContain('@source "/repo/root";');
  });

  it("returns empty string when there are no mappable tokens (stays inert)", () => {
    expect(buildBridgeCss({})).toBe("");
    expect(buildBridgeCss({ colors: { fn: () => "x" } })).toBe("");
  });

  it("emits @custom-variant dark for class dark mode, omits for media/undefined", () => {
    expect(
      buildBridgeCss({ colors: { a: "red" }, darkMode: "class" }),
    ).toContain("@custom-variant dark (&:is(.dark *));");
    expect(buildBridgeCss({ colors: { a: "red" }, darkMode: "media" })).not.toContain(
      "@custom-variant",
    );
    expect(buildBridgeCss({ colors: { a: "red" } })).not.toContain("@custom-variant");
  });
});

describe("darkVariantBody", () => {
  it("'class' / ['class'] -> default .dark ancestor selector", () => {
    expect(darkVariantBody("class")).toBe("&:is(.dark *)");
    expect(darkVariantBody(["class"])).toBe("&:is(.dark *)");
  });
  it("['selector', custom] -> custom ancestor selector", () => {
    expect(darkVariantBody(["selector", ".theme-dark"])).toBe("&:is(.theme-dark *)");
  });
  it("['variant', selector] -> the raw selector (documenso form)", () => {
    expect(darkVariantBody(["variant", "&:is(.dark:not(.dark-mode-disabled) *)"])).toBe(
      "&:is(.dark:not(.dark-mode-disabled) *)",
    );
  });
  it("['variant', [sel1, sel2]] -> comma-joined", () => {
    expect(darkVariantBody(["variant", ["&:is(.dark *)", ".night &"]])).toBe(
      "&:is(.dark *), .night &",
    );
  });
  it("media / undefined -> undefined", () => {
    expect(darkVariantBody("media")).toBeUndefined();
    expect(darkVariantBody(undefined)).toBeUndefined();
  });
});

describe("stripTailwindDirectives", () => {
  it("removes @tailwind base/components/utilities lines only", () => {
    const input = [
      "@tailwind base;",
      "@tailwind components;",
      "@tailwind utilities;",
      "",
      ":root { --primary: 95 71% 67%; }",
    ].join("\n");
    const out = stripTailwindDirectives(input);
    expect(out).not.toContain("@tailwind");
    expect(out).toContain(":root { --primary: 95 71% 67%; }");
  });
  it("leaves @apply / @layer untouched", () => {
    const input = "@tailwind base;\n@layer base { * { @apply border-border; } }";
    const out = stripTailwindDirectives(input);
    expect(out).not.toContain("@tailwind base;");
    expect(out).toContain("@layer base");
    expect(out).toContain("@apply border-border");
  });
  it("handles indented directives and does not touch @tailwindcss elsewhere", () => {
    const input = "  @tailwind utilities;\n.x { background: url(@tailwind.png); }";
    const out = stripTailwindDirectives(input);
    expect(out).not.toContain("@tailwind utilities;");
    expect(out).toContain("url(@tailwind.png)");
  });
});

describe("parseMajor", () => {
  it("extracts the leading integer from ranges", () => {
    expect(parseMajor("3.4.19")).toBe(3);
    expect(parseMajor("^3.4.0")).toBe(3);
    expect(parseMajor("~4.1.17")).toBe(4);
    expect(parseMajor(">=3.0.0 <4")).toBe(3);
  });
  it("undefined for missing / unparseable", () => {
    expect(parseMajor(undefined)).toBeUndefined();
    expect(parseMajor("latest")).toBeUndefined();
  });
});

describe("version + config detection (fs)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-twbridge-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detects the declared major from a nested workspace member (documenso shape)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    mkdirSync(join(dir, "packages/tailwind-config"), { recursive: true });
    writeFileSync(
      join(dir, "packages/tailwind-config/package.json"),
      JSON.stringify({ dependencies: { tailwindcss: "^3.4.0" } }),
    );
    expect(findTailwindDeclarer(dir, dir)).toBe(
      join(dir, "packages/tailwind-config/package.json"),
    );
    // Plant an installed tailwindcss v3 reachable from the declaring member so
    // the resolved-version path is deterministic (the ambient env may hoist a
    // v4 elsewhere).
    mkdirSync(join(dir, "packages/tailwind-config/node_modules/tailwindcss"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "packages/tailwind-config/node_modules/tailwindcss/package.json"),
      JSON.stringify({ name: "tailwindcss", version: "3.4.19" }),
    );
    expect(detectTailwindMajor(dir, dir)).toBe(3);
  });

  it("resolves the major per-directory (mixed-major monorepo: docs v4, ui v3)", () => {
    // Mirrors documenso: apps/docs installs Tailwind v4 while packages/ui uses v3.
    for (const [member, ver] of [
      ["apps/docs", "4.2.3"],
      ["packages/ui", "3.4.19"],
    ] as const) {
      const nm = join(dir, member, "node_modules/tailwindcss");
      mkdirSync(nm, { recursive: true });
      writeFileSync(join(dir, member, "package.json"), JSON.stringify({ name: member }));
      writeFileSync(
        join(nm, "package.json"),
        JSON.stringify({ name: "tailwindcss", version: ver }),
      );
    }
    expect(resolveTailwindMajorFromDir(join(dir, "apps/docs"))).toBe(4);
    expect(resolveTailwindMajorFromDir(join(dir, "packages/ui"))).toBe(3);
  });

  it("returns undefined when no repo package declares tailwind", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { react: "19" } }),
    );
    expect(detectTailwindMajor(dir, dir)).toBeUndefined();
  });

  it("finds config candidates in the chain and workspace members, non-TS first", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    mkdirSync(join(dir, "packages/ui"), { recursive: true });
    mkdirSync(join(dir, "packages/app"), { recursive: true });
    writeFileSync(join(dir, "packages/ui/tailwind.config.cjs"), "module.exports={}");
    writeFileSync(join(dir, "packages/app/tailwind.config.ts"), "export default {}");
    const candidates = findTailwindConfigCandidates(dir, dir);
    expect(candidates).toContain(join(dir, "packages/ui/tailwind.config.cjs"));
    expect(candidates).toContain(join(dir, "packages/app/tailwind.config.ts"));
    // within packages/app the .ts is the only one; ordering only matters within a dir
  });
});
