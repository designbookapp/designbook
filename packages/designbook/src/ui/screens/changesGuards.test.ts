/**
 * Guard (Changes tab MVP, decision #7): the mock changes dataset and the dead
 * "Create PR" button must never come back. Scans all src/ui sources (tests
 * excluded) for the banned tokens.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Assembled so this file can't match itself even if scanned.
const BANNED = ["mock" + "Changes", "Create" + " PR"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("changes-tab guards", () => {
  it("keeps mock changes data and the Create-PR button dead", () => {
    const offenders: string[] = [];
    for (const file of walk(UI_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const token of BANNED) {
        if (source.includes(token)) {
          offenders.push(`${relative(UI_ROOT, file)}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
