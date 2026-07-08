import { describe, expect, it } from "vitest";
import {
  drillableIndices,
  resolveClickSelection,
  resolveDeepClick,
  resolveDoubleClick,
  resolveEscape,
} from "@designbook-ui/models/selection/drillSelection";

// Chains are innermost-first (index 0), matching the fiber.return walk order.
const outer = { instanceId: "outer", kind: "component" as const };
const mid = { instanceId: "mid", kind: "component" as const };
const inner = { instanceId: "inner", kind: "component" as const };
const chain = [inner, mid, outer];

describe("resolveClickSelection", () => {
  it("selects the outermost entry on a fresh click (no drill path)", () => {
    expect(resolveClickSelection(chain, [])).toEqual({
      index: 2,
      drillPath: [],
    });
  });

  it("selects one level inside the drilled ancestor", () => {
    expect(resolveClickSelection(chain, ["outer"])).toEqual({
      index: 1,
      drillPath: ["outer"],
    });
  });

  it("selects a sibling at the drilled depth (different inner/mid instances)", () => {
    const siblingChain = [
      { instanceId: "inner-2" },
      { instanceId: "mid-2" },
      outer,
    ];
    expect(resolveClickSelection(siblingChain, ["outer"])).toEqual({
      index: 1,
      drillPath: ["outer"],
    });
  });

  it("resets when the click lands outside the drilled component", () => {
    const otherChain = [{ instanceId: "other-inner" }, { instanceId: "other-outer" }];
    expect(resolveClickSelection(otherChain, ["outer"])).toEqual({
      index: 1,
      drillPath: [],
    });
  });

  it("truncates to the common prefix when the drill path runs deeper than the chain", () => {
    // Only "outer" is under the cursor: stay drilled in it (common prefix)
    // and select it — the levels below it in the old path are gone.
    expect(resolveClickSelection([outer], ["outer", "mid"])).toEqual({
      index: 0,
      drillPath: ["outer"],
    });
  });

  it("selects the drilled entry itself when nothing is deeper (leaf)", () => {
    expect(resolveClickSelection([outer], ["outer"])).toEqual({
      index: 0,
      drillPath: ["outer"],
    });
  });

  it("returns undefined for an empty chain", () => {
    expect(resolveClickSelection([], [])).toBeUndefined();
    expect(resolveClickSelection([], ["outer"])).toBeUndefined();
  });
});

describe("resolveClickSelection — DOM level", () => {
  // CanvasOverlay prepends the raw DOM element under the pointer as
  // chain[0], one level deeper than the innermost registered component.
  const domA = { instanceId: "outer::dom:1", kind: "dom" as const };
  const domB = { instanceId: "outer::dom:2", kind: "dom" as const };

  it("never lands on the DOM level from a fresh click, even when a DOM entry is present", () => {
    expect(resolveClickSelection([domA, outer], [])).toEqual({
      index: 1,
      drillPath: [],
    });
  });

  it("selects the DOM entry once drilled into its owning (leaf) component", () => {
    expect(resolveClickSelection([domA, outer], ["outer"])).toEqual({
      index: 0,
      drillPath: ["outer"],
    });
  });

  it("selects a sibling DOM node on a later click without changing the drill path", () => {
    expect(resolveClickSelection([domB, outer], ["outer"])).toEqual({
      index: 0,
      drillPath: ["outer"],
    });
  });
});

describe("resolveDoubleClick", () => {
  it("drills one level deeper from a fresh state", () => {
    expect(resolveDoubleClick(chain, [])).toEqual({
      kind: "descend",
      index: 1,
      drillPath: ["outer"],
      entered: { chainIndex: 2 },
    });
  });

  it("drills repeatedly, going deeper each time", () => {
    const first = resolveDoubleClick(chain, []);
    expect(first?.drillPath).toEqual(["outer"]);

    const second = resolveDoubleClick(chain, first!.drillPath);
    expect(second).toEqual({
      kind: "descend",
      index: 0,
      drillPath: ["outer", "mid"],
      entered: { chainIndex: 1 },
    });
  });

  it("reports a leaf signal on a component leaf with nothing deeper to drill into", () => {
    expect(resolveDoubleClick([outer], ["outer"])).toEqual({
      kind: "leaf",
      index: 0,
      drillPath: ["outer"],
    });
  });

  it("reports a leaf signal on a single-level chain from a fresh state", () => {
    expect(resolveDoubleClick([outer], [])).toEqual({
      kind: "leaf",
      index: 0,
      drillPath: [],
    });
  });

  it("resets and drills into the outermost when double-clicking outside the drilled scope", () => {
    const otherChain = [{ instanceId: "other-inner" }, { instanceId: "other-outer" }];
    expect(resolveDoubleClick(otherChain, ["outer"])).toEqual({
      kind: "descend",
      index: 0,
      drillPath: ["other-outer"],
      entered: { chainIndex: 1 },
    });
  });
});

