/**
 * Chat-history threads for the UX v3 drawer (docs/specs/sandbox.md §UX v3,
 * U2): prior Pi sessions for the active cwd — the SessionManager JSONL
 * transcripts under `~/.pi/agent/sessions/<encoded-cwd>--/` — listed as
 * threads next to the sandbox pin threads, and opened READ-ONLY as rendered
 * transcripts (the client reuses its `messagesToThreadItems` fold).
 *
 * Ephemeral machine turns are kept OUT of the list two ways:
 *   1. Going forward, sandbox turns persist into a `designbook-ephemeral/`
 *      SUBDIR of the default store (SessionManager.list is non-recursive, so
 *      they are invisible here) — see runSandboxTurn in api.ts.
 *   2. Legacy files (and variation turns, which still share the default
 *      store) are filtered by their machine-generated FIRST MESSAGE prefixes
 *      (`isEphemeralTranscript`). A user message that happens to start with
 *      one of these openers would be hidden — acceptably unlikely.
 *
 * RESUME is NOT wired (deliberate): making an arbitrary transcript the active
 * session means swapping the per-branch session registry's live session —
 * invasive surgery the threads feature doesn't justify yet. The drawer shows
 * a disabled "Resume" affordance instead.
 */

import { resolve, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Subdir (inside the default session store) where designbook's ephemeral
 * sandbox turns persist — invisible to the non-recursive session listing. */
const EPHEMERAL_SESSION_SUBDIR = "designbook-ephemeral";

/** Machine-generated first-message openers (sandbox + variations turn
 * prompts, in-repo builders) — legacy ephemeral transcripts to hide. */
const EPHEMERAL_PROMPT_PREFIXES = [
  // variations.ts
  "Propose ",
  "Create ONE design variation",
  "Revise the design-variation file",
  // sandbox.ts — component + element pipelines
  "You are the design DIRECTOR",
  "Create ONE design variant",
  "Designer request on the live component",
  "The designer selected the live",
  "Revise the sandbox design variant",
  "Adopt a sandbox",
  "The sandbox design variant",
  "The rewrite you just applied",
  // sandbox.ts — UX v3 cheap turns
  "A designer selected the live",
  "Title this design request",
];

/** True when a transcript's first message reads as one of our machine turns. */
function isEphemeralTranscript(firstMessage: string): boolean {
  const head = firstMessage.trimStart();
  return EPHEMERAL_PROMPT_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/** The exact context-block frame `buildPromptWithCanvasContext` composes. */
const CONTEXT_BLOCK_HEADER = "Selected canvas node context:";
const CONTEXT_BLOCK_REQUEST = "\nUser request:\n";

/**
 * Thread title from a session's first user message: the real request with
 * any "Selected canvas node context:" block stripped, first line, capped.
 */
function chatThreadTitle(firstMessage: string, cap = 64): string {
  let text = firstMessage.trim();
  // Conversation-routed asks: `[Selection: …] (pin …)` frames title by the
  // trailing "User request:" section (the chip carries the scope).
  if (text.startsWith(CONTEXT_BLOCK_HEADER) || text.startsWith("[Selection: ")) {
    const request = text.lastIndexOf(CONTEXT_BLOCK_REQUEST);
    if (request !== -1) {
      text = text.slice(request + CONTEXT_BLOCK_REQUEST.length).trim();
    }
  }
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!line) return "Conversation";
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

type ChatThreadRow = {
  /** Absolute transcript path — the open/read key. */
  path: string;
  id: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  /** True for the live session (the drawer routes it to the live chat). */
  current: boolean;
  /** L3: the conversation this session was (sidecar map join) — history
   * rows group their changesets/pins by it. Absent = pre-L3 transcript. */
  conversationId?: string;
};

/**
 * List the cwd's chat sessions as thread rows, newest activity first.
 * `currentSessionFile` (the live session's transcript, when persisted) tags
 * its row `current`.
 */
async function listChatThreads(params: {
  cwd: string;
  currentSessionFile?: string;
  /** Test seam: a non-default session dir. */
  sessionDir?: string;
  /** L3: session id → conversationId (the conversations.ts sidecar map). */
  conversationTags?: Record<string, string>;
}): Promise<ChatThreadRow[]> {
  const sessions = await SessionManager.list(params.cwd, params.sessionDir);
  const current = params.currentSessionFile
    ? resolve(params.currentSessionFile)
    : undefined;
  const tags = params.conversationTags ?? {};
  return sessions
    .filter(
      (session) =>
        session.messageCount > 0 && !isEphemeralTranscript(session.firstMessage),
    )
    .map((session) => ({
      path: session.path,
      id: session.id,
      title: chatThreadTitle(session.firstMessage),
      createdAt: session.created.getTime(),
      lastActivityAt: session.modified.getTime(),
      messageCount: session.messageCount,
      current: current !== undefined && resolve(session.path) === current,
      ...(tags[session.id] ? { conversationId: tags[session.id] } : {}),
    }));
}

/**
 * Read one transcript READ-ONLY for rendering: the compaction-aware message
 * list (the same shape the live chat's `state` event carries). The path must
 * live inside the cwd's session store (list is the only place paths come
 * from, but the route is client-reachable — contain it).
 */
function readChatTranscript(params: {
  cwd: string;
  path: string;
  sessionDir?: string;
}): { messages?: unknown[]; error?: string } {
  const storeDir = resolve(
    params.sessionDir ?? SessionManager.create(params.cwd).getSessionDir(),
  );
  const target = resolve(params.path);
  if (
    !target.startsWith(`${storeDir}${sep}`) ||
    !target.endsWith(".jsonl") ||
    target.includes(`${sep}${EPHEMERAL_SESSION_SUBDIR}${sep}`)
  ) {
    return { error: "Not a session transcript of this project." };
  }
  try {
    const manager = SessionManager.open(target);
    return { messages: manager.buildSessionContext().messages as unknown[] };
  } catch (error) {
    return {
      error: `Could not read the transcript: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export {
  EPHEMERAL_SESSION_SUBDIR,
  chatThreadTitle,
  isEphemeralTranscript,
  listChatThreads,
  readChatTranscript,
};
export type { ChatThreadRow };
