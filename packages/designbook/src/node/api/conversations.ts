/**
 * Conversation identity (docs/specs/changeset-layers.md, L3 §Sessions &
 * conversations).
 *
 * A CONVERSATION is one real Pi session on a branch: "New conversation"
 * actually resets the per-branch session (api.ts resetSession), and the
 * retired session becomes a history row exactly as before. Each conversation
 * gets a durable `conversationId`, minted when its session is created and
 * persisted NEXT TO the session transcripts (one sidecar JSON map per session
 * store, keyed by Pi session id) so history rows keep their conversation
 * linkage across restarts. Ephemeral sub-turn sessions (director / variant /
 * edit / intent / title) are TAGGED into the same map with their PARENT
 * conversation's id.
 *
 * Pure of the Pi SDK — callers pass the session-store dir; everything here is
 * plain fs + string discipline (ids must satisfy the changeset-id segment
 * rules, because a conversation's direct-edits changeset embeds the id).
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Sidecar file inside a session store dir. Two shapes are read:
 *
 *   - legacy (L3): a flat map { <piSessionId>: <conversationId> }
 *   - G1:          { sessions: { <piSessionId>: <conversationId> },
 *                    turns: [ TurnRangeRecord, … ] }
 *
 * `turns` is the git linkage (changesets-on-git.md §Commits & linkage):
 * one record per agent turn that produced commits — message→commits and
 * commit→message resolvable offline. Best-effort bookkeeping — a
 * missing/corrupt file only costs history-row grouping and per-turn diffs,
 * never a feature. Writes always emit the G1 shape. */
const CONVERSATION_MAP_FILENAME = "designbook-conversations.json";

/** Upper bound on retained turn records (oldest dropped first). */
const MAX_TURN_RECORDS = 2000;

/** One turn's commit range on a changeset branch. */
type TurnRangeRecord = {
  /** `<piSessionId>/<turnIndex>` — matches the Designbook-Turn trailer. */
  turn: string;
  conversationId?: string;
  changesetId: string;
  /** The hidden ref the turn committed on. */
  ref: string;
  /** Branch tip before the turn (rollback's "restore to before here"). */
  from: string;
  /** Branch tip after the turn (the final commit carries the trailers). */
  to: string;
  at: number;
  /** G4: the Pi session entry id at this turn's END — the exact transcript
   * boundary a park-fork slices the chat at. Absent on pre-G4 records
   * (fork falls back to counting user prompts). */
  leaf?: string;
  /** Round 2: a generated 4-8 word description of what changed this turn
   * (cheap title-mode turn over the diff summary; lazily backfilled for
   * older records). Absent while unlabeled — UI falls back to the prompt
   * line, then commit subjects. */
  label?: string;
  /** First line of the user prompt that drove the turn (label fallback),
   * capped at record time. Absent on pin turns / pre-round-2 records. */
  prompt?: string;
};

/** G4 — one implicit park-fork's conversation linkage: the NEW conversation
 * (a sliced transcript) bound to the PARENT changeset's fork ref. Thread
 * lists nest the fork under its parent through this record. */
type ConversationForkRecord = {
  conversationId: string;
  parentConversationId: string;
  changesetId: string;
  /** The fork's hidden ref (refs/designbook/changesets/<id>/v/<altId>). */
  ref: string;
  /** The parent turn (`<sessionId>/<n>`) the fork was cut at, if known. */
  atTurn?: string;
  at: number;
};

/** The changeset id prefix of a conversation's DIRECT-EDITS layer. */
const DIRECT_CHANGESET_PREFIX = "direct-";

/** The alternative id a direct-edits changeset stores CODE overrides under
 * (one working alternative per file; data files use the layer DATA alt). */
const DIRECT_ALT_ID = "direct";

/** Mint a conversation id: lowercase alnum + dashes only (it embeds into the
 * conversation's direct-edits changeset id, which must satisfy the layer
 * id-segment rules). */
function makeConversationId(now: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `c${now.toString(36)}-${rand}`;
}

/** The one direct-edits changeset id of a conversation. */
function directChangesetId(conversationId: string): string {
  return `${DIRECT_CHANGESET_PREFIX}${conversationId}`;
}

/** Is this changeset a conversation's direct-edits layer? */
function isDirectChangesetId(changesetId: string): boolean {
  return changesetId.startsWith(DIRECT_CHANGESET_PREFIX);
}

function conversationMapFile(sessionDir: string): string {
  return join(sessionDir, CONVERSATION_MAP_FILENAME);
}

type ConversationStore = {
  sessions: Record<string, string>;
  turns: TurnRangeRecord[];
  forks: ConversationForkRecord[];
};

