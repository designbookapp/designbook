// Config compiled by THEIR vite. It imports a component-adjacent value through
// the app's own `@excalidraw/*` alias (resolved from THEIR vite.config), with
// ZERO designbook userVite bridging. The overlay reads `registry` to mount the
// canvas cells. This module is the K3 proof: curl its transformed output and
// the @excalidraw/common import must resolve to the app's source path.
import { COLOR_PALETTE } from "@excalidraw/common";

export type CellEntry = {
  id: string;
  title: string;
  load: () => Promise<{ default: React.ComponentType }>;
};

// Proof the alias resolved through their build (used as chrome accent).
export const accentColor: string = COLOR_PALETTE.blue[3];

export const registry: CellEntry[] = [
  {
    id: "Island",
    title: "Island",
    load: () => import("./cells/IslandCell"),
  },
  {
    id: "FilledButton",
    title: "FilledButton",
    load: () => import("./cells/FilledButtonCell"),
  },
  {
    id: "Card",
    title: "Card",
    load: () => import("./cells/CardCell"),
  },
];
