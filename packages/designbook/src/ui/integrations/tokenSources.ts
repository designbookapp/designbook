/**
 * Neutral theme-token source registry (G2a inversion). Adapters that own
 * design tokens (the theme adapter) PUBLISH a `TokenSource` here; integration
 * plugins (the figma plugin's variable sync + push attribution) CONSUME it.
 * Neither side knows the other: the adapter publishes neutral token facts,
 * the plugin applies its own tool-specific naming/options.
 *
 * Values are read lazily via `source.getTokens()` (always current); the
 * subscription only signals list-level changes (register/unregister) so the
 * workbench can re-render integration screens with a fresh array identity.
 */

import type { TokenSource } from "../../integration/index.ts";

const sources = new Map<string, TokenSource>();
const listeners = new Set<() => void>();
let snapshot: TokenSource[] = [];

function emit(): void {
  snapshot = [...sources.values()];
  for (const listener of listeners) listener();
}

/** Publish (or replace, by id) a token source. */
function registerTokenSource(source: TokenSource): void {
  sources.set(source.id, source);
  emit();
}

function unregisterTokenSource(id: string): void {
  if (sources.delete(id)) emit();
}

/** Stable-identity list of the registered sources (for useSyncExternalStore). */
function getTokenSources(): TokenSource[] {
  return snapshot;
}

function subscribeTokenSources(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: drop all registered sources. */
function resetTokenSources(): void {
  sources.clear();
  emit();
}

export {
  getTokenSources,
  registerTokenSource,
  resetTokenSources,
  subscribeTokenSources,
  unregisterTokenSource,
};
