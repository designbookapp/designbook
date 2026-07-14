/**
 * Pins the page-mode adapter-capture race fix (docs/specs/sandbox.md, D2).
 *
 * Root cause being guarded: the page-tools root mounts before the mount
 * bootstrap has even STARTED `loadAdapterRuntime()` (it waits on the big
 * WorkbenchRoot chunk first, then on every adapter setup's network fetches).
 * A pin submitted in that window used to read the SYNC `getAdapterRuntime()`,
 * swallow its "before initialization" throw, and record `adapters: {}` — so
 * variants rendered with DEFAULT theme/locale/flags instead of the live
 * state. `captureFromHit` must now AWAIT the shared init promise and record
 * the actual state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Deferred fake runtime: tests control when init "completes".
let resolveInit: ((runtime: unknown) => void) | undefined;
let rejectInit: ((error: unknown) => void) | undefined;
let ready = false;

vi.mock("@designbook-ui/adapterRuntime", () => ({
  isAdapterRuntimeReady: () => ready,
  loadAdapterRuntime: () =>
    new Promise((resolve, reject) => {
      resolveInit = (runtime) => {
        ready = true;
        resolve(runtime);
      };
      rejectInit = reject;
    }),
}));

// The registry evaluates the config store at import time — stub it out; the
// capture path only needs the lookup maps to exist.
vi.mock("@designbook-ui/models/catalog/componentRegistry", () => ({
  registryByName: new Map(),
  registryByRef: new Map(),
}));

import { captureFromHit } from "./captureLive";

const HIT = {
  kind: "component" as const,
  name: "Product · Card",
  instanceId: "product.ProductCard::0",
  entry: {
    id: "product.ProductCard",
    label: "Product · Card",
    sourcePath: "src/composite/product/variants/Card.tsx",
    key: "ProductCard",
  },
};

const RUNTIME = {
  dimensions: [
    { id: "theme:mode", defaultValue: "light" },
    { id: "i18next:locale", defaultValue: "en-US" },
    { id: "flags:tenant", defaultValue: "acme" },
  ],
  getSnapshot: () => ({
    context: { "theme:mode": "dark", "i18next:locale": "fr-FR" },
  }),
};

beforeEach(() => {
  ready = false;
  resolveInit = undefined;
  rejectInit = undefined;
  vi.restoreAllMocks();
});

describe("captureFromHit adapter state (page-mode race)", () => {
  it("awaits a not-yet-initialized runtime and records the LIVE state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = captureFromHit(HIT);
    // Init completes only AFTER capture started — the page-mode cold-load
    // window. The old sync read returned {} here.
    resolveInit!(RUNTIME);
    const { contextSnapshot } = await pending;
    expect(contextSnapshot.adapters).toEqual({
      "theme:mode": "dark",
      "i18next:locale": "fr-FR",
      "flags:tenant": "acme", // context miss falls back to the default
    });
    // The race leaves a diagnostic breadcrumb instead of failing silently.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("before the adapter runtime finished initializing"),
    );
  });

  it("captures without warning once the runtime is ready", async () => {
    ready = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = captureFromHit(HIT);
    resolveInit!(RUNTIME);
    const { contextSnapshot } = await pending;
    expect(contextSnapshot.adapters["theme:mode"]).toBe("dark");
    expect(warn).not.toHaveBeenCalled();
  });

  it("captures a context consumed only by the selection's SUBTREE (composite pins)", async () => {
    // Fake fiber shapes (React 19): the context object IS the provider type.
    const productContext = { $$typeof: Symbol.for("react.context"), displayName: "ProductContext" };
    const fiber = (over: Record<string, unknown>) => ({
      tag: 0,
      type: null,
      stateNode: null,
      return: null,
      child: null,
      sibling: null,
      memoizedProps: {},
      ...over,
    });
    // <ProductProvider> → <ProductCard> → <ProductPrice consumes ctx>
    const provider = fiber({
      tag: 10,
      type: productContext,
      memoizedProps: { value: { product: "Vineyard Loop", currency: "EUR" } },
    });
    const atom = fiber({
      dependencies: { firstContext: { context: productContext, next: null } },
    });
    const selection = fiber({ return: provider, child: atom, memoizedProps: {} });
    (atom as { return: unknown }).return = selection;

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = captureFromHit({ ...HIT, fiber: selection });
    resolveInit!(RUNTIME);
    const { contextSnapshot } = await pending;
    // Root-only consumption would have filtered this out — the composite
    // itself reads nothing; only its atom does.
    expect(contextSnapshot.contexts).toEqual([
      {
        name: "ProductContext",
        value: { product: "Vineyard Loop", currency: "EUR" },
      },
    ]);
  });

  it("degrades to {} (loudly) only when init itself fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = captureFromHit(HIT);
    rejectInit!(new Error("setup exploded"));
    const { contextSnapshot } = await pending;
    expect(contextSnapshot.adapters).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      "[designbook] sandbox adapter capture failed:",
      expect.any(Error),
    );
  });
});
