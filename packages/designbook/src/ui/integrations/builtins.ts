/**
 * Built-in integration ui halves (B1): static imports, no discovery. This is
 * one of the TWO whitelisted files allowed to import an integration plugin's
 * entry module (the other is src/node/integrations/builtins.ts for node
 * halves) — enforced by the integration import-lint test.
 */

import type { UiIntegration } from "./registry";
import { figmaUi } from "../../plugins/figma/ui";

const builtinUiIntegrations: UiIntegration[] = [
  { name: "figma", ui: figmaUi },
];

export { builtinUiIntegrations };
