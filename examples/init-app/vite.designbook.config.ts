import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import { designbookPlugin } from "@designbookapp/designbook";
import baseConfig from "./vite.config";

// Runs the app's REAL vite config plus designbookPlugin(), which injects the
// designbook toolbar + workbench overlay into the app's own dev server. Only
// used by the "design" script; the normal build is untouched.
export default defineConfig((env: ConfigEnv): UserConfig => {
  const base = (
    typeof baseConfig === "function" ? baseConfig(env) : baseConfig
  ) as UserConfig;

  // Drop any vite-plugin-checker (it can crash the dev server; pure dev noise).
  const plugins = (base.plugins ?? []).filter((p) => {
    const name = (p as { name?: string })?.name ?? "";
    return !String(name).includes("checker");
  });

  plugins.push(
    designbookPlugin({
      config: "./designbook.config.tsx",
      // Must match the sidecar port from `designbook dev --port`.
      serverUrl: "http://localhost:8793",
    }),
  );

  return { ...base, plugins, server: { ...(base.server ?? {}), open: false } };
});
