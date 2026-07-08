import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoUsesTailwind } from "./tailwind";

describe("repoUsesTailwind", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-tw-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("true when tailwindcss is a devDependency", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { tailwindcss: "4" } }),
    );
    expect(repoUsesTailwind(dir)).toBe(true);
  });

  it("false when tailwind is absent", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@emotion/react": "11" } }),
    );
    expect(repoUsesTailwind(dir)).toBe(false);
  });

  it("true when only a nested workspace member declares tailwindcss (fix: tailwind-scope-miss, documenso)", () => {
    // configDir has no tailwind of its own; projectRoot doesn't either — only
    // a sibling workspace member (e.g. documenso's packages/tailwind-config) does.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    mkdirSync(join(dir, "packages/tailwind-config"), { recursive: true });
    writeFileSync(
      join(dir, "packages/tailwind-config/package.json"),
      JSON.stringify({ dependencies: { tailwindcss: "3" } }),
    );
    expect(repoUsesTailwind(dir)).toBe(true);
  });

  it("true when the auto-detected vite config's css.postcss carries a Tailwind plugin", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    expect(repoUsesTailwind(dir, dir, { autoDetectedPostcssTailwind: true })).toBe(true);
  });

  it("false when neither dep, workspace member, nor auto-detected postcss have tailwind", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    expect(repoUsesTailwind(dir, dir, { autoDetectedPostcssTailwind: false })).toBe(false);
  });
});
