import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The integration plugin boundary (C1, figma-integration-plugin spec) is
 * enforced here so it runs in the standard `pnpm test:run` gate: nothing
 * outside src/plugins/figma may import figma-specific modules (except the two
 * builtins registration files, entry modules only), and the plugin itself may
 * import only the public seam. See scripts/integration-lint.mjs for the
 * rules; run as a child process to keep it a dependency-free node tool
 * (same pattern as layerLint.test.ts).
 */
describe("integration import-lint", () => {
  it("has no plugin-boundary violations", () => {
    const script = fileURLToPath(
      new URL("../scripts/integration-lint.mjs", import.meta.url),
    );
    let output = "";
    try {
      output = execFileSync("node", [script], { encoding: "utf8" });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(
        `integration-lint reported violations:\n${e.stdout ?? ""}${e.stderr ?? ""}`,
      );
    }
    expect(output).toContain("clean");
  });
});
