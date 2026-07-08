import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collapseStatus,
  discardChange,
  fileDiff,
  listChanges,
  parsePorcelainZ,
  toProjectChanges,
} from "./gitChanges.ts";
import { READ_ONLY_BLOCKED_ROUTES } from "./readOnlyRoutes.ts";
import {
  isSupportedSourcePath,
  resolveContainedPath,
  resolveSourceFile,
} from "./sourcePaths.ts";

describe("parsePorcelainZ", () => {
  it("parses plain entries from NUL-separated output", () => {
    const out = " M src/a.tsx\0?? notes.md\0D  gone.css\0";
    expect(parsePorcelainZ(out)).toEqual([
      { x: " ", y: "M", path: "src/a.tsx" },
      { x: "?", y: "?", path: "notes.md" },
      { x: "D", y: " ", path: "gone.css" },
    ]);
  });

  it("parses rename entries as target-then-origin pairs", () => {
    const out = "R  new/name.ts\0old/name.ts\0 M other.ts\0";
    expect(parsePorcelainZ(out)).toEqual([
      { x: "R", y: " ", path: "new/name.ts", origPath: "old/name.ts" },
      { x: " ", y: "M", path: "other.ts" },
    ]);
  });

  it("keeps paths containing spaces and unicode intact", () => {
    const out = "?? sp ace/fïle näme.tsx\0";
    expect(parsePorcelainZ(out)).toEqual([
      { x: "?", y: "?", path: "sp ace/fïle näme.tsx" },
    ]);
  });

  it("returns empty for empty output", () => {
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

describe("collapseStatus", () => {
  it("collapses staged/unstaged columns to one designer-facing status", () => {
    expect(collapseStatus(" ", "M")).toBe("modified");
    expect(collapseStatus("M", " ")).toBe("modified");
    expect(collapseStatus("M", "M")).toBe("modified");
    expect(collapseStatus("T", " ")).toBe("modified");
    expect(collapseStatus("A", " ")).toBe("added");
    expect(collapseStatus("A", "M")).toBe("added");
    expect(collapseStatus(" ", "D")).toBe("deleted");
    expect(collapseStatus("D", " ")).toBe("deleted");
    expect(collapseStatus("R", " ")).toBe("renamed");
    expect(collapseStatus("R", "M")).toBe("renamed");
    expect(collapseStatus("?", "?")).toBe("untracked");
  });

  it("maps every conflict combination to conflicted", () => {
    for (const [x, y] of [
      ["U", "U"],
      ["A", "A"],
      ["D", "D"],
      ["A", "U"],
      ["U", "A"],
      ["D", "U"],
      ["U", "D"],
    ]) {
      expect(collapseStatus(x, y)).toBe("conflicted");
    }
  });

  it("drops ignored entries", () => {
    expect(collapseStatus("!", "!")).toBeUndefined();
  });
});

describe("toProjectChanges", () => {
  const entries = parsePorcelainZ(
    " M pkg/app/src/b.tsx\0?? pkg/app/new.ts\0 M elsewhere/x.ts\0R  pkg/app/moved.ts\0pkg/app/orig.ts\0",
  );

  it("scopes to the project prefix and strips it", () => {
    expect(toProjectChanges(entries, "pkg/app/")).toEqual([
      { path: "moved.ts", status: "renamed", origPath: "orig.ts" },
      { path: "new.ts", status: "untracked", origPath: null },
      { path: "src/b.tsx", status: "modified", origPath: null },
    ]);
  });

  it("passes through unprefixed repos sorted by path", () => {
    const changes = toProjectChanges(entries, "");
    expect(changes.map((change) => change.path)).toEqual([
      "elsewhere/x.ts",
      "pkg/app/moved.ts",
      "pkg/app/new.ts",
      "pkg/app/src/b.tsx",
    ]);
  });
});

describe("path guards", () => {
  const root = "/proj";

  it("rejects escapes, absolute paths, and empties", () => {
    expect(resolveContainedPath(root, "../secrets.ts")).toBeUndefined();
    expect(resolveContainedPath(root, "a/../../etc/passwd")).toBeUndefined();
    expect(resolveContainedPath(root, "/etc/passwd")).toBeUndefined();
    expect(resolveContainedPath(root, "")).toBeUndefined();
    expect(resolveContainedPath(root, "a\0b.ts")).toBeUndefined();
  });

  it("accepts contained relative paths regardless of extension", () => {
    expect(resolveContainedPath(root, "src/a.tsx")).toBe("/proj/src/a.tsx");
    expect(resolveContainedPath(root, "image.png")).toBe("/proj/image.png");
  });

  it("gates content routes on the extension allowlist", () => {
    expect(isSupportedSourcePath("a.tsx")).toBe(true);
    expect(isSupportedSourcePath("a.png")).toBe(false);
    expect(resolveSourceFile(root, "src/a.ts")).toBe("/proj/src/a.ts");
    expect(resolveSourceFile(root, "src/a.png")).toBeUndefined();
    expect(resolveSourceFile(root, "../a.ts")).toBeUndefined();
  });
});

describe("read-only blocking", () => {
  it("blocks the discard route alongside the write data endpoints", () => {
    expect(READ_ONLY_BLOCKED_ROUTES.has("POST /api/changes/discard")).toBe(
      true,
    );
    for (const route of [
      "POST /api/file",
      "POST /api/json",
      "POST /api/style",
      "POST /api/i18n",
      "POST /api/po",
    ]) {
      expect(READ_ONLY_BLOCKED_ROUTES.has(route)).toBe(true);
    }
  });
});

// --- Integration against a real temp repo --------------------------------

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "designbook-changes-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/kept.ts"), "export const kept = 1;\n");
  writeFileSync(join(dir, "src/edited.ts"), "export const value = 1;\n");
  writeFileSync(join(dir, "src/deleted.ts"), "export const gone = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

describe("listChanges (integration)", () => {
  it("returns collapsed, sorted, project-relative changes", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    writeFileSync(join(repo, "src/edited.ts"), "export const value = 2;\n");
    rmSync(join(repo, "src/deleted.ts"));
    writeFileSync(join(repo, "src/new.ts"), "export const fresh = 1;\n");

    const result = await listChanges(repo);
    expect(result.git).toBe(true);
    expect(result.changes).toEqual([
      { path: "src/deleted.ts", status: "deleted", origPath: null },
      { path: "src/edited.ts", status: "modified", origPath: null },
      { path: "src/new.ts", status: "untracked", origPath: null },
    ]);
  });

  it("degrades to { git: false } outside a repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "designbook-nogit-"));
    cleanups.push(dir);
    expect(await listChanges(dir)).toEqual({ git: false, changes: [] });
  });
});

describe("fileDiff (integration)", () => {
  it("returns HEAD + working sides for a modified file", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    writeFileSync(join(repo, "src/edited.ts"), "export const value = 2;\n");

    const diff = await fileDiff(repo, "src/edited.ts", join(repo, "src/edited.ts"));
    expect(diff.status).toBe("modified");
    expect(diff.head).toBe("export const value = 1;\n");
    expect(diff.working).toBe("export const value = 2;\n");
  });

  it("returns a null HEAD side for untracked files", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    writeFileSync(join(repo, "src/new.ts"), "export const fresh = 1;\n");

    const diff = await fileDiff(repo, "src/new.ts", join(repo, "src/new.ts"));
    expect(diff.status).toBe("untracked");
    expect(diff.head).toBeNull();
    expect(diff.working).toBe("export const fresh = 1;\n");
  });

  it("returns a null working side for deleted files", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    rmSync(join(repo, "src/deleted.ts"));

    const diff = await fileDiff(
      repo,
      "src/deleted.ts",
      join(repo, "src/deleted.ts"),
    );
    expect(diff.status).toBe("deleted");
    expect(diff.head).toBe("export const gone = 1;\n");
    expect(diff.working).toBeNull();
  });

  it("flags unsupported extensions without reading content", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    const diff = await fileDiff(repo, "logo.png", join(repo, "logo.png"));
    expect(diff.unsupported).toBe(true);
    expect(diff.head).toBeNull();
    expect(diff.working).toBeNull();
  });
});

