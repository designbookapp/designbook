import { describe, expect, it } from "vitest";
import {
  sourceFromFiber,
  stampSynthesizedEntry,
  withStampedSource,
  type Fiber,
} from "./fibers";

const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_MEMO = Symbol.for("react.memo");

function fiberOf(type: unknown): Fiber {
  return { type } as unknown as Fiber;
}

/** Stamp a component the way the transform does: on the DECLARED binding. */
function stamp<T extends object>(binding: T, file: string): T {
  (binding as { __dbSource?: string }).__dbSource = file;
  return binding;
}

describe("sourceFromFiber", () => {
  it("reads the stamp off a plain function component (fiber.type)", () => {
    const Card = stamp(function Card() {}, "src/Card.tsx");
    expect(sourceFromFiber(fiberOf(Card))).toBe("src/Card.tsx");
  });

  it("reads the stamp off a memo wrapper binding (React uses it as fiber.type)", () => {
    const inner = function Inner() {};
    const memo = stamp(
      { $$typeof: REACT_MEMO, type: inner },
      "src/Memoed.tsx",
    );
    expect(sourceFromFiber(fiberOf(memo))).toBe("src/Memoed.tsx");
  });

  it("reads the stamp off a forwardRef wrapper binding", () => {
    const ref = stamp(
      { $$typeof: REACT_FORWARD_REF, render: () => null },
      "src/Reffed.tsx",
    );
    expect(sourceFromFiber(fiberOf(ref))).toBe("src/Reffed.tsx");
  });

  it("returns undefined for an unstamped component (library / prod build)", () => {
    expect(sourceFromFiber(fiberOf(function Plain() {}))).toBeUndefined();
  });

  it("returns undefined for host elements / non-objects", () => {
    expect(sourceFromFiber(fiberOf("div"))).toBeUndefined();
    expect(sourceFromFiber(fiberOf(null))).toBeUndefined();
  });
});

describe("withStampedSource — runtime prefers the stamp over the name index", () => {
  const nameEntry = {
    id: "src:a.tsx#PromoCard",
    name: "PromoCard",
    label: "PromoCard",
    sourcePath: "src/a.tsx", // name-index guess (first candidate)
    component: undefined,
    setId: "src",
    key: "PromoCard",
    origin: "index" as const,
  };

  it("overrides the entry sourcePath with the fiber's exact stamp", () => {
    const fiber = fiberOf(stamp(function PromoCard() {}, "src/wrap/index.tsx"));
    expect(withStampedSource(nameEntry, fiber).sourcePath).toBe(
      "src/wrap/index.tsx",
    );
  });

  it("leaves the entry untouched when the fiber is unstamped (fallback)", () => {
    const fiber = fiberOf(function PromoCard() {});
    expect(withStampedSource(nameEntry, fiber)).toBe(nameEntry);
  });
});

describe("stampSynthesizedEntry — a stamped fiber is a boundary even pre-index", () => {
  it("synthesizes an exact entry from a stamped, unindexed fiber", () => {
    const fiber = fiberOf(stamp(function PromoCard() {}, "src/wrap/index.tsx"));
    const entry = stampSynthesizedEntry(fiber);
    expect(entry).toMatchObject({
      name: "PromoCard",
      sourcePath: "src/wrap/index.tsx",
      id: "src:src/wrap/index.tsx#PromoCard",
      origin: "index",
    });
  });

  it("resolves two same-name components to their OWN files (distinct entries)", () => {
    const wrapper = fiberOf(stamp(function PromoCard() {}, "src/wrap/index.tsx"));
    const inner = fiberOf(stamp(function PromoCard() {}, "src/wrap/component.tsx"));
    const a = stampSynthesizedEntry(wrapper)!;
    const b = stampSynthesizedEntry(inner)!;
    expect(a.sourcePath).toBe("src/wrap/index.tsx");
    expect(b.sourcePath).toBe("src/wrap/component.tsx");
    expect(a.id).not.toBe(b.id); // file-scoped ids keep the twins distinct
  });

  it("returns undefined for an unstamped fiber (name index handles it)", () => {
    expect(stampSynthesizedEntry(fiberOf(function X() {}))).toBeUndefined();
  });
});
