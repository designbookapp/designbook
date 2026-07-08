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
      serverUrl: "http://localhost:8788",
    }),
  ],
});
