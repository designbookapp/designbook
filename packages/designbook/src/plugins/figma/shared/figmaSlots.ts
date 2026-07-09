/**
 * Pure i18n slot-naming helpers shared by the Figma push (render.ts) and pull
 * (readHtml.ts) paths: the
 * `#i18n.<ns>.<key>` layer-name / `i18n.<ns>.<key>` component-property-name
 * convention, and the dotted `<ns>.<key>` value that lands in the `data-i18n`
 * HTML attribute. i18next keys themselves contain dots, so the split rule is:
 * the FIRST dot-delimited segment is the NAMESPACE, the entire remainder (dots
 * preserved) is the KEY. The namespace is ALWAYS explicit on push (defaults to
 * `defaultNamespace`).
 *
 * Framework-free and ES2017-safe: compiled by the node/ui tsconfigs AND by the
 * Figma plugin's tsconfig.
 */

/** Fallback namespace when a string doesn't carry one (commonly "app"). */
const DEFAULT_NAMESPACE = "app";
/** Prefix marking an i18n slot (after any leading `#`). */
const I18N_PREFIX = "i18n.";

type I18nParts = { namespace: string; key: string };

/** All three related strings for one i18n binding. */
type I18nBinding = {
  /** Figma layer name: `#i18n.<ns>.<key>` (the `#name` fallback convention). */
  layerName: string;
  /** Component-property name: `i18n.<ns>.<key>` (no leading `#`). */
  propertyName: string;
  /** `data-i18n` attribute value: `<ns>.<key>` (dotted). */
  value: string;
};

function resolveNamespace(
  namespace: string | undefined,
  defaultNamespace: string,
): string {
  return namespace && namespace.length > 0 ? namespace : defaultNamespace;
}

/**
 * Builds the layer/property/value strings for an i18n slot. The namespace is
 * always explicit (falls back to `defaultNamespace`).
 */
function i18nBinding(
  namespace: string | undefined,
  key: string,
  defaultNamespace: string = DEFAULT_NAMESPACE,
): I18nBinding {
  const value = `${resolveNamespace(namespace, defaultNamespace)}.${key}`;
  return {
    layerName: `#${I18N_PREFIX}${value}`,
    propertyName: `${I18N_PREFIX}${value}`,
    value,
  };
}

/** Is a hash-stripped slot / component-property name an i18n binding? */
function isI18nSlotName(name: string): boolean {
  return name.indexOf(I18N_PREFIX) === 0;
}

/** The `data-i18n` value (`<ns>.<key>`) from a hash-stripped i18n slot name. */
function i18nValueFromSlotName(name: string): string {
  return name.slice(I18N_PREFIX.length);
}

/**
 * Splits a dotted i18n value into namespace + key: the FIRST segment is the
 * namespace, the remainder (dots preserved) is the key. `app.cart.add.button`
 * → { namespace: "app", key: "cart.add.button" }.
 */
function parseI18nValue(value: string): I18nParts {
  const dot = value.indexOf(".");
  if (dot === -1) return { namespace: DEFAULT_NAMESPACE, key: value };
  return { namespace: value.slice(0, dot), key: value.slice(dot + 1) };
}

export {
  DEFAULT_NAMESPACE,
  i18nBinding,
  i18nValueFromSlotName,
  isI18nSlotName,
  parseI18nValue,
};
export type { I18nBinding, I18nParts };
