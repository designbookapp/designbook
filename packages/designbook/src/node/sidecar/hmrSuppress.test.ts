import { describe, expect, it } from "vitest";
import {
  createRecentWrites,
  hotUpdateMatches,
  invalidateModulesForWrite,
  isCssOnlyHotUpdate,
  normalizeRel,
  selectNewWrites,
  toRepoRel,
} from "./hmrSuppress.ts";
import type { ModuleGraph, ModuleNode } from "vite";

describe("normalizeRel", () => {
  it("strips ./ and leading slashes and converts backslashes", () => {
    expect(normalizeRel("./src/a.css")).toBe("src/a.css");
    expect(normalizeRel("/src/a.css")).toBe("src/a.css");
    expect(normalizeRel("src\\flags\\t.json")).toBe("src/flags/t.json");
    expect(normalizeRel("src/a.css")).toBe("src/a.css");
  });
});

describe("toRepoRel", () => {
  const root = "/repo";
  it("relativizes an absolute path", () => {
    expect(toRepoRel(root, "/repo/src/flags/tenants.json")).toBe(
      "src/flags/tenants.json",
    );
  });
  it("passes through an already-relative path (normalized)", () => {
    expect(toRepoRel(root, "./src/flags/tenants.json")).toBe(
      "src/flags/tenants.json",
    );
  });
});

describe("hotUpdateMatches", () => {
  const root = "/repo";
  it("matches an absolute hot-update file against a repo-relative write", () => {
    expect(
      hotUpdateMatches("/repo/src/flags/tenants.json", ["src/flags/tenants.json"], root),
    ).toBe(true);
  });
  it("does not match a different file", () => {
    expect(
      hotUpdateMatches("/repo/src/App.tsx", ["src/flags/tenants.json"], root),
    ).toBe(false);
  });
  it("matches by path suffix when projectRoot differs (worktree case)", () => {
    // recent-writes came from a sidecar rooted elsewhere but same repo-relative
    // shape; the plugin's projectRoot is a worktree checkout.
    expect(
      hotUpdateMatches(
        "/worktrees/feature/src/flags/tenants.json",
        ["src/flags/tenants.json"],
        "/worktrees/feature",
      ),
    ).toBe(true);
  });
  it("ignores empty candidates", () => {
    expect(hotUpdateMatches("/repo/src/a.css", ["", "  "], root)).toBe(false);
  });
});

describe("createRecentWrites", () => {
  it("records and lists repo-relative paths", () => {
    const rw = createRecentWrites(5000);
    rw.record("src/a.css", 1000);
    rw.record("./src/b.json", 1000);
    expect(rw.paths(1000).sort()).toEqual(["src/a.css", "src/b.json"]);
  });

  it("expires entries past the ttl", () => {
    const rw = createRecentWrites(5000);
    rw.record("src/a.css", 1000);
    expect(rw.paths(2000)).toEqual(["src/a.css"]);
    expect(rw.paths(6001)).toEqual([]);
  });

  it("refreshes an entry's timestamp on re-record", () => {
    const rw = createRecentWrites(5000);
    rw.record("src/a.css", 1000);
    rw.record("src/a.css", 4000);
    // Would have expired at 6001 from the first write, but the re-record at
    // 4000 keeps it alive until 9001.
    expect(rw.paths(6001)).toEqual(["src/a.css"]);
    expect(rw.paths(9001)).toEqual([]);
  });

  it("ignores empty paths", () => {
    const rw = createRecentWrites();
    rw.record("");
    expect(rw.paths()).toEqual([]);
  });

  it("list() returns timestamps", () => {
    const rw = createRecentWrites();
    rw.record("src/a.css", 1234);
    expect(rw.list(1234)).toEqual([{ path: "src/a.css", ts: 1234 }]);
  });
});

