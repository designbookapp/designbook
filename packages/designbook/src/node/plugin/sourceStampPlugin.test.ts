import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { designbookPlugin } from "./plugin.ts";

// A throwaway project root (no .git → projectRoot === the config dir) with a
// minimal config file so `designbookPlugin` constructs without discovery.
const projectDir = mkdtempSync(join(tmpdir(), "db-stamp-"));
writeFileSync(join(projectDir, "designbook.config.tsx"), "export default {};\n");

function mainTransform(): (code: string, id: string) => unknown {
  const plugins = designbookPlugin({
    config: join(projectDir, "designbook.config.tsx"),
    serverUrl: "http://localhost:8787",
  }) as Plugin[];
  const main = plugins.find((p) => p.name === "designbook");
  const transform = main?.transform;
  const handler =
    typeof transform === "function" ? transform : transform?.handler;
  if (!handler) throw new Error("no transform handler");
  return (code, id) =>
    (handler as (this: unknown, code: string, id: string) => unknown).call(
      {},
      code,
      id,
    );
}

afterAll(() => {
  // best-effort; tmp dir is disposable
});

describe("source-stamp plugin wiring", () => {
  it("the main plugin is apply:'serve' (never runs in a production build)", () => {
    const plugins = designbookPlugin({
      config: join(projectDir, "designbook.config.tsx"),
      serverUrl: "http://localhost:8787",
    }) as Plugin[];
    const main = plugins.find((p) => p.name === "designbook");
    // Vite excludes `apply: "serve"` plugins from `vite build` entirely — this
    // is the dev-only proof: the transform (and its stamp) never touch prod
    // output.
    expect(main?.apply).toBe("serve");
  });

  it("appends a source stamp to a client-graph component module (dev serve)", () => {
    const transform = mainTransform();
    const result = transform(
      "export function ProductCard() { return null; }\n",
      join(projectDir, "src/ProductCard.tsx"),
    ) as { code: string } | undefined;
    expect(result?.code).toContain(
      'ProductCard.__dbSource = "src/ProductCard.tsx"',
    );
  });

  it("does NOT stamp node_modules / non-app modules", () => {
    const transform = mainTransform();
    const result = transform(
      "export function Button() { return null; }\n",
      join(projectDir, "node_modules/lib/Button.tsx"),
    );
    expect(result).toBeUndefined();
  });

  it("does NOT stamp the config file itself", () => {
    const transform = mainTransform();
    const result = transform(
      "export const Thing = () => null;\n",
      join(projectDir, "designbook.config.tsx"),
    );
    expect(result).toBeUndefined();
  });
});
