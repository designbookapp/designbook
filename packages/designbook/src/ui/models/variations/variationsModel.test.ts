/**
 * Pure variations-model tests: event folds, status reconstruction, module
 * URLs, and synthesized-entry shape (design-variations spec).
 */

import { describe, expect, it } from "vitest";
import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";
import {
  EMPTY_RENDER_THRESHOLD_PX,
  applyVariationsEvent,
  classifyRenderedSize,
  landedCounts,
  setsFromStatus,
  synthesizeVariantEntry,
  variantModuleUrl,
  type VariationsState,
} from "./variationsModel";

const BASE = "product.ProductCard";

function run(events: Array<Record<string, unknown>>): VariationsState {
  return events.reduce<VariationsState>(
    (state, event) => applyVariationsEvent(state, event),
    {},
  );
}

describe("applyVariationsEvent", () => {
  it("folds a full generate run: planning → planned → landings", () => {
    const state = run([
      { kind: "planning", base: BASE, count: 2 },
      {
        kind: "planned",
        base: BASE,
        items: [
          { slug: "compact", intent: "denser" },
          { slug: "airy", intent: "space" },
        ],
      },
      {
        kind: "landed",
        base: BASE,
        slug: "compact",
        path: ".designbook/variations/x.tsx",
        absPath: "/repo/.designbook/variations/x.tsx",
        rev: 1,
      },
      { kind: "failed", base: BASE, slug: "airy", error: "boom" },
    ]);
    const set = state[BASE];
    expect(set.planning).toBe(false);
    expect(landedCounts(set)).toEqual({ landed: 1, total: 2 });
    expect(set.items[0]).toMatchObject({
      slug: "compact",
      status: "landed",
      rev: 1,
      absPath: "/repo/.designbook/variations/x.tsx",
    });
    expect(set.items[1]).toMatchObject({
      slug: "airy",
      status: "failed",
      error: "boom",
    });
  });

  it("updating/updated bump status and rev (the ?t= remount key)", () => {
    const state = run([
      {
        kind: "landed",
        base: BASE,
        slug: "compact",
        absPath: "/r/v.tsx",
        rev: 1,
      },
      { kind: "updating", base: BASE, slug: "compact" },
      { kind: "updated", base: BASE, slug: "compact", absPath: "/r/v.tsx", rev: 2 },
    ]);
    expect(state[BASE].items[0]).toMatchObject({ status: "landed", rev: 2 });
  });

  it("resolved: keep/abandon drop the set; discard/keepAs drop one slug", () => {
    const landedTwo = [
      { kind: "landed", base: BASE, slug: "a", absPath: "/r/a.tsx", rev: 1 },
      { kind: "landed", base: BASE, slug: "b", absPath: "/r/b.tsx", rev: 1 },
    ];
    expect(run([...landedTwo, { kind: "resolved", base: BASE, action: "keep" }]))
      .toEqual({});
    expect(
      run([...landedTwo, { kind: "resolved", base: BASE, action: "abandon" }]),
    ).toEqual({});
    const afterDiscard = run([
      ...landedTwo,
      { kind: "resolved", base: BASE, action: "discard", slug: "a" },
    ]);
    expect(afterDiscard[BASE].items.map((item) => item.slug)).toEqual(["b"]);
    // Removing the last slug drops the whole set.
    expect(
      run([
        landedTwo[0],
        { kind: "resolved", base: BASE, action: "keepAs", slug: "a" },
      ]),
    ).toEqual({});
  });

  it("ignores baseless and unknown events", () => {
    expect(run([{ kind: "landed" }, { kind: "mystery", base: BASE }])).toEqual(
      {},
    );
  });
});

