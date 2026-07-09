/**
 * Guard: UI components must reach the previewed document ONLY through the
 * `previewHost` seam — never by importing the same-document implementation
 * (`fibers`) directly. This keeps the transport boundary intact so a future
 * Model-A shell can swap in a message-channel PreviewHost without touching
 * component code. (The Figma serializer moved into the figma integration
 * plugin — src/plugins/figma/ui/serialize.ts — where the integration
 * import-lint pins it to this seam; core no longer ships a serializer.)
 *
 * A plain fs-walk over `src/ui/components/**`, matching the repo's other
 * node-based tests (e.g. findUsageLine.test.ts).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const componentsDir = join(uiDir, "components");
// The Info panel + selection-context contributors read fibers too — they must
// go through the seam like everything else (spec: selection-context.md).
const screensDir = join(uiDir, "screens");
const selectionContextDir = join(uiDir, "models/selectionContext");

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

// Matches `from "…/fibers"` (single or double quotes), i.e. a direct import
// of the same-document implementation.
const forbiddenImport = /from\s+["'][^"']*\/(fibers|figmaSerialize)["']/;

function offendersIn(dir: string): string[] {
  const offenders: string[] = [];
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    for (const line of source.split("\n")) {
      if (forbiddenImport.test(line)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}

describe("previewHost seam", () => {
  it("no component imports fibers directly", () => {
    const offenders = offendersIn(componentsDir);
    expect(
      offenders,
      `components must import preview access from "@designbook-ui/previewHost", ` +
        `not fibers directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no screen or selection-context module imports fibers directly", () => {
    const offenders = [
      ...offendersIn(screensDir),
      ...offendersIn(selectionContextDir),
    ];
    expect(
      offenders,
      `screens and selection-context contributors must import preview access ` +
        `from "@designbook-ui/previewHost", not fibers directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
