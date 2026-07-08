/**
 * Lingui text adapter — the PO-catalog editor for the canvas text tool.
 *
 * Where the i18next adapter owns its own catalog + i18next instance, Lingui
 * repos already have a live `@lingui/core` `I18n` singleton driving their
 * `<Trans>`/`t()` output. This adapter accepts THAT instance (from the config)
 * and wraps its `_`/`t` translate functions to append designbook's invisible
 * markers to every resolved string — the same marker table the i18next
 * postProcessor fills, so hit-testing (`textHits`) and marker decode are shared.
 *
 * Attribution: a Lingui message id is the key. In documenso's source catalog
 * the id IS the English source text (`msgid == msgstr`); edits rewrite the
 * matching entry's `msgstr` in `packages/lib/translations/{locale}/web.po` via
 * the designbook server (`POST /api/po` → `poEdit.ts`), then merge the new
 * string into the live instance (`i18n.load` + its `"change"` emit re-renders
 * the canvas) with the file's HMR suppressed (`onDataWrite`).
 *
 * v1 scope: plain strings only. Messages carrying ICU placeholders/plurals
 * (`{…}`) or component slots (`<0/>`) are skipped (not claimed) with a debug
 * log — editing their raw ICU template safely is deferred.
 */

import type {
  Adapter,
  LanguageOption,
  TextClaim,
  TextNodeHit,
} from "@designbookapp/designbook/config";
import {
  allocateMarker,
  encodeMarker,
  stripMarkers,
} from "@designbook-ui/models/text/i18nMarkers";
import { textHitTest } from "@designbook-ui/models/text/textHits";
import { apiUrl } from "@designbook-ui/designbook";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";

const ADAPTER_NAME = "lingui";

/**
 * The structural slice of a `@lingui/core` `I18n` instance this adapter drives.
 * Kept minimal (and dep-free) so the adapter never imports `@lingui/*` into
 * designbook's own bundle — the repo passes its instance in.
 */
type LinguiI18n = {
  locale: string;
  messages: Record<string, unknown>;
  _: (id: unknown, values?: unknown, options?: unknown) => unknown;
  t: (id: unknown, values?: unknown, options?: unknown) => unknown;
  load: (localeOrMessages: unknown, messages?: unknown) => void;
};

type LinguiTranslate = LinguiI18n["_"];

type LinguiAdapterOptions = {
  /** The repo's live `@lingui/core` `I18n` instance (the one its `<I18nProvider>` uses). */
  i18n: LinguiI18n;
  /**
   * Where edits are written, relative to the config file. `{locale}` is
   * substituted with the instance's active locale.
   * e.g. `"packages/lib/translations/{locale}/web.po"`.
   */
  catalogPath: string;
  /** Source-language locale (the catalog whose `msgid == msgstr`). Default "en". */
  sourceLocale?: string;
  /** Marker/label namespace (cosmetic; groups edits). Default the catalog name or "lingui". */
  namespace?: string;
  /** Languages offered in the settings bar (optional; locale switching is best-effort in v1). */
  languages?: LanguageOption[];
};

const PATCH_FLAG = "__designbookLinguiPatched";

/** Extracts the message id from `_`'s first argument (string or descriptor). */
function extractMessageId(id: unknown): string | undefined {
  if (typeof id === "string") return id || undefined;
  if (id && typeof id === "object") {
    const descriptorId = (id as { id?: unknown }).id;
    if (typeof descriptorId === "string") return descriptorId || undefined;
  }
  return undefined;
}

/** True when a message id carries ICU placeholders/plurals or component slots. */
function hasDynamicSyntax(msgid: string): boolean {
  return /[{}]/.test(msgid) || /<\d/.test(msgid);
}

function debugLog(message: string): void {
  if (
    typeof window !== "undefined" &&
    (window as { __designbookDebug?: boolean }).__designbookDebug
  ) {
    console.debug(`[designbook:lingui] ${message}`);
  }
}

/**
 * Creates a Lingui-backed text adapter over an existing `@lingui/core`
 * instance. Wire it explicitly in the config's `adapters`, passing the same
 * `i18n` the repo's `<I18nProvider>` uses.
 */
