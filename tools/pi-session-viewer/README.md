# Pi session transcript viewer

Local dev tool. Drag a Pi session `.jsonl` file onto the page and read the
conversation as a story — thinking, tool calls, user input — instead of raw JSON.

Not a shipped feature and not wired into any package build. One self-contained
file, zero dependencies, no build step.

## Use

Open `index.html` in a browser (double-click / `file://` is fine) and drop a
transcript from `~/.pi/agent/sessions/<project>/*.jsonl`. Re-drop to replace.

## What it shows

- **User** messages as prominent bubbles. A leading `Selected canvas node
  context:` block is collapsed by default; the `User request:` part is surfaced.
- **Thinking** blocks as subdued collapsed rows (first line as summary).
- **Tool calls** as compact rows: name + smart one-line arg summary
  (command/path/pattern first), status from the matched `toolResult`
  (✓ done / ✗ error / ○ no result), and the result collapsed, truncated to
  ~4KB with a "copy full" button. Per-tool duration (call→result).
- **Assistant text** as normal bubbles, clamped with show-more.
- **Errors** (`stopReason:"error"` / `errorMessage` / `isError` results) as
  always-visible red rows.
- Elapsed-time chip per row; turn separators; stats footer.

Toolbar: filter thinking / tools / text, expand-all / collapse-all, plain-text
search (highlights + Enter/Shift-Enter to jump, Escape clears).

## Format handled

`type:"session"` header line; `type:"message"` lines (roles user / assistant /
toolResult). Extra line types `model_change` and `thinking_level_change` render
as subtle meta rows; any unknown line type or malformed line renders as a meta /
parse-error row rather than crashing the view.
