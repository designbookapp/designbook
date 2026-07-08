/**
 * i18next text adapter — the keyed catalog editor for the canvas text tool.
 *
 * Owns a workbench-private i18next instance built from the config's locale
 * resources, registers the invisible-marker postProcessor so rendered strings
 * carry their key back to the tool, and provides the rich placeholder/plural
 * editor plus live language switching. All behavior that used to live in the
 * hardcoded `@designbook-ui/i18n` module now lives here.
 */

import i18next, { type Resource } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { createElement, type ReactNode } from "react";
import { apiUrl } from "@designbook-ui/designbook";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";
import type {
  Adapter,
  I18nConfig,
  LanguageOption,
  PlaceholderMeta,
  PluralForm,
  TextClaim,
  TextNodeHit,
} from "@designbookapp/designbook/config";
import {
  designMarkerPostProcessor,
  stripMarkers,
} from "@designbook-ui/models/text/i18nMarkers";
import { textHitTest } from "@designbook-ui/models/text/textHits";
import { resolvePluralForms, stripPluralSuffix } from "@designbook-ui/models/text/pluralForms";

const ADAPTER_NAME = "i18next";
const DEFAULT_LOCALE_KEY_PATTERN = /locales\/([^/]+)\/([^/]+)\.json$/;

type I18nextAdapterOptions = {
  /**
   * Maps an `import.meta.glob` key to its locale + namespace. Replaces the
   * default `…locales/<locale>/<namespace>.json` matcher for non-standard
   * layouts. Returning `null` skips the file.
   */
  parseResourceKey?: (
    globKey: string,
  ) => { locale: string; namespace: string } | null;
};

function defaultParseResourceKey(
  globKey: string,
): { locale: string; namespace: string } | null {
  const match = globKey.match(DEFAULT_LOCALE_KEY_PATTERN);
  if (!match) return null;
  return { locale: match[1], namespace: match[2] };
}

/**
 * Creates an i18next-backed text adapter. Pass the same shape accepted by the
 * config's `i18n` field. Used automatically (as sugar) when a config sets
 * `i18n` without listing an explicit i18next adapter.
 */
