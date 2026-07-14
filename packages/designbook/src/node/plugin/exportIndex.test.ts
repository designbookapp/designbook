import { describe, expect, it } from "vitest";
import {
  collectImportedBindings,
  createExportIndex,
  isComponentName,
  isIndexableModuleId,
  nameFromFile,
  scanComponentExports,
} from "./exportIndex.ts";

describe("scanComponentExports", () => {
  it("finds declaration exports (function/const/class, async)", () => {
    const code = [
      "export function ProductCard() {}",
      "export async function AsyncThing() {}",
      "export const ProductBadges = () => null;",
      "export class ErrorBoundaryish {}",
      "export let MutableThing = () => null;",
      "export var OldSchool = () => null;",
    ].join("\n");
    expect(scanComponentExports(code, "src/x.tsx")).toEqual([
      "AsyncThing",
      "ErrorBoundaryish",
      "MutableThing",
      "OldSchool",
      "ProductBadges",
      "ProductCard",
    ]);
  });

  it("finds export-list forms incl. aliases", () => {
    const code = "const A = 1;\nexport { CardHeader, inner as CardBody };";
    expect(scanComponentExports(code, "src/card.tsx")).toEqual([
      "CardBody",
      "CardHeader",
    ]);
  });

  it("uses the local name for `export { X as default }`", () => {
    const code = "function HomePage() {}\nexport { HomePage as default };";
    expect(scanComponentExports(code, "src/pages/home.tsx")).toEqual([
      "HomePage",
    ]);
  });

  it("names a default function export by its own name", () => {
    expect(
      scanComponentExports("export default function HomePage() {}", "src/a.tsx"),
    ).toEqual(["HomePage"]);
  });

  it("infers anonymous/expression default exports from the filename", () => {
    expect(
      scanComponentExports("export default function () {}", "src/product-card.tsx"),
    ).toEqual(["ProductCard"]);
    expect(
      scanComponentExports("export default memo(Inner);", "src/hero-banner.tsx"),
    ).toEqual(["HeroBanner"]);
  });

  it("uses the identifier for `export default X`", () => {
    expect(
      scanComponentExports("const Card = () => null;\nexport default Card;", "src/x.tsx"),
    ).toEqual(["Card"]);
  });

  it("skips lowercase and SCREAMING_CASE exports", () => {
    const code = [
      "export const useProduct = () => {};",
      "export const API_URL = \"x\";",
      "export function helper() {}",
      "export const ProductTitle = () => null;",
    ].join("\n");
    expect(scanComponentExports(code, "src/x.tsx")).toEqual(["ProductTitle"]);
  });

  it("does NOT index barrel re-exports as local definitions", () => {
    // `export { X } from "./y"` re-exports a binding defined elsewhere — the
    // barrel file itself does not define X. Indexing it here made the
    // resolver see X in 2 files (the real definition + every barrel) and
    // spam an ambiguity warning for nearly every component in a barrel repo.
    expect(
      scanComponentExports('export { WalletSheet } from "./components/WalletSheet";', "src/index.ts"),
    ).toEqual([]);
  });

  it("does NOT index aliased re-exports (`export { X as Y } from ...`)", () => {
    expect(
      scanComponentExports('export { Button as PrimaryButton } from "./button";', "src/index.ts"),
    ).toEqual([]);
  });

  it("does NOT index `export * from` / `export * as NS from` re-exports", () => {
    expect(
      scanComponentExports('export * from "./button";', "src/index.ts"),
    ).toEqual([]);
    expect(
      scanComponentExports('export * as Wallet from "./wallet";', "src/index.ts"),
    ).toEqual([]);
  });

  it("still indexes a bare local list export (`export { X }`, no from)", () => {
    const code = "function CardHeader() {}\nexport { CardHeader };";
    expect(scanComponentExports(code, "src/card.tsx")).toEqual(["CardHeader"]);
  });

  it("indexes only the local definition in a mixed local+re-export file", () => {
    const code = [
      "function CardHeader() {}",
      "export { CardHeader };",
      'export { CardBody } from "./card-body";',
    ].join("\n");
    expect(scanComponentExports(code, "src/index.ts")).toEqual(["CardHeader"]);
  });

  it("does NOT index the import-then-export barrel form (bare list export of an imported name)", () => {
    // `import { X } from "./y"; export { X };` — no `from` clause on the
    // export, so the earlier fix (inline `from` only) missed this. It's
    // the MOST COMMON hand-written barrel shape, and also what esbuild
    // lowers `export { X } from "./y"` to under vite dev.
    const code = [
      'import { WalletSheet } from "./components/WalletSheet";',
      "export { WalletSheet };",
    ].join("\n");
    expect(scanComponentExports(code, "src/index.ts")).toEqual([]);
  });

  it("does NOT index an aliased import-then-export (`import { X as W } from ...; export { W as X };`)", () => {
    const code = [
      'import { WalletSheet as W } from "./components/WalletSheet";',
      "export { W as WalletSheet };",
    ].join("\n");
    expect(scanComponentExports(code, "src/index.ts")).toEqual([]);
  });

  it("still indexes a name that is locally defined AND exported in a bare list", () => {
    const code = [
      'import { Unrelated } from "./unrelated";',
      "function CardHeader() {}",
      "export { CardHeader };",
    ].join("\n");
    expect(scanComponentExports(code, "src/card.tsx")).toEqual(["CardHeader"]);
  });

  it("indexes only the local definition when a file both re-exports an import (bare) and defines its own component", () => {
    const code = [
      'import { WalletSheet } from "./components/WalletSheet";',
      "function CardHeader() {}",
      "export { WalletSheet, CardHeader };",
    ].join("\n");
    expect(scanComponentExports(code, "src/index.ts")).toEqual(["CardHeader"]);
  });
});

