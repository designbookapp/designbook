/**
 * Shared types for the context-architecture baseline eval.
 *
 * A Task is a scripted multi-turn session against a copy of the
 * `examples/demo` fixture. Checks are scriptable assertions; the optional
 * judge rubric covers fuzzier quality (redid-work, contradicted-decision).
 */

export type Check =
  | {
      type: "file_contains";
      file: string;
      /** JS regex source, tested against the file text. */
      pattern: string;
      flags?: string;
    }
  | { type: "file_not_contains"; file: string; pattern: string; flags?: string }
  | { type: "file_unchanged"; file: string }
  | {
      /**
       * Forgetting metric: the agent should not need to re-read a file it
       * already read. Counts `read` tool calls whose arguments mention
       * `file` across the WHOLE session.
       */
      type: "max_reads";
      file: string;
      max: number;
    }
  | {
      /** Final assistant text of turn index (0-based) must match. */
      type: "final_response_matches";
      turn: number;
      pattern: string;
      flags?: string;
    };

export type Task = {
  id: string;
  description: string;
  /** Scripted user turns, sent via session.prompt() in order. */
  turns: { user: string; note?: string }[];
  checks: Check[];
  /** Short LLM-judge rubric for fuzzy quality checks. */
  judgeRubric?: string;
};

export type CallRecord = {
  call: number;
  /** 0-based scripted user-turn index this LLM call belongs to. */
  turn: number;
  tStart: number;
  latencyMs?: number;
  httpStatus?: number;
  /** Shape of the raw provider request payload. */
  contextMessages?: number;
  contextBytes?: number;
  systemBytes?: number;
  toolCount?: number;
  /** From the assistant message that this call produced. */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  costUSD?: number;
  stopReason?: string;
  model?: string;
  errorMessage?: string;
};

export type TurnResult = {
  turn: number;
  user: string;
  finalText: string;
  wallMs: number;
  llmCalls: number;
  errorMessage?: string;
};

export type CheckResult = {
  check: Check;
  pass: boolean;
  detail?: string;
};

export type JudgeResult = {
  redid_work: boolean;
  contradicted_earlier_decision: boolean;
  /** Scope creep: real edits no user turn asked for. Optional — added after the first baseline run. */
  unrequested_edits?: boolean;
  notes: string;
  raw?: string;
};

export type Arch = "replay" | "curated";

export type TaskResult = {
  taskId: string;
  model: string;
  mock: boolean;
  /** Context architecture used ("replay" full-history baseline when absent). */
  arch?: Arch;
  /** Curated-mode assembler introspection (absent for replay). */
  curatorStats?: {
    keepLogEntries: number;
    keepLogChars: number;
    stateDocChars: number;
    stateUpdateCalls: number;
    recallCalls: number;
  };
  workspace: string;
  sessionFile?: string;
  turns: TurnResult[];
  calls: CallRecord[];
  checks: CheckResult[];
  judge?: JudgeResult;
  totals: {
    llmCalls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUSD: number;
    wallMs: number;
  };
  aborted?: string;
};
