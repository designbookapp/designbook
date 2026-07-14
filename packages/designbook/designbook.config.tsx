/**
 * Designbook's own dogfood config — self-host (R spec, docs/specs/r-ui-reorg.md
 * "Dogfood location" decision). Runs the workbench against its OWN
 * components/models in host mode: `pnpm --filter '@designbookapp/designbook' dogfood` (or
 * `designbook designbook.config.tsx` from this directory). Doubles as the
 * "component-library mode" showcase — a repo with no app of its own can still
 * register components + fixture-fed data models.
 *
 * Registers three sets:
 *   - `primitives` — a handful of shadcn/ui primitives (Button, Badge, Card,
 *     …), rendered bare (no wrapper/props), same convention as
 *     examples/demo's primitives set.
 *   - `chrome` — two PROMOTED PURE workbench components (SelectionToolbar,
 *     SideRail — `src/ui/components/`), fed representative sample props.
 *   - `models` — one cell per data model (`src/ui/models/<model>`) wrapping its
 *     Provider in `data` (fixture) mode and rendering a few of its atoms. All
 *     seven R-reorg models are covered: text, catalog, selection, configState,
 *     branch, chat, frame.
 * Plus one flow stitching three model cells into a "tour".
 *
 * ## The one real self-host wrinkle
 * Every `models/*` entry is registered via `lazy()` (a dynamic `import()`),
 * NOT a static import at the top of this file. Reason: this config lives
 * INSIDE the package it configures, so its top-level import graph is
 * evaluated as part of `virtual:designbook-config` — BEFORE `mountWorkbench`
 * calls `initConfigStore`. Two models' Providers (`catalog`, `text`) reach
 * `componentRegistry.ts` as a plain VALUE import (`registry`/`registryByRef`/
 * `registryByName` — catalog directly; text via the `previewHost` seam, which
 * re-exports catalog's registry lookups for fiber hit-testing), and that
 * module computes its registry ONCE, eagerly, at module-evaluation time, from
 * whatever `@designbook-ui/designbook`'s `sets` binding holds at that exact
 * moment. Import either Provider from this file's top level and that
 * evaluation happens too early — `sets` is still `[]` — permanently freezing
 * the REAL workbench's own registry empty (confirmed by instrumenting both
 * modules with timestamps: componentRegistry ran ~4ms before initConfigStore
 * on a cold load of this config; examples/demo's config, which lives outside
 * this package, does not have the problem — its componentRegistry import only
 * resolves after init, ~600ms later). `selection`/`configState`/`branch`/
 * `chat`/`frame` don't touch the registry at all (verified: their Providers'
 * import chains are type-only or fully self-contained), so they're safe to
 * import eagerly — but every model cell is registered via `lazy()` here
 * anyway, uniformly, so this isn't a trap for the next model added to this
 * file. `lazy()`'s dynamic `import()` only resolves at first render, well
 * after `initConfigStore` has already run — see PreviewCell.tsx, which
 * already materializes lazy sources through `React.lazy` for exactly this
 * kind of per-cell code-splitting.
 *
 * See packages/designbook/DOGFOOD.md for the full writeup.
 */
import { defineConfig, lazy } from "@designbookapp/designbook/config";
import { Avatar, AvatarFallback } from "@designbook-ui/components/ui/avatar";
import { Badge } from "@designbook-ui/components/ui/badge";
import { Button } from "@designbook-ui/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@designbook-ui/components/ui/card";
import { Input } from "@designbook-ui/components/ui/input";
import { Label } from "@designbook-ui/components/ui/label";
import { Separator } from "@designbook-ui/components/ui/separator";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import { SelectionToolbarCell, SideRailCell } from "./dogfood/ChromeCells";

/** `AvatarFallback` needs to render inside `<Avatar>`'s context — a bare
 * standalone registration would be malformed, so this small wrapper is the
 * cell instead (same "wrap for a valid demo" convention as the chrome cells). */
function AvatarDemo() {
  return (
    <Avatar>
      <AvatarFallback>DB</AvatarFallback>
    </Avatar>
  );
}

export default defineConfig({
  title: "Designbook (dogfood)",

  sets: [
    {
      id: "primitives",
      title: "Designbook/Primitives",
      // Bare — no wrapper/sample props, same convention as examples/demo's
      // primitives set. "Renderable, not styled for a screenshot" is the bar.
      components: {
        Button,
        Badge,
        Card,
        CardHeader,
        CardTitle,
        CardContent,
        Input,
        Label,
        Separator,
        Spinner,
        Avatar: AvatarDemo,
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
          ],
        },
      },
    },
    {
      id: "chrome",
      title: "Designbook/Workbench chrome",
      // Promoted pure Workbench components (src/ui/components/) — take their
      // state as props, so the cell just supplies representative sample props.
      components: {
        SelectionToolbar: SelectionToolbarCell,
        SideRail: SideRailCell,
      },
    },
    {
      id: "models",
      title: "Designbook/Models",
      // One cell per data model: Provider + fixtures.ts data + a few atoms.
      // Every entry is lazy — see the module doc for why.
      components: {
        TextClaims: lazy(() => import("./dogfood/TextModelCell")),
        Catalog: lazy(() => import("./dogfood/CatalogModelCell")),
        Selection: lazy(() => import("./dogfood/SelectionModelCell")),
        ConfigState: lazy(() => import("./dogfood/ConfigStateModelCell")),
        Branch: lazy(() => import("./dogfood/BranchModelCell")),
        Chat: lazy(() => import("./dogfood/ChatModelCell")),
        Frame: lazy(() => import("./dogfood/FrameModelCell")),
      },
    },
  ],

  flows: [
    {
      id: "model-tour",
      title: "Designbook/Model tour",
      screens: [
        {
          id: "text",
          label: "Text model",
          description: "TextProvider + atoms over the text fixture's claims.",
          registryId: "models.TextClaims",
        },
        {
          id: "catalog",
          label: "Catalog model",
          description: "CatalogProvider + atoms over the catalog fixture's sets/flows.",
          registryId: "models.Catalog",
        },
        {
          id: "chat",
          label: "Chat model",
          description: "ChatProvider + atoms over a fixture Pi session thread.",
          registryId: "models.Chat",
        },
      ],
    },
  ],
});
