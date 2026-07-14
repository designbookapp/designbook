/**
 * Props-panel section registry: registration, id-dedup replace, order/id
 * sorting, unregister, reset, and the empty-registry (nothing-extra) case.
 * Uses a trivial example section (NOT figma).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { PropsPanelSectionSpec } from "@designbook-ui/integrations";
import {
  getPropsPanelSections,
  registerPropsPanelSection,
  resetPropsPanelSections,
  unregisterPropsPanelSection,
} from "./sectionRegistry.ts";

/** A trivial example contribution — a section that renders nothing. */
const ExampleSection = () => null;

function section(
  id: string,
  order?: number,
): PropsPanelSectionSpec {
  return {
    id,
    title: `Section ${id}`,
    ...(order !== undefined ? { order } : {}),
    Component: ExampleSection,
  };
}

afterEach(() => resetPropsPanelSections());

describe("props-panel section registry", () => {
  it("is empty by default (renders nothing extra)", () => {
    expect(getPropsPanelSections()).toEqual([]);
  });

  it("registers and returns a contributed section", () => {
    registerPropsPanelSection(section("figma-export"));
    const sections = getPropsPanelSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("figma-export");
    expect(sections[0].Component).toBe(ExampleSection);
  });

  it("sorts by order then id", () => {
    registerPropsPanelSection(section("b", 1));
    registerPropsPanelSection(section("a", 1));
    registerPropsPanelSection(section("z", -1));
    registerPropsPanelSection(section("m")); // default order 0
    expect(getPropsPanelSections().map((s) => s.id)).toEqual([
      "z", // order -1
      "m", // order 0
      "a", // order 1, id a < b
      "b",
    ]);
  });

  it("replaces a section registered again under the same id", () => {
    registerPropsPanelSection(section("x"));
    const Replacement = () => null;
    registerPropsPanelSection({
      id: "x",
      title: "Replaced",
      Component: Replacement,
    });
    const sections = getPropsPanelSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Replaced");
    expect(sections[0].Component).toBe(Replacement);
  });

  it("unregisters by id", () => {
    registerPropsPanelSection(section("keep"));
    registerPropsPanelSection(section("drop"));
    unregisterPropsPanelSection("drop");
    expect(getPropsPanelSections().map((s) => s.id)).toEqual(["keep"]);
  });

  it("reset clears everything", () => {
    registerPropsPanelSection(section("a"));
    registerPropsPanelSection(section("b"));
    resetPropsPanelSections();
    expect(getPropsPanelSections()).toEqual([]);
  });
});
