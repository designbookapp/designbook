import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyExportIndex,
  exportIndexSnapshot,
  lookupExportFiles,
  resetExportIndexForTests,
} from "./exportIndexStore.ts";
import { resolveOwnerSource } from "./sandbox.ts";

beforeEach(() => resetExportIndexForTests());
afterEach(() => resetExportIndexForTests());

describe("exportIndexStore", () => {
  it("applies snapshots, bumps versions, and looks up by name", () => {
    applyExportIndex({
      files: { "src/b.tsx": ["Card"], "src/a.tsx": ["Card", "Badge"] },
    });
    expect(exportIndexSnapshot().version).toBe(1);
    expect(lookupExportFiles("Card")).toEqual(["src/a.tsx", "src/b.tsx"]);
    expect(lookupExportFiles("Badge")).toEqual(["src/a.tsx"]);
    expect(lookupExportFiles("Nope")).toEqual([]);

    applyExportIndex({ files: { "src/a.tsx": ["Badge"] } });
    expect(exportIndexSnapshot().version).toBe(2);
    expect(lookupExportFiles("Card")).toEqual([]);
  });

  it("sanitizes malformed payloads (traversal paths, non-identifier names)", () => {
    applyExportIndex({
      files: {
        "../evil.tsx": ["Card"],
        "src/ok.tsx": ["Fine", "not-an-identifier", 42],
        "src/empty.tsx": [],
      },
    });
    const { files } = exportIndexSnapshot();
    expect(files["../evil.tsx"]).toBeUndefined();
    expect(files["src/ok.tsx"]).toEqual(["Fine"]);
    expect(files["src/empty.tsx"]).toBeUndefined();
  });

  it("survives garbage payloads", () => {
    expect(() => applyExportIndex(null)).not.toThrow();
    expect(() => applyExportIndex({ files: "nope" })).not.toThrow();
    expect(exportIndexSnapshot().files).toEqual({});
  });
});

describe("resolveOwnerSource with the export index", () => {
  it("prefers the indexed file over the alphabetical scan order", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-index-"));
    try {
      // Both files export HomePage; the bounded scan (sorted) would pick
      // a-page.tsx — the index says the real one is z-page.tsx.
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src/a-page.tsx"),
        "export function HomePage() { return null; }\n",
      );
      await writeFile(
        join(root, "src/z-page.tsx"),
        "export function HomePage() { return null; }\n",
      );
      applyExportIndex({ files: { "src/z-page.tsx": ["HomePage"] } });

      const { resolved } = await resolveOwnerSource({
        repoRoot: root,
        appDir: "",
        names: ["HomePage"],
      });
      expect(resolved).toEqual({ file: "src/z-page.tsx", exportName: "HomePage" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the bounded scan when the index is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-index-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src/real.tsx"),
        "export function HomePage() { return null; }\n",
      );
      // Index points at a file that no longer exports the name.
      await writeFile(join(root, "src/stale.tsx"), "export const nothing = 1;\n");
      applyExportIndex({ files: { "src/stale.tsx": ["HomePage"] } });

      const { resolved } = await resolveOwnerSource({
        repoRoot: root,
        appDir: "",
        names: ["HomePage"],
      });
      expect(resolved).toEqual({ file: "src/real.tsx", exportName: "HomePage" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves indexed files OUTSIDE the app dir (monorepo workspace lib)", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-index-"));
    try {
      await mkdir(join(root, "apps/web/src"), { recursive: true });
      await mkdir(join(root, "packages/ui/src"), { recursive: true });
      await writeFile(
        join(root, "packages/ui/src/button.tsx"),
        "export function FancyButton() { return null; }\n",
      );
      applyExportIndex({
        files: { "packages/ui/src/button.tsx": ["FancyButton"] },
      });

      // The scan is bounded to appDir (apps/web) and would never find it.
      const { resolved } = await resolveOwnerSource({
        repoRoot: root,
        appDir: "apps/web",
        names: ["FancyButton"],
      });
      expect(resolved).toEqual({
        file: "packages/ui/src/button.tsx",
        exportName: "FancyButton",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
