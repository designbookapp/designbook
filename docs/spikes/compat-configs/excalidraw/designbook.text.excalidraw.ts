/**
 * Custom text adapter for excalidraw's homegrown i18n (packages/excalidraw/
 * i18n.ts): module-level `currentLang` + `t(path, vars, fallback)` reading
 * nested JSON from `locales/en.json`. designbook ships an `i18nextAdapter`
 * but nothing for a hand-rolled `t()` — this is a CONFIG-LEVEL adapter built
 * entirely on the public `@designbookapp/designbook/config` types + the same `/api/json`
 * endpoint the shipped flags/theme adapters already use for surgical
 * key-path writes (see designbook/src/ui/adapters/flags.tsx, theme.tsx).
 *
 * SDK GAP (see round-3 report): designbook's i18next adapter solves text
 * attribution precisely by injecting invisible zero-width markers into every
 * resolved string (postProcessor) and decoding them back to a namespace+key
 * on hit (`@designbook-ui/components/Workbench/i18nMarkers` +
 * `.../textHits.ts`). Those utilities are NOT re-exported from either
 * public subpath (`@designbookapp/designbook/config`, `@designbookapp/designbook/adapters` — confirmed by
 * reading packages/designbook/src/ui/adapters/index.ts, which only exports
 * flagsAdapter/i18nextAdapter/themeAdapter/sourceLiteralAdapter) and
 * excalidraw's `t()` is a plain function reassigned via ESM named imports
 * across ~100s of call sites — there's no seam (babel/swc plugin, or a
 * public "wrap this t() and get marker injection" helper) to intercept it at
 * config-level without a core change. So this adapter falls back to a
 * REVERSE LOOKUP: it flattens en.json once, matches the hit's rendered text
 * against known string VALUES, and resolves the matching key. This works but
 * is ambiguous whenever two keys share the same English string (32 of 566
 * strings in en.json do); we resolve ties with a cheap heuristic (prefer a
 * generic `buttons.*`/`labels.*` namespace) instead of true attribution.
 */

import type { Adapter, HostContextSource, TextClaim, TextNodeHit } from "@designbookapp/designbook/config";
import enJson from "./packages/excalidraw/locales/en.json";
import {
  defaultLang,
  getLanguage,
  languages,
  setLanguage,
} from "./packages/excalidraw/i18n";

const EDIT_PATH = "packages/excalidraw/locales/en.json";

type FlatEntry = { key: string; value: string };

function flatten(obj: unknown, prefix: string, out: FlatEntry[]): void {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof obj === "string") {
    out.push({ key: prefix, value: obj });
  }
}

const ENTRIES: FlatEntry[] = [];
flatten(enJson, "", ENTRIES);

const BY_VALUE = new Map<string, FlatEntry[]>();
// Mutable current-value-by-key, seeded from en.json and updated optimistically
// on save (mirrors i18nextAdapter's in-memory `instance.addResource` copy) —
// the text-edit popover prefills its input from `claim.getTemplate(key)`, NOT
// `claim.value` (confirmed against TextEditPopover.tsx), so this is required
// for the box to show the current string rather than opening empty.
const CURRENT = new Map<string, string>();
for (const entry of ENTRIES) {
  const list = BY_VALUE.get(entry.value) ?? [];
  list.push(entry);
  BY_VALUE.set(entry.value, list);
  CURRENT.set(entry.key, entry.value);
}

/** Best-effort disambiguation when >1 key shares the same English string. */
function pickEntry(candidates: FlatEntry[]): FlatEntry {
  const preferred = candidates.find(
    (c) => c.key.startsWith("buttons.") || c.key.startsWith("labels."),
  );
  return preferred ?? candidates[0];
}

/**
 * excalidraw's `t()` falls back to the SAME en.json module object we import
 * here (packages/excalidraw/i18n.ts `fallbackLangData`), so an in-place
 * mutation makes every subsequent `t()` call return the saved string.
 * Components re-render by subscribing to `subscribeI18n` (version bump).
 */
function setDeep(obj: Record<string, unknown>, keyPath: string, value: string): void {
  const parts = keyPath.split(".");
  let node: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== "object") return;
    node = next as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

let i18nVersion = 0;
const i18nListeners = new Set<() => void>();

function subscribeI18n(listener: () => void): () => void {
  i18nListeners.add(listener);
  return () => i18nListeners.delete(listener);
}

function getI18nVersion(): number {
  return i18nVersion;
}

async function saveEntry(key: string, next: string): Promise<void> {
  const previous = CURRENT.get(key);
  CURRENT.set(key, next);
  try {
    const response = await fetch("/api/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: EDIT_PATH, keyPath: key, value: next }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(payload.error ?? "Failed to save translation");
    }
    setDeep(enJson as unknown as Record<string, unknown>, key, next);
    i18nVersion += 1;
    for (const listener of i18nListeners) listener();
  } catch (error) {
    if (previous !== undefined) CURRENT.set(key, previous);
    throw error instanceof Error ? error : new Error("Failed to save translation");
  }
}

/**
 * Switch excalidraw's active language (C4.3 explicit pick). `setLanguage` loads
 * the locale JSON into the module's `currentLangData`; we then bump the i18n
 * version so the demos (which subscribe via `useI18nVersion`) re-run `t()` and
 * repaint in the chosen language.
 */
async function setLocale(code: string): Promise<void> {
  const lang = languages.find((l) => l.code === code) ?? defaultLang;
  await setLanguage(lang);
  i18nVersion += 1;
  for (const listener of i18nListeners) listener();
}

/**
 * Host-context source (C4.3) for the workbench `locale` dimension: reads
 * excalidraw's live language straight from its i18n module (same instance in
 * injected mode). No `subscribe` API is exported by excalidraw's i18n, so the
 * switcher polls this while open and refreshes on re-expand.
 */
const localeHostSource: HostContextSource = {
  get: () => getLanguage().code,
};

const excalidrawI18nAdapter: Adapter = {
  name: "excalidrawI18n",

  async setup() {
    return {
      dimensions: [
        {
          id: "locale",
          label: "Language",
          options: languages.map((l) => ({ value: l.code, label: l.label })),
          defaultValue: defaultLang.code,
        },
      ],
      setLocale,
    };
  },

  resolveText(hit: TextNodeHit): TextClaim | null {
    const text = hit.text?.trim();
    if (!text) return null;
    const candidates = BY_VALUE.get(text);
    if (!candidates || candidates.length === 0) return null;
    const entry = pickEntry(candidates);

    return {
      adapter: "excalidrawI18n",
      value: text,
      kind: "keyed",
      key: entry.key,
      namespace: "en",
      editPath: EDIT_PATH,
      label: entry.key,
      getTemplate: (key: string) => CURRENT.get(key),
      save: (next: string) => saveEntry(entry.key, next),
    };
  },
};

// resolveText is synchronous + side-effect-free, so hover previewing (which
// must not fetch/save) can safely reuse it — same pattern i18nextAdapter uses.
excalidrawI18nAdapter.previewText = excalidrawI18nAdapter.resolveText as (
  hit: TextNodeHit,
) => TextClaim | null;

export {
  excalidrawI18nAdapter,
  localeHostSource,
  subscribeI18n,
  getI18nVersion,
};
