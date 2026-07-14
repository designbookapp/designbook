/**
 * CLI entry.
 *
 *   pnpm --dir evals/context-arch run baseline          # real provider (keys from ~/.pi/agent/auth.json)
 *   pnpm --dir evals/context-arch run curated           # real provider, curated-context architecture
 *   pnpm --dir evals/context-arch run dry-run           # mock provider, no keys/spend
 *   pnpm --dir evals/context-arch run dry-run-curated   # mock + curated assembler smoke test
 *   node src/run.ts [--mock] [--arch replay|curated] [--task <id>] [--cap <usd>]
 *
 * HARD SPEND CAP: default $12 global (headroom for judge calls under the
 * $15 budget). Each task additionally has its own cap and an LLM-call cap.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import { runTask, type HarnessOptions } from "./harness.ts";
import { startMockServer } from "./mockServer.ts";
import type { Arch, Task, TaskResult } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(here, "..");

/**
 * The model the ORIGINAL baseline ran on (then the machine's pi default).
 * The machine default has since moved to another provider, so real runs pin
 * this explicitly to stay comparable across runs.
 */
const BASELINE_MODEL = { provider: "anthropic", pattern: "claude-opus-4-8" };

function parseArgs(argv: string[]) {
  // Default global cap $18: full 8-task baseline fits comfortably under the
  // $20 budget with headroom for judge calls (billed outside the recorder).
  const args = {
    mock: false,
    task: undefined as string | undefined,
    cap: 18,
    arch: "replay" as Arch,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mock") args.mock = true;
    else if (argv[i] === "--task") args.task = argv[++i];
    else if (argv[i] === "--cap") args.cap = Number(argv[++i]);
    else if (argv[i] === "--arch") {
      const v = argv[++i];
      if (v !== "replay" && v !== "curated") {
        console.error(`--arch must be "replay" or "curated" (got ${v})`);
        process.exit(1);
      }
      args.arch = v;
    }
  }
  return args;
}

function loadTasks(only?: string): Task[] {
  const dir = join(evalRoot, "tasks");
  const tasks = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Task);
  return only ? tasks.filter((t) => t.id === only) : tasks;
}

/** Mock mode gets an isolated agentDir (dummy key, no user settings). */
function makeMockAgentDir(): string {
  const dir = mkdtempSync(join(process.env.EVAL_TMPDIR ?? tmpdir(), "ctx-arch-agent-"));
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "mock-key" } }),
  );
  writeFileSync(join(dir, "settings.json"), JSON.stringify({}));
  return dir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(args.task);
  if (tasks.length === 0) {
    console.error("no tasks matched");
    process.exit(1);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(
    evalRoot,
    "runs",
    `${args.mock ? "mock-" : ""}${runId}${args.arch === "curated" ? "-curated" : ""}`,
  );
  mkdirSync(runDir, { recursive: true });
  const log = (line: string) => console.log(line);

  let mockServer;
  const agentDir = args.mock ? makeMockAgentDir() : getAgentDir();
  if (args.mock) mockServer = await startMockServer();

  // Real mode: pin the baseline model instead of trusting the machine's
  // (mutable) default pi settings.
  let pinnedModel;
  if (!args.mock) {
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const registry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const resolved = resolveCliModel({
      cliProvider: BASELINE_MODEL.provider,
      cliModel: BASELINE_MODEL.pattern,
      modelRegistry: registry,
    });
    if (!resolved.model) {
      console.error(
        `cannot resolve baseline model ${BASELINE_MODEL.provider}/${BASELINE_MODEL.pattern}: ${resolved.error ?? resolved.warning ?? "unknown"}`,
      );
      process.exit(1);
    }
    pinnedModel = resolved.model;
  }

  log(`run ${runDir}`);
  log(
    `mode: ${args.mock ? "MOCK (dry-run)" : `REAL (${pinnedModel?.provider}/${pinnedModel?.id})`}, arch ${args.arch}, global cap $${args.cap}`,
  );

  const results: TaskResult[] = [];
  let spent = 0;
  for (const task of tasks) {
    if (spent >= args.cap) {
      log(`SKIP ${task.id}: global spend cap reached ($${spent.toFixed(2)})`);
      continue;
    }
    log(`\n== task ${task.id}`);
    // Long tasks (15+ turns) get a larger per-task cap and call budget;
    // short tasks keep the original limits.
    const longTask = task.turns.length >= 10;
    const opts: HarnessOptions = {
      runDir,
      runId,
      agentDir,
      mock: args.mock,
      arch: args.arch,
      model: pinnedModel,
      taskCostCapUSD: Math.min(longTask ? 6 : 4, args.cap - spent),
      perTurnTimeoutMs: args.mock ? 60_000 : 420_000,
      // Curated mode legitimately spends extra calls on state_update/recall.
      maxCallsPerTask: Math.max(40, task.turns.length * (args.arch === "curated" ? 8 : 5)),
      judge: !args.mock,
      log,
    };
    try {
      const result = await runTask(task, opts);
      results.push(result);
      spent += result.totals.costUSD;
      const passed = result.checks.filter((c) => c.pass).length;
      log(
        `  done: ${result.totals.llmCalls} calls, $${result.totals.costUSD.toFixed(3)}, ` +
          `${(result.totals.wallMs / 1000).toFixed(0)}s, checks ${passed}/${result.checks.length}` +
          (result.aborted ? `, ABORTED: ${result.aborted}` : ""),
      );
    } catch (error) {
      log(`  FAILED: ${(error as Error).stack ?? error}`);
    }
  }

  const summary = {
    runId,
    mock: args.mock,
    arch: args.arch,
    globalCapUSD: args.cap,
    totalCostUSD: spent,
    tasks: results.map((r) => ({
      taskId: r.taskId,
      model: r.model,
      turns: r.turns.length,
      llmCalls: r.totals.llmCalls,
      input: r.totals.input,
      output: r.totals.output,
      cacheRead: r.totals.cacheRead,
      cacheWrite: r.totals.cacheWrite,
      costUSD: r.totals.costUSD,
      wallMs: r.totals.wallMs,
      checksPassed: r.checks.filter((c) => c.pass).length,
      checksTotal: r.checks.length,
      judge: r.judge
        ? {
            redid_work: r.judge.redid_work,
            contradicted_earlier_decision: r.judge.contradicted_earlier_decision,
            unrequested_edits: r.judge.unrequested_edits,
          }
        : undefined,
      aborted: r.aborted,
    })),
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`\nsummary → ${join(runDir, "summary.json")}`);
  log(JSON.stringify(summary.tasks, null, 2));
  log(`total spend: $${spent.toFixed(3)}`);

  mockServer?.close();
  // pi keeps some handles (session manager fs watchers etc.) — exit explicitly.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
