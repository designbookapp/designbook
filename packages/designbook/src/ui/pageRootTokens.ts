/**
 * Page root-token collector for shadow isolation (fixes "unstyled previews").
 *
 * ## The problem
 * In `isolation: "shadow"` mode, previewed cells render in the LIGHT DOM but are
 * projected into the canvas through native `<slot>`s that live inside our shadow
 * chrome. A slotted element's INHERITED values (including CSS custom properties)
 * follow the *flattened tree* — i.e. the `<slot>`'s shadow ancestors, our chrome
 * — not the page's `:root`. So a page that declares its design tokens on
 * `:root { --spacing: … }` never reaches the cells by inheritance. Worse, our
 * chrome css is Tailwind v4 too, and `mount.tsx` adds a
 * `::slotted([slot^="db-cell-"]) { --token: initial }` reset for every custom
 * property the chrome declares — which zeroes identically-named PAGE tokens
 * (`--spacing`, `--color-*`, `--font-*`, …). Result: class rules match, flex
 * works, but `var()`-based padding/radius/color/font compute to nothing.
 *
 * ## The fix
 * Collect every custom property the page declares on a root-matching selector
 * (`:root` / `html` / `:root[data-theme=…]` / `.dark` on `<html>` / `@theme`'s
 * `:root, :host`) and re-apply them as INLINE styles on each cell's light-DOM
 * `<div slot=…>` wrapper. Inline declarations beat both the `::slotted` reset and
 * flat-tree inheritance, so the cell sees the page's real token values. The
 * reset still protects cells from chrome tokens the page does NOT define (they
 * fall through to `initial`, never our chrome value — the C2.3 Geist-leak case).
 *
 * Values are read straight from the CSSOM rules (not `getComputedStyle`) so the
 * collector is unit-testable against minimal stubbed sheets, and we honor the
 * cascade the parts we can: later declarations win, non-matching `@media` blocks
 * are skipped, and selectors are gated on whether `documentElement` currently
 * matches them (so a `.dark`/`[data-theme]` flip changes what we collect).
 */

/** Injected DOM predicates so the core collector stays testable without a DOM. */
interface RootMatchDeps {
  /** Does `document.documentElement` currently match this compound selector? */
  matchesRoot(selector: string): boolean;
  /** Does this `@media` condition currently apply? */
  mediaMatches(condition: string): boolean;
}

/** Split a selector list on TOP-LEVEL commas (ignore commas inside ()/[]). */
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selectorText) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Does any part of this rule's selector list target the root element? */
function ruleTargetsRoot(selectorText: string, deps: RootMatchDeps): boolean {
  for (const part of splitSelectorList(selectorText)) {
    const trimmed = part.trim();
    if (trimmed && deps.matchesRoot(trimmed)) return true;
  }
  return false;
}

/** Minimal structural shapes we read off the CSSOM (duck-typed, defensive). */
type StyleLike = {
  length?: number;
  getPropertyValue(name: string): string;
  [index: number]: string;
};
type RuleLike = {
  selectorText?: string;
  style?: StyleLike;
  cssRules?: ArrayLike<RuleLike> & Iterable<RuleLike>;
  media?: { mediaText?: string };
};
type SheetLike = { cssRules?: ArrayLike<RuleLike> & Iterable<RuleLike> };

/** Pull every `--custom-prop: value` declared in a style declaration. */
function customPropsFromStyle(
  style: StyleLike,
  into: Map<string, string>,
): void {
  const length = typeof style.length === "number" ? style.length : 0;
  for (let i = 0; i < length; i++) {
    const name = style[i];
    if (typeof name === "string" && name.startsWith("--")) {
      // Later declarations overwrite earlier ones (document order == cascade
      // order for equal specificity, which root-token declarations share).
      into.set(name, String(style.getPropertyValue(name)).trim());
    }
  }
}

/** Recursively walk a rule list, honoring `@media`/`@layer`/`@supports` nesting. */
function walkRules(
  rules: ArrayLike<RuleLike> & Iterable<RuleLike>,
  into: Map<string, string>,
  deps: RootMatchDeps,
): void {
  for (const rule of rules) {
    // A plain style rule: `selector { … }`.
    if (rule.style && typeof rule.selectorText === "string") {
      if (ruleTargetsRoot(rule.selectorText, deps)) {
        customPropsFromStyle(rule.style, into);
      }
      continue;
    }
    // A grouping rule (`@layer`, `@media`, `@supports`, `@container`) exposes
    // nested `.cssRules`. Skip a non-matching `@media` block; recurse the rest
    // (Tailwind v4 wraps its theme in `@layer`).
    if (rule.cssRules) {
      const mediaText = rule.media?.mediaText;
      if (typeof mediaText === "string" && mediaText && !deps.mediaMatches(mediaText)) {
        continue;
      }
      walkRules(rule.cssRules, into, deps);
    }
  }
}