describe("resolveDoubleClick — DOM level", () => {
  const dom = { instanceId: "outer::dom:1", kind: "dom" as const };

  it("descends to the DOM level on double-click at the deepest (leaf) component", () => {
    expect(resolveDoubleClick([dom, outer], [])).toEqual({
      kind: "descend",
      index: 0,
      drillPath: ["outer"],
      entered: { chainIndex: 1 },
    });
  });

  it("reports a leaf signal on double-click of an already-selected DOM node", () => {
    expect(resolveDoubleClick([dom, outer], ["outer"])).toEqual({
      kind: "leaf",
      index: 0,
      drillPath: ["outer"],
    });
  });
});

// The user's normative example. ProductCard renders Card > div.relative >
// (ProductImage, ProductBadges). Hovering ProductBadges, the interleaved
// chain innermost -> outermost is: the pointer-target DOM node, ProductBadges,
// the `<div className="relative">`, Card, ProductCard.
const pbInner = { instanceId: "pbInner", kind: "dom" as const };
const productBadges = { instanceId: "ProductBadges", kind: "component" as const };
const divRelative = { instanceId: "divRelative", kind: "dom" as const };
const card = { instanceId: "Card", kind: "component" as const };
const productCard = { instanceId: "ProductCard", kind: "component" as const };
const interleaved = [pbInner, productBadges, divRelative, card, productCard];

describe("interleaved drill (ProductCard example)", () => {
  it("descends one render-tree level per double-click: Card, div, ProductBadges, DOM", () => {
    // Fresh click selects the outermost component.
    expect(resolveClickSelection(interleaved, [])).toEqual({
      index: 4,
      drillPath: [],
    });

    // dbl-click #1 -> Card (one level inside ProductCard).
    const d1 = resolveDoubleClick(interleaved, []);
    expect(d1).toEqual({
      kind: "descend",
      index: 3,
      drillPath: ["ProductCard"],
      entered: { chainIndex: 4 },
    });

    // dbl-click #2 -> the <div className="relative"> DOM level.
    const d2 = resolveDoubleClick(interleaved, d1!.drillPath);
    expect(d2).toEqual({
      kind: "descend",
      index: 2,
      drillPath: ["ProductCard", "Card"],
      entered: { chainIndex: 3 },
    });

    // dbl-click #3 -> ProductBadges.
    const d3 = resolveDoubleClick(interleaved, d2!.drillPath);
    expect(d3).toEqual({
      kind: "descend",
      index: 1,
      drillPath: ["ProductCard", "Card", "divRelative"],
      entered: { chainIndex: 2 },
    });

    // dbl-click #4 -> into ProductBadges' own tree (the DOM leaf).
    const d4 = resolveDoubleClick(interleaved, d3!.drillPath);
    expect(d4).toEqual({
      kind: "descend",
      index: 0,
      drillPath: ["ProductCard", "Card", "divRelative", "ProductBadges"],
      entered: { chainIndex: 1 },
    });

    // dbl-click #5 -> nothing deeper; leaf no-op.
    expect(resolveDoubleClick(interleaved, d4!.drillPath)).toEqual({
      kind: "leaf",
      index: 0,
      drillPath: ["ProductCard", "Card", "divRelative", "ProductBadges"],
    });
  });

  it("single-clicks re-select siblings at the current drilled depth", () => {
    // Drilled to the DOM level (div.relative selected): a click still lands on
    // the div, even reached via a sibling chain that shares the outer path.
    expect(
      resolveClickSelection(interleaved, ["ProductCard", "Card"]),
    ).toEqual({ index: 2, drillPath: ["ProductCard", "Card"] });
  });
});

