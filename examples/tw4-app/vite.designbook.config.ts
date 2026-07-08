import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import { designbookPlugin } from "@designbookapp/designbook";
import baseConfig from "./vite.config";

// App's real vite config + designbookPlugin(): injects the designbook toolbar +
// workbench overlay into the app's own dev server (shadow-isolated chrome).
export default defineConfig((env: ConfigEnv): UserConfig => {
  const base = (
    typeof baseConfig === "function" ? baseConfig(env) : baseConfig
  ) as UserConfig;

  const plugins = base.plugins ?? [];
  plugins.push(
    designbookPlugin({
      config: "./designbook.config.tsx",
      serverUrl: "http://localhost:8795",
    }),
  );

  return { ...base, plugins, server: { ...(base.server ?? {}), open: false } };
});
