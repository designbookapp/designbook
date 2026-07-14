/**
 * Renders markdown tables for BASELINE.md from a run directory.
 *
 *   node src/report.ts runs/<run-id>
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskResult } from "./types.ts";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node src/report.ts runs/<run-id>");
  process.exit(1);
}

const results: TaskResult[] = readdirSync(runDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(runDir, d.name, "results.json"))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, "utf8")) as TaskResult);

const fmt = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${n.toFixed(3)}`;

console.log(`## Per-task\n`);
console.log(
  `| task | turns | LLM calls | input (uncached) | cache read | cache write | output | cost | wall | checks | judge |`,
);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of results) {
  const checks = `${r.checks.filter((c) => c.pass).length}/${r.checks.length}`;
  const judge = r.judge
    ? `redid:${r.judge.redid_work ? "Y" : "n"} contra:${r.judge.contradicted_earlier_decision ? "Y" : "n"}`
    : "—";
  console.log(
    `| ${r.taskId}${r.aborted ? " ⚠️" : ""} | ${r.turns.length} | ${r.totals.llmCalls} | ${fmt(r.totals.input)} | ${fmt(r.totals.cacheRead)} | ${fmt(r.totals.cacheWrite)} | ${fmt(r.totals.output)} | ${usd(r.totals.costUSD)} | ${(r.totals.wallMs / 1000).toFixed(0)}s | ${checks} | ${judge} |`,
  );
}

const agg = results.reduce(
  (a, r) => {
    a.calls += r.totals.llmCalls;
    a.turns += r.turns.length;
    a.input += r.totals.input;
    a.output += r.totals.output;
    a.cacheRead += r.totals.cacheRead;
    a.cacheWrite += r.totals.cacheWrite;
    a.cost += r.totals.costUSD;
    a.wall += r.totals.wallMs;
    return a;
  },
  { calls: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, wall: 0 },
);
console.log(`\n## Aggregate\n`);
console.log(
  `- ${results.length} tasks, ${agg.turns} user turns, ${agg.calls} LLM calls (${(agg.calls / agg.turns).toFixed(1)} calls/turn)`,
);
console.log(
  `- tokens: input(uncached) ${fmt(agg.input)}, cacheRead ${fmt(agg.cacheRead)}, cacheWrite ${fmt(agg.cacheWrite)}, output ${fmt(agg.output)}`,
);
console.log(
  `- cached share of prompt tokens: ${((agg.cacheRead / Math.max(1, agg.cacheRead + agg.cacheWrite + agg.input)) * 100).toFixed(1)}%`,
);
console.log(`- cost ${usd(agg.cost)}, wall ${(agg.wall / 1000 / 60).toFixed(1)} min`);
console.log(
  `- per turn: ${fmt(Math.round((agg.input + agg.cacheRead + agg.cacheWrite) / agg.turns))} prompt tokens, ${usd(agg.cost / agg.turns)}`,
);

console.log(`\n## Context growth by user turn (request payload → provider)\n`);
console.log(`| task | turn | calls | last-call msgs | last-call payload KB | prompt tokens (in+cr+cw) at last call |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of results) {
  for (const t of r.turns) {
    const turnCalls = r.calls.filter((c) => c.turn === t.turn);
    const last = turnCalls[turnCalls.length - 1];
    if (!last) continue;
    const prompt = (last.usage?.input ?? 0) + (last.usage?.cacheRead ?? 0) + (last.usage?.cacheWrite ?? 0);
    console.log(
      `| ${r.taskId} | ${t.turn + 1} | ${turnCalls.length} | ${last.contextMessages ?? "?"} | ${((last.contextBytes ?? 0) / 1024).toFixed(0)} | ${fmt(prompt)} |`,
    );
  }
}

console.log(`\n## Per-call latency\n`);
const lats = results.flatMap((r) => r.calls.map((c) => c.latencyMs ?? 0)).filter((v) => v > 0).sort((a, b) => a - b);
if (lats.length > 0) {
  const p = (q: number) => lats[Math.min(lats.length - 1, Math.floor(q * lats.length))];
  console.log(
    `- n=${lats.length}, p50 ${(p(0.5) / 1000).toFixed(1)}s, p90 ${(p(0.9) / 1000).toFixed(1)}s, max ${(lats[lats.length - 1] / 1000).toFixed(1)}s`,
  );
}
