import { describe, expect, it } from "vitest";
import {
  changedEntryIds,
  changedPathSet,
  createChangesModel,
  discardAction,
  sortChanges,
  splitPath,
  statusBadgeVariant,
  statusLabel,
  type FileChange,
} from "./changesModel";
import { createChangesFixture, createNoGitChangesFixture } from "./fixtures";

describe("statusLabel", () => {
  it("uses designer-facing copy, never git letters", () => {
    expect(statusLabel("modified")).toBe("Edited");
    expect(statusLabel("added")).toBe("New");
    expect(statusLabel("untracked")).toBe("New");
    expect(statusLabel("deleted")).toBe("Deleted");
    expect(statusLabel("renamed")).toBe("Renamed");
    expect(statusLabel("conflicted")).toBe("Conflict");
  });
});

describe("statusBadgeVariant", () => {
  it("maps statuses onto the existing Badge variants", () => {
    expect(statusBadgeVariant("modified")).toBe("secondary");
    expect(statusBadgeVariant("untracked")).toBe("default");
    expect(statusBadgeVariant("added")).toBe("default");
    expect(statusBadgeVariant("deleted")).toBe("destructive");
    expect(statusBadgeVariant("conflicted")).toBe("destructive");
    expect(statusBadgeVariant("renamed")).toBe("outline");
  });
});

describe("splitPath", () => {
  it("splits basename and dirname", () => {
    expect(splitPath("src/product/Card.tsx")).toEqual({
      base: "Card.tsx",
      dir: "src/product",
    });
    expect(splitPath("README.md")).toEqual({ base: "README.md", dir: "" });
  });
});

describe("sortChanges / changedPathSet", () => {
  it("sorts by path and derives the changed-path set", () => {
    const { data } = createChangesFixture();
    const sorted = sortChanges(data.changes);
    expect(sorted.map((change) => change.path)).toEqual([
      "src/badges/NewBadge.tsx",
      "src/composite/product/variants/Card.tsx",
      "src/hero/HeroSlim.tsx",
      "src/legacy/OldPanel.tsx",
    ]);
    expect(changedPathSet(data.changes)).toContain(
      "src/composite/product/variants/Card.tsx",
    );
    expect(changedPathSet(data.changes).size).toBe(4);
  });
});

describe("changedEntryIds (registry ∩ changed files)", () => {
  it("badges exactly the entries whose sourcePath changed", () => {
    const { data } = createChangesFixture();
    const entries = [
      {
        id: "product.ProductCard",
        sourcePath: "src/composite/product/variants/Card.tsx",
      },
      { id: "hero.Hero", sourcePath: "src/hero/Hero.tsx" },
      { id: "misc.NoSource", sourcePath: "" },
    ];
    const ids = changedEntryIds(entries, changedPathSet(data.changes));
    expect(ids).toEqual(new Set(["product.ProductCard"]));
  });
});

describe("discardAction (confirm seam)", () => {
  const change = (status: FileChange["status"]): FileChange => ({
    path: "src/thing/File.tsx",
    status,
    origPath: null,
  });

  it("offers a gated 'Discard changes' for tracked changes", () => {
    for (const status of ["modified", "deleted", "renamed"] as const) {
      const action = discardAction(change(status));
      expect(action?.kind).toBe("discard");
      expect(action?.label).toBe("Discard changes");
      expect(action?.confirmMessage).toBe(
        "Discard changes to File.tsx? This can't be undone.",
      );
      expect(action?.confirmLabel).toBe("Discard");
    }
  });

  it("offers a gated 'Delete file' for new files", () => {
    for (const status of ["untracked", "added"] as const) {
      const action = discardAction(change(status));
      expect(action?.kind).toBe("delete");
      expect(action?.label).toBe("Delete file");
      expect(action?.confirmMessage).toBe(
        "Delete File.tsx? This can't be undone.",
      );
      expect(action?.confirmLabel).toBe("Delete");
    }
  });

  it("offers no destructive action for conflicts", () => {
    expect(discardAction(change("conflicted"))).toBeUndefined();
  });
});

describe("createChangesModel", () => {
  it("defaults to an empty unloaded set with no-op actions", async () => {
    const model = createChangesModel();
    expect(model.git).toBe(true);
    expect(model.loaded).toBe(false);
    expect(model.sortedChanges).toEqual([]);
    expect(model.changedPaths.size).toBe(0);
    model.refresh();
    model.openDiff("src/a.tsx");
    await model.discard("src/a.tsx");
  });

  it("wires fixture data and injected actions", async () => {
    const fixture = createChangesFixture();
    const model = createChangesModel(fixture);
    expect(model.sortedChanges).toHaveLength(4);
    model.refresh();
    model.openDiff("src/badges/NewBadge.tsx");
    await model.discard("src/legacy/OldPanel.tsx");
    expect(fixture.refreshes).toBe(1);
    expect(fixture.diffOpens).toEqual(["src/badges/NewBadge.tsx"]);
    expect(fixture.discards).toEqual(["src/legacy/OldPanel.tsx"]);
  });

  it("carries the no-git degrade", () => {
    const model = createChangesModel(createNoGitChangesFixture());
    expect(model.git).toBe(false);
    expect(model.loaded).toBe(true);
    expect(model.sortedChanges).toEqual([]);
  });
});
