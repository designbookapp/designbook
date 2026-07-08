import { defineConfig, fromGlob } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "TW4 App",
  sets: [
    {
      id: "components",
      title: "Components",
      components: fromGlob(import.meta.glob("./src/components/*.tsx")),
    },
  ],
});
