/**
 * Guard: UI components must reach the previewed document ONLY through the
 * `previewHost` seam — never by importing the same-document implementation
 * (`fibers` / `figmaSerialize`) directly. This keeps the transport boundary
 * intact so a future Model-A shell can swap in a message-channel PreviewHost
 * without touching component code.
 *
 * A plain fs-walk over `src/ui/components/**`, matching the repo's other
 * node-based tests (e.g. findUsageLine.test.ts).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../components",
);

/** Every `.ts`/`.tsx` file under `src/ui/components`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Matches `from "…/fibers"` / `from "…/figmaSerialize"` (single or double
// quotes), i.e. a direct import of the same-document implementation.
const forbiddenImport =
  /from\s+["'][^"']*\/(fibers|figmaSerialize)["']/;

describe("previewHost seam", () => {
  it("no component imports fibers/figmaSerialize directly", () => {
    const offenders: string[] = [];
    for (const file of walk(componentsDir)) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (forbiddenImport.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `components must import preview access from "@designbook-ui/previewHost", ` +
        `not fibers/figmaSerialize directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