function linguiAdapter(options: LinguiAdapterOptions): Adapter {
  const { i18n } = options;
  const sourceLocale = options.sourceLocale ?? "en";
  const namespace = options.namespace ?? deriveNamespace(options.catalogPath);

  function currentLocale(): string {
    return i18n.locale || sourceLocale;
  }

  function editPath(): string {
    return options.catalogPath.replace("{locale}", currentLocale());
  }

  /** Wraps a translate fn so its string results carry a decode marker. */
  function marked(original: LinguiTranslate): LinguiTranslate {
    return function markedTranslate(this: unknown, id, values, opts) {
      const result = original.call(i18n, id, values, opts);
      if (typeof result !== "string" || result.length === 0) return result;
      const msgid = extractMessageId(id);
      if (!msgid) return result;
      const index = allocateMarker({ namespace, key: msgid, resolvedKey: msgid });
      return result + encodeMarker(index);
    };
  }

  function patchInstance(): void {
    const flagged = i18n as unknown as Record<string, unknown>;
    if (flagged[PATCH_FLAG]) return;
    // `t` is a pre-bound alias of `_` captured at construction, so patching
    // `_` alone would leave `i18n.t`/context `_` (`i18n.t.bind(i18n)`) unmarked.
    i18n._ = marked(i18n._.bind(i18n) as LinguiTranslate);
    i18n.t = marked(i18n.t.bind(i18n) as LinguiTranslate);
    flagged[PATCH_FLAG] = true;
  }

  function getTemplate(key: string): string | undefined {
    const raw = i18n.messages[key];
    return typeof raw === "string" ? raw : key;
  }

  async function save(msgid: string, next: string): Promise<void> {
    const locale = currentLocale();
    const previous = i18n.messages[msgid];
    // Optimistic: merge the new string so the canvas updates immediately.
    i18n.load({ [locale]: { [msgid]: next } });
    try {
      const response = await fetch(apiUrl("/api/po"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: editPath(), msgid, msgstr: next }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "Failed to save translation");
      }
      notifyFileWritten(editPath());
    } catch (error) {
      // Roll back: restore the prior value, or echo the id (source display).
      i18n.load({
        [locale]: {
          [msgid]: typeof previous === "string" ? previous : msgid,
        },
      });
      throw error instanceof Error
        ? error
        : new Error("Failed to save translation");
    }
  }

  function resolveText(hit: TextNodeHit): TextClaim | null {
    const textHit = textHitTest(hit.element, hit.boundary);
    if (!textHit) return null;

    const msgid = textHit.entry.resolvedKey;
    if (hasDynamicSyntax(msgid)) {
      debugLog(`skipping dynamic message (placeholders/plural): ${msgid}`);
      return null;
    }

    const element = textHit.textNode.parentElement ?? hit.element;
    return {
      adapter: ADAPTER_NAME,
      value: stripMarkers(textHit.textNode.data),
      kind: "keyed",
      key: msgid,
      namespace,
      editPath: editPath(),
      node: textHit.textNode,
      element,
      rect: textHit.rect,
      label: msgid,
      getTemplate,
      save: (next) => save(msgid, next),
      updateLocal: (entries) => {
        const locale = currentLocale();
        for (const { key, value } of entries) {
          i18n.load({ [locale]: { [key]: value } });
        }
      },
    };
  }

  const adapter: Adapter = {
    name: ADAPTER_NAME,
    async setup() {
      patchInstance();
      // Text-only adapter: no Provider (the repo's own <I18nProvider i18n={i18n}>
      // already renders the patched instance) and no dimensions in v1.
      return {};
    },
    resolveText,
  };

  // Decode is synchronous + side-effect-free, so hover reuses resolution.
  adapter.previewText = resolveText;

  return adapter;
}

/** Derives a namespace label from a catalog path, e.g. ".../web.po" → "web". */
function deriveNamespace(catalogPath: string): string {
  const base = catalogPath.split("/").pop() ?? "";
  const name = base.replace(/\.po$/, "").replace("{locale}", "").trim();
  return name || "lingui";
}

export { linguiAdapter };
export type { LinguiAdapterOptions, LinguiI18n };
