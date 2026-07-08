import { defineConfig, fromGlob } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "Init App",

  sets: [
    {
      id: "primitives",
      title: "Primitives",
      // Register every component file lazily. Each cell code-splits through the
      // app's own bundler, so one broken component is one red cell; the code
      // panel's source path comes free from the glob key (nothing to register
      // manually for these entries).
      components: fromGlob(import.meta.glob("./src/components/*.tsx")),
      // overrides: {
      //   Button: {
      //     matrixAxes: [
      //       { name: "Variant", values: ["primary", "secondary", "danger"] },
      //     ],
      //   },
      // },
    },
  ],
});
