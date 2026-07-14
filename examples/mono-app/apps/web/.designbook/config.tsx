import { defineConfig, fromGlob } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "Web",

  sets: [
    {
      id: "primitives",
      title: "Primitives",
      // Register every component file lazily. Each cell code-splits through the
      // app's own bundler, so one broken component is one red cell; the code
      // panel's source path comes free from the glob key (nothing to register
      // manually for these entries).
      // Adjusted from init's default (../src/*.tsx): reach the workspace lib.
      // Relative to .designbook/, so ../../../ climbs to the monorepo root.
      components: fromGlob(import.meta.glob("../../../packages/ui/src/*.tsx")),
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
