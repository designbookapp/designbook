import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExportIndexToRegistry,
  registryByName,
  registryByRef,
} from "@designbook-ui/models/catalog/componentRegistry";
import { trimPageSizedTail } from "@designbook-ui/previewHost/fibers";
import type {
  ComponentFiberEntry,
  Fiber,
  FiberChainEntry,
} from "@designbook-ui/previewHost/fibers";
import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";

beforeEach(() => {
  // Isolate cases: the registry maps are module singletons.
  applyExportIndexToRegistry({});
  for (const key of [...registryByName.keys()]) {
    if (registryByName.get(key)?.origin === "index") registryByName.delete(key);
  }
});

describe("applyExportIndexToRegistry", () => {
  it("synthesizes name-keyed entries from the index", () => {
    applyExportIndexToRegistry({
      "src/composite/ProductCard.tsx": ["ProductCard"],
      "src/atoms.tsx": ["ProductBadges", "ProductTitle"],
    });
    const card = registryByName.get("ProductCard");
    expect(card).toMatchObject({
      id: "src:src/composite/ProductCard.tsx#ProductCard",
      label: "ProductCard",
      sourcePath: "src/composite/ProductCard.tsx",
      key: "ProductCard",
      exportName: "ProductCard",
      origin: "index",
    });
    expect(registryByName.get("ProductTitle")?.sourcePath).toBe("src/atoms.tsx");
    // byRef untouched — index entries are name-only.
    expect(registryByRef.size).toBe(0);
  });

  it("keeps config-set entries on name collisions", () => {
    const setEntry: RegistryEntry = {
      id: "product.ProductCard",
      name: "Product card",
      label: "Product · Product card",
      sourcePath: "src/real.tsx",
      component: undefined,
      setId: "product",
      key: "ProductCard",
    };
    registryByName.set("ProductCard", setEntry);
    try {
      applyExportIndexToRegistry({ "src/other.tsx": ["ProductCard"] });
      expect(registryByName.get("ProductCard")).toBe(setEntry);
    } finally {
      registryByName.delete("ProductCard");
    }
  });

  it("dedupes ambiguous names deterministically and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      applyExportIndexToRegistry({
        "src/z.tsx": ["Button"],
        "src/a.tsx": ["Button"],
      });
      const entry = registryByName.get("Button");
      expect(entry?.sourcePath).toBe("src/a.tsx"); // sorted-first
      expect(entry?.sourceCandidates).toEqual(["src/a.tsx", "src/z.tsx"]);
      const calls = warn.mock.calls.filter((call) =>
        String(call[0]).includes('"Button" is exported from'),
      );
      expect(calls.length).toBe(1);
      // Re-apply — logged once total.
      applyExportIndexToRegistry({
        "src/z.tsx": ["Button"],
        "src/a.tsx": ["Button"],
        "src/c.tsx": ["Other"],
      });
      expect(
        warn.mock.calls.filter((call) =>
          String(call[0]).includes('"Button" is exported from'),
        ).length,
      ).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("removes index entries whose name vanished from the snapshot", () => {
    applyExportIndexToRegistry({ "src/a.tsx": ["Gone"] });
    expect(registryByName.get("Gone")).toBeDefined();
    applyExportIndexToRegistry({ "src/a.tsx": ["Kept"] });
    expect(registryByName.get("Gone")).toBeUndefined();
    expect(registryByName.get("Kept")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// trimPageSizedTail — pure chain-trim logic (measure injected).
// ---------------------------------------------------------------------------

function componentEntry(
  name: string,
  origin?: "index",
): ComponentFiberEntry {
  return {
    kind: "component",
    entry: {
      id: `src:x#${name}`,
      name,
      label: name,
      sourcePath: "src/x.tsx",
      component: undefined,
      setId: "src",
      key: name,
      ...(origin ? { origin } : {}),
    },
    fiber: {} as Fiber,
    name,
  };
}

function domEntry(tag: string): FiberChainEntry {
  return {
    kind: "dom",
    element: {} as Element,
    fiber: {} as Fiber,
    tag,
  };
}

describe("trimPageSizedTail", () => {
  const pageSized = new Set(["App", "HomePage", "ThemeProvider"]);
  const measure = (entry: ComponentFiberEntry) => pageSized.has(entry.name ?? "");

  it("pops page-sized index shells (and their trailing DOM) off the tail", () => {
    const chain: FiberChainEntry[] = [
      domEntry("h3"),
      componentEntry("ProductTitle", "index"),
      componentEntry("ProductCard", "index"),
      domEntry("main"),
      componentEntry("HomePage", "index"),
      componentEntry("ThemeProvider", "index"),
      componentEntry("App", "index"),
    ];
    const out = trimPageSizedTail(chain, measure);
    expect(out.map((e) => (e.kind === "component" ? e.name : e.tag))).toEqual([
      "h3",
      "ProductTitle",
      "ProductCard",
    ]);
  });

  it("keeps the last component even when page-sized", () => {
    const chain: FiberChainEntry[] = [
      domEntry("div"),
      componentEntry("HomePage", "index"),
      componentEntry("App", "index"),
    ];
    const out = trimPageSizedTail(chain, measure);
    expect(out.map((e) => (e.kind === "component" ? e.name : e.tag))).toEqual([
      "div",
      "HomePage",
    ]);
  });

  it("never trims config-set entries", () => {
    const chain: FiberChainEntry[] = [
      componentEntry("ProductCard", "index"),
      componentEntry("HomePage"), // registered via sets — explicit choice
    ];
    expect(trimPageSizedTail(chain, measure)).toHaveLength(2);
  });

  it("stops at the first non-page-sized component", () => {
    const chain: FiberChainEntry[] = [
      componentEntry("ProductCard", "index"),
      componentEntry("App", "index"),
    ];
    const out = trimPageSizedTail(chain, measure);
    expect(out.map((e) => (e.kind === "component" ? e.name : e.tag))).toEqual([
      "ProductCard",
    ]);
  });
});