describe("collectImportedBindings", () => {
  it("collects default, named (incl. aliased), namespace, and combined imports", () => {
    const code = [
      'import Foo from "./foo";',
      'import { A, B as C } from "./ab";',
      'import * as NS from "./ns";',
      'import Default2, { D } from "./combo";',
      'import Default3, * as NS2 from "./combo2";',
      'import "./side-effect-only";',
    ].join("\n");
    expect([...collectImportedBindings(code)].sort()).toEqual(
      ["A", "C", "D", "Default2", "Default3", "Foo", "NS", "NS2"].sort(),
    );
  });
});

describe("nameFromFile / isComponentName", () => {
  it("PascalCases basenames and resolves index files to their dir", () => {
    expect(nameFromFile("src/product-card.tsx")).toBe("ProductCard");
    expect(nameFromFile("src/HeroBanner/index.tsx")).toBe("HeroBanner");
  });

  it("rejects non-component-ish names", () => {
    expect(isComponentName("Button")).toBe(true);
    expect(isComponentName("API_URL")).toBe(false);
    expect(isComponentName("useThing")).toBe(false);
  });
});

describe("isIndexableModuleId", () => {
  const ctx = {
    projectRoot: "/repo",
    packageRoot: "/repo/node_modules/@designbookapp/designbook",
    configPath: "/repo/app/designbook.config.tsx",
  };

  it("accepts app source files", () => {
    expect(isIndexableModuleId("/repo/app/src/App.tsx", ctx)).toBe(true);
    expect(isIndexableModuleId("/repo/app/src/x.ts?v=123", ctx)).toBe(true);
  });

  it("excludes node_modules, virtual ids, non-js, .designbook, config, package", () => {
    expect(isIndexableModuleId("/repo/node_modules/react/index.js", ctx)).toBe(false);
    expect(isIndexableModuleId("\0virtual:designbook-boot", ctx)).toBe(false);
    expect(isIndexableModuleId("virtual:designbook-mark", ctx)).toBe(false);
    expect(isIndexableModuleId("/repo/app/src/index.css", ctx)).toBe(false);
    expect(isIndexableModuleId("/repo/app/.designbook/sandbox/x.tsx", ctx)).toBe(false);
    expect(isIndexableModuleId("/repo/app/designbook.config.tsx", ctx)).toBe(false);
    expect(
      isIndexableModuleId(
        "/repo/node_modules/@designbookapp/designbook/dist/ui/index.js",
        ctx,
      ),
    ).toBe(false);
    expect(isIndexableModuleId("/elsewhere/src/App.tsx", ctx)).toBe(false);
  });
});

describe("createExportIndex", () => {
  it("updates incrementally and bumps the version only on change", () => {
    const index = createExportIndex();
    expect(index.update("src/a.tsx", ["Card"])).toBe(true);
    expect(index.snapshot().version).toBe(1);
    // Same names (any order) — no change.
    expect(index.update("src/a.tsx", ["Card"])).toBe(false);
    expect(index.snapshot().version).toBe(1);
    expect(index.update("src/a.tsx", ["Badge", "Card"])).toBe(true);
    expect(index.snapshot().files["src/a.tsx"]).toEqual(["Badge", "Card"]);
  });

  it("drops files that no longer export components", () => {
    const index = createExportIndex();
    index.update("src/a.tsx", ["Card"]);
    expect(index.update("src/a.tsx", [])).toBe(true);
    expect(index.snapshot().files["src/a.tsx"]).toBeUndefined();
    expect(index.remove("src/a.tsx")).toBe(false); // already gone
  });

  it("snapshots files sorted", () => {
    const index = createExportIndex();
    index.update("src/z.tsx", ["Z"]);
    index.update("src/a.tsx", ["A1"]);
    expect(Object.keys(index.snapshot().files)).toEqual(["src/a.tsx", "src/z.tsx"]);
  });
});
