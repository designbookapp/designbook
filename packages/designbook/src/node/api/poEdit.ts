/**
 * Surgical gettext-PO `msgstr` replacement for the canvas Lingui text tool.
 *
 * Finds the entry whose `msgid` matches a target (Lingui message id — for
 * source catalogs this IS the English source text) and rewrites only that
 * entry's `msgstr`, preserving every comment, blank line, and other entry.
 * A one-string edit stays a one-entry diff.
 *
 * Handles the two PO string layouts on both sides:
 *   - single line:  `msgid "Close"` / `msgstr "Close"`
 *   - multi line:   `msgid ""` followed by `"continuation "` `"lines"`.
 * A multi-line `msgstr` is collapsed to a single `msgstr "…"` line (still valid
 * PO); PO escapes (`\"`, `\\`, `\n`, `\t`, `\r`) are decoded on read and
 * re-encoded on write.
 */

const QUOTED = /"((?:[^"\\]|\\.)*)"/;

/** Decodes the escape sequences inside a PO quoted string body. */
function unescapePo(body: string): string {
  return body.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return ch;
    }
  });
}

/** Encodes a raw string as a PO quoted-string body (without the quotes). */
function escapePo(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
}

/** Extracts the still-escaped body of the first quoted string on a line. */
function extractQuoted(line: string): string | undefined {
  const match = line.match(QUOTED);
  return match ? match[1] : undefined;
}

function isContinuation(line: string): boolean {
  return line.trimStart().startsWith('"');
}

/**
 * Replaces the `msgstr` of the entry whose `msgid` decodes to `targetMsgid`.
 * Returns the updated PO text, or `undefined` when no entry matches (missing id)
 * or the entry has no `msgstr` (e.g. a gettext-plural entry, unused by Lingui).
 */
function replacePoMsgstr(
  raw: string,
  targetMsgid: string,
  newValue: string,
): string | undefined {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();

    if (trimmed.startsWith("msgid ") || trimmed === "msgid") {
      // Collect the (possibly multi-line) msgid.
      let msgid = unescapePo(extractQuoted(lines[i]) ?? "");
      let j = i + 1;
      while (j < lines.length && isContinuation(lines[j])) {
        msgid += unescapePo(extractQuoted(lines[j]) ?? "");
        j++;
      }

      const msgstrLine = j < lines.length ? lines[j].trimStart() : "";
      if (msgstrLine.startsWith("msgstr")) {
        // Span of the msgstr: its line plus any continuation quote lines.
        let k = j + 1;
        while (k < lines.length && isContinuation(lines[k])) k++;

        if (msgid === targetMsgid) {
          const rewritten = `msgstr "${escapePo(newValue)}"`;
          return [...lines.slice(0, j), rewritten, ...lines.slice(k)].join(eol);
        }
        // Not our entry — skip past its msgstr and keep scanning.
        i = k;
        continue;
      }
      // No msgstr followed (msgctxt/msgid_plural layout) — advance past msgid.
      i = j;
      continue;
    }

    i++;
  }

  return undefined;
}

export { escapePo, replacePoMsgstr, unescapePo };
