/**
 * Selection-context registry + run store (PREVIEW —
 * docs/specs/selection-context.md): deterministic order (core first),
 * sync-first/async-patch-in resolution, stale-run dropping, per-contributor
 * prompt budget, and the sampled serializer.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  getSelectionContributors,
  registerSelectionContributor,
  resetSelectionContributors,
} from "./registry";
import {
  PROMPT_FRAGMENT_BUDGET,
  buildSelectionContextBlock,
  capPromptFragment,
  getSelectionContextSnapshot,
  getSelectionPromptFragments,
  refreshSelectionContext,
  resetSelectionContext,
  runSelectionContext,
} from "./store";
import { sampleValue } from "./sampleValue";
import type {
  SelectionContextContribution,
  SelectionContextInput,
} from "./types";

const ctx = { apiUrl: (path: string) => `http://test${path}` };

function input(label = "Card"): SelectionContextInput {
  return { node: { label, description: "a card", path: "src/Card.tsx" } };
}

function contribution(
  source: string,
  prompt?: string,
): SelectionContextContribution {
  return { source, title: source, facts: [{ label: "k", value: "v" }], prompt };
}

/** Let queued promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  resetSelectionContributors();
  resetSelectionContext();
});

describe("selection contributor registry", () => {
  it("pins core first regardless of registration timing", () => {
    registerSelectionContributor("props", () => contribution("props"));
    registerSelectionContributor("figma", () => contribution("figma"));
    registerSelectionContributor("core", () => contribution("core"));
    expect(getSelectionContributors().map((entry) => entry.id)).toEqual([
      "core",
      "props",
      "figma",
    ]);
  });

  it("replaces by id without reordering", () => {
    registerSelectionContributor("a", () => contribution("a1"));
    registerSelectionContributor("b", () => contribution("b"));
    registerSelectionContributor("a", () => contribution("a2"));
    expect(getSelectionContributors().map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("selection context run store", () => {
  it("publishes sync contributions immediately, in registry order", () => {
    registerSelectionContributor("props", () => contribution("props"));
    registerSelectionContributor("core", () => contribution("core"));
    runSelectionContext(input(), ctx);
    const snapshot = getSelectionContextSnapshot();
    expect(snapshot.pending).toBe(0);
    expect(snapshot.contributions.map((entry) => entry.source)).toEqual([
      "core",
      "props",
    ]);
  });

  it("patches async contributions in when they resolve", async () => {
    registerSelectionContributor("core", () => contribution("core"));
    registerSelectionContributor("i18n", async () => contribution("i18n"));
    runSelectionContext(input(), ctx);

    let snapshot = getSelectionContextSnapshot();
    expect(snapshot.contributions.map((entry) => entry.source)).toEqual(["core"]);
    expect(snapshot.pending).toBe(1);

    await flush();
    snapshot = getSelectionContextSnapshot();
    expect(snapshot.pending).toBe(0);
    expect(snapshot.contributions.map((entry) => entry.source)).toEqual([
      "core",
      "i18n",
    ]);
  });

  it("skips undefined and throwing contributors", () => {
    registerSelectionContributor("core", () => contribution("core"));
    registerSelectionContributor("empty", () => undefined);
    registerSelectionContributor("broken", () => {
      throw new Error("boom");
    });
    runSelectionContext(input(), ctx);
    expect(
      getSelectionContextSnapshot().contributions.map((entry) => entry.source),
    ).toEqual(["core"]);
  });

  it("drops a stale run's async results", async () => {
    let release: (() => void) | undefined;
    registerSelectionContributor("slow", () => {
      return new Promise<SelectionContextContribution>((resolve) => {
        release = () => resolve(contribution("slow", "STALE"));
      });
    });
    runSelectionContext(input("First"), ctx);
    const releaseFirst = release;

    registerSelectionContributor("fast", () => contribution("fast"));
    runSelectionContext(input("Second"), ctx);
    releaseFirst?.();
    await flush();

    const snapshot = getSelectionContextSnapshot();
    expect(snapshot.input?.node.label).toBe("Second");
    expect(
      snapshot.contributions.map((entry) => entry.source),
    ).not.toContain("STALE");
  });

  it("clears on an undefined run and re-runs on refresh", () => {
    let runs = 0;
    registerSelectionContributor("core", () => {
      runs += 1;
      return contribution("core");
    });
    runSelectionContext(input(), ctx);
    expect(runs).toBe(1);
    refreshSelectionContext();
    expect(runs).toBe(2);

    runSelectionContext(undefined, ctx);
    expect(getSelectionContextSnapshot().contributions).toEqual([]);
    // Refresh with nothing selected stays empty (no crash, no stale re-run).
    refreshSelectionContext();
    expect(getSelectionContextSnapshot().contributions).toEqual([]);
  });
});

describe("prompt fragments", () => {
  it("caps each fragment to the budget with a truncation marker", () => {
    const long = "x".repeat(PROMPT_FRAGMENT_BUDGET + 100);
    expect(capPromptFragment("short")).toBe("short");
    const capped = capPromptFragment(long);
    expect(capped.length).toBe(
      PROMPT_FRAGMENT_BUDGET + "\n[truncated]".length,
    );
    expect(capped.endsWith("\n[truncated]")).toBe(true);
  });

  it("assembles resolved fragments under [source] headers, core first", () => {
    registerSelectionContributor("props", () =>
      contribution("props", "a: 1\nb: 2"),
    );
    registerSelectionContributor("core", () =>
      contribution("core", "Component defined at src/Card.tsx"),
    );
    registerSelectionContributor("silent", () => contribution("silent"));
    runSelectionContext(input(), ctx);

    expect(getSelectionPromptFragments().map((f) => f.source)).toEqual([
      "core",
      "props",
    ]);
    expect(buildSelectionContextBlock()).toBe(
      "[core]\nComponent defined at src/Card.tsx\n[props]\na: 1\nb: 2",
    );
  });

  it("returns undefined with no resolved fragments", () => {
    expect(buildSelectionContextBlock()).toBeUndefined();
  });
});

describe("sampleValue", () => {
  it("renders primitives and truncates long strings", () => {
    expect(sampleValue(42)).toBe("42");
    expect(sampleValue(true)).toBe("true");
    expect(sampleValue(null)).toBe("null");
    expect(sampleValue(undefined)).toBe("undefined");
    expect(sampleValue("hi")).toBe('"hi"');
    const long = sampleValue("y".repeat(200));
    expect(long.length).toBeLessThan(90);
    expect(long).toContain("…");
  });

  it("lists functions by name only", () => {
    function onSelect() {}
    expect(sampleValue(onSelect)).toBe("ƒ onSelect()");
    expect(sampleValue(() => {})).toMatch(/^ƒ/);
  });

  it("caps depth and entry counts", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(sampleValue(deep)).toBe("{a: {b: {c: {…}}}}");
    const wide = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`k${i}`, i]),
    );
    expect(sampleValue(wide)).toContain("…");
    expect(sampleValue(wide)).not.toContain("k9");
  });

  it("cuts cycles", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(sampleValue(cyclic)).toBe('{name: "loop", self: [circular]}');
  });

  it("marks react elements opaquely", () => {
    const element = { $$typeof: Symbol.for("react.element"), type: "div" };
    expect(sampleValue(element)).toBe("<element>");
  });
});
