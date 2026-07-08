import { describe, expect, it } from "vitest";
import {
  PERSIST_VERSION,
  domPathTo,
  elementAtDomPath,
  parseBlob,
  persistStorageKey,
  type DomNodeLike,
} from "./workbenchPersist";

describe("persistStorageKey", () => {
  it("namespaces by project id", () => {
    expect(persistStorageKey("packages/app")).toBe(
      "designbook:wb:packages/app",
    );
  });
  it("falls back to '.' for an empty project id", () => {
    expect(persistStorageKey("")).toBe("designbook:wb:.");
  });
});

describe("parseBlob versioning / migration-drop", () => {
  const valid = JSON.stringify({
    v: PERSIST_VERSION,
    expanded: true,
    deferredReloadPending: false,
    route: { branch: "main", nodeIds: ["a.B"] },
    activeTab: "code",
    rightTab: "props",
    rightCollapsed: true,
    leftWidth: 320,
    rightWidth: 480,
    tool: "select",
    themeId: "t1",
    darkMode: true,
    datasetId: "d1",
    transforms: { "a.B": { x: 1, y: 2, scale: 0.5 } },
    chatDraft: "draft",
    selection: {
      dbEntry: "a.B",
      domPath: [0, 1],
      drillDepth: 2,
      kind: "component",
      entryId: "a.B",
      name: "Card",
    },
  });

  it("drops null / empty / non-object", () => {
    expect(parseBlob(null)).toBeUndefined();
    expect(parseBlob("")).toBeUndefined();
    expect(parseBlob("null")).toBeUndefined();
    expect(parseBlob("42")).toBeUndefined();
  });

  it("drops unparseable json", () => {
    expect(parseBlob("{not json")).toBeUndefined();
  });

  it("drops a mismatched schema version", () => {
    const stale = JSON.parse(valid);
    stale.v = PERSIST_VERSION + 1;
    expect(parseBlob(JSON.stringify(stale))).toBeUndefined();
    delete stale.v;
    expect(parseBlob(JSON.stringify(stale))).toBeUndefined();
  });

  it("round-trips a valid blob, normalizing fields", () => {
    const blob = parseBlob(valid)!;
    expect(blob.v).toBe(PERSIST_VERSION);
    expect(blob.expanded).toBe(true);
    expect(blob.route).toEqual({ branch: "main", nodeIds: ["a.B"] });
    expect(blob.activeTab).toBe("code");
    expect(blob.rightTab).toBe("props");
    expect(blob.rightCollapsed).toBe(true);
    expect(blob.leftWidth).toBe(320);
    expect(blob.rightWidth).toBe(480);
    expect(blob.transforms["a.B"]).toEqual({ x: 1, y: 2, scale: 0.5 });
    expect(blob.selection?.drillDepth).toBe(2);
    expect(blob.chatDraft).toBe("draft");
  });

  it("drops a malformed selection but keeps the rest", () => {
    const obj = JSON.parse(valid);
    obj.selection = { dbEntry: "a.B", domPath: ["bad"], drillDepth: 1 };
    const blob = parseBlob(JSON.stringify(obj))!;
    expect(blob.selection).toBeNull();
    expect(blob.activeTab).toBe("code");
  });

  it("normalizes absent right-panel fields to null (pre-split blobs)", () => {
    const obj = JSON.parse(valid);
    delete obj.rightTab;
    delete obj.rightCollapsed;
    const blob = parseBlob(JSON.stringify(obj))!;
    expect(blob.rightTab).toBeNull();
    expect(blob.rightCollapsed).toBeNull();
    expect(blob.activeTab).toBe("code");
  });

  it("normalizes absent panel widths to null (pre-resize blobs)", () => {
    const obj = JSON.parse(valid);
    delete obj.leftWidth;
    delete obj.rightWidth;
    const blob = parseBlob(JSON.stringify(obj))!;
    expect(blob.leftWidth).toBeNull();
    expect(blob.rightWidth).toBeNull();
    expect(blob.rightCollapsed).toBe(true);
  });

  it("drops non-numeric panel widths without failing the blob", () => {
    const obj = JSON.parse(valid);
    obj.leftWidth = "wide";
    obj.rightWidth = Infinity; // JSON.stringify → null
    const blob = parseBlob(JSON.stringify(obj))!;
    expect(blob.leftWidth).toBeNull();
    expect(blob.rightWidth).toBeNull();
    expect(blob.activeTab).toBe("code");
  });

  it("drops a malformed transform entry without failing the blob", () => {
    const obj = JSON.parse(valid);
    obj.transforms = { good: { x: 1, y: 2, scale: 1 }, bad: { x: 1 } };
    const blob = parseBlob(JSON.stringify(obj))!;
    expect(blob.transforms.good).toEqual({ x: 1, y: 2, scale: 1 });
    expect(blob.transforms.bad).toBeUndefined();
  });
});

// A tiny structural DOM the pure path helpers can walk without jsdom.
function makeTree(): {
  root: DomNodeLike;
  leaf: DomNodeLike;
  detached: DomNodeLike;
} {
  function node(): DomNodeLike & { kids: DomNodeLike[] } {
    const kids: DomNodeLike[] = [];
    return { parentElement: null, children: kids, kids };
  }
  function attach(
    parent: DomNodeLike & { kids: DomNodeLike[] },
    child: DomNodeLike,
  ) {
    child.parentElement = parent;
    parent.kids.push(child);
  }
  const root = node();
  const a = node();
  const b = node();
  const leaf = node();
  attach(root, a);
  attach(root, b);
  attach(b, leaf); // root > [a, b > [leaf]]
  const detached = node();
  return { root, leaf, detached };
}

describe("domPathTo / elementAtDomPath", () => {
  it("encodes and decodes a descendant path", () => {
    const { root, leaf } = makeTree();
    const path = domPathTo(leaf, root);
    expect(path).toEqual([1, 0]);
    expect(elementAtDomPath(root, path!)).toBe(leaf);
  });

  it("returns [] for the root itself", () => {
    const { root } = makeTree();
    expect(domPathTo(root, root)).toEqual([]);
    expect(elementAtDomPath(root, [])).toBe(root);
  });

  it("returns undefined when node is not under root", () => {
    const { root, detached } = makeTree();
    expect(domPathTo(detached, root)).toBeUndefined();
  });

  it("returns undefined when a decode step misses", () => {
    const { root } = makeTree();
    expect(elementAtDomPath(root, [5])).toBeUndefined();
  });
});
