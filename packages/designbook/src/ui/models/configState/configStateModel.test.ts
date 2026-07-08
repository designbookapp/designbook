/**
 * The `configState` model — dimension-value exposure, the derived active
 * dataset, and injected setter routing (theme / context / dataset / dark) —
 * exercised through the canonical fixtures. Pure/DOM-free (the adapter runtime +
 * live-apply stay in `Workbench`, covered by the e2e), so this drives the seam
 * the settings bar + adapter panel consume.
 */

import { describe, expect, it } from "vitest";
import { createConfigStateModel } from "./configStateModel";
import { createConfigStateFixture } from "./fixtures";

describe("createConfigStateModel (fixture / data mode)", () => {
  it("exposes the dimension values", () => {
    const fx = createConfigStateFixture();
    const model = createConfigStateModel({ data: fx.data });
    expect(model.themeId).toBe("brand");
    expect(model.dimensions).toHaveLength(2);
    expect(model.context["i18n:locale"]).toBe("en-US");
    expect(model.follow["i18n:locale"].following).toBe(true);
    expect(model.hideDarkToggle).toBe(true);
  });

  it("derives the active dataset from the current id (else the first)", () => {
    const fx = createConfigStateFixture();
    expect(createConfigStateModel({ data: fx.data }).dataset?.id).toBe("default");
    const model = createConfigStateModel({
      data: { ...fx.data, datasetId: "missing" },
    });
    expect(model.dataset?.id).toBe("default"); // falls back to the first
  });

  it("routes every setter through the injected action", () => {
    const fx = createConfigStateFixture();
    const model = createConfigStateModel({
      data: fx.data,
      setTheme: fx.setTheme,
      setContext: fx.setContext,
      setDataset: fx.setDataset,
      toggleDarkMode: fx.toggleDarkMode,
    });
    model.setTheme("neutral");
    model.setContext("i18n:locale", "fr-FR");
    model.setDataset("empty");
    model.toggleDarkMode();
    expect(fx.themes).toEqual(["neutral"]);
    expect(fx.contexts).toEqual([{ id: "i18n:locale", value: "fr-FR" }]);
    expect(fx.datasetSelections).toEqual(["empty"]);
    expect(fx.darkToggles).toBe(1);
  });

  it("defaults setters to no-ops and data to an empty set", () => {
    const model = createConfigStateModel();
    expect(model.dimensions).toEqual([]);
    expect(model.dataset).toBeUndefined();
    expect(() => {
      model.setTheme("x");
      model.setContext("a", "b");
      model.setDataset("d");
      model.toggleDarkMode();
    }).not.toThrow();
  });
});
