import { describe, expect, it } from "vitest";
import {
  adapterIdForFile,
  classifyDataChange,
  dataFormatFor,
} from "./dataClassify.ts";

describe("dataFormatFor", () => {
  it("maps by extension", () => {
    expect(dataFormatFor("locales/en/app.json")).toBe("json");
    expect(dataFormatFor("translations/en/web.po")).toBe("po");
    expect(dataFormatFor("src/index.css")).toBe("cssvar");
    expect(dataFormatFor("src/Card.tsx")).toBeUndefined();
    expect(dataFormatFor("README.md")).toBeUndefined();
  });
});

describe("adapterIdForFile", () => {
  it("labels by path heuristics", () => {
    expect(adapterIdForFile("locales/en/app.json")).toBe("i18next");
    expect(adapterIdForFile("src/themes.json")).toBe("theme");
    expect(adapterIdForFile("src/flags/tenants.json")).toBe("flags");
    expect(adapterIdForFile("data/misc.json")).toBe("json");
    expect(adapterIdForFile("translations/en.po")).toBe("lingui");
    expect(adapterIdForFile("src/index.css")).toBe("theme");
  });
});

describe("classifyDataChange json", () => {
  it("separates added leaf keys from mutated ones; removals ignored", () => {
    const before = JSON.stringify({
      product: { title: "Buy", price: "9" },
      gone: "x",
    });
    const after = JSON.stringify({
      product: { title: "Purchase", price: "9", saleBadge: "Sale" },
      brand: { name: "Acme" },
    });
    const { added, mutated } = classifyDataChange("json", before, after);
    expect(added.sort()).toEqual(["brand.name", "product.saleBadge"]);
    expect(mutated).toEqual(["product.title"]);
  });

  it("treats arrays and non-string leaves as values", () => {
    const before = JSON.stringify({ a: [1, 2], b: true, c: 1 });
    const after = JSON.stringify({ a: [1, 2, 3], b: true, c: 2, d: null });
    const { added, mutated } = classifyDataChange("json", before, after);
    expect(added).toEqual(["d"]);
    expect(mutated.sort()).toEqual(["a", "c"]);
  });

  it("unparseable input yields nothing (no false positives)", () => {
    expect(classifyDataChange("json", "{bad", "{}")).toEqual({
      added: [],
      mutated: [],
    });
  });
});

describe("classifyDataChange po", () => {
  const cat = (entries: Array<[string, string]>) =>
    entries.map(([id, str]) => `msgid "${id}"\nmsgstr "${str}"\n`).join("\n");

  it("new msgid is an add; a changed msgstr is a mutate", () => {
    const before = cat([
      ["Close", "Close"],
      ["Open", "Open"],
    ]);
    const after = cat([
      ["Close", "Dismiss"],
      ["Open", "Open"],
      ["Sale", "Sale"],
    ]);
    const { added, mutated } = classifyDataChange("po", before, after);
    expect(added).toEqual(["Sale"]);
    expect(mutated).toEqual(["Close"]);
  });

  it("handles multi-line msgid/msgstr", () => {
    const before = `msgid ""\n"Hello "\n"world"\nmsgstr "Hi"\n`;
    const after = `msgid ""\n"Hello "\n"world"\nmsgstr "Howdy"\n`;
    const { added, mutated } = classifyDataChange("po", before, after);
    expect(added).toEqual([]);
    expect(mutated).toEqual(["Hello world"]);
  });
});

describe("classifyDataChange cssvar", () => {
  it("a new custom property is an add; a changed value is a mutate", () => {
    const before = `:root {\n  --primary: oklch(0.5 0.1 250);\n  --radius: 8px;\n}\n`;
    const after = `:root {\n  --primary: oklch(0.6 0.1 250);\n  --radius: 8px;\n  --accent: red;\n}\n`;
    const { added, mutated } = classifyDataChange("cssvar", before, after);
    expect(added).toEqual([":root --accent"]);
    expect(mutated).toEqual([":root --primary"]);
  });

  it("scopes tokens per selector and ignores commented declarations", () => {
    const before = `:root { --x: 1; }\n.dark { --x: 2; }\n`;
    const after = `:root { --x: 1; }\n.dark { --x: 9; /* --x: 5 */ }\n`;
    const { added, mutated } = classifyDataChange("cssvar", before, after);
    expect(added).toEqual([]);
    expect(mutated).toEqual([".dark --x"]);
  });
});