describe("resolveDeepClick", () => {
  it("selects the innermost component and back-fills the drill path", () => {
    // Innermost component under the pointer is ProductBadges (index 1); its
    // ancestors outermost-first become the drill path.
    expect(resolveDeepClick(interleaved)).toEqual({
      index: 1,
      drillPath: ["ProductCard", "Card", "divRelative"],
    });
  });

  it("makes subsequent clicks/Escape behave as if drilled step by step", () => {
    const deep = resolveDeepClick(interleaved)!;
    // A plain click reproduces the same innermost-component selection.
    expect(resolveClickSelection(interleaved, deep.drillPath)).toEqual({
      index: 1,
      drillPath: deep.drillPath,
    });
    // Escape pops back to the div.relative DOM level.
    expect(resolveEscape(deep.drillPath)).toEqual({
      drillPath: ["ProductCard", "Card"],
      selected: "divRelative",
    });
  });

  it("selects the sole component in a component-only chain", () => {
    expect(resolveDeepClick([outer])).toEqual({ index: 0, drillPath: [] });
  });

  it("returns undefined when the chain has no component", () => {
    expect(
      resolveDeepClick([
        { instanceId: "a", kind: "dom" },
        { instanceId: "b", kind: "dom" },
      ]),
    ).toBeUndefined();
    expect(resolveDeepClick([])).toBeUndefined();
  });
});

// Owner-filtered traversal: chains as produced by CanvasOverlay/fibers with
// per-level owner attribution (`ownerId` = registry id of the component whose
// JSX created the level, `componentId` = the level's own registry id).
// Mirrors the real ProductCard render verified against React 19: ProductCard
// renders <Card className="w-80 gap-3"> whose IMPLEMENTATION root
// <div data-slot="card"> (owned by Card) wraps the pass-through children
// <div className="relative"> > (ProductImage, ProductBadges) (owned by
// ProductCard); ProductBadges' own root div and inner span are owned by
// ProductBadges.
const oPc = { instanceId: "pc", kind: "component" as const, componentId: "PC" };
const oCard = {
  instanceId: "card",
  kind: "component" as const,
  componentId: "Card",
  ownerId: "PC",
};
const oCardRoot = {
  instanceId: "cardRoot",
  kind: "dom" as const,
  ownerId: "Card",
};
const oDivRel = { instanceId: "divRel", kind: "dom" as const, ownerId: "PC" };
const oBadges = {
  instanceId: "badges",
  kind: "component" as const,
  componentId: "PB",
  ownerId: "PC",
};
const oBadgesRoot = {
  instanceId: "badgesRoot",
  kind: "dom" as const,
  ownerId: "PB",
};
const oSpan = { instanceId: "span", kind: "dom" as const, ownerId: "PB" };
// Innermost → outermost, pointer over the badges. Chain index 4 (cardRoot)
// is Card's internal DOM and must be skipped by every drill gesture.
const badgesChain = [
  oSpan,
  oBadgesRoot,
  oBadges,
  oDivRel,
  oCardRoot,
  oCard,
  oPc,
];
// Pointer over the image: ProductImage's implementation div innermost.
const oImage = {
  instanceId: "image",
  kind: "component" as const,
  componentId: "PI",
  ownerId: "PC",
};
const oImageRoot = {
  instanceId: "imageRoot",
  kind: "dom" as const,
  ownerId: "PI",
};
const imageChain = [oImageRoot, oImage, oDivRel, oCardRoot, oCard, oPc];

