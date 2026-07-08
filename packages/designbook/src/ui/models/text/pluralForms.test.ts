import { describe, expect, it } from "vitest";
import { resolvePluralForms, stripPluralSuffix } from "@designbook-ui/models/text/pluralForms";

/** A `lookup` backed by a plain resource map, like a locale JSON file. */
function lookupIn(resources: Record<string, string>) {
  return (key: string) => resources[key];
}

describe("stripPluralSuffix", () => {
  it("strips a known plural suffix", () => {
    expect(stripPluralSuffix("results.count_other")).toBe("results.count");
    expect(stripPluralSuffix("results.count_one")).toBe("results.count");
    expect(stripPluralSuffix("results.count_zero")).toBe("results.count");
  });

  it("is a no-op on an already-bare key", () => {
    expect(stripPluralSuffix("results.count")).toBe("results.count");
  });

  it("only strips a TRAILING suffix (not one embedded mid-key)", () => {
    expect(stripPluralSuffix("results.one_other.count")).toBe(
      "results.one_other.count",
    );
  });
});

describe("resolvePluralForms", () => {
  const resources = {
    "results.count_one": "{{count}} trip",
    "results.count_other": "{{count}} trips",
  };

  it("finds the full form family from a SUFFIXED resolvedKey (canvas path)", () => {
    // The canvas's marker postProcessor computes the active suffix via
    // `options.count` + `Intl.PluralRules`, so `resolvedKey` already carries it.
    const forms = resolvePluralForms("results.count_other", lookupIn(resources));
    expect(forms).toEqual([
      { key: "results.count_one", suffix: "_one", value: "{{count}} trip" },
      { key: "results.count_other", suffix: "_other", value: "{{count}} trips" },
    ]);
  });

  it("finds the SAME form family from an UNSUFFIXED resolvedKey (page-transform path)", () => {
    // `__dbMark` only sees the verbatim source key (no `options`), so the page
    // path's resolvedKey is the bare key. Parity requires the identical family.
    const forms = resolvePluralForms("results.count", lookupIn(resources));
    expect(forms).toEqual([
      { key: "results.count_one", suffix: "_one", value: "{{count}} trip" },
      { key: "results.count_other", suffix: "_other", value: "{{count}} trips" },
    ]);
  });

  it("returns [] for an ordinary (non-plural) key even if it happens to end in a lookalike segment", () => {
    const forms = resolvePluralForms("greeting.title", lookupIn({
      "greeting.title": "Welcome back",
    }));
    expect(forms).toEqual([]);
  });

  it("returns [] when only ONE form exists (not a real plural family)", () => {
    const forms = resolvePluralForms(
      "solo.count",
      lookupIn({ "solo.count_other": "{{count}} things" }),
    );
    expect(forms).toEqual([]);
  });

  it("supports the full CLDR suffix set (zero/one/two/few/many/other)", () => {
    const cldrResources = {
      "cart.items_zero": "No items",
      "cart.items_one": "{{count}} item",
      "cart.items_two": "{{count}} items (dual)",
      "cart.items_few": "{{count}} items (few)",
      "cart.items_many": "{{count}} items (many)",
      "cart.items_other": "{{count}} items",
    };
    const forms = resolvePluralForms("cart.items", lookupIn(cldrResources));
    expect(forms.map((f) => f.suffix)).toEqual([
      "_zero",
      "_one",
      "_two",
      "_few",
      "_many",
      "_other",
    ]);
  });
});
