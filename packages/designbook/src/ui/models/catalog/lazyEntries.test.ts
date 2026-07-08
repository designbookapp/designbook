import { describe, expect, it } from "vitest";
import { asLazySource, resolveComponentExport } from "@designbook-ui/models/catalog/componentRegistry";
import { fromGlob, lazy } from "@designbookapp/designbook/config";
import { CellErrorBoundary, firstErrorLine } from "@designbook-ui/screens/PreviewCell";

const Button = () => null;
const Card = () => null;

describe("resolveComponentExport", () => {
  it("prefers the export matching the entry key", () => {
    const mod = { Button, default: Card };
    expect(resolveComponentExport(mod, "Button")).toBe(Button);
  });

  it("falls back to the default export", () => {
    expect(resolveComponentExport({ default: Card }, "Button")).toBe(Card);
  });

  it("falls back to the sole renderable export", () => {
    expect(
      resolveComponentExport({ helper: 42, OnlyOne: Button }, "Anything"),
    ).toBe(Button);
  });

  it("honors an explicit exportName override", () => {
    const mod = { Button, default: Card };
    expect(resolveComponentExport(mod, "Button", "default")).toBe(Card);
  });

  it("throws readably when the exportName is missing", () => {
    expect(() =>
      resolveComponentExport({ Button }, "Button", "Nope"),
    ).toThrow(/export "Nope"/);
  });

  it("throws readably when resolution is ambiguous", () => {
    expect(() =>
      resolveComponentExport({ A: Button, B: Card }, "Zed"),
    ).toThrow(/could not resolve/);
  });

  it("accepts memo/forwardRef ($$typeof) components", () => {
    const memoish = { $$typeof: Symbol.for("react.memo"), type: Button };
    expect(resolveComponentExport({ default: memoish }, "X")).toBe(memoish);
  });
});

describe("asLazySource", () => {
  it("classifies fromGlob-branded thunks as lazy with a globKey", () => {
    const record = fromGlob({
      "./src/Button.tsx": () => Promise.resolve({}),
    });
    const src = asLazySource(record.Button);
    expect(src?.globKey).toBe("./src/Button.tsx");
  });

  it("carries an exportName from lazy()", () => {
    const src = asLazySource(lazy(() => Promise.resolve({}), { exportName: "X" }));
    expect(src?.exportName).toBe("X");
  });

  it("sniffs a raw () => import(...) thunk", () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const thunk = new Function("return () => import('./Whatever')")() as () => Promise<unknown>;
    expect(asLazySource(thunk)).toBeTruthy();
  });

  it("does not classify a plain component as lazy", () => {
    expect(asLazySource(Button)).toBeUndefined();
    expect(asLazySource(() => null)).toBeUndefined();
    expect(asLazySource("nope")).toBeUndefined();
  });
});

describe("cell error surface", () => {
  it("firstErrorLine takes the first non-empty line", () => {
    expect(firstErrorLine(new Error("boom\nsecond"))).toBe("boom");
    expect(firstErrorLine("\n  real error \n")).toBe("real error");
    expect(firstErrorLine(undefined)).toBe("undefined");
  });

  it("getDerivedStateFromError captures the error", () => {
    const err = new Error("x");
    expect(CellErrorBoundary.getDerivedStateFromError(err)).toEqual({
      error: err,
    });
  });
});
