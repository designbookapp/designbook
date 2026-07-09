/**
 * Branch-scoped root resolution (the per-branch data-endpoint fix):
 *
 *   - pure resolution: `resolveActiveRepoRoot` (active worktree ?? primary —
 *     host mode and pre-switch proxy mode MUST resolve to projectRoot) and
 *     `rebaseConfigDir` (config-relative locale/.po paths land inside the
 *     SAME root the containment check uses);
 *   - a source scan of api.ts pinning the discipline the fix introduced:
 *     every per-request FILE handler resolves its root via `activeRepoRoot()`
 *     (or takes it as a `repoRoot` param) and never touches raw
 *     `projectRoot` — mixing roots within a request is a path-traversal
 *     hazard (containment checked against one root, file written under
 *     another). The remaining raw `projectRoot` uses are allowlisted line
 *     patterns: boot-time config paths, the session registry's primary cwd,
 *     and worktree MANAGEMENT (which is genuinely about the primary repo).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rebaseConfigDir, resolveActiveRepoRoot } from "./activeRepoRoot.ts";

describe("resolveActiveRepoRoot", () => {
  it("resolves to the active worktree root when the proxy has switched", () => {
    expect(
      resolveActiveRepoRoot({
        activeWorktreeRoot: "/repos/app-worktrees/design-hero",
        projectRoot: "/repos/app",
      }),
    ).toBe("/repos/app-worktrees/design-hero");
  });

  it("resolves to projectRoot when no worktree is active (host mode / pre-switch)", () => {
    expect(
      resolveActiveRepoRoot({
        activeWorktreeRoot: undefined,
        projectRoot: "/repos/app",
      }),
    ).toBe("/repos/app");
  });
});

describe("rebaseConfigDir", () => {
  it("keeps the primary configDir when the active root IS the primary", () => {
    expect(
      rebaseConfigDir({
        configDir: "/repos/app/examples/demo",
        projectRoot: "/repos/app",
        repoRoot: "/repos/app",
      }),
    ).toBe("/repos/app/examples/demo");
  });

  it("rebases the configDir into the active worktree root", () => {
    expect(
      rebaseConfigDir({
        configDir: "/repos/app/examples/demo",
        projectRoot: "/repos/app",
        repoRoot: "/repos/app-worktrees/design-hero",
      }),
    ).toBe("/repos/app-worktrees/design-hero/examples/demo");
  });

  it("handles a configDir at the project root itself", () => {
    expect(
      rebaseConfigDir({
        configDir: "/repos/app",
        projectRoot: "/repos/app",
        repoRoot: "/repos/app-worktrees/design-hero",
      }),
    ).toBe("/repos/app-worktrees/design-hero");
  });
});

// --- Source scan: the endpoints go through the resolved root ---------------

const apiSource = readFileSync(
  fileURLToPath(new URL("./api.ts", import.meta.url)),
  "utf8",
);

/**
 * Split api.ts into chunks, one per top-level-in-createApi function
 * declaration (2-space indent). A chunk runs from its declaration to the next
 * one, so interleaved consts/comments attach to the preceding function —
 * good enough for a ban scan.
 */
