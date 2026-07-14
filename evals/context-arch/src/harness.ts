/**
 * Headless task runner: drives `createAgentSession` (the same SDK entry
 * designbook's /api chat uses — see packages/designbook/src/node/api/api.ts)
 * against a temp copy of examples/demo, with an inline recorder extension
 * capturing every raw provider request + per-call usage/latency.
 *
 * Production parity notes:
 * - Same session construction as designbook's `createSessionFor`:
 *   cwd-scoped SettingsManager/SessionManager, DefaultResourceLoader with
 *   designbook's packaged core skills dir (variations skill), project
 *   untrusted. Integration custom tools (figma) are NOT registered — that
 *   requires the full designbook integration registry (listed as a gap).
 * - Real mode uses the machine's default pi model config
 *   (~/.pi/agent/settings.json → anthropic/claude-opus-4-8, thinking medium).
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { evaluateChecks } from "./checks.ts";
import { createCurator, type Curator } from "./curatedContext.ts";
import { hashFile, prepareSkillsDir, prepareWorkspace } from "./fixture.ts";
import { anthropicKeyFromAgentDir, judgeTask } from "./judge.ts";
import { MOCK_PORT } from "./mockServer.ts";
import { createRecorder } from "./recorder.ts";
import type { Arch, Task, TaskResult, TurnResult } from "./types.ts";

type PiModel = NonNullable<AgentSession["model"]>;

/** Mock model routed at the local stub server (dry-run mode). */
const mockModel = {
  id: "mock-model",
  name: "Mock (dry-run)",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} as PiModel;

export type HarnessOptions = {
  runDir: string;
  runId: string;
  agentDir: string;
  mock: boolean;
  /** Context architecture: "replay" (full history, baseline) or "curated". */
  arch: Arch;
  /**
   * Real-mode model pin. The original baseline ran on the machine's default
   * pi config (anthropic/claude-opus-4-8, thinking medium); the machine
   * default has since changed, so the runner resolves and pins the baseline
   * model explicitly to keep runs comparable.
   */
  model?: PiModel;
  /** Per-task spend cap (safety net under the global cap). */
  taskCostCapUSD: number;
  perTurnTimeoutMs: number;
  maxCallsPerTask: number;
  judge: boolean;
  log: (line: string) => void;
};

/** Neutral (non-repo-path) copy of designbook's packaged skills, per run. */
const skillsDirCache = new Map<string, string | undefined>();
function designbookSkillPaths(runId: string): string[] {
  if (!skillsDirCache.has(runId)) {
    skillsDirCache.set(runId, prepareSkillsDir(runId));
  }
  const dir = skillsDirCache.get(runId);
  return dir && existsSync(dir) ? [dir] : [];
}

function extractText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (!Array.isArray(m.content)) {
    return typeof m.content === "string" ? m.content : "";
  }
  return m.content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

function lastAssistantText(messages: unknown[], fromIndex: number): string {
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const m = messages[i] as { role?: string };
    if (m?.role === "assistant") return extractText(m);
  }
  return "";
}

function lastErrorMessage(
  messages: unknown[],
  fromIndex: number,
): string | undefined {
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const m = messages[i] as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (m?.role === "assistant" && m.stopReason === "error") {
      return m.errorMessage ?? "provider error (no message)";
    }
  }
  return undefined;
}

