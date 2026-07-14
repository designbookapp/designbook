import { describe, expect, it } from "vitest";
import {
  createOverrideHostDriver,
  hasBypassMarker,
  resolveOverrideRedirect,
  stripBypassMarker,
  type ModuleOverrideHost,
} from "./overrideController.ts";

const DEV = { command: "serve", isProduction: false };
const REDIRECTS = new Map([["/repo/src/Card.tsx", "/repo/.designbook/sandbox/overrides/src/Card.tsx"]]);

describe("resolveOverrideRedirect", () => {
  it("redirects a mapped module in a dev serve", () => {
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Card.tsx",
        redirects: REDIRECTS,
        env: DEV,
      }),
    ).toBe("/repo/.designbook/sandbox/overrides/src/Card.tsx");
  });

  it("DEV-ONLY HARD GATE: a production/build pass never sees redirects", () => {
    // A build command never redirects — even with a populated table.
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Card.tsx",
        redirects: REDIRECTS,
        env: { command: "build", isProduction: true },
      }),
    ).toBeUndefined();
    // A production-mode serve (vite preview-ish hosts) never redirects.
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Card.tsx",
        redirects: REDIRECTS,
        env: { command: "serve", isProduction: true },
      }),
    ).toBeUndefined();
    // An unknown environment fails CLOSED.
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Card.tsx",
        redirects: REDIRECTS,
        env: { command: "unknown", isProduction: true },
      }),
    ).toBeUndefined();
  });

  it("the ?db-original bypass is loop-proof", () => {
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Card.tsx?db-original",
        redirects: REDIRECTS,
        env: DEV,
      }),
    ).toBeUndefined();
    // Marker among other query params still bypasses.
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Card.tsx?t=3&db-original",
        redirects: REDIRECTS,
        env: DEV,
      }),
    ).toBeUndefined();
  });

  it("unmapped modules and empty tables resolve nothing", () => {
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Other.tsx",
        redirects: REDIRECTS,
        env: DEV,
      }),
    ).toBeUndefined();
    expect(
      resolveOverrideRedirect({
        resolvedId: "/repo/src/Card.tsx",
        redirects: new Map(),
        env: DEV,
      }),
    ).toBeUndefined();
  });
});

describe("bypass marker helpers", () => {
  it("detects and strips the marker (other query params kept)", () => {
    expect(hasBypassMarker("./Card.tsx?db-original")).toBe(true);
    expect(hasBypassMarker("./Card.tsx?t=1")).toBe(false);
    expect(stripBypassMarker("./Card.tsx?db-original")).toBe("./Card.tsx");
    expect(stripBypassMarker("./Card.tsx?t=1&db-original")).toBe(
      "./Card.tsx?t=1",
    );
  });
});

function fakeHost() {
  const calls: string[] = [];
  const host: ModuleOverrideHost = {
    originalBypassMarker: "?db-original",
    redirect: (map) => calls.push(`redirect:${map.size}`),
    invalidate: (id) => calls.push(`invalidate:${id}`),
    hotUpdate: () => calls.push("hot"),
  };
  return { host, calls };
}

describe("createOverrideHostDriver", () => {
  it("FIRST-TIME override = one importer invalidation + ONE hot update", () => {
    const { host, calls } = fakeHost();
    const driver = createOverrideHostDriver(host);
    driver.apply({ "/repo/src/Card.tsx": "/repo/shim/Card.tsx" });
    expect(calls).toEqual([
      "redirect:1",
      "invalidate:/repo/src/Card.tsx",
      "hot",
    ]);
  });

  it("an unchanged table re-applies without invalidation (byte-stable)", () => {
    const { host, calls } = fakeHost();
    const driver = createOverrideHostDriver(host);
    driver.apply({ "/repo/src/Card.tsx": "/repo/shim/Card.tsx" });
    calls.length = 0;
    driver.apply({ "/repo/src/Card.tsx": "/repo/shim/Card.tsx" });
    expect(calls).toEqual(["redirect:1"]); // refresh only — no hot churn
  });

  it("a removed redirect invalidates the SHIM's importers (back to original)", () => {
    const { host, calls } = fakeHost();
    const driver = createOverrideHostDriver(host);
    driver.apply({ "/repo/src/Card.tsx": "/repo/shim/Card.tsx" });
    calls.length = 0;
    driver.apply({});
    expect(calls).toEqual(["redirect:0", "invalidate:/repo/shim/Card.tsx", "hot"]);
  });

  it("a VALUE-CHANGED redirect (variant→variant flip) invalidates BOTH sides — the loaded PREVIOUS alternative carries the hot update (L2 live finding)", () => {
    const { host, calls } = fakeHost();
    const driver = createOverrideHostDriver(host);
    driver.apply({ "/repo/src/Card.tsx": "/repo/alts/promo/Card.tsx" });
    calls.length = 0;
    driver.apply({ "/repo/src/Card.tsx": "/repo/alts/split/Card.tsx" });
    expect(calls).toEqual([
      "redirect:1",
      "invalidate:/repo/src/Card.tsx",
      "invalidate:/repo/alts/promo/Card.tsx",
      "hot",
    ]);
  });

  it("a STAMP-CHANGED entry (same paths, re-projected CONTENT \u2014 park/rollback) is treated like a value change: both sides invalidate + ONE hot update", () => {
    const { host, calls } = fakeHost();
    const driver = createOverrideHostDriver(host);
    const table = { "/repo/src/Card.tsx": "/repo/alts/va/Card.tsx" };
    driver.apply(table, { "/repo/src/Card.tsx": 1 });
    calls.length = 0;
    // Same table, bumped stamp = the alt file was rewritten in place.
    driver.apply(table, { "/repo/src/Card.tsx": 2 });
    expect(calls).toEqual([
      "redirect:1",
      "invalidate:/repo/src/Card.tsx",
      "invalidate:/repo/alts/va/Card.tsx",
      "hot",
    ]);
    calls.length = 0;
    // Unchanged stamp = refresh only, no hot churn.
    driver.apply(table, { "/repo/src/Card.tsx": 2 });
    expect(calls).toEqual(["redirect:1"]);
  });

  it("a stamp APPEARING on an existing entry counts as a content change; stampless applies never invalidate", () => {
    const { host, calls } = fakeHost();
    const driver = createOverrideHostDriver(host);
    const table = { "/repo/src/Card.tsx": "/repo/alts/va/Card.tsx" };
    driver.apply(table); // no stamps at all (legacy payload)
    calls.length = 0;
    driver.apply(table); // still none \u2014 no churn
    expect(calls).toEqual(["redirect:1"]);
    calls.length = 0;
    driver.apply(table, { "/repo/src/Card.tsx": 7 }); // first stamp = write
    expect(calls).toEqual([
      "redirect:1",
      "invalidate:/repo/src/Card.tsx",
      "invalidate:/repo/alts/va/Card.tsx",
      "hot",
    ]);
  });
});