/** Parse one raw sidecar body into the G1 store shape (both shapes read). */
function parseConversationStore(raw: string): ConversationStore {
  const empty: ConversationStore = { sessions: {}, turns: [], forks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return empty;
  }
  const record = parsed as {
    sessions?: unknown;
    turns?: unknown;
    forks?: unknown;
    [key: string]: unknown;
  };
  const sessions: Record<string, string> = {};
  const sessionSource =
    record.sessions && typeof record.sessions === "object"
      ? (record.sessions as Record<string, unknown>)
      : record; // Legacy flat map.
  for (const [key, value] of Object.entries(sessionSource)) {
    if (key === "sessions" || key === "turns" || key === "forks") continue;
    if (typeof value === "string" && value) sessions[key] = value;
  }
  const turns: TurnRangeRecord[] = Array.isArray(record.turns)
    ? record.turns.filter(
        (entry): entry is TurnRangeRecord =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as TurnRangeRecord).turn === "string" &&
          typeof (entry as TurnRangeRecord).changesetId === "string" &&
          typeof (entry as TurnRangeRecord).ref === "string" &&
          typeof (entry as TurnRangeRecord).from === "string" &&
          typeof (entry as TurnRangeRecord).to === "string",
      )
    : [];
  const forks: ConversationForkRecord[] = Array.isArray(record.forks)
    ? record.forks.filter(
        (entry): entry is ConversationForkRecord =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as ConversationForkRecord).conversationId === "string" &&
          typeof (entry as ConversationForkRecord).parentConversationId ===
            "string" &&
          typeof (entry as ConversationForkRecord).changesetId === "string" &&
          typeof (entry as ConversationForkRecord).ref === "string",
      )
    : [];
  return { sessions, turns, forks };
}

/** Read the whole sidecar store (missing/corrupt → empty). */
async function readConversationStore(
  sessionDir: string,
): Promise<ConversationStore> {
  try {
    return parseConversationStore(
      await readFile(conversationMapFile(sessionDir), "utf8"),
    );
  } catch {
    return { sessions: {}, turns: [], forks: [] };
  }
}

/** Read the session-id → conversationId map (missing/corrupt → empty). */
async function readConversationMap(
  sessionDir: string,
): Promise<Record<string, string>> {
  return (await readConversationStore(sessionDir)).sessions;
}

/** Map-file writes serialize per store dir (parallel session creates). */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Record one session's conversation tag (merge + rewrite, queued per store
 * dir, best-effort — a failed write is logged by the CALLER's log seam only
 * through the returned promise, never thrown).
 */
/** Serialize + write the G1 store shape (queued per store dir). */
function queueStoreWrite(
  sessionDir: string,
  mutate: (store: ConversationStore) => boolean,
): Promise<void> {
  const queued = (writeQueues.get(sessionDir) ?? Promise.resolve()).then(
    async () => {
      const store = await readConversationStore(sessionDir);
      if (!mutate(store)) return;
      if (store.turns.length > MAX_TURN_RECORDS) {
        store.turns = store.turns.slice(-MAX_TURN_RECORDS);
      }
      const file = conversationMapFile(sessionDir);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    },
  );
  writeQueues.set(
    sessionDir,
    queued.catch(() => {}),
  );
  return queued;
}

function recordConversationTag(params: {
  sessionDir: string;
  sessionId: string;
  conversationId: string;
}): Promise<void> {
  const { sessionDir, sessionId, conversationId } = params;
  if (!sessionId || !conversationId) return Promise.resolve();
  return queueStoreWrite(sessionDir, (store) => {
    if (store.sessions[sessionId] === conversationId) return false;
    store.sessions[sessionId] = conversationId;
    return true;
  });
}

/** Record one turn's commit range (G1 sidecar linkage). */
function recordTurnRange(params: {
  sessionDir: string;
  record: TurnRangeRecord;
}): Promise<void> {
  const { sessionDir, record } = params;
  if (!record.turn || !record.changesetId) return Promise.resolve();
  return queueStoreWrite(sessionDir, (store) => {
    store.turns.push(record);
    return true;
  });
}

/** Stamp a generated label onto one turn record (round-2 turn labels).
 * Matched by turn id + changesetId (the same key the diff/park lookups
 * use); no-op when the record is gone (capped store) or already carries
 * the same label. */
function updateTurnLabel(params: {
  sessionDir: string;
  turn: string;
  changesetId: string;
  label: string;
}): Promise<void> {
  const { sessionDir, turn, changesetId, label } = params;
  if (!turn || !changesetId || !label) return Promise.resolve();
  return queueStoreWrite(sessionDir, (store) => {
    const record = [...store.turns]
      .reverse()
      .find(
        (candidate) =>
          candidate.turn === turn && candidate.changesetId === changesetId,
      );
    if (!record || record.label === label) return false;
    record.label = label;
    return true;
  });
}

/** Record one park-fork's conversation linkage (G4 — thread nesting +
 * fork→parent resolution survive restarts). */
function recordConversationFork(params: {
  sessionDir: string;
  record: ConversationForkRecord;
}): Promise<void> {
  const { sessionDir, record } = params;
  if (!record.conversationId || !record.parentConversationId) {
    return Promise.resolve();
  }
  return queueStoreWrite(sessionDir, (store) => {
    if (
      store.forks.some(
        (fork) => fork.conversationId === record.conversationId,
      )
    ) {
      return false;
    }
    store.forks.push(record);
    return true;
  });
}

export {
  CONVERSATION_MAP_FILENAME,
  DIRECT_ALT_ID,
  conversationMapFile,
  directChangesetId,
  isDirectChangesetId,
  makeConversationId,
  parseConversationStore,
  readConversationMap,
  readConversationStore,
  recordConversationFork,
  recordConversationTag,
  recordTurnRange,
  updateTurnLabel,
};
export type { ConversationForkRecord, ConversationStore, TurnRangeRecord };
