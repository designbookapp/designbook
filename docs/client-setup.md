# Set up designbook in this repo

Audience: a coding agent told "set up designbook in this repo". designbook is a
Storybook-like design workbench that **injects into the app's own Vite dev
server** (no separate build). You browse a proxy port; the app renders through
it with a toolbar pill that expands into the workbench.

The user gives you a **tarball path** (e.g. `~/designbook-0.1.0.tgz`). Everything
else you derive from the repo. Below, `$TARBALL` = that path, `$APP_PORT` = the
port the app's dev server will use (pick a free one, e.g. 3013), `$SIDECAR_PORT`
= the stable port the user connects to (default 8787; pick a free one).

## Preconditions (check first, bail with a clear message if unmet)

- **Vite app.** `vite.config.{ts,js,mts,mjs}` exists (or vite is a dep). Non-Vite
  repos (incl. Next.js) are **not supported yet** — stop and say so.
- **React >= 18.** Check `react` in package.json. React < 18 is unsupported.
- Package manager: use whatever the repo uses (`npm`/`pnpm`/`yarn`). Examples below use npm.

## 1. Install the tarball

```bash
npm i -D "$TARBALL"
```

Verify it's self-contained (no workspace symlink back to a source checkout):

```bash
npm ls @designbookapp/designbook            # → @designbookapp/designbook@0.3.0, no "invalid"/"extraneous"
ls node_modules/@designbookapp/designbook/dist   # → cli config node ui
ls node_modules/.bin/designbook   # → the CLI is linked
```

## 2. Discover components to register

Find the component directories to point a glob at:

```bash
# Common component locations
ls src/components src/ui packages/*/components 2>/dev/null
# Rank by reuse (most-imported dirs = best first)
grep -rEho "from ['\"].*(components|ui)/[A-Za-z]+['\"]" src | sort | uniq -c | sort -rn | head
```

Aim a glob at a directory of **presentational primitives** (Button, Card, Badge,
Input, Avatar…) that render standalone. `fromGlob` registers every file in that
directory as an entry — no per-component import lines to write, and `*.test.*` /
`*.spec.*` / `*.stories.*` are excluded automatically. Narrow with
`include`/`exclude` if the directory also holds non-visual files.

If a component needs context/providers or non-trivial props to render, write a
**demo wrapper** in the config file and point the code panel at the real source
via `overrides[Name].sourcePath` (see §3, "Wrappers").

## 3. Create `.designbook/config.tsx`

Put the config in a `.designbook/` folder next to the HOST APP's `vite.config`.
`.designbook/` is THE designbook folder for this app (it also holds figma push
baselines). The legacy repo-root `designbook.config.tsx` is still discovered if
present, so existing setups keep working.

Registry of what the workbench shows. Import `defineConfig` and `fromGlob` from
`@designbookapp/designbook/config`. Everything filesystem-shaped (component + source globs) uses
`import.meta.glob`, evaluated **relative to this file** — since the file lives in
`.designbook/`, paths start with `../` (one level up to the app root). `designbook
init` writes these for you.

### Monorepos

Put `.designbook/config.tsx` in the **app package** (e.g. `apps/web/.designbook/`),
not the workspace root. To register components from a workspace library, point the
glob up and across, e.g. from `apps/web/.designbook/` reach `packages/ui` with
`../../../packages/ui/src/*.tsx` (up to the app, up to the workspace root, into the
lib). Import the lib's source directly; the app's own bundler resolves the
workspace alias.

Spawning the app's dev server: `designbook dev` spawns `--target-cmd` in the
**directory of the nearest `package.json` at/above the config** — i.e. the app
package, where the `dev`/`design` scripts live (NOT the git root). Either rely on
that default, or be explicit with `--target-cmd "pnpm --filter <pkg> run
dev:designbook"` and/or `--target-cwd <dir>`. The agent's working root (`--root`,
where Pi edits files) still defaults to the git root above the config, so the
agent can touch the whole monorepo.

**Recommended: register a whole directory with `fromGlob`.** Each file becomes a
lazily-loaded entry — the app's own bundler code-splits it, so one broken
component shows as a single red cell (with a retry) instead of taking the
workbench down. The entry key is the file's PascalCase basename; the code panel's
source path comes free from the glob key (no `sourceModules` for these entries).

