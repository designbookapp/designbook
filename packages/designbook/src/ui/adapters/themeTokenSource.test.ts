/**
 * G2a inversion tests: the theme adapter publishes a NEUTRAL TokenSource into
 * the workbench registry (no figma naming, no figma imports), exposes a
 * write-back hook, and forwards the deprecated `figma` option through
 * `meta.figma` with a one-time console warning (the shim the one external
 * `theme.figma` user relies on).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The adapter notifies the (singleton) adapter runtime on optimistic edits;
// no runtime is initialized in unit tests.
vi.mock("@designbook-ui/adapterRuntime", () => ({
  getAdapterRuntime: () => ({ notifyValuesChanged: () => {} }),
}));

// notifyFileWritten dispatches a window event; vitest runs in node.
vi.mock("@designbook-ui/fileWriteBus", () => ({
  notifyFileWritten: () => {},
}));

import { themeAdapter } from "./theme";
import {
  getTokenSources,
  resetTokenSources,
} from "@designbook-ui/integrations/tokenSources";

const jsonSource = {
  light: { primary: "oklch(0.6 0.1 250)", radius: "0.5rem" },
  dark: { primary: "oklch(0.3 0.1 250)" },
};

function fetchStub() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

beforeEach(() => {
  resetTokenSources();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("themeAdapter token source (G2a)", () => {
  it("publishes a neutral source with resolved tokens and modes", async () => {
    fetchStub();
    const adapter = themeAdapter({
      source: jsonSource,
      modes: { light: ":root", dark: ".dark" },
      sourcePath: "./src/themes/tokens.json",
    });
    await adapter.setup!();

    const sources = getTokenSources();
    expect(sources).toHaveLength(1);
    const source = sources[0];
    expect(source.id).toBe("theme");
    expect(source.modes).toEqual(["light", "dark"]);
    expect(source.collectionHint).toBe("designbook/theme");
    expect(source.meta).toBeUndefined();

    const tokens = source.getTokens();
    const primary = tokens.find((token) => token.name === "primary");
    expect(primary).toMatchObject({
      type: "color",
      cssVar: "primary",
      valuesByMode: {
        light: "oklch(0.6 0.1 250)",
        dark: "oklch(0.3 0.1 250)",
      },
    });
    // Nothing figma-shaped leaks into the neutral tokens.
    for (const token of tokens) {
      expect(Object.keys(token)).not.toContain("figmaName");
    }
  });

  it("writes token edits back through setToken (the sync-from hook)", async () => {
    const calls = fetchStub();
    const adapter = themeAdapter({
      source: jsonSource,
      sourcePath: "./src/themes/tokens.json",
    });
    await adapter.setup!();

    const source = getTokenSources()[0];
    await source.setToken!("light", "primary", "oklch(0.7 0.2 120)");

    const write = calls.find((call) => call.url.includes("/api/json"));
    expect(write).toBeDefined();
    const body = JSON.parse(String(write!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      keyPath: "light.primary",
      value: "oklch(0.7 0.2 120)",
    });
    // And the in-memory model reflects the optimistic edit.
    expect(
      source.getTokens().find((token) => token.name === "primary")!
        .valuesByMode.light,
    ).toBe("oklch(0.7 0.2 120)");
  });

  it("forwards the deprecated figma option through meta with a warning", async () => {
    fetchStub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nameRule = (token: string) => `brand/${token}`;
    const adapter = themeAdapter({
      source: jsonSource,
      sourcePath: "./src/themes/tokens.json",
      figma: { collection: "legacy/collection", nameRule },
    });
    await adapter.setup!();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/deprecated/i);
    expect(String(warn.mock.calls[0][0])).toMatch(/integrations/);

    const source = getTokenSources()[0];
    expect(source.meta).toEqual({
      figma: { collection: "legacy/collection", nameRule },
    });
  });

  it("does not warn without the deprecated option", async () => {
    fetchStub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = themeAdapter({
      source: jsonSource,
      sourcePath: "./src/themes/tokens.json",
    });
    await adapter.setup!();
    expect(warn).not.toHaveBeenCalled();
  });
});
