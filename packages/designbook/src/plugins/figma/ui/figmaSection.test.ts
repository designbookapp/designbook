/**
 * The figma props-panel SECTION (FigmaSection) is the full-view home for
 * push/pull (docs/specs/props-panel.md §Plugin sections). These guards pin:
 *   - the plugin's ui half CONTRIBUTES the section through `propsSections`
 *     (so `initUiIntegrations` namespaces it `figma:sync` into the registry
 *     — the seam that keeps an unconfigured registry empty);
 *   - the serializer accepts a live `entryFiber` (the wrapper-less full-view
 *     frame host has no `[data-db-entry]` ancestor to walk down from).
 *
 * Source-level, matching the repo's other node-based UI seam guards
 * (figmaChatHandoff.test.ts, apiUrlSeam.test.ts): the vitest env is `node`, so
 * the React-coupled behavior is pinned at the seam, not the DOM.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { figmaUi } from "./index.tsx";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)));

function readUi(file: string): string {
  return readFileSync(join(uiDir, file), "utf8");
}

describe("figma props-panel section registration", () => {
  it("the ui half contributes a `sync` props section (title Figma)", async () => {
    const spec = await figmaUi();
    const sections = spec.propsSections ?? [];
    const sync = sections.find((section) => section.id === "sync");
    expect(sync, "figma ui declares a `sync` props section").toBeDefined();
    expect(sync!.title).toBe("Figma");
    expect(typeof sync!.Component).toBe("function");
    // Ordered after core so it renders below the prop controls.
    expect(sync!.order).toBeGreaterThan(0);
  });

  it("still contributes the serializeEntry + selectionContext seams", async () => {
    const spec = await figmaUi();
    expect(typeof spec.serializeEntry).toBe("function");
    expect(typeof spec.selectionContext).toBe("function");
  });
});

describe("figma section push/pull surface", () => {
  const section = readUi("FigmaSection.tsx");

  it("pushes the serialized live selection to the push route", () => {
    expect(section).toContain("/api/x/figma/push");
    // Push serializes from the live selection handles, not a DOM query.
    expect(section).toMatch(/serializeComponent\(\s*live\.root/);
    expect(section).toContain("entryFiber");
  });

  it("gates push/pull on the polled bridge status", () => {
    expect(section).toContain("/api/x/figma/status");
    // 409 (no plugin) surfaces as a clear disconnected error, not a raw throw.
    expect(section).toContain("409");
  });

  it("probes the pushed baseline through the read-only file route", () => {
    expect(section).toContain(".designbook/figma/");
    expect(section).toContain("/api/file?path=");
  });

  it("disables the actions when disconnected or the selection is unresolvable", () => {
    expect(section).toContain("serializable");
    expect(section).toContain("disabled={!canPush}");
    expect(section).toContain("disabled={!canPull}");
  });
});

describe("serializer live-frame (entryFiber) seam", () => {
  const serialize = readFileSync(join(uiDir, "serialize.ts"), "utf8");

  it("boundary-walks from a supplied entryFiber when there is no wrapper", () => {
    expect(serialize).toContain("entryFiber?: Fiber");
    expect(serialize).toContain("let entryFiber = opts.entryFiber");
    // Falls back to the wrapper walk only when no entryFiber is supplied.
    expect(serialize).toMatch(/if \(!entryFiber\) \{[\s\S]*getFiberFromDom\(rootEl\)/);
  });
});
