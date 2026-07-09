/**
 * Node-side reading of the config's `integrations:` toggles (D1).
 *
 * The designbook config is a browser-bundled `.tsx` (import.meta.glob / JSX)
 * that the node server never evaluates, so built-in on/off toggles are read
 * with a best-effort STATIC scan of the config source: only the literal form
 *
 *   integrations: { figma: false }
 *
 * is recognized (whitespace/quotes/trailing-comma tolerant). A computed
 * toggle silently stays enabled node-side — acceptable because integration
 * routes are same-origin-gated regardless; the UI half (which evaluates the
 * real config) honors any expression. Documented in the spec.
 */

/** Integration names explicitly disabled via a literal `<name>: false`. */
function parseDisabledIntegrations(configSource: string): Set<string> {
  const disabled = new Set<string>();
  const block = matchIntegrationsBlock(configSource);
  if (!block) return disabled;
  const entry = /['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*false\b/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(block))) {
    disabled.add(match[1]);
  }
  return disabled;
}

/**
 * The text of the top-level-ish `integrations: { … }` object literal, or
 * undefined. Brace-balanced scan (nested option objects are fine).
 */
function matchIntegrationsBlock(source: string): string | undefined {
  const start = source.search(/\bintegrations\s*:\s*\{/);
  if (start === -1) return undefined;
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return undefined;
}

export { parseDisabledIntegrations };
