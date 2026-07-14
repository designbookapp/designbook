import { describe, expect, it } from "vitest";
import {
  jsonKeyExists,
  replaceJsonStringValue,
  replaceJsonValue,
  setJsonValue,
} from "./jsonEdit";

const sample = `{
  "productCard": {
    "nights_one": "{{count}} Night",
    "@nights_one": {
      "description": "Cruise length in nights, singular",
      "placeholders": { "count": { "example": "1" } }
    },
    "balcony": "Balcony",
    "@balcony": { "description": "Balcony cabin type column header" }
  },
  "search": { "searchButton": "Search" }
}
`;

describe("replaceJsonStringValue", () => {
  it("replaces only the target value, preserving all other formatting", () => {
    const result = replaceJsonStringValue(
      sample,
      "productCard.balcony",
      "Veranda",
    );
    expect(result).toBe(sample.replace('"Balcony",', '"Veranda",'));
  });

  it("keeps compact one-line metadata objects untouched", () => {
    const result = replaceJsonStringValue(
      sample,
      "productCard.nights_one",
      "{{count}} night",
    );
    expect(result).toContain('"placeholders": { "count": { "example": "1" } }');
    expect(result).toContain('"nights_one": "{{count}} night"');
  });

  it("does not match a same-named key in a different group", () => {
    const result = replaceJsonStringValue(sample, "search.searchButton", "Go");
    expect(result).toContain('"searchButton": "Go"');
    expect(result).toContain('"balcony": "Balcony"');
  });

  it("escapes special characters in the new value", () => {
    const result = replaceJsonStringValue(
      sample,
      "search.searchButton",
      'Say "go"\nnow',
    );
    expect(result).toBeDefined();
    const parsed = JSON.parse(result ?? "") as {
      search: { searchButton: string };
    };
    expect(parsed.search.searchButton).toBe('Say "go"\nnow');
  });

  it("returns undefined for a missing key", () => {
    expect(replaceJsonStringValue(sample, "productCard.missing", "x")).toBe(
      undefined,
    );
  });

  it("returns undefined when the path resolves to a non-string", () => {
    expect(replaceJsonStringValue(sample, "productCard.@nights_one", "x")).toBe(
      undefined,
    );
    expect(replaceJsonStringValue(sample, "productCard", "x")).toBe(undefined);
  });

  it("skips string values containing braces without derailing the scan", () => {
    const tricky = `{"a": "has { and } inside", "b": "target"}`;
    const result = replaceJsonStringValue(tricky, "b", "done");
    expect(result).toBe(`{"a": "has { and } inside", "b": "done"}`);
  });
});

const flags = `{
  "acme": {
    "newCheckout": true,
    "density": "compact",
    "maxItems": 20
  },
  "globex": {
    "newCheckout": false,
    "density": "comfortable"
  }
}
`;

describe("replaceJsonValue", () => {
  it("replaces a boolean, preserving all other formatting", () => {
    const result = replaceJsonValue(flags, "acme.newCheckout", false);
    expect(result).toBe(flags.replace('"newCheckout": true', '"newCheckout": false'));
    const parsed = JSON.parse(result ?? "") as {
      acme: { newCheckout: boolean };
    };
    expect(parsed.acme.newCheckout).toBe(false);
  });

  it("round-trips a number", () => {
    const result = replaceJsonValue(flags, "acme.maxItems", 5);
    expect(result).toContain('"maxItems": 5');
    const parsed = JSON.parse(result ?? "") as { acme: { maxItems: number } };
    expect(parsed.acme.maxItems).toBe(5);
  });

  it("round-trips an enum/string value", () => {
    const result = replaceJsonValue(flags, "globex.density", "compact");
    expect(result).toContain('"density": "compact"');
    const parsed = JSON.parse(result ?? "") as {
      globex: { density: string };
    };
    expect(parsed.globex.density).toBe("compact");
  });

  it("can switch a value's JSON type (string ← boolean)", () => {
    const result = replaceJsonValue(flags, "globex.newCheckout", "on");
    expect(result).toContain('"newCheckout": "on"');
    const parsed = JSON.parse(result ?? "") as {
      globex: { newCheckout: string };
    };
    expect(parsed.globex.newCheckout).toBe("on");
  });

  it("does not match a same-named key in a different tenant", () => {
    const result = replaceJsonValue(flags, "globex.newCheckout", true);
    expect(result).toContain('"newCheckout": true,\n    "density": "compact"');
  });

  it("returns undefined for a missing key path", () => {
    expect(replaceJsonValue(flags, "acme.missing", 1)).toBe(undefined);
    expect(replaceJsonValue(flags, "nope.newCheckout", 1)).toBe(undefined);
  });
});

describe("setJsonValue", () => {
  const variants = `{
  "sunset": {
    "light": {
      "primary": "oklch(0.6 0.19 35)"
    }
  }
}
`;

  it("rewrites an existing key surgically (one-line diff)", () => {
    const result = setJsonValue(variants, "sunset.light.primary", "oklch(0.5 0.2 30)");
    expect(result).toBe(variants.replace("oklch(0.6 0.19 35)", "oklch(0.5 0.2 30)"));
  });

  it("creates a missing leaf under an existing object", () => {
    const result = setJsonValue(variants, "sunset.light.background", "oklch(1 0 0)");
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!);
    expect(parsed.sunset.light.background).toBe("oklch(1 0 0)");
    expect(parsed.sunset.light.primary).toBe("oklch(0.6 0.19 35)");
  });

  it("creates missing intermediate objects", () => {
    const result = setJsonValue(variants, "sunset.dark.primary", "oklch(0.72 0.17 35)");
    const parsed = JSON.parse(result!);
    expect(parsed.sunset.dark.primary).toBe("oklch(0.72 0.17 35)");
  });

  it("creates a whole new top-level variant", () => {
    const result = setJsonValue(variants, "forest.light.primary", "oklch(0.45 0.13 150)");
    const parsed = JSON.parse(result!);
    expect(parsed.forest.light.primary).toBe("oklch(0.45 0.13 150)");
    expect(parsed.sunset.light.primary).toBe("oklch(0.6 0.19 35)");
  });

  it("preserves a trailing newline", () => {
    const result = setJsonValue(variants, "forest.light.primary", "x");
    expect(result!.endsWith("\n")).toBe(true);
  });

  it("returns undefined when a segment collides with a non-object", () => {
    // sunset.light.primary is a string; can't descend into it.
    expect(
      setJsonValue(variants, "sunset.light.primary.deep", "x"),
    ).toBe(undefined);
  });
});

describe("jsonKeyExists (add-vs-mutate signal)", () => {
  it("is true for a present key path, false for an absent one", () => {
    expect(jsonKeyExists(sample, "productCard.nights_one")).toBe(true);
    expect(jsonKeyExists(sample, "productCard.saleBadge")).toBe(false);
    expect(jsonKeyExists(sample, "nope.at.all")).toBe(false);
  });

  it("is false on non-object JSON", () => {
    expect(jsonKeyExists("[1,2]", "0")).toBe(false);
    expect(jsonKeyExists("not json", "a")).toBe(false);
  });
});
