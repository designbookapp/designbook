import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The UI three-layer split is enforced here so it runs in the standard
 * `pnpm test:run` gate. See scripts/layer-lint.mjs for the rules. The script is
 * run as a child process (rather than imported) to keep it a dependency-free,
 * untyped node tool while this test stays inside the typed `src/ui` program.
 */
describe("ui layer-lint", () => {
  it("has no cross-layer import violations", () => {
    const script = fileURLToPath(
      new URL("../../scripts/layer-lint.mjs", import.meta.url),
    );
    let output = "";
    try {
      output = execFileSync("node", [script], { encoding: "utf8" });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(
        `layer-lint reported violations:\n${e.stdout ?? ""}${e.stderr ?? ""}`,
      );
    }
    expect(output).toContain("clean");
  });
});
