/**
 * Tailwind source coverage for `.designbook/variations/` — variant-only
 * utilities must generate CSS (the live-dogfood "rendered empty" root cause).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendSandboxSource,
  appendVariationsSource,
  generatedDirsTailwindSourcePlugin,
  importsTailwindV4,
} from "./variationsTailwindSource.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("appendVariationsSource", () => {
  const v4Entry = '@import "tailwindcss";\n@source "./";\n';

  it("appends the variations @source to a v4 entry css", () => {
    const out = appendVariationsSource(v4Entry, "/repo");
    expect(out).toContain('@source "/repo/.designbook/variations";');
    // Original content preserved, addition appended.
    expect(out?.startsWith(v4Entry)).toBe(true);
  });

  it("leaves non-tailwind css and v3 directive css untouched", () => {
    expect(appendVariationsSource(".a { color: red }", "/repo")).toBeUndefined();
    expect(
      appendVariationsSource("@tailwind base;\n@tailwind utilities;", "/repo"),
    ).toBeUndefined();
    expect(importsTailwindV4("@import 'tailwindcss';")).toBe(true);
  });

  it("is idempotent (no duplicate @source)", () => {
    const once = appendVariationsSource(v4Entry, "/repo")!;
    expect(appendVariationsSource(once, "/repo")).toBeUndefined();
  });
});

describe("appendSandboxSource (docs/specs/sandbox.md)", () => {
  const v4Entry = '@import "tailwindcss";\n';

  it("mirrors the variations handling for .designbook/sandbox", () => {
    const out = appendSandboxSource(v4Entry, "/repo");
    expect(out).toContain('@source "/repo/.designbook/sandbox";');
    expect(appendSandboxSource(out!, "/repo")).toBeUndefined();
    expect(appendSandboxSource(".a{}", "/repo")).toBeUndefined();
  });

  it("the sandbox plugin is wired before tailwind in server.ts", () => {
    const server = readFileSync(join(here, "../sidecar/server.ts"), "utf8");
    const pluginIdx = server.indexOf(
      "sandboxTailwindSourcePlugin(dirname(configPath))",
    );
    const tailwindIdx = server.indexOf("...tailwind,", pluginIdx);
    expect(pluginIdx).toBeGreaterThan(-1);
    expect(tailwindIdx).toBeGreaterThan(pluginIdx);
  });
});

describe("generatedDirsTailwindSourcePlugin (injected mode)", () => {
  const v4Entry = '@import "tailwindcss";\n';
  const plugin = generatedDirsTailwindSourcePlugin("/repo/app");
  const transform = plugin.transform as {
    order?: string;
    handler: (code: string, id: string) => { code: string } | null;
  };

  it("appends BOTH generated-dir @sources to a v4 entry css", () => {
    const out = transform.handler(v4Entry, "/repo/app/src/index.css");
    expect(out?.code).toContain('@source "/repo/app/.designbook/variations";');
    expect(out?.code).toContain('@source "/repo/app/.designbook/sandbox";');
  });

  it("leaves non-css / non-v4 modules untouched, and is idempotent", () => {
    expect(transform.handler(v4Entry, "/repo/app/src/App.tsx")).toBeNull();
    expect(transform.handler(".a{}", "/repo/app/src/plain.css")).toBeNull();
    const once = transform.handler(v4Entry, "/repo/app/src/index.css")!;
    expect(transform.handler(once.code, "/repo/app/src/index.css")).toBeNull();
  });

  it("uses hook-level order 'pre' (must beat the app's enforce-pre tailwind plugin regardless of registration order)", () => {
    expect(transform.order).toBe("pre");
    expect(plugin.apply).toBe("serve");
  });
});

describe("embedded-server wiring", () => {
  it("the plugin runs pre, before tailwind, in server.ts", () => {
    const server = readFileSync(
      join(here, "../sidecar/server.ts"),
      "utf8",
    );
    // App-owned home (monorepo rule): the @source points at the CONFIG dir's
    // .designbook/variations, not the git root.
    const pluginIdx = server.indexOf(
      "variationsTailwindSourcePlugin(dirname(configPath))",
    );
    // The plugins array's tailwind spread (the earlier hit is an unrelated
    // helper); order within the array is what matters.
    const tailwindIdx = server.indexOf("...tailwind,", pluginIdx);
    expect(pluginIdx).toBeGreaterThan(-1);
    expect(tailwindIdx).toBeGreaterThan(pluginIdx);

    const plugin = readFileSync(
      join(here, "variationsTailwindSource.ts"),
      "utf8",
    );
    expect(plugin).toContain('enforce: "pre"');
  });
});
