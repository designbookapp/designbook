/**
 * Props-panel usage-site write path (docs/specs/props-panel.md §Writes):
 * `stageDirectCodeEdit` commits a precise JSX-attribute edit onto the active
 * conversation's direct-edits changeset trunk (real file untouched), and the
 * spread-props / unresolvable case bails without committing.
 *
 * Drives the sandbox orchestrator against a REAL git repo (git is the truth
 * plane) — the same harness style as sandbox.test.ts.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createSandboxOrchestrator } from "./sandbox.ts";
import { editJsxAttribute } from "./jsxAttrEdit.ts";

const execFileAsync = promisify(execFile);
const cleanups: string[] = [];
const settlers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const settle of settlers) await settle().catch(() => {});
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

const USAGE = `export function Page() {
  return <ProductCard title="Old" price={10} className="card" />;
}
`;

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "db-props-edit-"));
  cleanups.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/Page.tsx"), USAGE);
  await execFileAsync("git", ["init", "-q", "-b", "main", root]);
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    { cwd: root },
  );
  return root;
}

function makeOrchestrator() {
  const orchestrator = createSandboxOrchestrator({
    runTurn: async () => ({ ok: true }) as never,
    runTypecheck: async () => ({ ok: true }),
    broadcast: () => {},
    log: () => {},
  });
  settlers.push(() => orchestrator.settle());
  return orchestrator;
}

/** The content of `path` on the changeset's trunk ref. */
async function trunkContent(
  root: string,
  changesetId: string,
  path: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", `refs/designbook/changesets/${changesetId}/trunk:${path}`],
    { cwd: root },
  );
  return stdout;
}

describe("stageDirectCodeEdit", () => {
  it("commits a JSX attribute edit onto the conversation trunk; real file untouched", async () => {
    const root = await makeRepo();
    const orchestrator = makeOrchestrator();
    const apply = (current: string) => {
      const result = editJsxAttribute({
        source: current,
        elementName: "ProductCard",
        className: "card",
        prop: "title",
        edit: { type: "set", value: { kind: "string", value: "New" } },
      });
      return "unresolvable" in result
        ? { unresolvable: result.unresolvable }
        : { updated: result.updated };
    };

    const staged = await orchestrator.stageDirectCodeEdit({
      repoRoot: root,
      appDir: "",
      conversationId: "cabc-0001",
      rel: "src/Page.tsx",
      apply,
    });

    expect(staged.staged).toBe(true);
    expect(staged.changesetId).toBe("direct-cabc-0001");
    expect(staged.from).toBeTruthy();
    expect(staged.to).toBeTruthy();

    // Committed content carries the edit.
    const committed = await trunkContent(root, staged.changesetId!, "src/Page.tsx");
    expect(committed).toContain('title="New"');
    expect(committed).toContain('price={10}');

    // Real working-tree file is byte-identical to the original.
    const real = await readFile(join(root, "src/Page.tsx"), "utf8");
    expect(real).toBe(USAGE);
  });

  it("is a no-op that still reports the changeset when the value is unchanged", async () => {
    const root = await makeRepo();
    const orchestrator = makeOrchestrator();
    const staged = await orchestrator.stageDirectCodeEdit({
      repoRoot: root,
      appDir: "",
      conversationId: "cabc-0002",
      rel: "src/Page.tsx",
      apply: (current) => {
        const result = editJsxAttribute({
          source: current,
          elementName: "ProductCard",
          prop: "title",
          edit: { type: "set", value: { kind: "string", value: "Old" } },
        });
        return "unresolvable" in result
          ? { unresolvable: result.unresolvable }
          : { updated: result.updated };
      },
    });
    expect(staged.staged).toBe(true);
    // No commit landed — from/to absent (unchanged).
    expect(staged.to).toBeUndefined();
  });

  it("bails out (unresolvable) on spread props without committing", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-props-edit-"));
    cleanups.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src/Spread.tsx"),
      "export function P(props){ return <ProductCard {...props} title=\"x\" />; }\n",
    );
    await execFileAsync("git", ["init", "-q", "-b", "main", root]);
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
      { cwd: root },
    );
    const orchestrator = makeOrchestrator();
    const staged = await orchestrator.stageDirectCodeEdit({
      repoRoot: root,
      appDir: "",
      conversationId: "cabc-0003",
      rel: "src/Spread.tsx",
      apply: (current) => {
        const result = editJsxAttribute({
          source: current,
          elementName: "ProductCard",
          prop: "title",
          edit: { type: "set", value: { kind: "string", value: "y" } },
        });
        return "unresolvable" in result
          ? { unresolvable: result.unresolvable }
          : { updated: result.updated };
      },
    });
    expect(staged.unresolvable).toBeTruthy();
    expect(staged.staged).toBeUndefined();
  });
});
