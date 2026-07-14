---
title: Your first config
description: A minimal designbook.config.tsx you can run today, then how to grow it with more sets.
---

Everything Designbook shows comes from a single config file. In injected mode it lives at
`.designbook/config.tsx` in your app (globs are then relative to `.designbook/`, so `../…`); a
legacy `designbook.config.tsx` at the project root still works, and is what the host-mode
examples below pass to the CLI. You author it with `defineConfig`, importing your own
components directly — the config file runs inside designbook, so anything you can import in your
app you can import here.

## A minimal config

Start with one set of components. This is the smallest thing worth running:

```tsx
// designbook.config.tsx
import { defineConfig } from "@designbookapp/designbook/config";
import "./src/index.css";
import { Button } from "./src/components/ui/button";
import { Badge } from "./src/components/ui/badge";
import { Card, CardHeader, CardContent } from "./src/components/ui/card";

export default defineConfig({
  title: "My app",
  sets: [
    {
      id: "primitives",
      title: "Primitives",
      components: { Button, Badge, Card, CardHeader, CardContent },
    },
  ],
});
```

Run it:

```bash
designbook designbook.config.tsx
```

Note the `import "./src/index.css"` — in **host mode** designbook runs your components through
its own embedded Vite, so you have to bring in whatever global stylesheet they expect, exactly
as your app's entry point does, or they render unstyled. (In injected mode this is usually
unnecessary — your app's real dev server already loads your stylesheet.) See
[Troubleshooting](/reference/troubleshooting/) if styles look missing.

Each key in `components` becomes a registered entry named after that key. The `title` is
`/`-delimited and groups related sets under a shared label.

## Grow it

### Multiple sets

`sets` is a list, so group related components however makes sense — one set per feature
area, one for shared primitives, and so on. Give each a unique `id` and a `title`.

### Components that need context

You don't need to give designbook a way to render a component with context or sample data —
everything you select renders inside your **real, running app**, with its real provider tree
already in place, so a component that needs a provider or data just has it, the same as it
does anywhere else in your app. (Older designbook versions rendered registered components
inside their own preview canvas and needed a config-level `wrapper` to supply that context;
that canvas is retired, and `wrapper`/`datasets` are now no-ops — see [Component
registration](/concepts/component-sets/#wrapper-and-datasets).)

## Where to go from here

- **[Component registration](/concepts/component-sets/)** — what registering a component
  actually buys you today.
- **[Component sets & overrides](/config/sets-and-overrides/)** — the full `EntryOverride`
  shape, including which fields are live and which are deprecated no-ops.
- **[Adapters overview](/adapters/overview/)** — turn on theme, text, and flag editing.
- **[Configuration reference](/config/define-config/)** — every `defineConfig` field.