describe("owner-filtered drill (authored JSX only)", () => {
  it("computes the drillable path, skipping Card's internal root div", () => {
    // ProductBadges, div.relative, [skip cardRoot], Card, PC — the levels
    // inside ProductBadges (its root div, span) are its implementation and
    // are never drill-reachable.
    expect(drillableIndices(badgesChain)).toEqual([2, 3, 5, 6]);
    expect(drillableIndices(imageChain)).toEqual([1, 2, 4, 5]);
  });

  it("descends ProductCard → Card → div.relative → ProductBadges (normative sequence, div[data-slot=card] skipped)", () => {
    const d1 = resolveDoubleClick(badgesChain, []);
    expect(d1).toMatchObject({ kind: "descend", index: 5, drillPath: ["pc"] });

    // Card → div.relative directly: Card's own root div is NOT a stop.
    const d2 = resolveDoubleClick(badgesChain, d1!.drillPath);
    expect(d2).toMatchObject({
      kind: "descend",
      index: 3,
      drillPath: ["pc", "card"],
    });

    const d3 = resolveDoubleClick(badgesChain, d2!.drillPath);
    expect(d3).toMatchObject({
      kind: "descend",
      index: 2,
      drillPath: ["pc", "card", "divRel"],
    });
  });

  it("treats a component with no deeper authored level as a leaf (implementation never drill-reachable)", () => {
    // From ProductBadges: nothing deeper is owned by ProductCard, and a
    // component's own internals are only reachable via "Go to component" —
    // double-click is a no-op leaf on the (already selected) ProductBadges.
    expect(resolveDoubleClick(badgesChain, ["pc", "card", "divRel"])).toEqual({
      kind: "leaf",
      index: 2,
      drillPath: ["pc", "card", "divRel"],
    });
    // Same over a component's padding with no authored child under the
    // cursor: dbl-click while drilled into Card selects ProductBadges'
    // sibling level... over the badges the deepest stop stays ProductBadges.
    expect(
      resolveClickSelection(badgesChain, ["pc", "card", "divRel"]),
    ).toEqual({ index: 2, drillPath: ["pc", "card", "divRel"] });
  });

  it("Escape reverses the same filtered path", () => {
    const path = ["pc", "card", "divRel"];
    const e1 = resolveEscape(path);
    expect(e1).toEqual({
      drillPath: ["pc", "card"],
      selected: "divRel",
    });
    const e2 = resolveEscape(e1.drillPath);
    expect(e2).toEqual({ drillPath: ["pc"], selected: "card" });
    // Selecting after the pop lands on the same filtered level — never on
    // the skipped cardRoot.
    expect(resolveClickSelection(badgesChain, e1.drillPath)).toEqual({
      index: 3,
      drillPath: ["pc", "card"],
    });
  });

  it("sibling clicks at a drilled depth stay on the filtered level", () => {
    // Drilled into Card: a click over the image area selects div.relative
    // (the authored level), not Card's internal root div.
    expect(resolveClickSelection(imageChain, ["pc", "card"])).toEqual({
      index: 2,
      drillPath: ["pc", "card"],
    });
    // Drilled to div.relative: clicking over the image selects ProductImage,
    // a sibling of ProductBadges at the same authored depth.
    expect(
      resolveClickSelection(imageChain, ["pc", "card", "divRel"]),
    ).toEqual({ index: 1, drillPath: ["pc", "card", "divRel"] });
  });

  it("deep click drills to the innermost component with filtered ancestors as the drill path", () => {
    expect(resolveDeepClick(imageChain)).toEqual({
      index: 1,
      drillPath: ["pc", "card", "divRel"],
    });
  });

  it("double-click after a deep click is a leaf no-op (implementation never drill-reachable)", () => {
    const deep = resolveDeepClick(imageChain)!;
    // ProductImage's own root div is its implementation: not a drill stop.
    expect(resolveDoubleClick(imageChain, deep.drillPath)).toEqual({
      kind: "leaf",
      index: 1,
      drillPath: ["pc", "card", "divRel"],
    });
  });
});

// Divergence selection: ProductCard's authored JSX also has CardHeader >
// (ProductTitle, ProductTagline) and CardContent > (ProductRating, ...)
// branches. Owner attribution as in the real render: the section components
// and their leaf components are all created in ProductCard's JSX (owner PC);
// each component's own root div is owned by itself.
const oCardHeader = {
  instanceId: "cardHeader",
  kind: "component" as const,
  componentId: "CH",
  ownerId: "PC",
};
const oCardHeaderRoot = {
  instanceId: "chRoot",
  kind: "dom" as const,
  ownerId: "CH",
};
const oTitle = {
  instanceId: "title",
  kind: "component" as const,
  componentId: "PT",
  ownerId: "PC",
};
const oTagline = {
  instanceId: "tagline",
  kind: "component" as const,
  componentId: "PTG",
  ownerId: "PC",
};
const oCardContent = {
  instanceId: "cardContent",
  kind: "component" as const,
  componentId: "CC",
  ownerId: "PC",
};
const oCardContentRoot = {
  instanceId: "ccRoot",
  kind: "dom" as const,
  ownerId: "CC",
};
const oRating = {
  instanceId: "rating",
  kind: "component" as const,
  componentId: "PR",
  ownerId: "PC",
};
// Pointer over ProductTitle: PC → Card → CardHeader → ProductTitle (filtered).
const titleChain = [
  oTitle,
  oCardHeaderRoot,
  oCardHeader,
  oCardRoot,
  oCard,
  oPc,
];
// Pointer over ProductTagline: same branch as ProductTitle.
const taglineChain = [
  oTagline,
  oCardHeaderRoot,
  oCardHeader,
  oCardRoot,
  oCard,
  oPc,
];
// Pointer over ProductRating: PC → Card → CardContent → ProductRating.
const ratingChain = [
  oRating,
  oCardContentRoot,
  oCardContent,
  oCardRoot,
  oCard,
  oPc,
];
// Drilled to ProductTitle: ProductCard → Card → CardHeader → ProductTitle.
const titlePath = ["pc", "card", "cardHeader", "title"];

