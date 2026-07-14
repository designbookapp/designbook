import { describe, expect, it } from "vitest";
import type { Fiber } from "@designbook-ui/previewHost";
import { sourceOwnerFromFiber } from "./sourceOwner";

/** Minimal fiber fixture — the walker reads type/_debugOwner/return only. */
function fiberOf(
  type: unknown,
  links: { owner?: Fiber; parent?: Fiber } = {},
): Fiber {
  return {
    type,
    _debugOwner: links.owner ?? null,
    return: links.parent ?? null,
  } as unknown as Fiber;
}

function HomePage() {
  return null;
}
function App() {
  return null;
}
/** Stand-in for a node_modules component (react-router's Link). */
function Link() {
  return null;
}

describe("sourceOwnerFromFiber (sandbox owner fallback)", () => {
  it("resolves the nearest named owner on the _debugOwner chain, with the name ladder", () => {
    const app = fiberOf(App);
    const page = fiberOf(HomePage, { owner: app });
    const section = fiberOf("section", { owner: page });
    const owner = sourceOwnerFromFiber(section, () => undefined);
    expect(owner).toMatchObject({
      name: "HomePage",
      exportName: "HomePage",
      sourcePath: "",
      ownerNames: ["HomePage", "App"],
    });
  });

  it("prefers the nearest owner whose source path RESOLVES client-side", () => {
    const app = fiberOf(App);
    const page = fiberOf(HomePage, { owner: app });
    const link = fiberOf(Link, { owner: page });
    const anchor = fiberOf("a", { owner: link });
    // Link is node_modules (no repo path); HomePage resolves via the
    // sourceModules-style lookup — it wins as the owner identity, while the
    // full chain still records Link for the server ladder.
    const owner = sourceOwnerFromFiber(anchor, (ref) =>
      ref === HomePage ? "src/pages/HomePage.tsx" : undefined,
    );
    expect(owner).toMatchObject({
      name: "HomePage",
      sourcePath: "src/pages/HomePage.tsx",
      ownerNames: ["Link", "HomePage", "App"],
    });
  });

  it("keeps the nearest NAMED owner when nothing resolves client-side (server ladder finishes)", () => {
    const page = fiberOf(HomePage);
    const link = fiberOf(Link, { owner: page });
    const anchor = fiberOf("a", { owner: link });
    const owner = sourceOwnerFromFiber(anchor, () => undefined);
    expect(owner).toMatchObject({
      name: "Link",
      sourcePath: "",
      ownerNames: ["Link", "HomePage"],
    });
  });

  it("skips unnamed wrappers/providers and host levels on the chain", () => {
    const page = fiberOf(HomePage);
    const provider = fiberOf(
      { $$typeof: Symbol.for("react.provider") },
      { owner: page },
    );
    const anonymous = fiberOf(() => null, { owner: provider });
    const div = fiberOf("div", { owner: anonymous });
    const owner = sourceOwnerFromFiber(div, () => undefined);
    expect(owner?.name).toBe("HomePage");
    expect(owner?.ownerNames).toEqual(["HomePage"]);
  });

  it("falls back to the render-tree parent chain when owner info is absent", () => {
    const page = fiberOf(HomePage);
    const section = fiberOf("section", { parent: page });
    const owner = sourceOwnerFromFiber(section, () => undefined);
    expect(owner?.name).toBe("HomePage");
  });

  it("is undefined without a fiber or without any named component", () => {
    expect(sourceOwnerFromFiber(undefined, () => undefined)).toBeUndefined();
    const bare = fiberOf("div");
    expect(sourceOwnerFromFiber(bare, () => undefined)).toBeUndefined();
  });

  it("survives a cyclic owner chain (defensive, React internals drift)", () => {
    const a = fiberOf(HomePage);
    const b = fiberOf(App, { owner: a });
    (a as { _debugOwner?: Fiber })._debugOwner = b; // cycle
    const el = fiberOf("div", { owner: b });
    const owner = sourceOwnerFromFiber(el, () => undefined);
    expect(owner?.ownerNames).toEqual(["App", "HomePage"]);
  });
});