/**
 * Core, DOM-free collector: given an ordered list of stylesheets and the DOM
 * predicates, return `Map<customPropName, value>` for every property declared on
 * a root-matching selector. Sheets earlier in the list are overridden by later
 * ones (pass `document.styleSheets` before `document.adoptedStyleSheets`).
 * Cross-origin sheets throw on `.cssRules` access — those are skipped.
 */
function collectRootCustomProps(
  sheets: Iterable<SheetLike>,
  deps: RootMatchDeps,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const sheet of sheets) {
    let rules: (ArrayLike<RuleLike> & Iterable<RuleLike>) | undefined;
    try {
      rules = sheet.cssRules ?? undefined;
    } catch {
      // Cross-origin stylesheet — `.cssRules` throws a SecurityError. Skip it.
      continue;
    }
    if (rules) walkRules(rules, map, deps);
  }
  return map;
}

/** Real-DOM wiring of {@link collectRootCustomProps} over the current document. */
function collectPageRootTokens(): Map<string, string> {
  if (typeof document === "undefined") return new Map();
  const deps: RootMatchDeps = {
    matchesRoot: (selector) => {
      try {
        return document.documentElement.matches(selector);
      } catch {
        return false;
      }
    },
    mediaMatches: (condition) => {
      try {
        return window.matchMedia(condition).matches;
      } catch {
        // Unknown/unsupported condition: don't hide its declarations.
        return true;
      }
    },
  };
  const sheets: SheetLike[] = [];
  try {
    sheets.push(...(Array.from(document.styleSheets) as unknown as SheetLike[]));
  } catch {
    /* ignore */
  }
  try {
    // Adopted sheets cascade AFTER the document's own sheets, so append them
    // last (later wins). Only the DOCUMENT's adopted sheets are visible here —
    // our chrome sheet lives on the shadow root, so it is never collected.
    const adopted = (document as unknown as { adoptedStyleSheets?: SheetLike[] })
      .adoptedStyleSheets;
    if (adopted) sheets.push(...adopted);
  } catch {
    /* ignore */
  }
  return collectRootCustomProps(sheets, deps);
}

// ---------------------------------------------------------------------------
// Shared, refcounted cache + freshness observer.
//
// One collection is shared across every mounted cell. A single MutationObserver
// (active only while ≥1 cell is mounted) watches `document.head` for added /
// removed / mutated `<style>`/`<link>` and `documentElement` attribute changes
// (class/style/data-theme flips move token values), recollecting on change with
// a trailing debounce so a burst of mutations costs one pass.
// ---------------------------------------------------------------------------

const EMPTY_TOKENS: ReadonlyMap<string, string> = new Map();
const RECOLLECT_DEBOUNCE_MS = 30;

let cache: ReadonlyMap<string, string> | null = null;
let refCount = 0;
let observer: MutationObserver | null = null;
let debounceHandle: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function recollectNow(): void {
  cache = collectPageRootTokens();
  for (const listener of listeners) listener();
}

function scheduleRecollect(): void {
  if (debounceHandle != null) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    recollectNow();
  }, RECOLLECT_DEBOUNCE_MS);
}

/**
 * Register interest in the page's root tokens. Returns the current cache plus an
 * `release()` to call on unmount. The observer starts on the first acquirer and
 * disconnects when the last one releases.
 */
function acquirePageRootTokens(onChange: () => void): {
  release: () => void;
} {
  listeners.add(onChange);
  refCount++;
  if (refCount === 1) {
    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
      observer = new MutationObserver(scheduleRecollect);
      // <style>/<link> added, removed, or their media/href changed.
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["media", "href", "disabled"],
      });
      // Theme flips: class / style / data-* on the root element change which
      // declarations `documentElement.matches(...)` and thus their values.
      observer.observe(document.documentElement, { attributes: true });
    }
    recollectNow();
  }
  return {
    release() {
      listeners.delete(onChange);
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0) {
        observer?.disconnect();
        observer = null;
        if (debounceHandle != null) {
          clearTimeout(debounceHandle);
          debounceHandle = null;
        }
        cache = null;
      }
    },
  };
}

/** Current cached token map (empty until the first acquirer collects). */
function currentPageRootTokens(): ReadonlyMap<string, string> {
  return cache ?? EMPTY_TOKENS;
}

export {
  acquirePageRootTokens,
  collectPageRootTokens,
  collectRootCustomProps,
  currentPageRootTokens,
  EMPTY_TOKENS,
};
export type { RootMatchDeps, SheetLike };
