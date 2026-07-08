import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { designbookPlugin } from "@designbookapp/designbook";

// Injected mode: the app's OWN dev server runs the workbench overlay via
// designbookPlugin, backed by the API sidecar on 8794 (started by
// `designbook dev`, which proxies this server on 8794).
export default defineConfig({
  plugins: [
    react(),
    designbookPlugin({
      config: "./designbook.config.tsx",
      serverUrl: "http://localhost:8794",
    }),
  ],
});
