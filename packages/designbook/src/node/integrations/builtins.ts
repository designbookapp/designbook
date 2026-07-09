/**
 * Built-in integration node halves (B1): static imports, no discovery. This
 * is one of the TWO whitelisted files allowed to import an integration
 * plugin's entry module (the other is src/ui/integrations/builtins.ts for ui
 * halves) — enforced by the integration import-lint test. External-package
 * auto-discovery (a package.json marker) is S6, post-launch.
 */

import type { NodeIntegration } from "../integration/registry.ts";
import { figmaNode } from "../../plugins/figma/node/index.ts";

function builtinNodeIntegrations(): NodeIntegration[] {
  return [{ name: "figma", node: figmaNode() }];
}

export { builtinNodeIntegrations };
