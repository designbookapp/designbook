import { describe, expect, it } from "vitest";
import { fromGlob, lazy, readLazyMeta } from "./index";

type Glob = Record<string, () => Promise<unknown>>;

/** Build a fake non-eager glob record from a list of paths. */
function glob(...paths: string[]): Glob {
  return Object.fromEntries(
    paths.map((p) => [p, () => Promise.resolve({})]),
  ) as Glob;
}

describe("fromGlob key derivation", () => {
  it("derives PascalCase keys from the file basename", () => {
    const record = fromGlob(
      glob(
        "./src/components/Button.tsx",
        "./src/components/product-card.tsx",
        "./src/components/results_list.tsx",
      ),
    );
    expect(Object.keys(record).sort()).toEqual([
      "Button",
      "ProductCard",
      "ResultsList",
    ]);
  });

  it("preserves existing casing on already-PascalCase names", () => {
    const record = fromGlob(glob("./x/ProductDetailSection.tsx"));
    expect(Object.keys(record)).toEqual(["ProductDetailSection"]);
  });

  it("dedupes same-basename collisions by parent dir", () => {
    const record = fromGlob(
      glob("./ui/Button.tsx", "./form/Button.tsx"),
    );
    expect(Object.keys(record).sort()).toEqual(["FormButton", "UiButton"]);
  });
});

describe("fromGlob exclusions", () => {
  it("excludes test/spec/stories files by default", () => {
    const record = fromGlob(
      glob(
        "./x/Button.tsx",
        "./x/Button.test.tsx",
        "./x/Button.spec.ts",
        "./x/Button.stories.tsx",
      ),
    );
    expect(Object.keys(record)).toEqual(["Button"]);
  });

  it("applies a custom exclude (string = substring)", () => {
    const record = fromGlob(glob("./x/Button.tsx", "./x/internal/Secret.tsx"), {
      exclude: "/internal/",
    });
    expect(Object.keys(record)).toEqual(["Button"]);
  });

  it("applies include as an allowlist", () => {
    const record = fromGlob(glob("./ui/Button.tsx", "./legacy/Old.tsx"), {
      include: /\/ui\//,
    });
    expect(Object.keys(record)).toEqual(["Button"]);
  });

  it("honors a custom key mapper and skips empty keys", () => {
    const record = fromGlob(glob("./x/Button.tsx", "./x/Skip.tsx"), {
      key: (path) => (path.includes("Skip") ? "" : "Renamed"),
    });
    expect(Object.keys(record)).toEqual(["Renamed"]);
  });
});

describe("fromGlob branding", () => {
  it("brands each thunk with its glob key for source attribution", () => {
    const record = fromGlob(glob("./src/components/Button.tsx"));
    expect(readLazyMeta(record.Button)).toEqual({
      globKey: "./src/components/Button.tsx",
    });
    expect(typeof record.Button).toBe("function");
  });
});

describe("lazy()", () => {
  it("brands a one-off thunk with an exportName", () => {
    const src = lazy(() => Promise.resolve({}), { exportName: "Named" });
    expect(readLazyMeta(src)).toEqual({ exportName: "Named" });
  });

  it("readLazyMeta returns undefined for a plain component", () => {
    expect(readLazyMeta(() => null)).toBeUndefined();
    expect(readLazyMeta("nope")).toBeUndefined();
  });
});
