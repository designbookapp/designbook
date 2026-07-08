/**
 * Canvas-theming constants with no imports, so modules that only need the class
 * name (e.g. the theme adapter's live-preview injection) don't pull in
 * `themes.ts` — which reads the virtual config at module init and would form an
 * import cycle when reached through the `@designbookapp/designbook/adapters` barrel.
 */

/** Class on the preview container that scopes injected theme CSS variables. */
export const CANVAS_THEME_CLASS = "designbook-theme";
