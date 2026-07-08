/**
 * Library build for the workbench UI (phase C2.2; multi-entry since C4.5).
 *
 * Produces a prebuilt, host-React-rendered bundle that any page can consume:
 *   - `dist/ui/index.js`    — ESM, entry `src/ui/mount.tsx` (`mountWorkbench`).
 *   - `dist/ui/adapters.js` — ESM, entry `src/ui/adapters/index.ts` (the shipped
 *                             text adapters: theme/flags/i18next/lingui/…).
 *   - `dist/ui/style.css`   — the workbench chrome css, tailwind v4 compiled in.
 *
 * ## One runtime, two entries (the fix for injected mode)
 * `index` and `adapters` are built as TWO rollup entry points in ONE build so
 * the shared internals both reach — the config store (`src/ui/designbook.ts`),
 * `adapterRuntime.ts`, `i18nMarkers`, `textHits`, … — are code-split into shared
 * chunks that BOTH entries import (verify: `dist/ui/adapters.js` and
 * `dist/ui/index.js` must import the SAME `chunk-*.js` for the config store).
 * That guarantees a SINGLE module instance at runtime: the adapters an app
 * imports from `@designbookapp/designbook/adapters` share the workbench's initialized config
 * store / adapterRuntime (right configDir, right API origin) instead of spawning
 * a second, empty copy. This is what makes `@designbookapp/designbook/adapters` usable in
 * injected mode.
 *
 * ## Externals
 * React is externalized (peer) so the host app's single React copy renders us —
 * no duplicate-React/hooks breakage. `i18next` + `react-i18next` are ALSO
 * externalized (optional peers): the i18next adapter's marker-instrumented
 * `<I18nextProvider>` MUST provide the SAME react-i18next context object the
 * app's own components read, or every `useTranslation()` falls through to the
 * app's global instance and reads "hardcoded" (the C4.5 bug-2). Externalizing
 * makes both sides share the app's single react-i18next module. Everything else
 * (radix, codemirror, lucide, …) is bundled. The i18next adapter lives in its
 * own lazily-reached chunk (adapterRuntime dynamic-imports it, and it's a
 * distinct export of the adapters entry), so a NO-i18n app never evaluates the
 * `i18next`/`react-i18next` imports. Not minified, sourcemaps on.
 *
 * The `virtual:designbook-config` coupling is gone (C2.1): `mount.tsx` takes the
 * config as a value, so nothing in this graph needs the dev server's virtual
 * modules. The bridge css import lives only in `main.tsx`, which is not part of
 * this entry.
 */

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const abs = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Internal workbench alias (mirrors tsconfig.ui.json / vitest.config.ts).
      "@designbook-ui": abs("./src/ui"),
      // NOTE: `@designbookapp/designbook/config` is deliberately NOT aliased here — it is
      // externalized (see rollupOptions.external) so the runtime resolves ONE
      // shared instance. Bundling a copy into dist/ui gave the workbench its
      // own private DatasetContext while the user's config file read the
      // aliased dist/config copy → useDataset() fell through to defaultDataset
      // (data: undefined) in injected mode (the dual-instance bug family).
      "@designbookapp/designbook/adapters": abs("./src/ui/adapters/index.ts"),
      // Fonts → system fallback in lib mode (see shims/empty.css). Avoids
      // embedding font binaries / emitting separate font assets.
      "@fontsource-variable/geist": abs("./src/ui/shims/empty.css"),
    },
  },
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    cssCodeSplit: false,
    lib: {
      // Two entries in ONE build → rollup code-splits shared internals into
      // shared chunks both entries import (single runtime; see file header).
      entry: {
        index: abs("./src/ui/mount.tsx"),
        adapters: abs("./src/ui/adapters/index.ts"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // Host React renders the workbench — keep these as peers. i18next +
      // react-i18next are externalized too (optional peers) so the i18next
      // adapter shares the APP's single react-i18next context (bug-2 fix).
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        /^i18next(\/.*)?$/,
        /^react-i18next(\/.*)?$/,
        // One shared config-API instance (DatasetContext identity): injected
        // mode aliases this to dist/config/index.js for the app config AND
        // these chunks alike; host mode aliases it to src. See alias note.
        /^@designbookapp\/designbook\/config$/,
      ],
      output: {
        // Emit the single bundled stylesheet as a stable `style.css`.
        assetFileNames: (asset) => {
          const name = asset.names?.[0] ?? asset.name ?? "";
          return name.endsWith(".css") ? "style.css" : "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