describe("divergence selection (common-prefix drill matching)", () => {
  it("selects the sibling branch at the divergence level and truncates the drill path (ProductTitle drilled, click ProductRating → CardContent)", () => {
    // Sanity: on its own chain the drilled path resolves to ProductTitle.
    expect(resolveClickSelection(titleChain, titlePath)).toEqual({
      index: 0,
      drillPath: titlePath,
    });
    // Common prefix [pc, card]; divergence: cardHeader (path) vs cardContent
    // (chain) → select CardContent, one level inside the common ancestor Card.
    expect(resolveClickSelection(ratingChain, titlePath)).toEqual({
      index: 2,
      drillPath: ["pc", "card"],
    });
  });

  it("still selects a sibling of the deepest level on a full prefix match (ProductTagline)", () => {
    // Drilled into CardHeader: full prefix matches taglineChain's ancestry,
    // so the click selects ProductTagline at the same depth as ProductTitle.
    expect(
      resolveClickSelection(taglineChain, ["pc", "card", "cardHeader"]),
    ).toEqual({
      index: 0,
      drillPath: ["pc", "card", "cardHeader"],
    });
  });

  it("selects the other top-level component on divergence at depth zero", () => {
    const otherTop = [
      { instanceId: "other-inner", kind: "dom" as const, ownerId: "OTHER" },
      {
        instanceId: "other",
        kind: "component" as const,
        componentId: "OTHER",
      },
    ];
    expect(resolveClickSelection(otherTop, titlePath)).toEqual({
      index: 1,
      drillPath: [],
    });
  });

  it("double-click after a divergence click enters the newly selected branch", () => {
    // Straight double-click over ProductRating while drilled to ProductTitle:
    // the click part resolves CardContent with the truncated path, the
    // descend part enters it and selects ProductRating.
    expect(resolveDoubleClick(ratingChain, titlePath)).toMatchObject({
      kind: "descend",
      index: 0,
      drillPath: ["pc", "card", "cardContent"],
    });
  });

  it("Escape after a divergence click pops to the common ancestor", () => {
    const diverged = resolveClickSelection(ratingChain, titlePath)!;
    expect(resolveEscape(diverged.drillPath)).toEqual({
      drillPath: ["pc"],
      selected: "card",
    });
  });
});

describe("resolveEscape — through DOM levels", () => {
  it("pops DOM-level drill entries one at a time", () => {
    const path = ["ProductCard", "Card", "divRelative", "ProductBadges"];
    const step1 = resolveEscape(path);
    expect(step1).toEqual({
      drillPath: ["ProductCard", "Card", "divRelative"],
      selected: "ProductBadges",
    });
    const step2 = resolveEscape(step1.drillPath);
    expect(step2).toEqual({
      drillPath: ["ProductCard", "Card"],
      selected: "divRelative",
    });
  });
});

describe("resolveEscape", () => {
  it("pops the deepest drill level and selects it", () => {
    expect(resolveEscape(["outer", "mid"])).toEqual({
      drillPath: ["outer"],
      selected: "mid",
    });
  });

  it("pops the last remaining level down to an empty drill path", () => {
    expect(resolveEscape(["outer"])).toEqual({
      drillPath: [],
      selected: "outer",
    });
  });

  it("returns undefined selection when the drill path is already empty", () => {
    expect(resolveEscape([])).toEqual({ drillPath: [], selected: undefined });
  });

  it("pops back to the owning component when escaping from a DOM-level selection", () => {
    // drillPath/drillStack never contain DOM entries (only the *selection*
    // can be at DOM depth), so popping the deepest drilled level always
    // lands back on the component that owns the DOM node.
    const outerHit = { kind: "component" as const, instanceId: "outer" };
    expect(resolveEscape([outerHit])).toEqual({
      drillPath: [],
      selected: outerHit,
    });
  });
});
