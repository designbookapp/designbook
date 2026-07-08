import i18next from "i18next";
import { initReactI18next } from "react-i18next";

/** Standalone-app i18n init; under designbook the workbench initializes i18n from the config instead. */
const localeModules = import.meta.glob<Record<string, unknown>>(
  "../locales/*/app.json",
  { eager: true, import: "default" },
);

function buildResources() {
  const resources: Record<string, { app: Record<string, unknown> }> = {};
  for (const [path, strings] of Object.entries(localeModules)) {
    const locale = path.match(/locales\/([^/]+)\//)?.[1];
    if (locale) {
      resources[locale] = { app: strings };
    }
  }
  return resources;
}

export async function initI18n() {
  await i18next.use(initReactI18next).init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["app"],
    defaultNS: "app",
    resources: buildResources(),
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
  });
  return i18next;
}
