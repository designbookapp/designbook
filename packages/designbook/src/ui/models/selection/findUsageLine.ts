/**
 * Locates the JSX *usage* line of an element inside its owner component's
 * source. Where `findDefinitionLine` finds where a component is *defined*,
 * this finds where an element is *used* — e.g. the `<Card className="w-80
 * gap-3">` line inside `ProductCard` — so a drilled canvas selection can
 * highlight the exact JSX site in the owner's file.
 *
 * There is no source-position metadata on React 19 fibers, so matching is
 * textual: search within the owner component's definition for `<name` tags
 * and prefer the one whose tag contains the element's className.
 *
 * Duplicate identical tags with no className to disambiguate resolve to the
 * first occurrence (rendered-order matching is out of scope).
 */

import { findDefinitionLine } from "@designbook-ui/models/selection/findDefinitionLine";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the 1-based line of `<name …>`'s usage within `ownerExportName`'s
 * definition in `content`. Prefers the occurrence whose opening tag contains
 * `className`; otherwise the first occurrence; otherwise falls back to the
 * owner's definition line.
 */
function findUsageLine(
  content: string,
  ownerExportName: string,
  name: string,
  className?: string,
): number {
  const lines = content.split("\n");
  const definitionLine = findDefinitionLine(content, ownerExportName);
  const startIndex = definitionLine - 1;

  // `<name` followed by whitespace, `/`, `>`, or end-of-line — a word boundary
  // that keeps `<div` from matching `<divider`, matches both open and
  // self-closing tags, and handles a tag name that ends its line (a multiline
  // opening tag with the props on the following lines).
  const tagOpen = new RegExp(`<${escapeRegExp(name)}(?=[\\s/>]|$)`);

  let firstMatch = -1;
  for (let i = startIndex; i < lines.length; i++) {
    if (!tagOpen.test(lines[i])) continue;
    if (firstMatch === -1) firstMatch = i;
    if (!className) continue;

    // Collect the opening tag's text — it may span multiple lines — and check
    // for the className anywhere inside it.
    let tagText = lines[i];
    let j = i;
    while (!tagText.includes(">") && j + 1 < lines.length) {
      j += 1;
      tagText += `\n${lines[j]}`;
    }
    if (tagText.includes(className)) return i + 1;
  }

  if (firstMatch !== -1) return firstMatch + 1;
  return definitionLine;
}

export { findUsageLine };