describe("discardChange (integration)", () => {
  it("restores a modified tracked file to HEAD", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    writeFileSync(join(repo, "src/edited.ts"), "export const value = 2;\n");

    const result = await discardChange(
      repo,
      "src/edited.ts",
      join(repo, "src/edited.ts"),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(repo, "src/edited.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
  });

  it("restores a deleted tracked file", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    rmSync(join(repo, "src/deleted.ts"));

    await discardChange(repo, "src/deleted.ts", join(repo, "src/deleted.ts"));
    expect(await readFile(join(repo, "src/deleted.ts"), "utf8")).toBe(
      "export const gone = 1;\n",
    );
  });

  it("deletes an untracked file", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    writeFileSync(join(repo, "src/new.ts"), "export const fresh = 1;\n");

    await discardChange(repo, "src/new.ts", join(repo, "src/new.ts"));
    await expect(stat(join(repo, "src/new.ts"))).rejects.toThrow();
  });

  it("404s when the file has no changes", async () => {
    const repo = makeRepo();
    cleanups.push(repo);
    await expect(
      discardChange(repo, "src/kept.ts", join(repo, "src/kept.ts")),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("409s outside a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "designbook-nogit-"));
    cleanups.push(dir);
    writeFileSync(join(dir, "loose.ts"), "1\n");
    await expect(
      discardChange(dir, "loose.ts", join(dir, "loose.ts")),
    ).rejects.toMatchObject({ status: 409 });
  });
});
