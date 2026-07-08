/**
 * Public entry for the shipped text adapters (`@designbookapp/designbook/adapters`). Import
 * the adapter types from `@designbookapp/designbook/config`.
 */

export { flagsAdapter } from "./flags";
export type {
  FlagsAdapterOptions,
  FlagsProviderProps,
  FlagSpec,
} from "./flags";
export { i18nextAdapter } from "./i18next";
export type { I18nextAdapterOptions } from "./i18next";
export { linguiAdapter } from "./lingui";
export type { LinguiAdapterOptions, LinguiI18n } from "./lingui";
export { themeAdapter } from "./theme";
export type { ThemeAdapterOptions } from "./theme";
export { sourceLiteralAdapter } from "./sourceLiteralAdapter";
