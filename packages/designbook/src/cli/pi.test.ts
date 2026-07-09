/**
 * Guards for `designbook login` / `designbook pi`.
 *
 * The bug this feature fixes: `npx pi` runs an unrelated ancient registry
 * package under pnpm/yarn-pnp (which don't link a transitive dep's bins). So we
 * (1) resolve the bundled Pi bin from designbook's OWN dependency tree via its
 * package.json `bin` field, and (2) purge bare `npx pi` from the callout + docs.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePiBinFromPackageJson } from "./pi.ts";

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(here, "../../../.."); // packages/designbook/src/cli → repo root

describe("resolvePiBinFromPackageJson", () => {
  it("resolves the pi bin from a bin object relative to the package dir", () => {
    const path = resolvePiBinFromPackageJson(
      { bin: { pi: "dist/cli.js" } },
      "/pkgs/pi/package.json",
    );
    expect(path).toBe("/pkgs/pi/dist/cli.js");
  });

  it("accepts a string bin field", () => {
    const path = resolvePiBinFromPackageJson(
      { bin: "./dist/cli.js" },
      "/pkgs/pi/package.json",
    );
    expect(path).toBe("/pkgs/pi/dist/cli.js");
  });

  it("falls back to the first bin entry when there's no `pi` key", () => {
    const path = resolvePiBinFromPackageJson(
      { bin: { other: "dist/other.js" } },
      "/pkgs/pi/package.json",
    );
    expect(path).toBe("/pkgs/pi/dist/other.js");
  });

  it("preserves an already-absolute bin path", () => {
    const path = resolvePiBinFromPackageJson(
      { bin: { pi: "/abs/cli.js" } },
      "/pkgs/pi/package.json",
    );
    expect(path).toBe("/abs/cli.js");
  });

  it("throws a friendly error when there is no bin", () => {
    expect(() =>
      resolvePiBinFromPackageJson({}, "/pkgs/pi/package.json"),
    ).toThrow(/no bin entry/);
  });
});

describe("CLI subcommand wiring", () => {
  const indexSrc = readFileSync(join(here, "index.ts"), "utf8");

  it("dispatches `login` and `pi` to the pi module", () => {
    expect(indexSrc).toContain('import { runLogin, runPi } from "./pi.ts"');
    expect(indexSrc).toMatch(
      /process\.argv\[2\] === "login"[\s\S]*?runLogin\(process\.argv\.slice\(3\)\)/,
    );
    expect(indexSrc).toMatch(
      /process\.argv\[2\] === "pi"[\s\S]*?runPi\(process\.argv\.slice\(3\)\)/,
    );
  });
});

describe("no bare `npx pi` in user-facing copy or docs", () => {
  const files = [
    "README.md",
    "docs-site/src/content/docs/getting-started/install-and-run.md",
    "docs-site/src/content/docs/concepts/agent.md",
    "packages/designbook/src/ui/screens/DesignChat/DesignChat.tsx",
  ];

  for (const rel of files) {
    it(`${rel} says \`npx designbook\`, not bare \`npx pi\``, () => {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      // Allow `npx designbook pi`; forbid bare `npx pi`.
      expect(src).not.toMatch(/npx pi\b/);
    });
  }
});
