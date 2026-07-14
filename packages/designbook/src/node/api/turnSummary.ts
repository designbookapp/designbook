/**
 * Agent-supplied turn summaries + branch titles (Michael, replaces the
 * round-2 async title-mode label turn — that mechanism booted a separate
 * session per label, was slow, and labels visibly lagged):
 *
 * The WORKING turn supplies its own label. Every write-class turn prompt
 * (conversation, changeset edit, variant, iterate) ends with an instruction
 * to close the reply with a single line
 *
 *     Summary: <brief description of what changed>
 *
 * and, OPTIONALLY (only when the turn sees a better name for the branch it
 * worked on),
 *
 *     Title: <better branch name>
 *
 * Both are METADATA: parsed at turn end (label on the sidecar turn record +
 * the catch-all commit's subject; title renames the ref's display title
 * unless the user renamed it) and STRIPPED from the visible reply.
 */

/** Appended to write-class turn prompts (git turns + conversation turns). */
const SUMMARY_PROMPT_INSTRUCTION = [
  "End your reply with a single line `Summary: <brief description of what changed>` (omit it if you changed no files).",
  "Optionally — only if you see a clearly better display name for the branch you worked on — also add a line `Title: <short branch name>`.",
].join("\n");

type ParsedTurnSummary = {
  /** The `Summary:` line's text, when present (trimmed, single line). */
  summary?: string;
  /** The optional `Title:` line's text, when present. */
  title?: string;
  /** The reply with the Summary/Title metadata lines removed. */
  cleaned: string;
};

const SUMMARY_LINE = /^\s*Summary:\s*(.+)\s*$/;
const TITLE_LINE = /^\s*Title:\s*(.+)\s*$/;

/** Single-line cap for parsed metadata (tooltip-length is fine — a little
 * longer than the old 4-8 words is acceptable per Michael). */
const META_MAX_LENGTH = 160;

function capMeta(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > META_MAX_LENGTH
    ? `${flat.slice(0, META_MAX_LENGTH - 1)}…`
    : flat;
}

/**
 * Parse the trailing Summary/Title metadata lines out of a turn reply. Only
 * lines in the TAIL of the reply count (the last 8 non-empty lines) so a
 * reply QUOTING "Summary:" mid-text is never mis-parsed; the LAST occurrence
 * wins. Returns the reply with those lines removed.
 */
function parseTurnSummary(text: string): ParsedTurnSummary {
  const lines = text.split("\n");
  // Indices of the tail window: last 8 non-empty lines.
  const tailIndexes: number[] = [];
  for (let i = lines.length - 1; i >= 0 && tailIndexes.length < 8; i--) {
    if (lines[i].trim()) tailIndexes.push(i);
  }
  let summary: string | undefined;
  let title: string | undefined;
  const remove = new Set<number>();
  for (const index of tailIndexes) {
    const summaryMatch = SUMMARY_LINE.exec(lines[index]);
    if (summaryMatch && summary === undefined) {
      summary = capMeta(summaryMatch[1]);
      remove.add(index);
      continue;
    }
    const titleMatch = TITLE_LINE.exec(lines[index]);
    if (titleMatch && title === undefined) {
      title = capMeta(titleMatch[1]);
      remove.add(index);
    }
  }
  if (remove.size === 0) return { cleaned: text };
  const cleaned = lines
    .filter((_, index) => !remove.has(index))
    .join("\n")
    .replace(/\n{3,}$/g, "\n")
    .trimEnd();
  return {
    ...(summary ? { summary } : {}),
    ...(title ? { title } : {}),
    cleaned,
  };
}

/** A new fork's INITIAL display name: the creating prompt truncated to 10
 * characters (Michael's rule; "…" marks the cut). Undefined when the prompt
 * carries no usable text — the caller keeps its id-based fallback. */
function forkTitleFromPrompt(prompt: string | undefined): string | undefined {
  const flat = (prompt ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > 10 ? `${flat.slice(0, 10)}…` : flat;
}

export { forkTitleFromPrompt, parseTurnSummary, SUMMARY_PROMPT_INSTRUCTION };
export type { ParsedTurnSummary };
