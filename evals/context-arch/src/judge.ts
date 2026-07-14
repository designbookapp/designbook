/**
 * LLM judge for the fuzzy quality rubric (redid-work,
 * contradicted-earlier-decision). One small non-streaming call per task,
 * straight against the Anthropic Messages API with the key pi already has
 * in ~/.pi/agent/auth.json. Skipped in mock mode.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JudgeResult, Task, TurnResult } from "./types.ts";

const JUDGE_MODEL = "claude-opus-4-8";

export function anthropicKeyFromAgentDir(agentDir: string): string | undefined {
  const p = join(agentDir, "auth.json");
  if (!existsSync(p)) return undefined;
  try {
    const auth = JSON.parse(readFileSync(p, "utf8")) as Record<
      string,
      { type?: string; key?: string }
    >;
    const cred = auth["anthropic"];
    return cred?.type === "api_key" ? cred.key : undefined;
  } catch {
    return undefined;
  }
}

export async function judgeTask(
  task: Task,
  turns: TurnResult[],
  apiKey: string,
): Promise<JudgeResult | undefined> {
  if (!task.judgeRubric) return undefined;
  const transcript = turns
    .map(
      (t) =>
        `## Turn ${t.turn + 1}\nUSER:\n${t.user}\n\nASSISTANT (final text):\n${t.finalText || "(no text)"}`,
    )
    .join("\n\n");
  const prompt = [
    `You are grading a coding-agent transcript for context-retention quality.`,
    `Task: ${task.description}`,
    ``,
    `Rubric: ${task.judgeRubric}`,
    ``,
    `Transcript:\n${transcript}`,
    ``,
    `Answer with ONLY a JSON object, no markdown fences:`,
    `{"redid_work": boolean, "contradicted_earlier_decision": boolean, "unrequested_edits": boolean, "notes": "one or two sentences"}`,
    `redid_work = the agent repeated work it had already completed (re-derived, re-implemented, or visibly re-established context it should have retained).`,
    `contradicted_earlier_decision = a later answer or edit contradicts a decision or constraint established earlier in the session.`,
    `unrequested_edits = scope creep: the agent made a real file edit that no user turn asked for (beyond mechanical necessities of the requested change). Honest disclosure in the recap does not excuse it.`,
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      // 1500: long-task transcripts overflowed the old 500-token cap
      // (task 07's judge reply was truncated mid-JSON in the first baseline).
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    return {
      redid_work: false,
      contradicted_earlier_decision: false,
      unrequested_edits: false,
      notes: `judge call failed: HTTP ${res.status}`,
    };
  }
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text =
    data.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
  try {
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as JudgeResult;
    return { ...parsed, raw: text };
  } catch {
    return {
      redid_work: false,
      contradicted_earlier_decision: false,
      unrequested_edits: false,
      notes: "judge returned unparseable output",
      raw: text,
    };
  }
}
