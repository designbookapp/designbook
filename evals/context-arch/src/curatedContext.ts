/**
 * Experimental "curated context" assembler (the --arch=curated mode).
 *
 * Replaces full-history replay with a compiled context, rebuilt for every
 * LLM call via pi's extension "context" event (wired to `transformContext`
 * inside `createAgentSession` — the same seam designbook's /api chat uses,
 * so this module can later sit behind production unchanged):
 *
 *   [system (+addendum)] [keep-log] [last 3 turns RAW] [state doc]
 *
 * - keep-log: append-only user-role message. All user prompts so far
 *   verbatim, plus "kept" artifacts (file reads) promoted from turns that
 *   aged out of the recent window, each with a one-line why-annotation.
 *   Corrections (e.g. "this kept read is now stale") are APPENDED, never
 *   edited in place — the byte-stable prefix is what makes provider prompt
 *   caching work. One text block per entry so cache-prefix matching works
 *   at block granularity.
 * - recent window: the last RECENT_TURNS user turns fully intact —
 *   toolCall/toolResult pairs and thinking blocks untouched (protocol-safe;
 *   a window always starts at a user message, so no orphaned tool results).
 * - state doc: mutable, ALWAYS the final message (user role). XML-wrapped
 *   markdown sections with per-section char limits. Maintained by the model
 *   itself via the `state_update` custom tool.
 * - `recall` custom tool: grep-style search over the session's full JSONL
 *   transcript, so dropped details stay retrievable on demand.
 *
 * Cache breakpoints (before_provider_request, raw Anthropic payload):
 * pi puts its single conversation breakpoint on the last user message —
 * which here is the mutable state doc, so the conversation prefix would
 * never cache-hit. This module strips message-level cache_control and sets
 * two of its own: (1) on the last keep-log block (survives window slides),
 * (2) on the newest REAL conversation message before the state doc
 * (within-turn incremental hits). With pi's system+tools breakpoints that
 * is exactly Anthropic's 4-breakpoint budget.
 */

import { readFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ------------------------------------------------------------ local shapes
// (AgentMessage lives in the transitive @earendil-works/pi-agent-core dep;
// structural types keep this package's dependency list unchanged.)

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [k: string]: unknown;
};

