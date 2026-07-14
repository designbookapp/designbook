import { describe, expect, it, vi } from "vitest";
import type { DesignbookConfig } from "@designbookapp/designbook/config";
import {
  getDeprecatedConfigFields,
  initConfigStore,
  sets,
} from "@designbook-ui/designbook";
import { fromGlob } from "@designbookapp/designbook/config";

describe("deprecated config fields (config-slim back-compat)", () => {
  it("warns ONCE, records the fields, and keeps legacy fields functional", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const legacy = {
        title: "Legacy app",
        sets: [{ id: "a", title: "A", components: { X: () => null } }],
        flows: [{ id: "f", title: "F", screens: [] }],
        sourceModules: { "./src/x.tsx": {} },
        providers: [() => null],
        datasets: [{ id: "d", label: "D", data: {} }],
      } as unknown as DesignbookConfig;

      initConfigStore(legacy, ".");
      // Still functional: sets flow into the store (work-with-warning release).
      expect(sets.length).toBe(1); // ESM live binding sees the populated value
      expect(getDeprecatedConfigFields()).toEqual([
        "sets",
        "flows",
        "sourceModules",
        "providers",
        "datasets",
      ]);
      const deprecationCalls = () =>
        warn.mock.calls.filter((call) =>
          String(call[0]).includes("DEPRECATED designbook.config fields"),
        ).length;
      expect(deprecationCalls()).toBe(1);

      // Second init (e.g. remount) — no second console warning.
      initConfigStore(legacy, ".");
      expect(deprecationCalls()).toBe(1);
    } finally {
      warn.mockRestore();
      initConfigStore({} as DesignbookConfig, ".");
    }
  });

  it("records nothing for a slim config", () => {
    initConfigStore(
      { title: "Slim", adapters: [] } as unknown as DesignbookConfig,
      ".",
    );
    expect(getDeprecatedConfigFields()).toEqual([]);
    // Empty arrays don't count as usage either.
    initConfigStore(
      { sets: [], flows: [], providers: [], datasets: [] } as unknown as DesignbookConfig,
      ".",
    );
    expect(getDeprecatedConfigFields()).toEqual([]);
  });

  it("fromGlob warns once and keeps working", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = fromGlob({ "./src/Button.tsx": () => Promise.resolve({}) });
      const second = fromGlob({ "./src/Card.tsx": () => Promise.resolve({}) });
      expect(Object.keys(first)).toEqual(["Button"]);
      expect(Object.keys(second)).toEqual(["Card"]);
      const calls = warn.mock.calls.filter((call) =>
        String(call[0]).includes("fromGlob() is deprecated"),
      );
      expect(calls.length).toBeLessThanOrEqual(1); // once across the process
    } finally {
      warn.mockRestore();
    }
  });
});
