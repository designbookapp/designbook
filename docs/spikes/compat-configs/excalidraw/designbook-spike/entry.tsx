// designbook spike entry — REBUILT on the real C2 library (stage C2.3 accept).
//
// The hand-rolled mini-workbench is gone. This entry imports the PREBUILT
// `mountWorkbench` from the main repo's `dist/ui` (the same artifact `@designbookapp/designbook/ui`
// exports) and the built `style.css` as text, then mounts the REAL workbench in
// shadow-DOM overlay mode. Everything here is still compiled by THEIR vite and
// rendered by THEIR React (react is externalized in the lib build), so the
// workbench chrome runs on excalidraw's own React 19 copy.
//
//   - chrome  → sealed in a shadow root, styled ONLY by our injected style.css
//   - cells   → excalidraw components in the LIGHT DOM (LightDomSlot), styled by
//               their app.scss / styles.scss
//   - toolbar → a their-app pill (light DOM) drives the overlay expand/collapse
//               handle returned by mountWorkbench.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";

// The real library, prebuilt. react/react-dom stay external → resolved to THEIR
// optimized copy by their vite. Path: designbook-spike → … → <designbook repo>.
import { mountWorkbench } from "../../../packages/designbook/dist/ui/index.js";
// The built workbench chrome css, as raw text, injected into the shadow root only
// (never document.head — so tailwind preflight cannot leak onto the app).
import workbenchCss from "../../../packages/designbook/dist/ui/style.css?raw";

// Their global excalidraw styles (light DOM). Injected into document.head by
// their scss pipeline; the light-DOM canvas cells pick these up, the shadow
// chrome is isolated from them.
import "../packages/excalidraw/css/app.scss";
import "../packages/excalidraw/css/styles.scss";
import "../packages/excalidraw/components/ColorPicker/ColorPicker.scss";

import { registry, accentColor, type CellEntry } from "./spike.config";

import IslandCell from "./cells/IslandCell";
import FilledButtonCell from "./cells/FilledButtonCell";
import CardCell from "./cells/CardCell";

// ---------------------------------------------------------------------------
// Set wrapper: reproduce excalidraw's `.excalidraw` root class so the theme CSS
// custom properties (--island-bg-color, --color-*, …) resolve on the cells.
// This is the light-DOM styling the shadow chrome must NOT leak into and must
// NOT be leaked into (K2).
// ---------------------------------------------------------------------------
function ExcalidrawWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="excalidraw excalidraw-container notranslate"
      style={{
        background: "var(--island-bg-color, #fff)",
        padding: 24,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

// The real workbench config: the three spike cells as a component set. Their
// aliases/scss resolve through THEIR build; designbook does no bridging (K3 —
// accentColor still comes from @excalidraw/common via spike.config).
const config = {
  title: "designbook · spike S1 on real lib",
  sets: [
    {
      id: "excalidraw",
      title: "Excalidraw",
      components: {
        Island: IslandCell,
        FilledButton: FilledButtonCell,
        Card: CardCell,
      },
      wrapper: ExcalidrawWrapper,
    },
  ],
};

// Mount the real workbench: shadow isolation + full-screen overlay, starting
// collapsed. The returned handle exposes expand()/collapse() for the toolbar.
const anchor = document.createElement("div"); // required by API; unused in overlay mode
const handle = mountWorkbench({
  container: anchor,
  config,
  configDir: ".",
  isolation: "shadow",
  overlay: true,
  startCollapsed: true,
  styles: workbenchCss,
});

// ---------------------------------------------------------------------------
// Their-app toolbar (light DOM, their React). Pill → expand; while expanded a
// floating control (stacked above the overlay) → collapse. This is the shape
// C3's real toolbar will take over.
// ---------------------------------------------------------------------------
function SpikeToolbar() {
  const [expanded, setExpanded] = useState(false);

  if (expanded) {
    return (
      <button
        data-spike-collapse
        onClick={() => {
          handle.collapse();
          setExpanded(false);
        }}
        style={{
          position: "fixed",
          right: 16,
          top: 16,
          zIndex: 2147483647,
          font: "12px system-ui",
          padding: "8px 14px",
          borderRadius: 999,
          border: "none",
          background: "#0b0d10",
          color: "#7cfc00",
          boxShadow: "0 4px 16px rgba(0,0,0,.4)",
          cursor: "pointer",
        }}
      >
        ✕ collapse workbench
      </button>
    );
  }

  return (
    <button
      data-spike-toolbar
      onClick={() => {
        handle.expand();
        setExpanded(true);
      }}
      style={{
        position: "fixed",
        left: 16,
        bottom: 16,
        zIndex: 2147483000,
        font: "13px system-ui",
        padding: "10px 16px",
        borderRadius: 999,
        border: "none",
        background: "#0b0d10",
        color: "#7cfc00",
        boxShadow: "0 4px 16px rgba(0,0,0,.3)",
        cursor: "pointer",
      }}
    >
      ◈ designbook — expand
    </button>
  );
}

// Sibling root of their #root so an app crash leaves the toolbar standing.
const toolbarHost = document.createElement("div");
toolbarHost.id = "designbook-spike-toolbar";
document.body.appendChild(toolbarHost);
createRoot(toolbarHost).render(<SpikeToolbar />);

// Silence unused-import lints for the retired mini-workbench registry surface;
// keep them referenced so spike.config stays the K3 proof.
void (registry satisfies CellEntry[]);
void accentColor;

// eslint-disable-next-line no-console
console.log(
  "[designbook-spike] real workbench mounted on their React",
  React.version,
  "· cells:",
  registry.length,
  "· accent:",
  accentColor,
);
