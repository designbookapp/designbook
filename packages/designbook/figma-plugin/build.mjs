#!/usr/bin/env node
/**
 * Bundles the designbook Figma plugin into `figma-plugin/dist/`.
 *
 * The repo's main package builds with plain `tsc` (no bundling), but Figma
 * plugins require a single-file `code.js` for the main thread and a single
 * self-contained `ui.html` with its script inlined. esbuild does both here:
 *   - code.ts -> dist/code.js (IIFE, no external deps to resolve at runtime)
 *   - ui.ts   -> bundled in memory, then inlined into ui.html's <body>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(pluginRoot, "dist");

async function buildCode() {
  await esbuild.build({
    entryPoints: [resolve(pluginRoot, "code.ts")],
    outfile: resolve(distDir, "code.js"),
    bundle: true,
    format: "iife",
    target: "es2017",
    platform: "browser",
    logLevel: "info",
  });
}

async function buildUi() {
  const result = await esbuild.build({
    entryPoints: [resolve(pluginRoot, "ui.ts")],
    bundle: true,
    format: "iife",
    target: "es2017",
    platform: "browser",
    write: false,
    logLevel: "info",
  });

  const bundledJs = result.outputFiles[0].text;
  const template = await readFile(resolve(pluginRoot, "ui.html"), "utf8");
  const marker = "<!-- build:figma-plugin inlines the bundled ui.ts script here -->";

  if (!template.includes(marker)) {
    throw new Error(`ui.html is missing the build marker: ${marker}`);
  }

  const html = template.replace(marker, `<script>\n${bundledJs}\n</script>`);
  await writeFile(resolve(distDir, "ui.html"), html, "utf8");
}

async function main() {
  await mkdir(distDir, { recursive: true });
  await buildCode();
  await buildUi();
  console.log(`designbook figma-plugin built -> ${distDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