function i18nextAdapter(
  i18nConfig?: I18nConfig,
  options: I18nextAdapterOptions = {},
): Adapter {
  const parseResourceKey = options.parseResourceKey ?? defaultParseResourceKey;

  const resources: Record<string, Record<string, unknown>> = {};
  const namespaces: string[] = [];
  for (const [globKey, strings] of Object.entries(
    i18nConfig?.resources ?? {},
  )) {
    const parsed = parseResourceKey(globKey);
    if (!parsed) continue;
    const { locale, namespace } = parsed;
    resources[locale] ??= {};
    resources[locale][namespace] = strings;
    if (!namespaces.includes(namespace)) namespaces.push(namespace);
  }

  const defaultLocale = i18nConfig?.defaultLocale ?? "en-US";
  const defaultNamespace =
    i18nConfig?.defaultNamespace ?? namespaces[0] ?? "translation";
  const languages: LanguageOption[] =
    i18nConfig?.languages ??
    Object.keys(resources).map((id) => ({
      id,
      label: id.split("-")[0].toUpperCase(),
    }));

  const instance = i18next.createInstance();

  /**
   * The locale the canvas is currently showing — driven by the `locale`
   * dimension via `changeLanguage`. Edits must read/write THIS locale's catalog,
   * not the default, or editing while viewing e.g. `fr-FR` would write `en-US`.
   */
  function currentLocale(): string {
    return instance.language || defaultLocale;
  }

  function localeEditPath(namespace: string): string {
    const template =
      i18nConfig?.localePath ?? "./locales/{locale}/{namespace}.json";
    return template
      .replace("{locale}", currentLocale())
      .replace("{namespace}", namespace);
  }

  function getTemplate(namespace: string, key: string): string | undefined {
    const raw = instance.getResource(currentLocale(), namespace, key);
    return typeof raw === "string" ? raw : undefined;
  }

  function getPluralForms(namespace: string, resolvedKey: string): PluralForm[] {
    return resolvePluralForms(resolvedKey, (candidateKey) =>
      getTemplate(namespace, candidateKey),
    );
  }

  function getPlaceholderMeta(
    namespace: string,
    resolvedKey: string,
  ): PlaceholderMeta[] {
    const baseKey = stripPluralSuffix(resolvedKey);
    // Placeholder metadata is usually authored once in the default locale;
    // read the current locale first, then fall back so it shows in any locale.
    const meta = (instance.getResource(
      currentLocale(),
      namespace,
      `@${baseKey}`,
    ) ?? instance.getResource(defaultLocale, namespace, `@${baseKey}`)) as
      | {
          placeholders?: Record<
            string,
            { example?: string; description?: string }
          >;
        }
      | undefined;
    if (!meta?.placeholders) return [];
    return Object.entries(meta.placeholders).map(([name, info]) => ({
      name,
      example: info.example,
      description: info.description,
    }));
  }

  function updateLocal(
    namespace: string,
    entries: Array<{ key: string; value: string }>,
  ) {
    for (const { key, value } of entries) {
      instance.addResource(currentLocale(), namespace, key, value);
    }
  }

  /** Optimistically applies edits, persists them, and rolls back + throws on failure. */
  async function saveEntries(
    namespace: string,
    entries: Array<{ key: string; value: string }>,
  ) {
    const previous = entries.map(({ key }) => ({
      key,
      value: getTemplate(namespace, key),
    }));
    updateLocal(namespace, entries);
    try {
      const response = await fetch(apiUrl("/api/i18n"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: localeEditPath(namespace), entries }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "Failed to save translation");
      }
      notifyFileWritten(localeEditPath(namespace));
    } catch (error) {
      for (const { key, value } of previous) {
        if (typeof value === "string") {
          instance.addResource(currentLocale(), namespace, key, value);
        }
      }
      throw error instanceof Error
        ? error
        : new Error("Failed to save translation");
    }
  }

  const adapter: Adapter = {
    name: ADAPTER_NAME,

    async setup() {
      if (!instance.isInitialized) {
        const supportedLngs = [
          ...new Set([
            defaultLocale,
            ...languages.map((option) => option.id),
            ...Object.keys(resources),
          ]),
        ];
        await instance
          .use(initReactI18next)
          .use(designMarkerPostProcessor)
          .init({
            lng: defaultLocale,
            fallbackLng: defaultLocale,
            supportedLngs,
            ns: namespaces.length > 0 ? namespaces : [defaultNamespace],
            defaultNS: defaultNamespace,
            resources: resources as Resource,
            postProcess: ["designMarker"],
            react: { useSuspense: false, bindI18nStore: "added removed" },
            interpolation: { escapeValue: false },
            returnNull: false,
            returnEmptyString: false,
          });
      }

      const Provider = ({ children }: { children: ReactNode }) =>
        createElement(I18nextProvider, { i18n: instance }, children);

      return {
        Provider,
        // Locale is now a normal context dimension; switching it drives
        // `i18n.changeLanguage`. `languages`/`setLocale` are kept for
        // back-compat with anything still reading the old locale shape.
        dimensions: [
          {
            id: "locale",
            label: "Language",
            options: languages.map((language) => ({
              value: language.id,
              label: language.label,
            })),
            defaultValue: defaultLocale,
          },
        ],
        onContextChange: (id: string, value: string) => {
          if (id === "locale") {
            return instance.changeLanguage(value).then(() => {});
          }
        },
        setLocale: (locale: string) =>
          instance.changeLanguage(locale).then(() => {}),
        languages,
        defaultLocale,
      };
    },

    resolveText(hit: TextNodeHit): TextClaim | null {
      const textHit = textHitTest(hit.element, hit.boundary);
      if (!textHit) return null;

      const { namespace, resolvedKey } = textHit.entry;
      const element = textHit.textNode.parentElement ?? hit.element;

      return {
        adapter: ADAPTER_NAME,
        value: stripMarkers(textHit.textNode.data),
        kind: "keyed",
        key: resolvedKey,
        namespace,
        editPath: localeEditPath(namespace),
        node: textHit.textNode,
        element,
        rect: textHit.rect,
        label: resolvedKey,
        getTemplate: (key) => getTemplate(namespace, key),
        pluralForms: getPluralForms(namespace, resolvedKey),
        placeholders: getPlaceholderMeta(namespace, resolvedKey),
        save: (next) => saveEntries(namespace, [{ key: resolvedKey, value: next }]),
        saveEntries: (entries) => saveEntries(namespace, entries),
        updateLocal: (entries) => updateLocal(namespace, entries),
      };
    },
  };

  // Marker decoding is synchronous and side-effect-free, so hover previewing
  // reuses the same resolution.
  adapter.previewText = adapter.resolveText as (
    hit: TextNodeHit,
  ) => TextClaim | null;

  return adapter;
}

export { i18nextAdapter };
export type { I18nextAdapterOptions };
