import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG_NAMES,
  findDefaultConfig,
  PRIMARY_CONFIG_NAME,
} from "./configDiscovery.ts";

describe("config discovery order", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const touch = (rel: string) => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "");
    return abs;
  };

  it("prefers .designbook/config.* over a legacy root file", () => {
    const legacy = touch("designbook.config.tsx");
    const preferred = touch(".designbook/config.tsx");
    expect(findDefaultConfig(dir)).toBe(preferred);
    expect(findDefaultConfig(dir)).not.toBe(legacy);
  });

  it("still finds the legacy root file when no .designbook/ exists", () => {
    const legacy = touch("designbook.config.tsx");
    expect(findDefaultConfig(dir)).toBe(legacy);
  });

  it("orders .designbook/config extensions tsx > ts > jsx > js", () => {
    touch(".designbook/config.js");
    touch(".designbook/config.ts");
    const tsx = touch(".designbook/config.tsx");
    expect(findDefaultConfig(dir)).toBe(tsx);
  });

  it("returns undefined when nothing matches", () => {
    expect(findDefaultConfig(dir)).toBeUndefined();
  });

  it("lists the .designbook/ config first (the primary name)", () => {
    expect(DEFAULT_CONFIG_NAMES[0]).toBe(".designbook/config.tsx");
    expect(PRIMARY_CONFIG_NAME).toBe(".designbook/config.tsx");
    // Legacy names remain in the list.
    expect(DEFAULT_CONFIG_NAMES).toContain("designbook.config.tsx");
  });
});
