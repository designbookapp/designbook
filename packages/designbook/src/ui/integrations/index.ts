/**
 * The workbench-side integration seam (`@designbook-ui/integrations`).
 *
 * Two audiences:
 *   - core (mount/Workbench): init + tab registry + token sources;
 *   - integration plugin UI code (src/plugins/figma/ui/…), which may import
 *     ONLY this module, `@designbook-ui/previewHost`, the shared UI
 *     primitives (`@designbook-ui/components`, `@designbook-ui/lib`), and the
 *     public config entry — enforced by the integration import-lint test.
 *
 * The re-exports below are the curated core surface plugins get: API-origin
 * resolution, the open-entry/adapter context, catalog identity lookups, and
 * text-marker helpers (the figma serializer's needs).
 */

export {
  getIntegrationOptions,
  getIntegrationTabs,
  initUiIntegrations,
  resetUiIntegrations,
} from "./registry";
export type { IntegrationTab, UiIntegration } from "./registry";

export {
  getTokenSources,
  registerTokenSource,
  resetTokenSources,
  subscribeTokenSources,
  unregisterTokenSource,
} from "./tokenSources";

// --- Curated core surface for plugin UI code --------------------------------

// API-origin resolution + repo-path mapping (every /api fetch goes through
// apiUrl; see src/ui/designbook.ts).
export { apiUrl, repoPathFromGlobKey } from "@designbook-ui/designbook";

// Adapter runtime facts (context dimension values for push metadata).
export { getAdapterRuntime } from "@designbook-ui/adapterRuntime";

// Catalog identity (nested-component detection in serializers).
export {
  registryByName,
  registryByRef,
} from "@designbook-ui/models/catalog/componentRegistry";

// i18n text markers (serializers strip/attribute canvas text markers).
export {
  decodeMarker,
  getMarkerEntry,
  stripMarkers,
} from "@designbook-ui/models/text/i18nMarkers";

// The canvas theme scope class (token probing happens inside it).
export { CANVAS_THEME_CLASS } from "@designbook-ui/models/configState/themeConstants";

// Public seam types, re-exported so plugin UI files have a single import.
export type {
  IntegrationEntryRef,
  PluginScreenProps,
  PluginTabSpec,
  PluginUiSpec,
  SelectionContextContribution,
  SelectionContextContributor,
  SelectionContextFact,
  SelectionContextRunCtx,
  SelectionContextSelection,
  SerializeEntryOptions,
  TokenSource,
  TokenSourceToken,
} from "../../integration/index.ts";
