import { describe, expect, it } from "vitest";
import {
  collectRootCustomProps,
  type RootMatchDeps,
  type SheetLike,
} from "./pageRootTokens";

// ---------------------------------------------------------------------------
// Minimal stubbed CSSOM, in the spirit of fiberContext.test.ts stubbing
// `document`. We build the exact rule shapes the collector reads: style rules
// (`selectorText` + a declaration array-like with `getPropertyValue`), and
// grouping rules (`cssRules`, plus `media` for `@media`).
// ---------------------------------------------------------------------------

/** A style declaration exposing custom props like a real CSSStyleDeclaration. */
function decl(props: Record<string, string>) {
  const names = Object.keys(props);
  const style: Record<string | number, unknown> = {
    length: names.length,
    getPropertyValue: (name: string) => props[name] ?? "",
  };
  names.forEach((name, i) => {
    style[i] = name;
  });
  return style;
}

/** A `selector { …props… }` style rule. */
function styleRule(selectorText: string, props: Record<string, string>) {
  return { selectorText, style: decl(props) };
}

/** A grouping rule (`@layer`/`@media`/…) wrapping nested rules. */
function groupRule(children: unknown[], media?: string) {
  const cssRules = children as never[];
  return media ? { cssRules, media: { mediaText: media } } : { cssRules };
}

/** A stylesheet whose `.cssRules` is the given rule list. */
function sheet(rules: unknown[]): SheetLike {
  return { cssRules: rules as never };
}

/** A stylesheet that throws on `.cssRules` access (cross-origin). */
function crossOriginSheet(): SheetLike {
  return {
    get cssRules(): never {
      throw new DOMException("cross-origin", "SecurityError");
    },
  } as SheetLike;
}

/** Deps: root selectors are `:root`/`html`; `@media` conditions in `matching`. */
function deps(matchingMedia: string[] = []): RootMatchDeps {
  return {
    matchesRoot: (sel) => sel === ":root" || sel === "html",
    mediaMatches: (cond) => matchingMedia.includes(cond),
  };
}

describe("collectRootCustomProps", () => {
  it("collects custom props from a bare :root rule", () => {
    const map = collectRootCustomProps(
      [sheet([styleRule(":root", { "--spacing": "0.25rem", "--radius": "8px" })])],
      deps(),
    );
    expect(map.get("--spacing")).toBe("0.25rem");
    expect(map.get("--radius")).toBe("8px");
    expect(map.size).toBe(2);
  });

  it("ignores non-root selectors and non-custom properties", () => {
    const map = collectRootCustomProps(
      [
        sheet([
          styleRule(".card", { "--local": "nope" }),
          styleRule(":root", { color: "red", "--tok": "yes" }),
        ]),
      ],
      deps(),
    );
    expect(map.has("--local")).toBe(false);
    expect(map.has("color")).toBe(false);
    expect(map.get("--tok")).toBe("yes");
  });

  it("later declarations win (document order)", () => {
    const map = collectRootCustomProps(
      [
        sheet([styleRule(":root", { "--c": "first" })]),
        sheet([styleRule(":root", { "--c": "second" })]),
      ],
      deps(),
    );
    expect(map.get("--c")).toBe("second");
  });

  it("later win also holds within a single sheet", () => {
    const map = collectRootCustomProps(
      [
        sheet([
          styleRule("html", { "--c": "a" }),
          styleRule(":root", { "--c": "b" }),
        ]),
      ],
      deps(),
    );
    expect(map.get("--c")).toBe("b");
  });

  it("recurses into nested @layer (Tailwind v4 wraps theme in @layer)", () => {
    const map = collectRootCustomProps(
      [
        sheet([
          groupRule([
            groupRule([styleRule(":root", { "--font-sans": "Inter" })]),
          ]),
        ]),
      ],
      deps(),
    );
    expect(map.get("--font-sans")).toBe("Inter");
  });

  it("includes a matching @media block and skips a non-matching one", () => {
    const rules = [
      styleRule(":root", { "--c": "light" }),
      groupRule(
        [styleRule(":root", { "--c": "dark" })],
        "(prefers-color-scheme: dark)",
      ),
      groupRule([styleRule(":root", { "--w": "wide" })], "(min-width: 900px)"),
    ];
    // Only the dark media matches -> --c becomes dark; wide media excluded.
    const map = collectRootCustomProps(
      [sheet(rules)],
      deps(["(prefers-color-scheme: dark)"]),
    );
    expect(map.get("--c")).toBe("dark");
    expect(map.has("--w")).toBe(false);

    // Neither media matches -> --c stays light.
    const map2 = collectRootCustomProps([sheet(rules)], deps());
    expect(map2.get("--c")).toBe("light");
  });

  it("skips cross-origin sheets without throwing, keeps the rest", () => {
    const map = collectRootCustomProps(
      [
        crossOriginSheet(),
        sheet([styleRule(":root", { "--ok": "1" })]),
      ],
      deps(),
    );
    expect(map.get("--ok")).toBe("1");
    expect(map.size).toBe(1);
  });

  it("collects from adoptedStyleSheets passed after document sheets (adopted wins)", () => {
    // Caller convention: document.styleSheets first, adoptedStyleSheets last.
    const documentSheets = [sheet([styleRule(":root", { "--c": "doc" })])];
    const adopted = [sheet([styleRule(":root", { "--c": "adopted" })])];
    const map = collectRootCustomProps([...documentSheets, ...adopted], deps());
    expect(map.get("--c")).toBe("adopted");
  });

  it("matches a multi-selector list where one part is :root (@theme's :root, :host)", () => {
    const map = collectRootCustomProps(
      [sheet([styleRule(":root, :host", { "--tok": "themed" })])],
      // deps only matches bare :root; the list is split on the top-level comma.
      deps(),
    );
    expect(map.get("--tok")).toBe("themed");
  });

  it("does not split commas nested inside :is()/:where() (no false root match)", () => {
    const map = collectRootCustomProps(
      [sheet([styleRule(":is(.a, .b) .card", { "--x": "no" })])],
      deps(),
    );
    expect(map.has("--x")).toBe(false);
  });

  it("gates class/attr theme selectors on documentElement.matches", () => {
    const rules = [
      styleRule(":root", { "--c": "light" }),
      styleRule(':root[data-theme="dark"]', { "--c": "dark" }),
    ];
    const light: RootMatchDeps = {
      matchesRoot: (sel) => sel === ":root",
      mediaMatches: () => true,
    };
    const dark: RootMatchDeps = {
      matchesRoot: (sel) => sel === ":root" || sel === ':root[data-theme="dark"]',
      mediaMatches: () => true,
    };
    expect(collectRootCustomProps([sheet(rules)], light).get("--c")).toBe("light");
    expect(collectRootCustomProps([sheet(rules)], dark).get("--c")).toBe("dark");
  });
});
