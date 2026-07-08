/**
 * Locates the line of a component's definition in its source file. There is
 * no line-number metadata in React 19 fibers, so the code panel finds the
 * definition by matching the export name against the raw source.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the 1-based line of `exportName`'s definition in `source`: the
 * first line matching a function/const/class declaration of that name, else
 * the first line containing the name at all, else line 1.
 */
function findDefinitionLine(source: string, exportName?: string): number {
  if (!exportName) return 1;

  const lines = source.split("\n");
  const definition = new RegExp(
    `(export\\s+)?(default\\s+)?(async\\s+)?(function|const|class)\\s+${escapeRegExp(exportName)}\\b`,
  );

  const definitionIndex = lines.findIndex((line) => definition.test(line));
  if (definitionIndex !== -1) return definitionIndex + 1;

  const occurrenceIndex = lines.findIndex((line) => line.includes(exportName));
  return occurrenceIndex !== -1 ? occurrenceIndex + 1 : 1;
}

export { findDefinitionLine };
