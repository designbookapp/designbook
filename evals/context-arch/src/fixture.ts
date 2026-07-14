/**
 * Workspace fixture: copies `examples/demo` into a fresh temp dir per run so
 * tasks can mutate files safely. node_modules/dist/.designbook are excluded
 * (tasks only read/edit source, they never build or run the app).
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Monorepo root (evals/context-arch/src → ../../..). */
export const repoRoot = resolve(here, "../../..");
export const demoDir = join(repoRoot, "examples", "demo");

const EXCLUDED = new Set(["node_modules", "dist", ".designbook", ".git"]);

export function prepareWorkspace(taskId: string, runId: string): string {
  const base = process.env.EVAL_TMPDIR ?? tmpdir();
  const workspace = join(base, `ctx-arch-${runId}`, taskId);
  mkdirSync(workspace, { recursive: true });
  cpSync(demoDir, workspace, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(demoDir.length).split("/");
      return !rel.some((part) => EXCLUDED.has(part));
    },
  });
  // Workspace anchor. Without it, absolute paths that leak into the system
  // prompt (pi's own docs live under the harness repo's node_modules) can
  // pull the agent OUT of the fixture — observed in the first baseline run,
  // where the agent edited the harness repo's examples/demo instead of the
  // fixture copy. Real designbook projects ship an AGENTS.md too.
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      "# Project notes",
      "",
      "This directory is the project root of the demo app.",
      "All file paths in user requests (e.g. `src/components/ui/card.tsx`)",
      "are relative to this directory. Only read and modify files inside",
      "this project — never outside it.",
      "",
    ].join("\n"),
  );
  return workspace;
}

/**
 * Copies designbook's packaged skills into a NEUTRAL temp dir so the skill
 * `<location>` entries in the system prompt don't leak the monorepo path
 * (second half of the same escape bug described above).
 */
export function prepareSkillsDir(runId: string): string | undefined {
  const source = join(repoRoot, "packages", "designbook", "src", "skills");
  if (!existsSync(source)) return undefined;
  const base = process.env.EVAL_TMPDIR ?? tmpdir();
  const dest = join(base, `ctx-arch-${runId}`, "packaged-skills");
  mkdirSync(dest, { recursive: true });
  cpSync(source, dest, { recursive: true });
  return dest;
}

export function hashFile(workspace: string, rel: string): string | undefined {
  const p = join(workspace, rel);
  if (!existsSync(p)) return undefined;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