describe("setsFromStatus (reload reconstruction)", () => {
  it("maps the GET /api/variations payload into state", () => {
    const state = setsFromStatus({
      sets: [
        {
          base: BASE,
          baseSourcePath: "src/x/Card.tsx",
          planning: false,
          items: [
            {
              slug: "compact",
              intent: "denser",
              status: "landed",
              sourcePath: ".designbook/variations/v.tsx",
              absPath: "/repo/.designbook/variations/v.tsx",
              rev: 1,
            },
            { slug: "weird", status: "not-a-status" },
          ],
        },
        { planning: true }, // baseless → dropped
      ],
    });
    expect(Object.keys(state)).toEqual([BASE]);
    expect(state[BASE].items[0]).toMatchObject({
      slug: "compact",
      status: "landed",
      path: ".designbook/variations/v.tsx",
    });
    // Unknown status degrades to generating (skeleton), never crashes.
    expect(state[BASE].items[1].status).toBe("generating");
  });
});

describe("classifyRenderedSize (empty-render detection, FIX 2)", () => {
  it("flags near-zero-area roots as empty at the threshold", () => {
    expect(classifyRenderedSize({ width: 320, height: 0 })).toBe("empty");
    expect(classifyRenderedSize({ width: 0, height: 200 })).toBe("empty");
    expect(
      classifyRenderedSize({
        width: 320,
        height: EMPTY_RENDER_THRESHOLD_PX - 1,
      }),
    ).toBe("empty");
    expect(
      classifyRenderedSize({ width: 320, height: EMPTY_RENDER_THRESHOLD_PX }),
    ).toBe("ok");
    expect(classifyRenderedSize({ width: 320, height: 180 })).toBe("ok");
  });

  it("stays unknown (never a false positive) without a measured root", () => {
    expect(classifyRenderedSize(undefined)).toBe("unknown");
  });

  it("honors a custom threshold", () => {
    expect(classifyRenderedSize({ width: 40, height: 40 }, 48)).toBe("empty");
  });
});

describe("variantModuleUrl / synthesizeVariantEntry", () => {
  const base: RegistryEntry = {
    id: BASE,
    name: "Card",
    label: "Product · Card",
    sourcePath: "src/x/Card.tsx",
    component: undefined,
    load: async () => ({}),
    setId: "product",
    key: "ProductCard",
  };

  it("builds /@fs URLs with the rev cache-bust", () => {
    expect(variantModuleUrl("/repo/.designbook/variations/v.tsx", 3)).toBe(
      "/@fs/repo/.designbook/variations/v.tsx?t=3",
    );
  });

  it("synthesizes a PreviewCell-renderable entry for a landed item", () => {
    const entry = synthesizeVariantEntry(base, {
      slug: "compact",
      intent: "denser",
      status: "landed",
      path: ".designbook/variations/v.tsx",
      absPath: "/repo/.designbook/variations/v.tsx",
      rev: 2,
    });
    expect(entry).toMatchObject({
      id: `variation/${BASE}/compact#2`,
      setId: "product",
      key: "ProductCard",
      sourcePath: ".designbook/variations/v.tsx",
    });
    expect(typeof entry?.load).toBe("function");
  });

  it("is identity-stable per (base, slug, rev) — PreviewCell's lazy memo key", () => {
    const item = {
      slug: "compact",
      intent: "denser",
      status: "landed" as const,
      path: ".designbook/variations/v.tsx",
      absPath: "/repo/.designbook/variations/v.tsx",
      rev: 1,
    };
    const first = synthesizeVariantEntry(base, item);
    const second = synthesizeVariantEntry(base, { ...item });
    expect(second).toBe(first); // same reference, not merely equal
    // A new rev (iterate landed) retires the cached entry.
    const bumped = synthesizeVariantEntry(base, { ...item, rev: 2 });
    expect(bumped).not.toBe(first);
    expect(bumped?.id).toContain("#2");
  });

  it("returns undefined for anything not landed", () => {
    expect(
      synthesizeVariantEntry(base, {
        slug: "x",
        intent: "",
        status: "generating",
        rev: 0,
      }),
    ).toBeUndefined();
  });
});
