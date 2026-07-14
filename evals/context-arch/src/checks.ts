/**
 * Scriptable assertions over the finished workspace + session transcript.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, CheckResult, Task, TurnResult } from "./types.ts";

export type CheckContext = {
  workspace: string;
  turns: TurnResult[];
  /** sha256 per file captured right after fixture copy (pre-session). */
  baselineHashes: Map<string, string | undefined>;
  hashFile: (rel: string) => string | undefined;
  /** # of `read` tool calls whose arguments mention the given path. */
  readCount: (file: string) => number;
};

export function evaluateChecks(task: Task, ctx: CheckContext): CheckResult[] {
  return task.checks.map((check) => evaluate(check, ctx));
}

function evaluate(check: Check, ctx: CheckContext): CheckResult {
  switch (check.type) {
    case "file_contains":
    case "file_not_contains": {
      const p = join(ctx.workspace, check.file);
      if (!existsSync(p)) {
        return { check, pass: false, detail: `missing file ${check.file}` };
      }
      const text = readFileSync(p, "utf8");
      const hit = new RegExp(check.pattern, check.flags).test(text);
      const pass = check.type === "file_contains" ? hit : !hit;
      return {
        check,
        pass,
        detail: `pattern ${hit ? "found" : "not found"} in ${check.file}`,
      };
    }
    case "file_unchanged": {
      const before = ctx.baselineHashes.get(check.file);
      const after = ctx.hashFile(check.file);
      const pass = before !== undefined && before === after;
      return {
        check,
        pass,
        detail: pass ? "hash identical" : "file was modified (or missing)",
      };
    }
    case "max_reads": {
      const n = ctx.readCount(check.file);
      return {
        check,
        pass: n <= check.max,
        detail: `${n} read(s) of ${check.file} (max ${check.max})`,
      };
    }
    case "final_response_matches": {
      const turn = ctx.turns[check.turn];
      if (!turn) return { check, pass: false, detail: "turn missing" };
      const pass = new RegExp(check.pattern, check.flags ?? "i").test(
        turn.finalText,
      );
      return {
        check,
        pass,
        detail: pass
          ? "response matched"
          : `no match in: ${turn.finalText.slice(0, 160)}…`,
      };
    }
  }
}