export async function runTask(
  task: Task,
  opts: HarnessOptions,
): Promise<TaskResult> {
  const taskDir = join(opts.runDir, task.id);
  mkdirSync(taskDir, { recursive: true });
  const workspace = prepareWorkspace(task.id, opts.runId);

  // Baseline hashes for file_unchanged checks.
  const baselineHashes = new Map<string, string | undefined>();
  for (const check of task.checks) {
    if (check.type === "file_unchanged") {
      baselineHashes.set(check.file, hashFile(workspace, check.file));
    }
  }

  let abortedReason: string | undefined;
  const sessionRef: { current?: AgentSession } = {};
  const recorder = createRecorder({
    payloadPath: join(taskDir, "payloads.jsonl"),
    maxCalls: opts.maxCallsPerTask,
    costCapUSD: opts.taskCostCapUSD,
    onOverrun: (reason) => {
      if (abortedReason) return;
      abortedReason = reason;
      opts.log(`  !! aborting task ${task.id}: ${reason}`);
      void sessionRef.current?.abort();
    },
  });

  // Curated mode: the assembler runs BEFORE the recorder so the recorded
  // payloads include its cache-breakpoint edits (i.e. what was actually sent).
  let curator: Curator | undefined;
  if (opts.arch === "curated") {
    curator = createCurator({
      getSessionFile: () => sessionRef.current?.sessionFile,
    });
  }

  const settingsManager = SettingsManager.create(workspace, opts.agentDir, {
    projectTrusted: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: opts.agentDir,
    settingsManager,
    additionalSkillPaths: designbookSkillPaths(opts.runId),
    extensionFactories: [
      ...(curator ? [{ name: "curated-context", factory: curator.extension }] : []),
      { name: "context-arch-recorder", factory: recorder.extension },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: opts.agentDir,
    settingsManager,
    sessionManager: SessionManager.create(workspace),
    resourceLoader,
    ...(opts.mock
      ? { model: mockModel }
      : opts.model
        ? { model: opts.model, thinkingLevel: "medium" as const }
        : {}),
  });
  sessionRef.current = session;
  opts.log(
    `  session ${session.sessionId} model=${session.model?.id ?? "none"} thinking=${session.thinkingLevel}`,
  );

  const turns: TurnResult[] = [];
  const t0 = Date.now();
  try {
    for (let i = 0; i < task.turns.length; i++) {
      if (abortedReason) break;
      recorder.setTurn(i);
      const callsBefore = recorder.calls.length;
      const messagesBefore = session.messages.length;
      const turnStart = Date.now();
      opts.log(`  turn ${i + 1}/${task.turns.length}: ${task.turns[i].user.slice(0, 70).replace(/\n/g, " ")}…`);

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), opts.perTurnTimeoutMs);
      });
      const promptPromise = session
        .prompt(task.turns[i].user)
        .then(() => "done" as const);
      const outcome = await Promise.race([promptPromise, timeout]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        abortedReason = abortedReason ?? `turn ${i + 1} timed out`;
        await session.abort().catch(() => {});
        await promptPromise.catch(() => {});
      }

      const messages = session.messages as unknown[];
      turns.push({
        turn: i,
        user: task.turns[i].user,
        finalText: lastAssistantText(messages, messagesBefore),
        wallMs: Date.now() - turnStart,
        llmCalls: recorder.calls.length - callsBefore,
        errorMessage: lastErrorMessage(messages, messagesBefore),
      });
      // A provider error means the rest of the script would compound noise.
      if (turns[i]?.errorMessage) {
        abortedReason = abortedReason ?? `provider error: ${turns[i].errorMessage}`;
      }
    }
  } finally {
    // Snapshot transcript info before dispose.
    var sessionFile = session.sessionFile;
    var finalMessages = [...(session.messages as unknown[])];
    session.dispose();
  }

  // Persist the pi session transcript beside the task's other artifacts so the
  // run dir is self-contained (viewable in tools/pi-session-viewer via the
  // dashboard's "view conversation" links even after ~/.pi cleanup).
  if (sessionFile && existsSync(sessionFile)) {
    try {
      copyFileSync(sessionFile, join(taskDir, "session.jsonl"));
    } catch (err) {
      opts.log(`  !! failed to persist session.jsonl for ${task.id}: ${String(err)}`);
    }
  }

  const readCount = (file: string): number => {
    let n = 0;
    for (const m of finalMessages) {
      const msg = m as { role?: string; content?: unknown };
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as { type?: string; name?: string; arguments?: unknown };
        if (b.type === "toolCall" && b.name === "read") {
          if (JSON.stringify(b.arguments ?? {}).includes(file)) n++;
        }
      }
    }
    return n;
  };

  const checks = evaluateChecks(task, {
    workspace,
    turns,
    baselineHashes,
    hashFile: (rel) => hashFile(workspace, rel),
    readCount,
  });

  let judge;
  if (opts.judge && !opts.mock && task.judgeRubric) {
    const key = anthropicKeyFromAgentDir(opts.agentDir);
    if (key) {
      judge = await judgeTask(task, turns, key).catch(() => undefined);
    }
  }

  const totals = recorder.calls.reduce(
    (acc, c) => {
      acc.llmCalls++;
      acc.input += c.usage?.input ?? 0;
      acc.output += c.usage?.output ?? 0;
      acc.cacheRead += c.usage?.cacheRead ?? 0;
      acc.cacheWrite += c.usage?.cacheWrite ?? 0;
      acc.costUSD += c.costUSD ?? 0;
      return acc;
    },
    {
      llmCalls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUSD: 0,
      wallMs: Date.now() - t0,
    },
  );

  const result: TaskResult = {
    taskId: task.id,
    model: opts.mock ? mockModel.id : (recorder.calls.find((c) => c.model)?.model ?? "unknown"),
    mock: opts.mock,
    arch: opts.arch,
    ...(curator ? { curatorStats: curator.stats() } : {}),
    workspace,
    sessionFile,
    turns,
    calls: recorder.calls,
    checks,
    judge,
    totals,
    ...(abortedReason ? { aborted: abortedReason } : {}),
  };
  writeFileSync(join(taskDir, "results.json"), JSON.stringify(result, null, 2));
  return result;
}
