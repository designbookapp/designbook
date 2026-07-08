/**
 * Pure matcher for the source-literal text adapter: locate a plain string
 * literal in a source file so the adapter can replace exactly one occurrence.
 *
 * The tool passes the rendered (visible) text. JSX text collapses runs of
 * whitespace, so a rendered "Add to cart" may appear in source with different
 * internal spacing; we compare on a whitespace-collapsed basis. A match is only
 * usable when it is unambiguous — exactly one occurrence in the source.
 */

type LiteralMatch = {
  /** 1-based line of the matched occurrence. */
  line: number;
  /** The exact substring in the source that was matched. */
  matched: string;
  /** Character offset of the match in the source. */
  index: number;
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Returns the unique occurrence of `literal` in `source`, or `null` when the
 * literal is absent or appears more than once (ambiguous → not safe to edit).
 *
 * Tries an exact (trimmed) match first, then a whitespace-collapsed match that
 * tolerates JSX-text reflow.
 */
function findLiteralMatch(source: string, literal: string): LiteralMatch | null {
  const needle = literal.trim();
  if (!needle) return null;

  // Exact occurrences of the trimmed literal.
  const exact: number[] = [];
  let from = source.indexOf(needle);
  while (from !== -1) {
    exact.push(from);
    from = source.indexOf(needle, from + 1);
  }
  if (exact.length === 1) {
    return {
      line: lineOfIndex(source, exact[0]),
      matched: needle,
      index: exact[0],
    };
  }
  if (exact.length > 1) return null;

  // Whitespace-collapsed match: each run of whitespace in the needle matches a
  // run of whitespace in the source. Only usable when unique.
  const collapsed = collapseWhitespace(needle);
  if (!collapsed) return null;
  const pattern = collapsed
    .split(" ")
    .map((token) => escapeRegExp(token))
    .join("\\s+");
  const regex = new RegExp(pattern, "g");

  const matches: Array<{ index: number; matched: string }> = [];
  let match = regex.exec(source);
  while (match) {
    matches.push({ index: match.index, matched: match[0] });
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
    match = regex.exec(source);
  }
  if (matches.length !== 1) return null;

  return {
    line: lineOfIndex(source, matches[0].index),
    matched: matches[0].matched,
    index: matches[0].index,
  };
}

/**
 * Replaces the single occurrence located by `findLiteralMatch` with `next`,
 * or returns `null` when the literal is not uniquely matchable.
 */
function replaceLiteral(
  source: string,
  literal: string,
  next: string,
): string | null {
  const found = findLiteralMatch(source, literal);
  if (!found) return null;
  return (
    source.slice(0, found.index) +
    next +
    source.slice(found.index + found.matched.length)
  );
}

export { collapseWhitespace, findLiteralMatch, replaceLiteral };
export type { LiteralMatch };
