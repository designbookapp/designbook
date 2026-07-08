/**
 * The `text` model's shared pipeline — claim resolution, save routing, and the
 * plural inline-commit escalation — exercised through the canonical fixtures.
 * DOM-free (`buildHit` needs a real DOM and is covered by the live e2e), so this
 * drives everything the three surfaces now share EXCEPT hit construction.
 */

import { describe, expect, it, vi } from "vitest";
import { createTextModel, matchClaim, planInlineCommit } from "./textModel";
import { createTextFixture } from "./fixtures";
import type { TextClaim } from "@designbookapp/designbook/config";

describe("createTextModel (fixture / data mode)", () => {
  it("resolves a hit to the matching fixture claim", async () => {
    const fx = createTextFixture();
    const model = createTextModel({ data: fx.data });

    const claim = await model.resolveHit(fx.hitFor(fx.claims.keyed));
    expect(claim?.key).toBe("app.title");
    expect(model.previewHit(fx.hitFor(fx.claims.literal))?.kind).toBe("literal");
    expect(model.claims).toHaveLength(3);
  });

  it("routes save() and saveEntries() through the resolved claim", async () => {
    const fx = createTextFixture();
    const model = createTextModel({ data: fx.data });

    await model.save(fx.claims.keyed, "Home");
    await model.saveEntries(fx.claims.plural, [
      { key: "results.count_one", value: "{{count}} item" },
      { key: "results.count_other", value: "{{count}} items" },
    ]);

    expect(fx.writes).toEqual([
      { kind: "save", claim: "app.title", entries: [{ key: "app.title", value: "Home" }] },
      {
        kind: "saveEntries",
        claim: "results.count",
        entries: [
          { key: "results.count_one", value: "{{count}} item" },
          { key: "results.count_other", value: "{{count}} items" },
        ],
      },
    ]);
  });

  it("saveEntries falls back to save when the claim has no saveEntries", async () => {
    const fx = createTextFixture();
    const model = createTextModel({ data: fx.data });

    await model.saveEntries(fx.claims.literal, [{ key: "x", value: "Tap me" }]);

    expect(fx.writes).toEqual([
      { kind: "save", claim: "src/components/Button.tsx", entries: [{ key: "Click me", value: "Tap me" }] },
    ]);
  });

  it("applies decorateSave to every resolved claim's persistence", async () => {
    const fx = createTextFixture();
    const applied: string[] = [];
    const model = createTextModel({
      data: fx.data,
      decorateSave: (claim) => ({
        ...claim,
        save: async (next) => {
          applied.push(next);
          await claim.save(next);
        },
      }),
    });

    const claim = await model.resolveHit(fx.hitFor(fx.claims.keyed));
    await claim!.save("Overview");

    expect(applied).toEqual(["Overview"]);
    expect(fx.writes).toHaveLength(1);
    expect(fx.writes[0].entries[0].value).toBe("Overview");
  });
});

describe("planInlineCommit", () => {
  it("escalates a plural claim to the popover, pre-filled by key", () => {
    const fx = createTextFixture();
    const plan = planInlineCommit(fx.claims.plural, "5 results");
    expect(plan).toEqual({
      escalate: true,
      initialValues: { "results.count_other": "5 results" },
    });
  });

  it("commits a simple keyed claim straight through (no escalation)", () => {
    const fx = createTextFixture();
    expect(planInlineCommit(fx.claims.keyed, "Home")).toEqual({ escalate: false });
  });

  it("does not escalate a plural claim missing an anchor element", () => {
    const fx = createTextFixture();
    const noEl: TextClaim = { ...fx.claims.plural, element: undefined };
    expect(planInlineCommit(noEl, "5 results")).toEqual({ escalate: false });
  });
});

describe("matchClaim", () => {
  it("prefers element identity, then node, then stripped text", () => {
    const el = {} as HTMLElement;
    const withEl = { ...createTextFixture().claims.keyed, element: el } as TextClaim;
    const claims = [withEl];
    const hit = { element: el, text: "different" } as never;
    expect(matchClaim(claims, hit)).toBe(withEl);
  });

  it("returns null when nothing matches", () => {
    const fx = createTextFixture();
    const hit = { element: null, node: null, text: "nope" } as never;
    expect(matchClaim(fx.data.claims, hit)).toBeNull();
  });
});

describe("live / runtime mode", () => {
  it("decorates a resolved claim and leaves preview undecorated", async () => {
    const raw = { adapter: "x", kind: "keyed", key: "k", value: "v", editPath: "p", save: vi.fn() } as unknown as TextClaim;
    const decorate = vi.fn((c: TextClaim) => ({ ...c, decorated: true }) as TextClaim);
    const model = createTextModel({
      runtime: {
        resolveClaim: async () => raw,
        previewClaim: () => raw,
      },
      decorateSave: decorate,
    });

    const resolved = await model.resolveHit({} as never);
    expect((resolved as unknown as { decorated: boolean }).decorated).toBe(true);
    expect(decorate).toHaveBeenCalledTimes(1);

    const preview = model.previewHit({} as never);
    expect((preview as unknown as { decorated?: boolean }).decorated).toBeUndefined();
  });
});
