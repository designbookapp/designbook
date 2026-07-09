/**
 * Static i18next scanner (selection-context i18n contributor): call shapes,
 * Trans elements, dynamic template-key flagging, merge/dedupe, ns stripping.
 */

import { describe, expect, it } from "vitest";
import { baseKey, mergeScans, scanI18nSource } from "./i18nStaticScan";

describe("scanI18nSource", () => {
  it("finds double- and single-quoted t() keys", () => {
    const source = `
      const a = t("product.title");
      const b = t('product.price', { count: 2 });
      const c = i18n.t("cart.empty");
    `;
    expect(scanI18nSource(source).keys).toEqual([
      "product.title",
      "cart.empty",
      "product.price",
    ]);
  });

  it("finds static template keys and <Trans i18nKey>", () => {
    const source = `
      const a = t(\`checkout.confirm\`);
      return <Trans i18nKey="legal.terms" components={[<a />]} />;
      const b = <Trans count={n} i18nKey='legal.privacy'>fallback</Trans>;
    `;
    const scan = scanI18nSource(source);
    expect(scan.keys).toEqual([
      "checkout.confirm",
      "legal.terms",
      "legal.privacy",
    ]);
    expect(scan.dynamic).toEqual([]);
  });

  it("flags dynamic template keys as non-enumerable", () => {
    const source = "const label = t(`badges.${badge.kind}`);";
    const scan = scanI18nSource(source);
    expect(scan.keys).toEqual([]);
    expect(scan.dynamic).toEqual(["t(`badges.${badge.kind}`)"]);
  });

  it("does not match word-suffixed calls like split(", () => {
    const source = `
      const parts = value.split("x");
      const formatted = format("y");
    `;
    expect(scanI18nSource(source).keys).toEqual([]);
  });

  it("dedupes repeated keys", () => {
    const source = 't("a.b"); t("a.b"); t(\'a.b\');';
    expect(scanI18nSource(source).keys).toEqual(["a.b"]);
  });
});

describe("mergeScans / baseKey", () => {
  it("merges file scans preserving order and deduping", () => {
    const merged = mergeScans([
      { keys: ["a", "b"], dynamic: ["t(`x.${i}`)"] },
      { keys: ["b", "c"], dynamic: ["t(`x.${i}`)"] },
    ]);
    expect(merged.keys).toEqual(["a", "b", "c"]);
    expect(merged.dynamic).toEqual(["t(`x.${i}`)"]);
  });

  it("strips an ns: prefix for marker comparison", () => {
    expect(baseKey("app:product.title")).toBe("product.title");
    expect(baseKey("product.title")).toBe("product.title");
  });
});
