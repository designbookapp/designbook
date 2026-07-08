/**
 * The `frame` model — the live-handle state exposure, injected open/latch
 * routing, and the bundled pure route + hit ops — exercised through the
 * canonical fixtures. The DOM/iframe-bound helpers (reload/flush/hit-test) stay
 * in their own modules with their own tests; this drives the seam the App page's
 * overlays consume.
 */

import { describe, expect, it } from "vitest";
import { createFrameModel } from "./frameModel";
import { createFrameFixture } from "./fixtures";
import { DEFAULT_APP_PATH } from "./appFrame";

describe("createFrameModel (fixture / data mode)", () => {
  it("exposes the iframe handle + route", () => {
    const fx = createFrameFixture();
    const model = createFrameModel({ data: fx.data });
    expect(model.iframe).toBeNull();
    expect(model.generation).toBe(0);
    expect(model.path).toBe("/products");
    expect(model.defaultPath).toBe(DEFAULT_APP_PATH);
  });

  it("routes open() and ignoreNextNavigation() through injected actions", () => {
    const fx = createFrameFixture();
    const model = createFrameModel({
      data: fx.data,
      open: fx.open,
      ignoreNextNavigation: fx.ignoreNextNavigation,
    });
    model.open("/cart");
    model.open("/checkout");
    model.ignoreNextNavigation();
    expect(fx.opens).toEqual(["/cart", "/checkout"]);
    expect(fx.ignores).toBe(1);
  });

  it("routes setIframe() and notifyNavigated() through injected actions", () => {
    const iframes: (HTMLIFrameElement | null)[] = [];
    let navigated = 0;
    const model = createFrameModel({
      setIframe: (el) => void iframes.push(el),
      notifyNavigated: () => void (navigated += 1),
    });
    model.setIframe(null);
    model.notifyNavigated();
    model.notifyNavigated();
    expect(iframes).toEqual([null]);
    expect(navigated).toBe(2);
  });

  it("defaults actions to no-ops and the handle to empty", () => {
    const model = createFrameModel();
    expect(model.iframe).toBeNull();
    expect(model.path).toBe(DEFAULT_APP_PATH);
    expect(() => {
      model.open("/x");
      model.ignoreNextNavigation();
      model.setIframe(null);
      model.notifyNavigated();
    }).not.toThrow();
  });
});

describe("bundled pure route ops", () => {
  it("builds a same-origin frame src carrying the recursion-guard param", () => {
    const model = createFrameModel();
    const src = model.buildFrameSrc("cart");
    expect(src).toContain("/cart");
    expect(src).toContain("__designbook_frame=1");
    expect(model.stripFrameParam(src)).toBe("/cart");
    expect(model.normalizeAppPath("cart")).toBe("/cart");
  });
});

describe("bundled pure hit ops", () => {
  it("gates Go-to-component to component-level hits", () => {
    const fx = createFrameFixture();
    const model = createFrameModel();
    expect(model.canGoToComponent(fx.componentHit)).toBe(true);
    expect(model.canGoToComponent(fx.domHit)).toBe(false);
  });

  it("builds a rich prompt prefill for a component hit with a code target", () => {
    const fx = createFrameFixture();
    const model = createFrameModel();
    const prefill = model.buildPromptPrefill(fx.componentHit);
    expect(prefill).toContain("Re: ProductCard");
    expect(prefill).toContain("src/pages/Products.tsx");
    expect(prefill).toContain('className="featured"');
  });

  it("degrades the prompt prefill for a plain DOM hit", () => {
    const fx = createFrameFixture();
    const model = createFrameModel();
    const prefill = model.buildPromptPrefill(fx.domHit);
    expect(prefill).toContain("button.cta");
    expect(prefill).toContain("not a registered component");
  });
});
