/**
 * Maps a file path to the CodeMirror language family used by the code
 * panel's editor.
 */

type CodeLanguage = "typescript" | "javascript" | "css" | "json" | "text";

function languageForPath(path: string): CodeLanguage {
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  return "text";
}

export { languageForPath };
export type { CodeLanguage };
