import { describe, expect, it, vi } from "vitest";
import {
  armInstanceInstrumentation,
  disarmInstanceInstrumentation,
  withMarker,
  withoutMarker,
  type InstrumentableI18n,
} from "./pageTextInstrument";

describe("postProcess list helpers", () => {
  it("adds the marker idempotently across the string/array/undefined forms", () => {
    expect(withMarker(undefined)).toEqual(["designMarker"]);
    expect(withMarker("otherPP")).toEqual(["otherPP", "designMarker"]);
    expect(withMarker(["a", "designMarker"])).toEqual(["a", "designMarker"]);
  });

  it("removes only the marker, preserving other post-processors", () => {
    expect(withoutMarker(["a", "designMarker", "b"])).toEqual(["a", "b"]);
    expect(withoutMarker("designMarker")).toEqual([]);
    expect(withoutMarker(undefined)).toEqual([]);
  });
});

describe("armInstanceInstrumentation", () => {
  it("registers the processor once and enables it on options.postProcess", () => {
    const use = vi.fn();
    const i18n: InstrumentableI18n = { use, options: {}, modules: {} };

    expect(armInstanceInstrumentation(i18n, "PP")).toBe(true);
    expect(use).toHaveBeenCalledTimes(1);
    expect(use).toHaveBeenCalledWith("PP");
    expect(i18n.options?.postProcess).toEqual(["designMarker"]);
  });

  it("does not re-register when the processor is already present", () => {
    const use = vi.fn();
    const i18n: InstrumentableI18n = {
      use,
      options: { postProcess: "existing" },
      modules: { postProcessor: { designMarker: {} } },
    };
    armInstanceInstrumentation(i18n, "PP");
    expect(use).not.toHaveBeenCalled();
    expect(i18n.options?.postProcess).toEqual(["existing", "designMarker"]);
  });

  it("returns false for a missing instance", () => {
    expect(armInstanceInstrumentation(undefined)).toBe(false);
  });
});

describe("disarmInstanceInstrumentation", () => {
  it("strips the marker back off options.postProcess", () => {
    const i18n: InstrumentableI18n = {
      options: { postProcess: ["keep", "designMarker"] },
    };
    expect(disarmInstanceInstrumentation(i18n)).toBe(true);
    expect(i18n.options?.postProcess).toEqual(["keep"]);
  });

  it("is a no-op for an instance without options", () => {
    expect(disarmInstanceInstrumentation({})).toBe(false);
  });
});
