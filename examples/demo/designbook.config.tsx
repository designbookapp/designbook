import { defineConfig, fromGlob, useDataset } from "@designbookapp/designbook/config";
import { flagsAdapter, themeAdapter } from "@designbookapp/designbook/adapters";
import type { ReactNode } from "react";
import "./src/index.css";
import { Badge } from "./src/components/ui/badge";
import { Button } from "./src/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "./src/components/ui/card";
import { Skeleton } from "./src/components/ui/skeleton";
import * as productAtoms from "./src/composite/product/atoms";
import { ProductProvider } from "./src/composite/product/context";
import type { DemoData } from "./src/data/products";
import { datasets } from "./src/data/products";
import { FlagsProvider } from "./src/providers/FlagsProvider";
import { LanguageProvider } from "./src/providers/LanguageProvider";
import { ThemeProvider } from "./src/providers/ThemeProvider";

/** Feeds the first product of the active dataset to product composites. */
function ProductWrapper({ children }: { children: ReactNode }) {
  const { data } = useDataset<DemoData>();
  return (
    <ProductProvider product={data.products[0]} currency={data.currency}>
      {children}
    </ProductProvider>
  );
}

export default defineConfig({
  title: "Demo Shop",

  sets: [
    {
      id: "product",
      title: "Shop/Product",
      // Variants register lazily via a glob (per-cell code-split + fault
      // isolation); their file basename maps to the ProductXxx entry key. Atoms
      // stay static — several live in one file, so they can't be file-derived.
      components: {
        ...fromGlob(
          import.meta.glob("./src/composite/product/variants/*.tsx"),
          { key: (path) => `Product${path.split("/").pop()!.replace(/\.tsx?$/, "")}` },
        ),
        ...productAtoms,
      },
      wrapper: ProductWrapper,
    },
    {
      id: "search",
      title: "Shop/Search",
      // One file per component — glob keys are the basenames directly, and the
      // code panel's source path comes free from the glob key (no sourceModules).
      components: fromGlob(
        import.meta.glob("./src/composite/search/variants/*.tsx"),
      ),
    },
    {
      id: "primitives",
      title: "Primitives",
      components: {
        Button,
        Badge,
        Skeleton,
        Card,
        CardHeader,
        CardContent,
        CardFooter,
      },
      overrides: {
        Button: {
          matrixAxes: [
            {
              name: "Variant",
              values: [
                "default",
                "secondary",
                "outline",
                "destructive",
                "ghost",
                "link",
              ],
            },
            { name: "Size", values: ["default", "sm", "lg", "icon"] },
            { name: "State", values: ["Default", "Disabled"] },
          ],
        },
      },
    },
  ],

  flows: [
    {
      id: "booking",
      title: "Shop/Booking funnel",
      screens: [
        {
          id: "search-results",
          label: "Search results",
          description: "Trip search results with filters.",
          registryId: "search.ResultsList",
          previews: [
            {
              wireframeKind: "bar",
              wireframeStrings: ["Filters", "Sort by price", "Dates"],
            },
            { rendererId: "search.ResultsList" },
          ],
        },
        {
          id: "product-details",
          label: "Trip details",
          description: "Trip detail page with booking call-to-action.",
          registryId: "product.ProductDetailSection",
        },
        {
          id: "checkout",
          label: "Checkout",
          description: "Traveller details and payment.",
          wireframeKind: "form",
          wireframeStrings: ["Traveller details", "Payment", "Confirm"],
        },
      ],
    },
  ],

  datasets,

  // Only static entries need sourceModules for code-panel attribution; the
  // glob-registered variants/search sets self-attribute from their glob key.
  sourceModules: import.meta.glob(
    ["./src/composite/*/atoms.tsx", "./src/components/ui/*.tsx"],
    { eager: true },
  ),

  providers: [ThemeProvider, LanguageProvider],

  adapters: [
    themeAdapter({
      source: "./src/index.css",
      modes: { light: ":root", dark: ".dark" },
      variants: {
        source: import.meta.glob("./src/themes.json", {
          eager: true,
          import: "default",
        }),
        sourcePath: "./src/themes.json",
        labels: { forest: "Forest", sunset: "Sunset" },
      },
    }),
    flagsAdapter({
      Provider: FlagsProvider,
      source: import.meta.glob("./src/flags/*.json", {
        eager: true,
        import: "default",
      }),
      sourcePath: "./src/flags/tenants.json",
      flags: {
        newCheckout: { label: "New checkout", control: "toggle" },
        density: {
          label: "Density",
          control: "select",
          options: ["comfortable", "compact"],
        },
      },
    }),
  ],

  i18n: {
    resources: import.meta.glob("./locales/*/app.json", {
      eager: true,
      import: "default",
    }),
    languages: [
      { id: "en-US", label: "EN" },
      { id: "fr-FR", label: "FR" },
      { id: "es-419", label: "ES" },
    ],
    defaultLocale: "en-US",
    defaultNamespace: "app",
    localePath: "./locales/{locale}/{namespace}.json",
  },
});
