import { describe, expect, it } from "vitest";
import {
  resolveCodeTargets,
  resolveLevelOwner,
  type AttributableLink,
} from "@designbook-ui/models/selection/codeTargets";
import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";

function entry(key: string, sourcePath: string): RegistryEntry {
  return {
    id: `set.${key}`,
    name: key,
    label: key,
    sourcePath,
    component: () => null,
    setId: "set",
    key,
  };
}

const productCard = entry("ProductCard", "src/variants/Card.tsx");
const card = entry("Card", "src/ui/card.tsx");
const productBadges = entry("ProductBadges", "src/atoms.tsx");

// The user's normative ProductCard chain, innermost → outermost, with owner
// attribution exactly as produced by hitTestChain under a real React 19 dev
// render (verified via react-dom + _debugOwner): children passed through
// <Card>{children}</Card> are owned by ProductCard, NOT by their fiber-parent
// Card; Card's own root div IS owned by Card.
const chain: AttributableLink[] = [
  { kind: "dom", ownerEntry: productBadges, name: "span" },
  {
    kind: "component",
    entry: productBadges,
    ownerEntry: productCard,
    name: "ProductBadges",
    className: "absolute top-2 left-2",
  },
  { kind: "dom", ownerEntry: productCard, name: "div", className: "relative" },
  { kind: "dom", ownerEntry: card, name: "div", className: "card-base w-80" },
  {
    kind: "component",
    entry: card,
    ownerEntry: productCard,
    name: "Card",
    className: "w-80 gap-3",
  },
  { kind: "component", entry: productCard, name: "ProductCard" },
];

describe("resolveCodeTargets", () => {
  const targets = resolveCodeTargets(chain);

  it("gives the outermost level no code target (fresh click → definition)", () => {
    expect(targets[targets.length - 1]).toBeUndefined();
  });

  it("attributes every deeper level to its creating owner's file", () => {
    // Card usage line lives in ProductCard's file, not card.tsx.
    expect(targets[4]).toEqual({
      file: "src/variants/Card.tsx",
      ownerExportName: "ProductCard",
      name: "Card",
      kind: "component",
      className: "w-80 gap-3",
    });
    // Pass-through child: div.relative is owned by ProductCard even though
    // its fiber parent is Card.
    expect(targets[2]).toEqual({
      file: "src/variants/Card.tsx",
      ownerExportName: "ProductCard",
      name: "div",
      kind: "dom",
      className: "relative",
    });
    // ProductBadges usage also attributed to ProductCard's file.
    expect(targets[1]).toMatchObject({
      file: "src/variants/Card.tsx",
      ownerExportName: "ProductCard",
      name: "ProductBadges",
    });
  });

  it("attributes a component's own internals to that component's file", () => {
    // Card's root div was created by Card → card.tsx usage line.
    expect(targets[3]).toEqual({
      file: "src/ui/card.tsx",
      ownerExportName: "Card",
      name: "div",
      kind: "dom",
      className: "card-base w-80",
    });
    // The span inside ProductBadges → atoms.tsx.
    expect(targets[0]).toMatchObject({
      file: "src/atoms.tsx",
      ownerExportName: "ProductBadges",
    });
  });

  it("falls back to the nearest registered chain ancestor when _debugOwner found nothing", () => {
    const noOwners: AttributableLink[] = [
      { kind: "dom", name: "span" },
      { kind: "component", entry: productBadges, name: "ProductBadges" },
      { kind: "component", entry: productCard, name: "ProductCard" },
    ];
    const resolved = resolveCodeTargets(noOwners);
    expect(resolved[0]).toMatchObject({
      file: "src/atoms.tsx",
      ownerExportName: "ProductBadges",
    });
    expect(resolved[1]).toMatchObject({
      file: "src/variants/Card.tsx",
      ownerExportName: "ProductCard",
    });
    expect(resolved[2]).toBeUndefined();
  });

  it("yields undefined when the owner has no source path", () => {
    const pathless = entry("Mystery", "");
    const resolved = resolveCodeTargets([
      { kind: "dom", ownerEntry: pathless, name: "div" },
      { kind: "component", entry: pathless, name: "Mystery" },
    ]);
    expect(resolved[0]).toBeUndefined();
  });

  it("gives a single-level chain (outermost only) no code target", () => {
    expect(
      resolveCodeTargets([
        { kind: "component", entry: productCard, name: "ProductCard" },
      ]),
    ).toEqual([undefined]);
  });
});

describe("resolveLevelOwner", () => {
  it("prefers the _debugOwner attribution over the chain ancestor", () => {
    // div.relative: fiber parent/chain ancestor is Card, creator is ProductCard.
    expect(resolveLevelOwner(chain, 2)).toBe(productCard);
  });

  it("falls back to the nearest component ancestor", () => {
    const noOwner: AttributableLink[] = [
      { kind: "dom", name: "span" },
      { kind: "component", entry: card, name: "Card" },
    ];
    expect(resolveLevelOwner(noOwner, 0)).toBe(card);
  });
});
