/**
 * Instance-instrumentation fallback for the live-page text tool (M spec, M2,
 * step 4) — the no-transform path.
 *
 * When the build transform is disabled (`pageTextTransform: false`), the app's
 * `t()` calls are NOT rewritten, so markers can't be appended per call site.
 * Instead we register designbook's marker postProcessor on the app's REAL
 * i18next instance (handed over via `config.pageText.i18n`) and toggle
 * `options.postProcess` with the tool — every resolved string then carries a
 * marker exactly as the workbench's own instance does on the canvas. The pure
 * `postProcess`-list helpers are unit-tested; the `i18next.use()` registration
 * is exercised against a mock instance (live e2e of this path is deferred — the
 * M2 fixture uses the transform).
 */

import { designMarkerPostProcessor } from "@designbook-ui/models/text/i18nMarkers";

const MARKER_NAME = "designMarker";

/** The slice of an i18next instance this fallback drives. */
type InstrumentableI18n = {
  options?: { postProcess?: string | string[] };
  modules?: { postProcessor?: Record<string, unknown> };
  use?: (module: unknown) => unknown;
};

/** Normalize i18next's `postProcess` (string | string[] | undefined) to a list. */
function toList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string" && value) return [value];
  return [];
}

/** Add the marker postProcessor to a `postProcess` list (idempotent). */
function withMarker(value: string | string[] | undefined): string[] {
  const list = toList(value);
  return list.includes(MARKER_NAME) ? list : [...list, MARKER_NAME];
}

/** Remove the marker postProcessor from a `postProcess` list. */
function withoutMarker(value: string | string[] | undefined): string[] {
  return toList(value).filter((name) => name !== MARKER_NAME);
}

/** Whether the marker postProcessor appears registered on the instance. */
function hasProcessor(i18n: InstrumentableI18n): boolean {
  return Boolean(i18n.modules?.postProcessor?.[MARKER_NAME]);
}

/**
 * Register (once) + enable marker attribution on the app instance. Returns true
 * when the instance was usable. Registration uses `use()` when the processor
 * isn't already present; enabling appends the name to `options.postProcess`.
 */
function armInstanceInstrumentation(
  i18n: InstrumentableI18n | undefined,
  processor: unknown = designMarkerPostProcessor,
): boolean {
  if (!i18n) return false;
  if (typeof i18n.use === "function" && !hasProcessor(i18n)) {
    i18n.use(processor);
  }
  i18n.options ??= {};
  i18n.options.postProcess = withMarker(i18n.options.postProcess);
  return true;
}

/** Disable marker attribution (leaves the processor registered, harmless). */
function disarmInstanceInstrumentation(
  i18n: InstrumentableI18n | undefined,
): boolean {
  if (!i18n?.options) return false;
  i18n.options.postProcess = withoutMarker(i18n.options.postProcess);
  return true;
}

export {
  MARKER_NAME,
  armInstanceInstrumentation,
  disarmInstanceInstrumentation,
  hasProcessor,
  withMarker,
  withoutMarker,
};
export type { InstrumentableI18n };
