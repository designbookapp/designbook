import path from "path";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";

// Extend the app's REAL vite config so the spike runs through THEIR build:
// their @vitejs/plugin-react (their React), their @excalidraw/* aliases, their
// svgr/ejs/scss pipeline. We only (a) drop vite-plugin-checker (known to crash
// the dev server on this repo; pure dev-tooling noise, irrelevant to the spike)
// and (b) append the designbook spike plugin that injects our separate entry.
import theirConfig from "./vite.config.mts";
import { designbookSpike } from "../designbook-spike/plugin";

// repo root (one level up from excalidraw-app) — everything the spike touches
// (designbook-spike/, packages/, node_modules/) lives under here.
const repoRoot = path.resolve(__dirname, "..");

// The main designbook repo root (this excalidraw clone lives under
// <designbook>/.claude/worktrees/…/tmp-repos/excalidraw). C2.3: the spike now
// imports the PREBUILT library from <designbook>/packages/designbook/dist/ui,
// which is outside the excalidraw repoRoot — allow serving it via /@fs.
const designbookRoot = path.resolve(repoRoot, "../../../../..");

export default defineConfig((env: ConfigEnv): UserConfig => {
  const base = (
    typeof theirConfig === "function" ? theirConfig(env) : theirConfig
  ) as UserConfig;

  const plugins = (base.plugins ?? []).filter((p) => {
    const name = (p as any)?.name ?? "";
    return !String(name).includes("checker");
  });
  plugins.push(designbookSpike());

  return {
    ...base,
    plugins,
    server: {
      ...(base.server ?? {}),
      open: false,
      // allow serving the out-of-root spike entry + the prebuilt designbook lib
      // (under the main repo, above this clone) via /@fs/
      fs: { allow: [repoRoot, designbookRoot] },
    },
  };
});
