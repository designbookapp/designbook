import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@designbook-ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
      // Resolve package self-references to source (mirrors vite.lib.config.ts) so
      // tests never depend on a freshly built dist/config.
      "@designbookapp/designbook/config": fileURLToPath(
        new URL("./src/config/index.ts", import.meta.url),
      ),
      "@designbookapp/designbook/adapters": fileURLToPath(
        new URL("./src/ui/adapters/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
