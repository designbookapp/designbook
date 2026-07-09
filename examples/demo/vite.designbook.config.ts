import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { designbookPlugin } from "@designbookapp/designbook";

// Injected mode: the demo app's own dev server plus the designbook toolbar
// (page tools / workbench overlay), backed by the sidecar started by
// `pnpm dev` on 8788. The plain app config stays untouched (dev:plain).
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    designbookPlugin({
      config: "./designbook.config.tsx",
      // Env-overridable so a sidecar on a non-default port (verification
      // runs, parallel checkouts, branch worktrees inheriting this file)
      // can be targeted without editing the config.
      serverUrl:
        process.env.DESIGNBOOK_SERVER_URL ?? "http://localhost:8788",
    }),
  ],
});
