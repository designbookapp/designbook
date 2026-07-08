/**
 * Surgical CSS custom-property replacement: swaps the value of a single
 * `--var` inside a given selector's block without reformatting anything else,
 * so a one-token edit produces a one-line diff. Used by the theme adapter's
 * `POST /api/style` write path.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locates the `{ … }` body of `<selector>` in `raw`, matching `selector` as a
 * whole token (so `.dark` never matches `.darker`, nor `:root` the `@theme`
 * block). Returns the [start, end) offsets of the content between the braces.
 */
function findBlockRange(
  raw: string,
  selector: string,
): { start: number; end: number } | undefined {
  let from = 0;
  while (from <= raw.length) {
    const idx = raw.indexOf(selector, from);
    if (idx === -1) return undefined;
    from = idx + selector.length;

    const before = idx === 0 ? "" : raw[idx - 1];
    if (before && /[A-Za-z0-9_-]/.test(before)) continue;

    let i = idx + selector.length;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] !== "{") continue;

    let depth = 0;
    const open = i;
    for (let j = i; j < raw.length; j++) {
      if (raw[j] === "{") depth++;
      else if (raw[j] === "}") {
        depth--;
        if (depth === 0) return { start: open + 1, end: j };
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * Replaces the value of `--<prop>` within `<selector> { … }` in `raw` with
 * `value`, rewriting only that declaration's value span (handles multi-token
 * values like `oklch(0.5 0.19 258)`). Returns the updated CSS, or undefined
 * when the selector or property isn't found.
 */
function replaceCssVar(
  raw: string,
  selector: string,
  prop: string,
  value: string,
): string | undefined {
  const block = findBlockRange(raw, selector);
  if (!block) return undefined;

  const segment = raw.slice(block.start, block.end);
  const re = new RegExp(
    `(--${escapeRegExp(prop)}(?![\\w-])\\s*:\\s*)([^;\\n]*)`,
  );
  const match = re.exec(segment);
  if (!match) return undefined;

  const valueStart = block.start + match.index + match[1].length;
  const valueEnd = valueStart + match[2].length;
  return raw.slice(0, valueStart) + value + raw.slice(valueEnd);
}

export { replaceCssVar };
