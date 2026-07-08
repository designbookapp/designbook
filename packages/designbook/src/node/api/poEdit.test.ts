import { describe, expect, it } from "vitest";
import { escapePo, replacePoMsgstr, unescapePo } from "./poEdit";

const header = `msgid ""
msgstr ""
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=utf-8\\n"
"Language: en\\n"

`;

const sample =
  header +
  `#: packages/ui/primitives/dialog.tsx
msgid "Close"
msgstr "Close"

#. placeholder {0}: name
#: apps/remix/app/foo.tsx
msgid "Hello {0}"
msgstr "Hello {0}"

#: apps/remix/app/bar.tsx
msgid "Save changes"
msgstr "Save changes"
`;

describe("replacePoMsgstr", () => {
  it("replaces a single-line msgstr, preserving all other lines", () => {
    const result = replacePoMsgstr(sample, "Close", "Dismiss");
    expect(result).toBe(sample.replace('msgstr "Close"', 'msgstr "Dismiss"'));
    // Comments + neighbouring entries untouched.
    expect(result).toContain("#: packages/ui/primitives/dialog.tsx");
    expect(result).toContain('msgid "Save changes"');
  });

  it("targets by msgid, not position (edits a later entry)", () => {
    const result = replacePoMsgstr(sample, "Save changes", "Save");
    expect(result).toContain('msgid "Save changes"\nmsgstr "Save"');
    expect(result).toContain('msgid "Close"\nmsgstr "Close"');
  });

  it("does not match a partial/substring msgid", () => {
    expect(replacePoMsgstr(sample, "Clos", "x")).toBeUndefined();
    expect(replacePoMsgstr(sample, "Save", "x")).toBeUndefined();
  });

  it("returns undefined for a missing id", () => {
    expect(replacePoMsgstr(sample, "Nope", "x")).toBeUndefined();
  });

  it("escapes quotes, backslashes, and newlines in the new value", () => {
    const result = replacePoMsgstr(sample, "Close", 'A "quote" and \\ and\nnewline');
    expect(result).toContain(
      'msgstr "A \\"quote\\" and \\\\ and\\nnewline"',
    );
    // Result stays valid single-line PO (no raw newline injected mid-entry).
    expect(result).not.toContain("\nnewline\n");
  });

  it("collapses a multi-line msgstr into a single line", () => {
    const multi = `#: a.tsx
msgid "Wrapped"
msgstr ""
"part one "
"part two"

msgid "After"
msgstr "After"
`;
    const result = replacePoMsgstr(multi, "Wrapped", "short");
    expect(result).toContain('msgid "Wrapped"\nmsgstr "short"');
    // The old continuation lines are gone; the next entry survives.
    expect(result).not.toContain('"part two"');
    expect(result).toContain('msgid "After"\nmsgstr "After"');
  });

  it("matches a multi-line msgid", () => {
    const multi = `msgid ""
"long line one "
"long line two"
msgstr "old"
`;
    const result = replacePoMsgstr(multi, "long line one long line two", "new");
    expect(result).toBe(`msgid ""
"long line one "
"long line two"
msgstr "new"
`);
  });

  it("handles a translated (non-source) catalog where msgstr differs", () => {
    const de = `#: dialog.tsx
msgid "Close"
msgstr "Schließen"
`;
    const result = replacePoMsgstr(de, "Close", "Zumachen");
    expect(result).toBe(`#: dialog.tsx
msgid "Close"
msgstr "Zumachen"
`);
  });

  it("preserves CRLF line endings", () => {
    const crlf = 'msgid "Close"\r\nmsgstr "Close"\r\n';
    const result = replacePoMsgstr(crlf, "Close", "Dismiss");
    expect(result).toBe('msgid "Close"\r\nmsgstr "Dismiss"\r\n');
  });
});

describe("escapePo/unescapePo round-trip", () => {
  it("round-trips quotes, backslashes, and control chars", () => {
    const raw = 'He said "hi"\\\tand\nbye';
    expect(unescapePo(escapePo(raw))).toBe(raw);
  });
});
