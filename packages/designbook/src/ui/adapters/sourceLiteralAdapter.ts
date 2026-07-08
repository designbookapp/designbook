/**
 * Built-in fallback text adapter: edits a unique plain string literal directly
 * in its source file via the designbook file API.
 *
 * Runs last in the chain, so it only sees text no keyed adapter claimed. It
 * fetches the owning component's source (attributed by the canvas fiber
 * hit-test), and claims the node only when the rendered text matches exactly
 * one literal in that file — an ambiguous match is left to the "hardcoded
 * string" callout so the change stays safe.
 */

import type { TextAdapter, TextClaim, TextNodeHit } from "@designbookapp/designbook/config";
import { findLiteralMatch, replaceLiteral } from "./sourceLiteral";
import { apiUrl } from "@designbook-ui/designbook";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";

const ADAPTER_NAME = "sourceLiteral";

type FileResponse = { path: string; content: string };

function sourceLiteralAdapter(): TextAdapter {
  const cache = new Map<string, string>();

  async function readFile(path: string, fresh = false): Promise<string | null> {
    if (!fresh) {
      const cached = cache.get(path);
      if (cached !== undefined) return cached;
    }
    const response = await fetch(
      apiUrl(`/api/file?path=${encodeURIComponent(path)}`),
    ).catch(() => null);
    if (!response || !response.ok) return null;
    const payload = (await response.json().catch(() => null)) as
      | FileResponse
      | null;
    if (!payload || typeof payload.content !== "string") return null;
    cache.set(path, payload.content);
    return payload.content;
  }

  return {
    name: ADAPTER_NAME,

    async resolveText(hit: TextNodeHit): Promise<TextClaim | null> {
      const sourcePath = hit.sourcePath;
      const literal = hit.text;
      if (!sourcePath || !literal) return null;

      const source = await readFile(sourcePath);
      if (source === null) return null;

      const match = findLiteralMatch(source, literal);
      if (!match) return null;

      return {
        adapter: ADAPTER_NAME,
        value: literal,
        kind: "literal",
        editPath: sourcePath,
        line: match.line,
        node: hit.node ?? undefined,
        element: hit.element,
        rect: hit.rect,
        label: "Edit text",
        async save(next: string) {
          // Re-read fresh: the canvas may have re-rendered since we cached.
          const current = await readFile(sourcePath, true);
          if (current === null) {
            throw new Error(`Could not read source file: ${sourcePath}`);
          }
          const updated = replaceLiteral(current, literal, next);
          if (updated === null) {
            throw new Error(
              `Could not locate a unique "${literal}" in ${sourcePath}`,
            );
          }
          const response = await fetch(apiUrl("/api/file"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: sourcePath, content: updated }),
          }).catch(() => null);
          if (!response || !response.ok) {
            const payload = (await response?.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(payload?.error ?? "Failed to save text");
          }
          cache.set(sourcePath, updated);
          notifyFileWritten(sourcePath);
        },
      };
    },
  };
}

export { sourceLiteralAdapter };