```tsx
import { defineConfig, fromGlob } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "My App",

  sets: [
    {
      id: "primitives",
      title: "Primitives",  // "/"-delimited → folder structure, e.g. "Forms/Input"
      // One entry per file in the directory; keys are basenames (Button, Card…).
      // Relative to .designbook/, so `../` climbs to the app root.
      components: fromGlob(import.meta.glob("../src/components/*.tsx")),
      overrides: {
        // Optional: render a Button in a variant matrix on its detail page.
        Button: {
          matrixAxes: [
            { name: "Variant", values: ["primary", "secondary", "danger"] },
          ],
        },
      },
    },
  ],
});
```

`fromGlob` resolves the component export per file: the export matching the entry
key, else the default export, else the file's sole component export. Pin an
unusual one with `overrides[Name].exportName`. Options: `include` / `exclude`
(string = substring match, or RegExp) and a `key` mapper.

**Static registration** still works — `components: { Button, Card }` from explicit
imports — but a broken static import fails the whole config module, so it has no
per-cell fault isolation. Prefer `fromGlob`. Static (and demo-wrapper) entries do
need `sourceModules` for code-panel attribution:

```tsx
// Only needed for statically-registered / demo-wrapper entries.
// Relative to .designbook/ — note the leading `../`.
sourceModules: import.meta.glob("../src/components/*.tsx", { eager: true }),
```

**Wrappers** (when a component needs providers). Wrap either the whole set
(`sets[].wrapper`) or one entry (register a local demo component). Because the
demo/wrapper lives in the config file, `sourceModules` can't attribute it — set
`overrides[Name].sourcePath` to the real repo-relative file so the code panel
shows the true source. Pattern (from a real excalidraw config):

```tsx
import { defineConfig } from "@designbookapp/designbook/config";
import { useState, type ReactNode } from "react";
// Imports are relative to .designbook/ — `../` climbs to the app/repo root.
import { EditorJotaiProvider } from "../packages/excalidraw/editor-jotai";
import { ColorInput } from "../packages/excalidraw/components/ColorPicker/ColorInput";

// Set-level wrapper: provides context AND the root class the app's theme
// CSS vars are scoped under, so previews pick up real styling.
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <EditorJotaiProvider>
      <div className="excalidraw excalidraw-container notranslate">{children}</div>
    </EditorJotaiProvider>
  );
}

// Entry-level demo wrapper: supplies stateful/required props.
const ColorInputDemo = () => {
  const [color, setColor] = useState("#e64980");
  return <ColorInput color={color} onChange={setColor} label="Stroke" colorPickerType="elementStroke" />;
};

export default defineConfig({
  title: "Excalidraw",
  sourceModules: import.meta.glob("../packages/excalidraw/components/**/*.tsx", { eager: true }),
  sets: [
    {
      id: "editor",
      title: "Editor",
      wrapper: Wrapper,
      components: { ColorInput: ColorInputDemo },
      overrides: {
        // Demo wrapper lives here; point the code panel at the real file.
        ColorInput: { sourcePath: "packages/excalidraw/components/ColorPicker/ColorInput.tsx" },
      },
    },
  ],
});
```

If the app needs global CSS to render components correctly, `import` it
(side-effect only) at the top of the config file, and reproduce any root
class/provider the app puts around its tree (see the `Wrapper` above).

## 4. Create the Vite variant `vite.designbook.config.ts`

