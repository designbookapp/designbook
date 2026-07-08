/**
 * Guard: every `/api/*` access in the UI must route through `apiUrl()` (see
 * src/ui/designbook.ts) so injected mode can retarget requests at
 * the cross-origin sidecar. A bare `fetch("/api/…")` / `new EventSource("/api/…")`
 * hardcodes a same-origin relative path and breaks injected mode.
 *
 * A plain fs-walk over `src/ui/**`, matching the repo's other node-based tests
 * (e.g. previewHostSeam.test.ts).
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)));

/** Every `.ts`/`.tsx` file under `src/ui`, recursively (skipping tests). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// A bare `/api/…` literal handed straight to fetch() or new EventSource().
// `apiUrl("/api/…")` does not match (the arg after `(` is `apiUrl`, not a quote).
const forbidden =
  /(?:fetch|EventSource)\(\s*[`"']\/api\//;

describe("apiUrl seam", () => {
  it("no UI code fetches a bare /api/ path (must go through apiUrl)", () => {
    const offenders: string[] = [];
    for (const file of walk(uiDir)) {
      // apiUrl() itself is defined here; nothing to route through.
      if (basename(file) === "designbook.ts") continue;
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (forbidden.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `these must call apiUrl("/api/…") instead of fetching a bare relative path:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
