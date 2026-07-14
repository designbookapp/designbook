---
title: Flags adapter
description: Edit per-tenant feature flag values from JSON, written back to the same source your app reads.
---

The **flags adapter** teaches designbook to read and edit per-tenant feature flag values from
a JSON source of truth. It contributes a **tenant** dimension (top bar), a **Flags** tab of
editable fields (left panel), and a `Provider` field required by the config shape — see
[Your provider](#your-provider) for what it actually reaches today.

```tsx
import { flagsAdapter } from "@designbookapp/designbook/adapters";
import { FlagsProvider } from "./src/providers/FlagsProvider";

adapters: [
  flagsAdapter({
    Provider: FlagsProvider,
    source: import.meta.glob("./src/flags/*.json", { eager: true, import: "default" }),
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
```

## Options

| Option | Type | Description |
| --- | --- | --- |
| `Provider` | `ComponentType<{ tenant, flags, children }>` | Required. Constructed and fed `{ tenant, flags }`, but wrapped around the designbook chrome, not your running app — see [Your provider](#your-provider). |
| `source` | `Record<string, unknown>` | The flag source: an `import.meta.glob` result (eager, `import: "default"`) or a plain object. See layouts below. |
| `sourcePath` | `string` | Write target (config-relative) for the single-file layout. |
| `flags` | `Record<string, FlagSpec>` | The flags to surface as editable fields, keyed by flag id. |
| `tenants` | `{ value, label }[]` | Tenants offered in the selector. Default: top-level keys of `source`. |
| `id` | `string` | Adapter name + dimension namespace. Default `"flags"`. |
| `label` | `string` | Tab label. Default `"Flags"`. |
| `icon` | `string` | Tab/side-rail icon name. Default `"flag"`. |

### `FlagSpec`

```ts
type FlagSpec = {
  label: string;
  control: "toggle" | "select" | "text" | "number" | "color";
  /** For control: "select" — the allowed values. */
  options?: string[];
};
```

## Source layouts

The adapter accepts two file layouts and figures out which you're using:

- **Single file keyed by tenant** — `{ acme: { newCheckout: true }, globex: { … } }`. Set
  `sourcePath` to the file; edits write `POST /api/json` at key path `"<tenant>.<flag>"`.
- **Per-tenant files** — a glob of `acme.json`, `globex.json`, … each a flat flag map. The
  tenant is the filename stem; edits write to that tenant's file at key path `"<flag>"`.

Either way the adapter keeps a mutable in-memory copy (the eager glob is a build-time
snapshot), updates it optimistically on each save, and persists a surgical one-field write —
rolling back on failure.

## Your provider

`Provider` is a required option, and designbook does construct it — fed `{ tenant, flags }` for
the active tenant — but it's wrapped around the rest of the designbook chrome, **not around
your running app**. Your app always renders live in its own frame (see [Reaching your running
app](/adapters/overview/#reaching-your-running-app)), a separate document a chrome-side React
tree can't reach into, so mounting your `FlagsProvider` here doesn't make a tenant switch or a
flag edit show up in your app.

What actually makes an edit show up: your app needs to read the **same flags source** — the
`source` JSON this adapter edits — through its own normal import/fetch, wherever it already
mounts its own `FlagsProvider` (in your app's real entry point, unrelated to this config).
Saving a flag writes to that file through the designbook API; your dev server's own hot reload
then picks the change up in your running app, the same as if you'd hand-edited the file.

The `tenant` dimension itself only scopes **which tenant's flags the Flags tab shows and
edits** — switching it doesn't push a value into your running app. If your app also needs to
follow the picked tenant, it has to derive "which tenant am I" from its own source (a route, a
subdomain, a cookie) independently of this picker.
