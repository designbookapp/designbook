import path from "path";
import type { Plugin } from "vite";

// Spike vite plugin: injects a SEPARATE module-script entry for the designbook
// spike into the served index.html. This is the "injection" seam of Model-C —
// designbook (as a dev-only dep) adds its own entry that their bundler compiles
// with their React + their aliases, independent of the app's own entry.
const SPIKE_ENTRY = path.resolve(__dirname, "entry.tsx");

export function designbookSpike(): Plugin {
  return {
    name: "designbook-spike",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        // Serve the out-of-root entry via Vite's /@fs/ filesystem endpoint.
        const src = `/@fs/${SPIKE_ENTRY}`;
        return {
          html,
          tags: [
            {
              tag: "script",
              attrs: { type: "module", src },
              injectTo: "body",
            },
          ],
        };
      },
    },
  };
}

export default designbookSpike;
