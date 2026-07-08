import { afterEach, describe, expect, it } from "vitest";
import { readFiberContext } from "./fiberContext";

type FakeFiber = {
  tag: number;
  type: unknown;
  stateNode: unknown;
  return: FakeFiber | null;
  child: FakeFiber | null;
  sibling: FakeFiber | null;
  memoizedProps: Record<string, unknown>;
};

function fiber(partial: Partial<FakeFiber>): FakeFiber {
  return {
    tag: 0,
    type: null,
    stateNode: null,
    return: null,
    child: null,
    sibling: null,
    memoizedProps: {},
    ...partial,
  };
}

/** A React 18 context + its `<Ctx.Provider>` fiber type. */
function context18() {
  const ctx: Record<string, unknown> = { $$typeof: Symbol.for("react.context") };
  const providerType = { $$typeof: Symbol.for("react.provider"), _context: ctx };
  ctx.Provider = providerType;
  return { ctx, providerType };
}

/** A React 19 context, used directly as the provider fiber's `type`. */
function context19() {
  return { $$typeof: Symbol.for("react.context"), _currentValue: undefined };
}

/**
 * A stand-in for a DOM element carrying React's `__reactFiber$…` expando. The
 * helper only calls `Object.keys(el)` on it, so a plain object suffices in the
 * node test environment (no jsdom).
 */
function elementWithFiber(leaf: FakeFiber): Element {
  return { __reactFiber$test: leaf } as unknown as Element;
}

const globalWithDocument = globalThis as { document?: unknown };
const originalDocument = globalWithDocument.document;

afterEach(() => {
  if (originalDocument === undefined) delete globalWithDocument.document;
  else globalWithDocument.document = originalDocument;
});

/** Stub a `document` whose `querySelectorAll("*")` returns the given nodes. */
function stubDocument(nodes: unknown[]) {
  globalWithDocument.document = { querySelectorAll: () => nodes };
}

describe("readFiberContext — walk up from an element", () => {
  it("reads the nearest React 18 <Ctx.Provider> value", () => {
    const { ctx, providerType } = context18();
    const provider = fiber({ type: providerType, memoizedProps: { value: "tenant-18" } });
    const leaf = fiber({ return: provider });
    provider.child = leaf;

    expect(readFiberContext(ctx, elementWithFiber(leaf))).toBe("tenant-18");
  });

  it("reads a React 19 <Ctx> provider value (type === context)", () => {
    const ctx = context19();
    const provider = fiber({ type: ctx, memoizedProps: { value: "tenant-19" } });
    const leaf = fiber({ return: provider });

    expect(readFiberContext(ctx, elementWithFiber(leaf))).toBe("tenant-19");
  });

  it("returns the nearest provider when several are stacked", () => {
    const ctx = context19();
    const outer = fiber({ type: ctx, memoizedProps: { value: "outer" } });
    const inner = fiber({ type: ctx, memoizedProps: { value: "inner" }, return: outer });
    const leaf = fiber({ return: inner });

    expect(readFiberContext(ctx, elementWithFiber(leaf))).toBe("inner");
  });

  it("returns undefined when no provider is above the element", () => {
    const ctx = context19();
    const leaf = fiber({ return: fiber({}) });
    expect(readFiberContext(ctx, elementWithFiber(leaf))).toBeUndefined();
  });

  it("returns undefined for an element with no fiber (never throws)", () => {
    expect(readFiberContext(context19(), {} as unknown as Element)).toBeUndefined();
  });

  it("does not match an unrelated context", () => {
    const ctx = context19();
    const other = context19();
    const provider = fiber({ type: other, memoizedProps: { value: "x" } });
    const leaf = fiber({ return: provider });
    expect(readFiberContext(ctx, elementWithFiber(leaf))).toBeUndefined();
  });
});

describe("readFiberContext — search the app root", () => {
  it("finds a provider top-down from the React root container", () => {
    const ctx = context19();
    const provider = fiber({ type: ctx, memoizedProps: { value: "root-value" } });
    const root = fiber({ child: provider });
    stubDocument([{ __reactContainer$test: { current: root } }]);

    expect(readFiberContext(ctx)).toBe("root-value");
  });

  it("handles a container that is the root fiber directly (no `.current`)", () => {
    const ctx = context19();
    const provider = fiber({ type: ctx, memoizedProps: { value: "direct" } });
    const root = fiber({ child: provider });
    stubDocument([{ __reactContainer$test: root }]);

    expect(readFiberContext(ctx)).toBe("direct");
  });

  it("returns undefined when no React root is present", () => {
    stubDocument([{ id: "not-a-root" }]);
    expect(readFiberContext(context19())).toBeUndefined();
  });
});