function functionChunks(source: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const decl = /\n  (?:async )?function ([A-Za-z0-9_]+)\s*\(/g;
  let previous: { name: string; start: number } | undefined;
  for (let match = decl.exec(source); match; match = decl.exec(source)) {
    if (previous) {
      chunks.set(previous.name, source.slice(previous.start, match.index));
    }
    previous = { name: match[1], start: match.index };
  }
  if (previous) chunks.set(previous.name, source.slice(previous.start));
  return chunks;
}

/**
 * The per-request FILE handlers and their path-resolution helpers: every repo
 * read/write these perform must go through the request's resolved root.
 */
const REPO_FILE_HANDLERS = [
  "handleI18nUpdate",
  "handlePoUpdate",
  "handleGetFile",
  "handleWriteFile",
  "handleListChanges",
  "handleFileDiff",
  "handleDiscardChange",
  "handleJsonWrite",
  "handleStyleWrite",
];

/** Root-threaded helpers: they take the caller's resolved root as a param. */
const ROOT_PARAM_HELPERS = [
  "noteDataWrite",
  "resolveLocaleFile",
  "resolvePoFile",
  "resolveSourceFile",
];

/**
 * Line patterns for the legitimate raw `projectRoot` uses. Anything else is a
 * regression toward the cross-branch bug (or a new mixed-root hazard) and
 * must either thread the resolved root or be allowlisted here CONSCIOUSLY.
 */
const ALLOWED_PROJECT_ROOT_LINES: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^\s*projectRoot: string;$/, why: "ApiOptions type" },
  { pattern: /^\s*projectRoot,$/, why: "destructure / seam + worktree-mgmt args" },
  {
    pattern: /const configRelPath = relative\(projectRoot, configPath\);/,
    why: "boot: config path relayed to host-mode branch instances (repo-rel, identical across worktrees)",
  },
  {
    pattern: /rebaseConfigDir\(\{ configDir, projectRoot, repoRoot \}\)/,
    why: "the resolution seam itself (activeConfigDirFor)",
  },
  {
    pattern: /^\s*primaryCwd: projectRoot,$/,
    why: "session registry: the PRIMARY session's cwd",
  },
  {
    pattern: /cwd: entry\?\.cwd \?\? projectRoot,/,
    why: "serializeSession display fallback",
  },
  {
    pattern: /getCurrentBranch\(projectRoot\)/,
    why: "worktree mgmt: the primary checkout's branch",
  },
  {
    pattern: /listWorktrees\(projectRoot, gitBranch, port\)/,
    why: "worktree mgmt: enumerates the primary repo's worktrees",
  },
  {
    pattern: /^\s*repoRoot: projectRoot,$/,
    why: "worktree mgmt: ensureInstance spawns from the primary repo",
  },
];

describe("api.ts branch-scoping source scan", () => {
  const chunks = functionChunks(apiSource);

  it("finds every scanned function (scan stays honest across refactors)", () => {
    for (const name of [...REPO_FILE_HANDLERS, ...ROOT_PARAM_HELPERS]) {
      expect(chunks.has(name), `function ${name} not found in api.ts`).toBe(
        true,
      );
    }
  });

  it("bans raw projectRoot in the per-request file handlers", () => {
    for (const name of [...REPO_FILE_HANDLERS, ...ROOT_PARAM_HELPERS]) {
      const body = chunks.get(name) ?? "";
      expect(
        /\bprojectRoot\b/.test(body),
        `${name} references raw projectRoot — thread the resolved root instead`,
      ).toBe(false);
    }
  });

  it("routes every file handler through the resolved root", () => {
    for (const name of REPO_FILE_HANDLERS) {
      const body = chunks.get(name) ?? "";
      expect(
        body.includes("activeRepoRoot()"),
        `${name} must resolve its root via activeRepoRoot() (once, then thread it)`,
      ).toBe(true);
    }
    for (const name of ROOT_PARAM_HELPERS) {
      const body = chunks.get(name) ?? "";
      expect(
        /repoRoot: string/.test(body),
        `${name} must take the caller's resolved root as a repoRoot param`,
      ).toBe(true);
    }
  });

  it("resolves the root at most once per handler (no mid-request re-resolution)", () => {
    for (const name of REPO_FILE_HANDLERS) {
      const body = chunks.get(name) ?? "";
      const count = body.split("activeRepoRoot()").length - 1;
      expect(
        count,
        `${name} resolves activeRepoRoot() ${count} times — resolve once and thread it, or containment and write may disagree`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("allowlists every remaining raw projectRoot line", () => {
    const offenders = apiSource
      .split("\n")
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(({ line }) => /\bprojectRoot\b/.test(line))
      .filter(
        ({ line }) =>
          !ALLOWED_PROJECT_ROOT_LINES.some(({ pattern }) =>
            pattern.test(line),
          ),
      );
    expect(
      offenders.map(({ lineNo, line }) => `${lineNo}: ${line.trim()}`),
      "new raw projectRoot use in api.ts — per-request file ops must use activeRepoRoot(); if this is genuinely a boot/worktree-mgmt concern, extend the allowlist",
    ).toEqual([]);
  });
});
