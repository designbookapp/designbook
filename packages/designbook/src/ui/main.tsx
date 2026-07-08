/**
 * Dev-server bootstrap. The node server aliases the user's config file to
 * `virtual:designbook-config`; this thin entry imports it and hands it to
 * `mountWorkbench`. The library entry (src/ui/mount.tsx) has no knowledge of
 * the virtual module — that coupling lives only here.
 */

import { config, configDir } from "virtual:designbook-config";
import { mountWorkbench } from "./mount";
// Tailwind v3 -> v4 token bridge. Empty (no-op) unless the target repo uses
// Tailwind v3, in which case the node server serves the synthesized @theme css.
// Server-only: not part of the library build.
import "virtual:designbook-tailwind-bridge.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root element was not found.");
}

mountWorkbench({ container, config, configDir });
