import { describe, expect, it } from "vitest";
import { matchFiber, type Fiber } from "./fibers";

// Minimal stand-ins for React element-type wrappers. matchFiber only reads
// `fiber.type`, so a bare object fiber is enough.
const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_MEMO = Symbol.for("react.memo");

function fiberOf(type: unknown): Fiber {
  return { type } as unknown as Fiber;
}

const entry = { id: "primitives.Button", label: "Button" } as never;

describe("matchFiber wrapper identity", () => {
  it("matches a plain function component registered by ref", () => {
    function Button() {
      return null;
    }
    const byRef = new Map<unknown, never>([[Button, entry]]);
    expect(matchFiber(fiberOf(Button), byRef, new Map())).toBe(entry);
  });

  it("matches a forwardRef component registered by its WRAPPER object", () => {
    // Fast-refresh-style anonymous inner render: no usable name, so the
    // byName fallback cannot save us — the direct wrapper lookup must.
    const wrapper = { $$typeof: REACT_FORWARD_REF, render: () => null };
    const byRef = new Map<unknown, never>([[wrapper, entry]]);
    expect(matchFiber(fiberOf(wrapper), byRef, new Map())).toBe(entry);
  });

  it("matches a memo(forwardRef) component registered by the memo wrapper", () => {
    const inner = { $$typeof: REACT_FORWARD_REF, render: () => null };
    const wrapper = { $$typeof: REACT_MEMO, type: inner };
    const byRef = new Map<unknown, never>([[wrapper, entry]]);
    expect(matchFiber(fiberOf(wrapper), byRef, new Map())).toBe(entry);
  });

  it("still matches wrappers by their unwrapped inner function", () => {
    function Inner() {
      return null;
    }
    const wrapper = { $$typeof: REACT_FORWARD_REF, render: Inner };
    const byRef = new Map<unknown, never>([[Inner, entry]]);
    expect(matchFiber(fiberOf(wrapper), byRef, new Map())).toBe(entry);
  });

  it("falls back to name matching when refs miss", () => {
    function NamedButton() {
      return null;
    }
    const byName = new Map<string, never>([["NamedButton", entry]]);
    expect(matchFiber(fiberOf(NamedButton), new Map(), byName)).toBe(entry);
  });

  it("returns undefined for unregistered types", () => {
    expect(matchFiber(fiberOf(() => null), new Map(), new Map())).toBe(
      undefined,
    );
  });
});
