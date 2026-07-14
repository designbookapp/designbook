import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A distinctive same-origin /api/health the app owns. If designbook's proxy
// intercepted /api/*, this would be shadowed — the e2e checks it is NOT.
export default defineConfig({
  plugins: [
    react(),
    {
      name: "app-health",
      configureServer(server) {
        server.middlewares.use("/api/health", (_req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              app: "mono-web",
              status: "healthy",
              marker: "THE-APPS-OWN-API",
            }),
          );
        });
      },
    },
  ],
});
