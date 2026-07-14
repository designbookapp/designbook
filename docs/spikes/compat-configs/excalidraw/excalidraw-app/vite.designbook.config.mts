import path from "path";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";

// C3.1: run excalidraw's REAL vite config + the real `designbookPlugin()`.
// No spike shim — the plugin injects its own module-script entry (toolbar +
// prebuilt workbench overlay) into their dev server, backed by the designbook
// API sidecar reached cross-origin via `serverUrl`.
//
// We only (a) drop vite-plugin-checker (known to crash the dev server on this
// repo; pure dev-tooling noise) — a user-side quirk the plugin must NOT touch
// itself — and (b) append designbookPlugin().
import theirConfig from "./vite.config.mts";
// The designbook plugin, prebuilt (dist/node). Its resolveId/load serve the
// boot module; it also opens `server.fs.allow` for the out-of-root dist/ui.
import { designbookPlugin } from "../../../packages/designbook/dist/node/plugin.js";

// The host-mode designbook config already living at the excalidraw repo root
// (reused from the compat work). Compiled by THEIR pipeline at boot.
const designbookConfig = path.resolve(__dirname, "../designbook.config.tsx");

export default defineConfig((env: ConfigEnv): UserConfig => {
  const base = (
    typeof theirConfig === "function" ? theirConfig(env) : theirConfig
  ) as UserConfig;

  const plugins = (base.plugins ?? []).filter((p) => {
    const name = (p as { name?: string })?.name ?? "";
    return !String(name).includes("checker");
  });
  plugins.push(
    designbookPlugin({
      config: designbookConfig,
      serverUrl: "http://localhost:8790",
    }),
  );

  return {
    ...base,
    plugins,
    server: {
      ...(base.server ?? {}),
      open: false,
    },
  };
});