type Msg = {
  role: string;
  content?: string | Block[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  [k: string]: unknown;
};

export const KEEPLOG_HEADER = "=== SESSION KEEP-LOG (append-only) ===";
export const STATEDOC_OPEN = "<state_doc>";

const RECENT_TURNS = 3;
const KEEP_READ_MAX_CHARS = 6000;
const SECTION_CHAR_LIMIT = 5000;
const RECALL_MAX_MATCHES = 20;
const RECALL_MAX_CHARS = 6000;

const KNOWN_SECTIONS = ["current_task", "files_known", "decisions", "plan", "next_step"];

export const CURATED_SYSTEM_ADDENDUM = `
## Session memory architecture (IMPORTANT)

This session does NOT replay full history to you. Each request you see:
1. A KEEP-LOG (append-only): every user prompt so far verbatim, plus file
   reads promoted from older turns, each with a why-annotation. Later
   correction notes override earlier entries.
2. The last ${RECENT_TURNS} turns RAW (everything older is dropped).
3. A STATE DOC as the final message — your own mutable working memory.

Because old turns are dropped, you MUST maintain the state doc with the
\`state_update\` tool or you will forget things:
- Record standing constraints and decisions in \`decisions\` the moment they
  are stated, and UPDATE the entry when a decision is amended (include the
  reason). Never rely on old turns for these.
- Record every file you modify in \`files_known\` (one line: path — what
  changed, plus key values like exact strings/classes you wrote and any
  original values you replaced).
- Keep \`current_task\`, \`plan\`, and \`next_step\` current. You may add new
  sections when useful.
- Update the state doc in the SAME assistant turn as the work (e.g. right
  after an edit), not later. Keep entries terse — sections have char limits.

If you need a dropped detail that is not in the keep-log or state doc, use
the \`recall\` tool (regex search over the full session transcript) instead
of guessing or re-reading files you already read.`.trim();

// ------------------------------------------------------------------ helpers

function blocksOf(m: Msg): Block[] {
  if (typeof m.content === "string") return [{ type: "text", text: m.content }];
  return Array.isArray(m.content) ? m.content : [];
}

function textOf(m: Msg): string {
  return blocksOf(m)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Split raw session history into user turns (turn = user msg + follow-ons). */
function segmentTurns(messages: Msg[]): { preamble: Msg[]; turns: Msg[][] } {
  const preamble: Msg[] = [];
  const turns: Msg[][] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push([m]);
    else if (turns.length === 0) preamble.push(m);
    else turns[turns.length - 1].push(m);
  }
  return { preamble, turns };
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} chars truncated — use recall or re-read if the elided part matters]…\n${s.slice(s.length - tail)}`;
}

type ToolUse = { name: string; path?: string };

/** toolCallId → {name, path} across a message list. */
function indexToolCalls(msgs: Msg[]): Map<string, ToolUse> {
  const map = new Map<string, ToolUse>();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    for (const b of blocksOf(m)) {
      if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
        const args = (b.arguments ?? {}) as Record<string, unknown>;
        const path =
          typeof args.path === "string"
            ? args.path
            : typeof args.file_path === "string"
              ? (args.file_path as string)
              : undefined;
        map.set(b.id, { name: b.name, path });
      }
    }
  }
  return map;
}

export type CuratorOptions = {
  /** Session JSONL transcript path, resolved lazily (set after session create). */
  getSessionFile: () => string | undefined;
  recentTurns?: number;
  log?: (line: string) => void;
};

export type Curator = {
  /** Inline extension factory (pass BEFORE the recorder so recorded payloads include the cache-breakpoint edits). */
  extension: (pi: ExtensionAPI) => void;
  /** Introspection for logging/sanity checks. */
  stats: () => {
    keepLogEntries: number;
    keepLogChars: number;
    stateDocChars: number;
    stateUpdateCalls: number;
    recallCalls: number;
  };
};

// ------------------------------------------------------------------ curator

export function createCurator(opts: CuratorOptions): Curator {
  const recentTurns = opts.recentTurns ?? RECENT_TURNS;

  // ---- append-only keep-log (entry 0 = header) -------------------------
  const keepLog: string[] = [
    `${KEEPLOG_HEADER}\nOlder turns are dropped from this context. This log preserves: every user prompt verbatim, and file reads promoted from aged-out turns (each with a why-annotation). Later NOTE entries correct earlier ones. Your own working memory lives in the state doc (final message).`,
  ];
  let promptCount = 0; // user prompts already appended
  let triagedCount = 0; // turns already triaged (aged out)
  // path → keep-log entry index of the most recent kept read
  const keptReads = new Map<string, { turn: number }>();
  const staleNoted = new Set<string>(); // `${path}@@${turn}`

  // ---- state doc --------------------------------------------------------
  const sections = new Map<string, string>();
  const sectionOrder: string[] = [...KNOWN_SECTIONS];
  for (const s of KNOWN_SECTIONS) sections.set(s, "");
  let stateUpdateCalls = 0;
  let recallCalls = 0;

  function renderStateDoc(): string {
    const parts: string[] = [STATEDOC_OPEN];
    parts.push(
      `This state doc is YOUR mutable working memory (maintained via the state_update tool; it is always the final message and survives turn dropping — see system prompt).`,
    );
    for (const name of sectionOrder) {
      if (!sections.has(name)) continue;
      const content = sections.get(name) ?? "";
      parts.push(
        `<section name="${name}" chars="${content.length}" limit="${SECTION_CHAR_LIMIT}">\n${content || "(empty)"}\n</section>`,
      );
    }
    parts.push("</state_doc>");
    return parts.join("\n");
  }

  // ---- triage of aged-out turns -----------------------------------------
  /**
   * Called once per turn index when it leaves the recent window. Promotes
   * still-relevant file reads into the keep-log; appends staleness notes
   * for edits to files whose reads were kept earlier; drops the rest
   * (assistant text/thinking, tool diffs — recoverable via `recall`).
   */
  function triageTurn(turnIdx: number, allTurns: Msg[][]): void {
    const turn = allTurns[turnIdx];
    const allMsgs = allTurns.flat();
    const calls = indexToolCalls(allMsgs);

    // Chronology helpers over the whole known history.
    const flatEvents: { turn: number; use: ToolUse; order: number }[] = [];
    let order = 0;
    allTurns.forEach((t, ti) => {
      for (const m of t) {
        if (m.role !== "assistant") continue;
        for (const b of blocksOf(m)) {
          if (b.type === "toolCall" && typeof b.id === "string") {
            const use = calls.get(b.id);
            if (use) flatEvents.push({ turn: ti, use, order: order++ });
          }
        }
      }
    });

    for (const m of turn) {
      if (m.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
      const use = calls.get(m.toolCallId);
      if (!use) continue;

      if (use.name === "read" && use.path && m.isError !== true) {
        const path = use.path;
        const thisRead = flatEvents.find(
          (e) => e.turn === turnIdx && e.use.name === "read" && e.use.path === path,
        );
        const laterRead = flatEvents.some(
          (e) => e.use.name === "read" && e.use.path === path && e.order > (thisRead?.order ?? -1),
        );
        const laterWrite = flatEvents.some(
          (e) =>
            (e.use.name === "edit" || e.use.name === "write") &&
            e.use.path === path &&
            e.order > (thisRead?.order ?? -1),
        );
        if (laterRead) continue; // a newer read will be (or was) kept instead
        const supersedes = keptReads.get(path);
        keptReads.set(path, { turn: turnIdx });
        const why = laterWrite
          ? `latest read of this file when the turn aged out; the file WAS modified after this read (see files_known / NOTE entries) — content below is the pre-edit state`
          : `latest read of this file when the turn aged out; not modified since — reuse instead of re-reading`;
        keepLog.push(
          `[turn ${turnIdx + 1}] KEPT read: ${path}${supersedes ? ` (supersedes the turn-${supersedes.turn + 1} kept read)` : ""}\nwhy: ${why}\n${truncateMiddle(textOf(m), KEEP_READ_MAX_CHARS)}`,
        );
      }

      if ((use.name === "edit" || use.name === "write") && use.path && m.isError !== true) {
        const path = use.path;
        const kept = keptReads.get(path);
        const key = `${path}@@${turnIdx}`;
        if (kept && kept.turn < turnIdx && !staleNoted.has(key)) {
          staleNoted.add(key);
          keepLog.push(
            `[turn ${turnIdx + 1}] NOTE: ${path} was modified in turn ${turnIdx + 1} (${use.name}); the kept read above is now stale for the changed region.`,
          );
        }
      }
    }
  }

  // ---- per-call assembly --------------------------------------------------
  function assemble(raw: Msg[]): Msg[] {
    const { preamble, turns } = segmentTurns(raw);
    if (turns.length === 0) return raw; // nothing to curate yet

    // 1) age-out triage (append-only, runs once per aged turn)
    const agedCount = Math.max(0, turns.length - recentTurns);
    for (; triagedCount < agedCount; triagedCount++) {
      triageTurn(triagedCount, turns);
    }
    // 2) new user prompts → keep-log, verbatim
    for (; promptCount < turns.length; promptCount++) {
      keepLog.push(`[turn ${promptCount + 1}] USER:\n${textOf(turns[promptCount][0])}`);
    }

    const now = Date.now();
    const keepLogMsg: Msg = {
      role: "user",
      content: keepLog.map((text) => ({ type: "text", text })),
      timestamp: now,
    };
    const stateDocMsg: Msg = {
      role: "user",
      content: [{ type: "text", text: renderStateDoc() }],
      timestamp: now,
    };
    const recent = turns.slice(agedCount).flat();
    return [keepLogMsg, ...preamble, ...recent, stateDocMsg];
  }

  // ---- extension ---------------------------------------------------------
  const extension = (pi: ExtensionAPI) => {
    // System-prompt addendum: same constant text every turn (cache-stable).
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${CURATED_SYSTEM_ADDENDUM}`,
    }));

    // The compiled context, rebuilt before every LLM call.
    pi.on("context", (event) => ({
      messages: assemble(event.messages as unknown as Msg[]) as unknown as typeof event.messages,
    }));

    // Cache breakpoints on the raw provider payload (see module docs).
    pi.on("before_provider_request", (event) => {
      const payload = event.payload as {
        messages?: { role: string; content: string | Record<string, unknown>[] }[];
      };
      const msgs = payload?.messages;
      if (!Array.isArray(msgs) || msgs.length < 2) return;
      const first = msgs[0];
      const firstText =
        Array.isArray(first.content) && typeof first.content[0]?.text === "string"
          ? (first.content[0].text as string)
          : "";
      if (!firstText.startsWith(KEEPLOG_HEADER)) return; // not curated-shaped
      // Strip every message-level breakpoint pi set (notably the one on the
      // mutable state doc — it would burn the 4-breakpoint budget for zero hits).
      for (const m of msgs) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content) delete (b as Record<string, unknown>).cache_control;
      }
      const mark = (m: { content: string | Record<string, unknown>[] }) => {
        if (!Array.isArray(m.content)) return;
        for (let i = m.content.length - 1; i >= 0; i--) {
          const t = m.content[i].type;
          if (t === "thinking" || t === "redacted_thinking") continue; // not cacheable
          m.content[i].cache_control = { type: "ephemeral" };
          return;
        }
      };
      mark(first); // end of keep-log: survives recent-window slides
      if (msgs.length >= 3) mark(msgs[msgs.length - 2]); // newest real message: within-turn incremental hits
      return payload;
    });

    // ---- state_update tool ----------------------------------------------
    pi.registerTool({
      name: "state_update",
      label: "State update",
      description:
        "Maintain your state doc (the final context message). op=set replaces a section, op=append adds to it, op=delete removes it. Known sections: current_task, files_known, decisions, plan, next_step — you may create new ones. Keep entries terse; each section is limited to " +
        `${SECTION_CHAR_LIMIT} chars.`,
      promptSnippet:
        "state_update: maintain your mutable state doc (decisions, plan, files touched) — old turns are dropped, the state doc is what persists",
      parameters: Type.Object({
        op: Type.Union([Type.Literal("set"), Type.Literal("append"), Type.Literal("delete")], {
          description: "set = replace section content, append = add to it, delete = remove the section",
        }),
        section: Type.String({
          description: "Section name (e.g. current_task, files_known, decisions, plan, next_step, or a new name)",
        }),
        content: Type.Optional(Type.String({ description: "Markdown content (required for set/append)" })),
      }),
      async execute(_id, params) {
        stateUpdateCalls++;
        const section = params.section.trim();
        if (!section) throw new Error("section name required");
        if (params.op === "delete") {
          sections.delete(section);
          return { content: [{ type: "text", text: `ok: section "${section}" deleted` }], details: undefined };
        }
        const add = params.content ?? "";
        if (!add) throw new Error(`content required for op=${params.op}`);
        let next = params.op === "append" && sections.has(section) && sections.get(section)
          ? `${sections.get(section)}\n${add}`
          : add;
        let note = "";
        if (next.length > SECTION_CHAR_LIMIT) {
          next = next.slice(next.length - SECTION_CHAR_LIMIT); // keep the newest content
          note = ` (over ${SECTION_CHAR_LIMIT}-char limit — oldest content truncated; keep it terser)`;
        }
        if (!sections.has(section)) sectionOrder.push(section);
        sections.set(section, next);
        return {
          content: [{ type: "text", text: `ok: ${section} = ${next.length} chars${note}` }],
          details: undefined,
        };
      },
    });

    // ---- recall tool ------------------------------------------------------
    pi.registerTool({
      name: "recall",
      label: "Recall",
      description:
        "Search the FULL session transcript (including turns dropped from this context) with a case-insensitive regex. Returns matching lines tagged [turn N][role]. Use this to retrieve dropped details (earlier file contents, exact user wording, old tool output) instead of guessing or re-reading files.",
      promptSnippet:
        "recall: regex-search the full session transcript for details from dropped turns",
      parameters: Type.Object({
        pattern: Type.String({ description: "JS regex, matched case-insensitively per line" }),
        max_matches: Type.Optional(Type.Number({ description: `max matching lines to return (default ${RECALL_MAX_MATCHES})` })),
      }),
      async execute(_id, params) {
        recallCalls++;
        const file = opts.getSessionFile();
        if (!file || !existsSync(file)) throw new Error("session transcript not available");
        let re: RegExp;
        try {
          re = new RegExp(params.pattern, "i");
        } catch (e) {
          throw new Error(`invalid regex: ${(e as Error).message}`);
        }
        const maxMatches = Math.max(1, Math.min(100, params.max_matches ?? RECALL_MAX_MATCHES));
        const lines: string[] = [];
        let turn = 0;
        for (const raw of readFileSync(file, "utf8").split("\n")) {
          if (!raw.trim()) continue;
          let entry: { type?: string; message?: Msg };
          try {
            entry = JSON.parse(raw);
          } catch {
            continue;
          }
          if (entry.type !== "message" || !entry.message) continue;
          const m = entry.message;
          if (m.role === "user") turn++;
          const tag = (kind: string) => `[turn ${turn}][${kind}]`;
          if (m.role === "user" || m.role === "assistant") {
            for (const b of blocksOf(m)) {
              if (b.type === "text" && b.text) {
                for (const l of b.text.split("\n")) lines.push(`${tag(m.role)} ${l}`);
              } else if (b.type === "toolCall") {
                lines.push(`${tag(`toolCall ${b.name}`)} ${JSON.stringify(b.arguments ?? {})}`);
              }
            }
          } else if (m.role === "toolResult") {
            for (const l of textOf(m).split("\n")) {
              lines.push(`${tag(`toolResult ${m.toolName ?? "?"}`)} ${l}`);
            }
          }
        }
        const matches: string[] = [];
        let chars = 0;
        for (const l of lines) {
          if (!re.test(l)) continue;
          matches.push(l);
          chars += l.length;
          if (matches.length >= maxMatches || chars > RECALL_MAX_CHARS) break;
        }
        const text = matches.length
          ? `${matches.length} match(es):\n${matches.join("\n")}`
          : `no matches for /${params.pattern}/i in the session transcript`;
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
  };

  return {
    extension,
    stats: () => ({
      keepLogEntries: keepLog.length - 1,
      keepLogChars: keepLog.reduce((a, s) => a + s.length, 0),
      stateDocChars: renderStateDoc().length,
      stateUpdateCalls,
      recallCalls,
    }),
  };
}
