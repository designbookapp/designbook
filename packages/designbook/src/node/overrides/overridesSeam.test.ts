/**
 * Layer-lint / seam test (docs/specs/changeset-layers.md — the
 * ModuleOverrideHost portability seam carries over from sandbox-overrides
 * §Build-environment portability unchanged): the override modules must not
 * deepen the vite coupling — NOTHING under src/node/overrides/ imports vite
 * (types included). The vite adapter lives in
 * src/node/plugin/sandboxOverridesVite.ts, outside this layer, and is the
 * only place allowed to touch vite.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  altFilePath,
  computeLayerRedirects,
  type ChangesetLayer,
} from "./layerStore.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Any static/dynamic/type import of vite (or a vite plugin package). */
const VITE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:vite|@vitejs\/[^"']*)["']/;

describe("override layer imports no vite", () => {
  it("every module under src/node/overrides/ is vite-free", () => {
    const files = readdirSync(here).filter((name) => /\.tsx?$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(here, file), "utf8");
      expect(VITE_IMPORT.test(source), `${file} must not import vite`).toBe(
        false,
      );
    }
  });

  it("the layer redirect table is plain data (bundler-agnostic)", () => {
    const layer: ChangesetLayer = {
      id: "cs-x",
      pinId: "x",
      branch: "main",
      baseCommit: "abc",
      createdAt: 1,
      active: true,
      order: 1,
      baseHashes: {},
      overrides: {
        "src/Card.tsx": { selection: "v1", alternatives: ["v1"] },
      },
    };
    const redirects = computeLayerRedirects({
      layers: [layer],
      branch: "main",
      appDir: "",
      isDataPath: () => false,
    });
    expect(redirects.get("src/Card.tsx")).toBe(
      altFilePath("", "cs-x", "v1", "src/Card.tsx"),
    );
    // A plain string map — nothing vite-shaped in the resolution model.
    for (const [real, alt] of redirects) {
      expect(typeof real).toBe("string");
      expect(typeof alt).toBe("string");
    }
  });
});