describe("isCssOnlyHotUpdate", () => {
  it("passes a plain css file", () => {
    expect(isCssOnlyHotUpdate("/repo/src/index.css")).toBe(true);
    expect(isCssOnlyHotUpdate("examples/demo/src/index.css")).toBe(true);
  });
  it("is case-insensitive on the extension", () => {
    expect(isCssOnlyHotUpdate("/repo/src/Index.CSS")).toBe(true);
  });
  it("stays suppressed for a non-css file", () => {
    expect(isCssOnlyHotUpdate("/repo/src/flags/tenants.json")).toBe(false);
    expect(isCssOnlyHotUpdate("/repo/src/App.tsx")).toBe(false);
  });
});

describe("invalidateModulesForWrite", () => {
  const root = "/repo";

  function fakeModuleGraph(fileToMods: Record<string, unknown[]>) {
    const invalidated: unknown[] = [];
    const graph = {
      fileToModulesMap: new Map(Object.entries(fileToMods)),
      invalidateModule: (mod: unknown) => invalidated.push(mod),
    } as unknown as ModuleGraph;
    return { graph, invalidated };
  }

  it("invalidates every module mapped to a matching file", () => {
    const modA = {} as ModuleNode;
    const modB = {} as ModuleNode;
    const { graph, invalidated } = fakeModuleGraph({
      "/repo/src/flags/tenants.json": [modA, modB],
      "/repo/src/App.tsx": [{} as ModuleNode],
    });

    invalidateModulesForWrite(graph, "src/flags/tenants.json", root);

    expect(invalidated).toEqual([modA, modB]);
  });

  it("does nothing when no module-graph entry matches the write", () => {
    const { graph, invalidated } = fakeModuleGraph({
      "/repo/src/App.tsx": [{} as ModuleNode],
    });

    invalidateModulesForWrite(graph, "src/flags/tenants.json", root);

    expect(invalidated).toEqual([]);
  });

  it("is a no-op (idempotent) called twice for the same write", () => {
    const mod = {} as ModuleNode;
    const { graph, invalidated } = fakeModuleGraph({
      "/repo/src/index.css": [mod],
    });

    invalidateModulesForWrite(graph, "src/index.css", root);
    invalidateModulesForWrite(graph, "src/index.css", root);

    expect(invalidated).toEqual([mod, mod]);
  });
});

describe("selectNewWrites", () => {
  it("returns a write once per (path, ts)", () => {
    const seen = new Map<string, number>();
    const writes = [{ path: "locales/en/app.json", ts: 100 }];
    expect(selectNewWrites(writes, seen)).toEqual(writes);
    expect(selectNewWrites(writes, seen)).toEqual([]);
  });

  it("re-returns a path when its timestamp advances (re-write)", () => {
    const seen = new Map<string, number>();
    selectNewWrites([{ path: "locales/en/app.json", ts: 100 }], seen);
    const again = selectNewWrites([{ path: "locales/en/app.json", ts: 200 }], seen);
    expect(again).toEqual([{ path: "locales/en/app.json", ts: 200 }]);
  });

  it("normalizes paths and drops empties/missing ts", () => {
    const seen = new Map<string, number>();
    const fresh = selectNewWrites(
      [
        { path: "./locales/en/app.json", ts: 1 },
        { path: "", ts: 2 },
        { path: "x.json", ts: undefined as unknown as number },
      ],
      seen,
    );
    expect(fresh).toEqual([{ path: "locales/en/app.json", ts: 1 }]);
  });

  it("forgets seen entries that leave the payload window", () => {
    const seen = new Map<string, number>();
    selectNewWrites([{ path: "a.json", ts: 1 }], seen);
    selectNewWrites([{ path: "b.json", ts: 2 }], seen);
    expect(seen.has("a.json")).toBe(false);
    // ...so a re-appearing a.json (same ts) is treated as new again — safe
    // (invalidation is idempotent), never silently stale.
    expect(selectNewWrites([{ path: "a.json", ts: 1 }], seen)).toEqual([
      { path: "a.json", ts: 1 },
    ]);
  });
});