Wraps the app's **own** vite config and appends `designbookPlugin()` (imported
from the `designbook` root export). Only used by the `design` script — the
normal build is untouched. Template (works verbatim; adjust the base import to
your config's real filename/extension):

```ts
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import { designbookPlugin } from "@designbookapp/designbook";
import baseConfig from "./vite.config";        // ← the app's real config

export default defineConfig((env: ConfigEnv): UserConfig => {
  const base = (
    typeof baseConfig === "function" ? baseConfig(env) : baseConfig
  ) as UserConfig;

  // Drop vite-plugin-checker — it can crash the dev server; pure dev noise.
  const plugins = (base.plugins ?? []).filter((p) => {
    const name = (p as { name?: string })?.name ?? "";
    return !String(name).includes("checker");
  });

  plugins.push(
    designbookPlugin({
      config: "./.designbook/config.tsx",
      serverUrl: "http://localhost:$SIDECAR_PORT", // MUST match the sidecar port (§5)
      // autoExpand: true,  // optional: open the overlay on load
    }),
  );

  return { ...base, plugins, server: { ...(base.server ?? {}), open: false } };
});
```

`designbookPlugin(options)`:
- `config?` — path to the config file (abs or relative to vite cwd). Auto-discovered (`.designbook/config.*` then legacy `designbook.config.*`) if omitted.
- `serverUrl?` — sidecar origin. Default `http://localhost:8787`. **Must equal the sidecar port.**
- `autoExpand?` — auto-open the overlay on load. Default false.

**API namespacing (important).** Through the proxy, plain `/api/*` is forwarded
to YOUR app untouched — designbook does not intercept it, so an app with its own
same-origin `/api` keeps working. designbook's own api is served under
`/__designbook/api/*` on the proxy origin (the injected client uses this
automatically). The sidecar also exposes a **direct api port** (`--port` + 1)
where plain `/api/*` is designbook's, for cross-origin use.

## 5. Add scripts

`designbook dev` runs the API/agent sidecar on `$SIDECAR_PORT` and proxies the
app's dev server behind it. **It must spawn the app using the Vite variant
above**, so override `--target-cmd`:

```jsonc
{
  "scripts": {
    "dev:designbook": "vite --config vite.designbook.config.ts --port $APP_PORT",
    "design": "designbook dev --port $SIDECAR_PORT --target-cmd \"npm run dev:designbook\" --target-port $APP_PORT"
  }
}
```

`--target-port` is optional but recommended (skips log-based port detection).
Substitute real numbers (the defaults in this repo were `$APP_PORT`=3013,
`$SIDECAR_PORT`=8792). If the ports are already the defaults you want, you can
omit the flags, but being explicit avoids conflicts.

`designbook dev` flags (`designbook dev --help`):
- `-p, --port` stable port the user connects to (default 8787, env `DESIGNBOOK_PORT`)
- `--target-cmd` command to spawn the target dev server (default: package.json `dev`)
- `--target-cwd` directory to spawn `--target-cmd` in (default: nearest
  `package.json` at/above the config — the app package, NOT the git root)
- `--target-url` attach to an already-running dev server instead of spawning
- `--target-port` force/known target port (skips "Local:" log discovery)
- `--root` project root the agent works in (default: git root above the config)
- `--no-open` don't open a browser; `--debug` verbose

**Auto-recovery / backoff.** If the target dev server crashes, `designbook dev`
restarts it forever with escalating backoff (1s → 2s → 5s → 10s → 30s cap, reset
on a clean boot). After 5 consecutive fast failures it collapses to a single
`target failing repeatedly: <last stderr> — retrying every 30s` line instead of
spamming the log. Fix the app and it recovers on its own.

## 6. Run

```bash
export ANTHROPIC_API_KEY=...   # needed only for the Pi chat tab; workbench works without it
npm run design
```

Open **http://localhost:$SIDECAR_PORT/** (the proxy — NOT the app port).

## Acceptance checklist

- [ ] `npm run design` starts; log shows sidecar on `$SIDECAR_PORT` and target Vite `Local: …:$APP_PORT`.
- [ ] `http://localhost:$SIDECAR_PORT/` renders the app + a `◈ designbook` pill (bottom-right).
- [ ] Click the pill → workbench overlay expands (branch selector, Flows, Components sidebar).
- [ ] Expand the Components set → your entries listed; clicking one renders it on the canvas (matrix axes show variants).
- [ ] Chat tab shows **Connected** and a session id (with `ANTHROPIC_API_KEY` set, messages get replies; without it the tab still loads — workbench unaffected).
- [ ] Deep link `http://localhost:$SIDECAR_PORT/__designbook/component/<setId>.<ComponentKey>` (e.g. `primitives.Card`) auto-expands and navigates to that component.
- [ ] Code panel (`</>` icon): activate the selection tool (arrow, bottom toolbar), click a rendered component on its detail page → a `Set · Name` badge appears and its source shows in the panel.
- [ ] HMR: with the overlay expanded, edit a registered component's file → the canvas hot-updates without a page reload. An edit that forces a full reload (e.g. `index.html`) shows an "app updated — reload" pill instead of reloading; it applies on click or collapse.

## Troubleshooting

- **Unstyled previews.** Two causes: **(a) design tokens on `:root`.** designbook
  forwards the app's `:root` custom properties into the shadow-DOM cells
  automatically as of this version — if previews are unstyled, update designbook.
  **(b) Utilities never generated.** Components registered from a workspace lib
  need the HOST's Tailwind to *scan those sources*. In Tailwind v4, add
  `@source "../../packages/ui/src";` (path relative to your css entry) to the css
  file that imports your theme, so v4 generates the utilities those components
  use; otherwise the classes exist in markup but no CSS is emitted for them.
- **`EADDRINUSE` / "port … in use".** `designbook dev` (and host mode) print a
  one-line `port <n> in use — another designbook running? --port to change` and
  exit; pick a free `--port`. The direct api port (`--port` + 1) warns and is
  skipped if taken; use `--api-port` to move it.
- **The app's own `/api` returned designbook's response.** Fixed: the proxy now
  forwards `/api/*` to your app. designbook's api is under `/__designbook/api/*`.
  If a health check ever hits designbook, make sure you're on the current version.
- **Port conflict.** Change `--port` (sidecar) and/or `--port $APP_PORT` in
  `dev:designbook`, and keep `serverUrl` in the vite variant equal to the
  sidecar port. `--target-port` must match the app port.
- **`serverUrl` mismatch.** If the chat/API is dead but the app renders, the
  plugin's `serverUrl` ≠ the sidecar `--port`. Make them equal.
- **vite-plugin-checker crashes the dev server.** The variant already filters
  any plugin whose name contains `checker`. If a different checker plugin slips
  through, widen the filter.
- **Target port not detected** (proxy shows "waiting"/recovery page though the
  app is up): pass `--target-port $APP_PORT`. Detection parses Vite's "Local:"
  line; custom loggers can hide it.
- **Missing `ANTHROPIC_API_KEY`.** The chat/Pi tab won't produce replies, but it
  loads and the rest of the workbench (canvas, code panel, deep links) works.
  Set the key in the shell that runs `npm run design` (it's read by the
  sidecar).
- **`@designbookapp/designbook/config` won't resolve in the config file.** That specifier is
  aliased by the plugin at dev time — it only resolves when the config is loaded
  through the Vite variant (via `designbook dev`), not when type-checked
  standalone. That's expected.
- **504 / dep-optimizer error on `@designbookapp/designbook/adapters` (or the workbench won't
  mount after importing an adapter).** Fixed in **≥ 0.2.2**: `@designbookapp/designbook/adapters`
  now resolves to a prebuilt bundle that shares the workbench's runtime, and the
  plugin excludes it from the app's dep optimizer. If you see the optimizer 504
  on `@designbookapp/designbook/adapters`, or `@designbook-ui/*` "failed to resolve" errors,
  update designbook and remove any hand-rolled alias that pointed
  `@designbookapp/designbook/adapters` at its source. (The i18n adapter also needs `i18next` +
  `react-i18next` as app dependencies — see docs/adapters-setup.md.)
- **i18n text tool reads everything as "hardcoded" in injected mode.** Fixed in
  **≥ 0.2.2** (the bundle now externalizes `react-i18next` so it shares the app's
  instance). If it persists, you have two `react-i18next` copies — add
  `resolve.dedupe: ["react-i18next", "i18next"]` to the Vite variant.
- **React deduplication (invalid hook call, context misses).** designbook's
  workbench bundle always externalizes `react`/`react-dom` as required peers
  rather than shipping its own copies — the same externalized-peer model the
  optional `i18next`/`react-i18next` peers use (0.2.2 notes, see
  `docs/adapters-setup.md`). In injected mode this means the workbench and the
  app **must resolve to one React instance**: fiber-based hit-testing
  (select/text tools) walks the app's own fiber tree, and any adapter provider
  (e.g. the i18next adapter's
  `I18nextProvider`) has to share context with the app's components. A
  monorepo with a nested/mismatched `react` or `react-dom` range gives the
  workbench a SECOND copy, which shows up as "Invalid hook call" errors, a
  provider's context reading as its default value (context misses), or the
  select/text tool silently failing to attribute a registered component. Fix:
  add both to `resolve.dedupe` in the app's **real** Vite config (the one
  `vite.designbook.config.ts` wraps — dedupe has to apply before
  `designbookPlugin` is even in the picture):
  ```ts
  // vite.config.ts (the app's own config, not the designbook variant)
  export default defineConfig({
    resolve: { dedupe: ["react", "react-dom"] },
    // ...
  });
  ```
  If the monorepo still resolves two copies after deduping (e.g. a workspace
  package pins an incompatible `react` range), align that package's range
  with the app's before retrying.
- **React < 18 / non-Vite (incl. Next.js).** Unsupported in this phase. Stop and
  report rather than forcing it.
