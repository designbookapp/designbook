import { describe, expect, it } from "vitest";
import {
  CASES,
  SET_ID,
  caseEntryId,
  caseRoute,
  caseEntrySelector,
  casesForTier,
} from "./caseConfig.ts";

describe("caseConfig", () => {
  it("derives entry id, route, and selector from the case id", () => {
    expect(caseEntryId("solid-bg")).toBe("fidelity.solid-bg");
    expect(caseRoute("solid-bg")).toBe("#/component/fidelity.solid-bg");
    expect(caseEntrySelector("solid-bg")).toBe("fidelity.solid-bg");
    expect(SET_ID).toBe("fidelity");
  });

  it("has unique, slug-shaped case ids", () => {
    const ids = CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("marks every case for the tier-1 HTML gate", () => {
    for (const entry of CASES) expect(entry.tiers.html).toBe(true);
  });

  it("filters cases by tier", () => {
    const vision = casesForTier(CASES, "vision").map((entry) => entry.id);
    expect(vision).toContain("text-basic");
    expect(vision).not.toContain("solid-bg");
    expect(casesForTier(CASES, "html").length).toBe(CASES.length);
  });
});
