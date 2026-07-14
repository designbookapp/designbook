/**
 * Sandbox orchestrator tests (docs/specs/sandbox.md).
 *
 * Pure helpers (index round-trip, position seeding, fallback wrapper, prompt
 * builders) plus the orchestrator state machine against FAKE turns in a temp
 * repo — the variations test pattern: no Pi SDK, no auth, injected
 * `runTurn`/`runTypecheck`. Ends with source scans pinning the seams in
 * api.ts (handlers resolve their root via activeRepoRoot(); ephemeral pin
 * sessions are restricted, log-only, disposed) and the --read-only blocks.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCATOR_OUTER_HTML_CAP,
  applyFrameDimension,
  buildBakeMergePrompt,
  buildComposePrompt,
  buildElementDirectorPrompt,
  buildElementModuleVariantPrompt,
  buildElementVariantPrompt,
  buildSandboxDirectorPrompt,
  buildSandboxEditPrompt,
  buildSandboxIntentPrompt,
  buildSandboxIteratePrompt,
  buildSandboxRenderFixPrompt,
  buildSandboxSourceContext,
  buildSandboxTurnPrompt,
  buildSandboxVariantPrompt,
  changesetIdForPin,
  classifySandboxTurnFailure,
  controllerPath,
  createSandboxOrchestrator,
  createTurnActivityRelay,
  generateSandboxWrapper,
  isSandboxPath,
  isValidIdSegment,
  makePinId,
  moduleAltPath,
  originalPath,
  parseIntentReply,
  parseSandboxIndex,
  sanitizeElementLocator,
  sanitizeIterateElement,
  sanitizeTitle,
  sandboxDir,
  sandboxIndexFile,
  seedVariantPositions,
  serializeSandboxIndex,
  variantFilePath,
  wrapperPath,
  type SandboxElementLocator,
  type SandboxPin,
  type SandboxRunTurn,
  type SandboxTurnActivity,
  type SandboxTypecheck,
} from "./sandbox.ts";
import {
  DATA_ALT_ID,
  altFilePath,
  baseFilePath,
  changesetMetaPath,
  changesetsDir,
  mergedDataPath,
  parseLayerMeta,
  serializeLayerMeta,
  type ChangesetLayer,
} from "../overrides/layerStore.ts";
import {
  applyDataAdditions,
  computeDataAdditions,
  mergeDataLayers,
} from "./dataMerge.ts";
import { READ_ONLY_BLOCKED_ROUTES } from "./readOnlyRoutes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// The L1 index carries pins only (layers own their own meta.json records);
// the parser still revives the legacy array + O1 object shapes. Most of this
// file exercises PIN mechanics through these wrappers.
function parsePins(source: string): SandboxPin[] {
  return parseSandboxIndex(source).pins;
}
function serializePins(pins: SandboxPin[]): string {
  return serializeSandboxIndex({ pins });
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("paths and ids", () => {
  it("builds sandbox paths under the app dir", () => {
    expect(sandboxDir("")).toBe(".designbook/sandbox");
    expect(sandboxDir("examples/demo")).toBe(
      "examples/demo/.designbook/sandbox",
    );
    expect(variantFilePath("", "card-abc", "compact")).toBe(
      ".designbook/sandbox/card-abc/compact.tsx",
    );
    expect(wrapperPath("examples/demo", "card-abc")).toBe(
      "examples/demo/.designbook/sandbox/card-abc/wrapper.tsx",
    );
    expect(isSandboxPath(".designbook/sandbox/x/y.tsx", "")).toBe(true);
    expect(isSandboxPath("src/App.tsx", "")).toBe(false);
  });

  it("generates filesystem-safe pin ids", () => {
    const id = makePinId("ProductCard");
    expect(isValidIdSegment(id)).toBe(true);
    expect(id.startsWith("productcard-")).toBe(true);
    expect(isValidIdSegment("../escape")).toBe(false);
    expect(isValidIdSegment("UPPER")).toBe(false);
  });
});

describe("seedVariantPositions", () => {
  it("lays a non-overlapping 3-column grid, continuing after existing cells", () => {
    const first = seedVariantPositions(0, 4);
    expect(first[0]).toEqual({ x: 24, y: 24 });
    expect(first[1].x).toBeGreaterThan(first[0].x);
    expect(first[2].x).toBeGreaterThan(first[1].x);
    // Fourth wraps to the second row.
    expect(first[3].x).toBe(first[0].x);
    expect(first[3].y).toBeGreaterThan(first[0].y);
    // A second run continues, never re-seeding cell 0.
    const more = seedVariantPositions(4, 1);
    expect(more[0]).toEqual({ x: first[1].x, y: first[3].y });
    // No two cells collide.
    const all = [...first, ...more].map((p) => `${p.x},${p.y}`);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("applyFrameDimension", () => {
  it("clamps positive dims, drops null/garbage to auto (undefined)", () => {
    expect(applyFrameDimension(500.6)).toBe(501);
    expect(applyFrameDimension(10)).toBe(120); // below the floor
    expect(applyFrameDimension(9999)).toBe(4000); // above the ceiling
    // Reset-to-auto + any non-positive/garbage value → undefined (field dropped).
    expect(applyFrameDimension(null)).toBeUndefined();
    expect(applyFrameDimension(undefined)).toBeUndefined();
    expect(applyFrameDimension(0)).toBeUndefined();
    expect(applyFrameDimension(-40)).toBeUndefined();
    expect(applyFrameDimension(NaN)).toBeUndefined();
  });
});

const PIN: SandboxPin = {
  id: "productcard-x1",
  createdAt: 1,
  kind: "component",
  target: {
    file: "src/composite/product/variants/Card.tsx",
    exportName: "ProductCard",
    name: "Product Card",
    entryId: "product.ProductCard",
    instancePath: "product.ProductCard#0",
  },
  contextSnapshot: {
    props: {
      title: "Vase",
      onAdd: { $unserializable: "function onAdd" },
    },
    contexts: [{ name: "CartContext", value: { items: 2 } }],
    adapters: { "theme:mode": "dark" },
  },
  thread: [{ role: "user", text: "make variants", at: 2 }],
  variants: [
    {
      id: "compact",
      intent: "denser",
      file: ".designbook/sandbox/productcard-x1/compact.tsx",
      x: 24,
      y: 24,
      status: "ready",
      rev: 1,
    },
  ],
  resolved: false,
};

/** ELEMENT pin fixture (docs/specs/sandbox.md v2): a div inside ProductCard. */
const LOCATOR: SandboxElementLocator = {
  tag: "div",
  outerHtml: '<div class="flex items-baseline gap-2"><span>$29</span><s>$39</s></div>',
  childIndexPath: [0, 2],
  textHash: "1a2b3c",
  text: "$29 $39",
  className: "flex items-baseline gap-2",
};

const ELEMENT_PIN: SandboxPin = {
  id: "productcard-e1",
  createdAt: 1,
  kind: "element",
  target: {
    file: "src/composite/product/variants/Card.tsx",
    exportName: "ProductCard",
    name: "div.flex",
    entryId: "product.ProductCard",
    instancePath: "product.ProductCard#0>div:2",
  },
  locator: LOCATOR,
  controllerFile: ".designbook/sandbox/productcard-e1/controller.tsx",
  contextSnapshot: {
    props: {},
    contexts: [{ name: "ProductContext", value: { price: 29 } }],
    adapters: { "i18next:locale": "en-US" },
    element: { tag: "div", text: "$29 $39", props: { className: "flex" } },
  },
  thread: [],
  variants: [
    {
      id: "stacked",
      intent: "vertical price stack",
      file: ".designbook/sandbox/productcard-e1/stacked.tsx",
      x: 24,
      y: 24,
      status: "ready",
      rev: 1,
    },
  ],
  resolved: false,
};

describe("index round-trip", () => {
  it("serializes a JSON literal and parses it back verbatim", () => {
    const source = serializePins([PIN]);
    expect(source).toContain("export const sandbox =");
    expect(parsePins(source)).toEqual([PIN]);
  });

  it("round-trips an ELEMENT pin: kind + locator + controllerFile survive", () => {
    const source = serializePins([ELEMENT_PIN]);
    const [revived] = parsePins(source);
    expect(revived).toEqual(ELEMENT_PIN);
    expect(revived.kind).toBe("element");
    expect(revived.locator).toEqual(LOCATOR);
    expect(revived.controllerFile).toBe(
      ".designbook/sandbox/productcard-e1/controller.tsx",
    );
  });

  it("REVIVE COMPAT: pre-v2 records without `kind` parse as component pins", () => {
    // Serialize a legacy record by hand — exactly what an old index holds.
    const { kind: _kind, ...legacy } = PIN;
    const source = serializePins([legacy as SandboxPin]);
    expect(source).not.toContain('"kind"');
    const [revived] = parsePins(source);
    expect(revived.kind).toBe("component");
    expect(revived.target).toEqual(PIN.target);
  });

  it("parses nothing from unrelated or corrupt content", () => {
    expect(parsePins("export const x = 1;")).toEqual([]);
    expect(parsePins("export const sandbox = [{ broken")).toEqual([]);
  });
});

describe("sanitizeElementLocator", () => {
  it("caps the outerHTML/path and rejects unusable shapes", () => {
    const sanitized = sanitizeElementLocator({
      tag: "div",
      outerHtml: `<div>${"x".repeat(4096)}</div>`,
      childIndexPath: [0, 1, -2, 1.5, 3],
      textHash: "abc",
      text: "hello",
      className: "row",
    })!;
    expect(sanitized.outerHtml.length).toBe(LOCATOR_OUTER_HTML_CAP);
    // Negative / fractional indexes dropped; order preserved.
    expect(sanitized.childIndexPath).toEqual([0, 1, 3]);
    expect(sanitized.tag).toBe("div");
    expect(sanitized.text).toBe("hello");

    expect(sanitizeElementLocator(undefined)).toBeUndefined();
    expect(sanitizeElementLocator({ tag: "DIV", outerHtml: "<div/>" })).toBeUndefined();
    expect(sanitizeElementLocator({ tag: "div", outerHtml: "" })).toBeUndefined();
    expect(sanitizeElementLocator({ tag: "../x", outerHtml: "<x/>" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deterministic wrapper generation (the PRIMARY path — never model-authored).
// ---------------------------------------------------------------------------

describe("generateSandboxWrapper", () => {
  /** Fixture app repo the generator resolves providers/locales against. */
  async function makeFixtureRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "db-wrapper-"));
    cleanups.push(root);
    await mkdir(join(root, "src/composite/product"), { recursive: true });
    await mkdir(join(root, "src/providers"), { recursive: true });
    await mkdir(join(root, "locales/fr-FR"), { recursive: true });
    await writeFile(
      join(root, "src/composite/product/context.tsx"),
      [
        "import { createContext, useContext } from 'react';",
        "const ProductContext = createContext(undefined);",
        "function ProductProvider({ product, currency, children }) {",
        "  return <ProductContext value={{ product, currency }}>{children}</ProductContext>;",
        "}",
        "export { ProductProvider };",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "src/providers/CartContext.tsx"),
      "import { createContext } from 'react';\nexport const CartContext = createContext(undefined);\n",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "react-i18next": "^15.0.0" } }),
    );
    await writeFile(
      join(root, "locales/fr-FR/app.json"),
      JSON.stringify({ product: { viewTrip: "Voir le voyage" } }),
    );
    return root;
  }

  it("re-instantiates an importable provider with captured serializable props", async () => {
    const repoRoot = await makeFixtureRepo();
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-x1",
      contextSnapshot: {
        props: { title: "Vase", onAdd: { $unserializable: "function onAdd" } },
        contexts: [
          {
            name: "Context",
            value: { product: { title: "Vase" }, currency: "USD" },
            ownerName: "ProductProvider",
            providerName: "ProductProvider",
            providerProps: {
              product: { title: "Vase" },
              currency: "USD",
              onSelect: { $unserializable: "function onSelect" },
            },
          },
        ],
        adapters: {},
      },
    });
    // Real provider import, wrapper-relative (pin dir is 3 levels deep).
    expect(wrapper).toContain(
      'import { ProductProvider } from "../../../src/composite/product/context";',
    );
    expect(wrapper).toContain(
      '<ProductProvider product={{"title":"Vase"}} currency={"USD"}>',
    );
    expect(wrapper).toContain("</ProductProvider>");
    expect(wrapper).toContain("{children}");
    // Unserializable provider prop documented, never inlined.
    expect(wrapper).toContain("onSelect: function onSelect");
    // Captured props literal keeps the serializable ones only.
    expect(wrapper).toContain('"title": "Vase"');
    expect(wrapper).not.toContain("$unserializable");
    expect(wrapper).toContain("omitted: onAdd: function onAdd");
    expect(wrapper).toContain("export const capturedProps");
    expect(wrapper).toContain("export function SandboxProviders");
  });

  it("falls back to a Context literal, then a documented stub", async () => {
    const repoRoot = await makeFixtureRepo();
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-x1",
      contextSnapshot: {
        props: {},
        contexts: [
          // Context object importable by its captured name → literal provider.
          { name: "CartContext", value: { items: 2 } },
          // Nothing importable (unknown owner, unnamed context) → stub.
          {
            name: "Context",
            value: { user: { $unserializable: "function getUser" } },
            ownerName: "AuthProviderNotInRepo",
          },
        ],
        adapters: {},
      },
    });
    expect(wrapper).toContain(
      'import { CartContext } from "../../../src/providers/CartContext";',
    );
    expect(wrapper).toContain('<CartContext.Provider value={{"items":2}}>');
    expect(wrapper).toContain("NOT re-created (no importable provider)");
    expect(wrapper).not.toContain("AuthProviderNotInRepo>");
  });

  it("re-creates i18next from the app's locale JSON — the ADAPTER locale wins", async () => {
    const repoRoot = await makeFixtureRepo();
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-x1",
      contextSnapshot: {
        props: {},
        contexts: [
          // The i18next provider entry is covered by the generated section.
          {
            name: "Context",
            // Provider snapshot DISAGREES with the adapter — adapter wins.
            value: { language: "en-US" },
            ownerName: "I18nextProvider",
          },
        ],
        adapters: { "i18next:locale": "fr-FR" },
        i18n: {
          localePathPattern: "locales/{locale}/{namespace}.json",
          defaultNamespace: "app",
          defaultLocale: "en-US",
        },
      },
    });
    expect(wrapper).toContain(
      'import { I18nextProvider, initReactI18next } from "react-i18next";',
    );
    expect(wrapper).toContain('import { createInstance } from "i18next";');
    expect(wrapper).toContain(
      'import localeResources0 from "../../../locales/fr-FR/app.json";',
    );
    expect(wrapper).toContain('lng: "fr-FR"');
    expect(wrapper).toContain('"fr-FR": { "app": localeResources0 }');
    expect(wrapper).toContain("<I18nextProvider i18n={sandboxI18n}>");
    // The adapter-wins rule is documented in the wrapper itself.
    expect(wrapper).toContain("ADAPTER-captured locale wins");
    // The I18nextProvider context entry did not double-emit a stub.
    expect(wrapper).not.toContain("I18nextProvider: NOT re-created");
  });

  it("applies the captured theme mode/variant as canvas classes/attrs", async () => {
    const repoRoot = await makeFixtureRepo();
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-x1",
      contextSnapshot: {
        props: {},
        contexts: [],
        adapters: { "theme:mode": "dark", "theme:variant": "forest" },
      },
    });
    expect(wrapper).toContain(
      '<div className="designbook-theme dark" data-theme-variant="forest">',
    );
    expect(wrapper).toContain("theme:mode=dark");
    // Light mode captures the scope class WITHOUT the mode class.
    const light = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-x1",
      contextSnapshot: {
        props: {},
        contexts: [],
        adapters: { "theme:mode": "light" },
      },
    });
    expect(light).toContain('<div className="designbook-theme">');
  });

  it("is DETERMINISTIC: same snapshot → byte-identical output", async () => {
    const repoRoot = await makeFixtureRepo();
    const snapshot = {
      props: { title: "Vase" },
      contexts: [
        {
          name: "Context",
          value: { product: { title: "Vase" }, currency: "USD" },
          providerName: "ProductProvider",
          providerProps: { product: { title: "Vase" }, currency: "USD" },
        },
        { name: "CartContext", value: { items: 2 } },
      ],
      adapters: { "i18next:locale": "fr-FR", "theme:mode": "dark" },
      i18n: {
        localePathPattern: "locales/{locale}/{namespace}.json",
        defaultNamespace: "app",
      },
    };
    const first = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-aa",
      contextSnapshot: snapshot,
    });
    const second = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-bb", // a different pin, same selection snapshot
      contextSnapshot: snapshot,
    });
    expect(second).toBe(first);
    expect(first).toContain("<ProductProvider");
    expect(first).toContain("<I18nextProvider");
  });

  it("degrades to a pass-through wrapper on an empty snapshot", async () => {
    // A repo WITHOUT react-i18next — nothing to re-create at all.
    const repoRoot = await makeRepo();
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "productcard-x1",
      contextSnapshot: {},
    });
    expect(wrapper).toContain("return <>{children}</>;");
    expect(wrapper).toContain("export const capturedProps");
  });

  it("wraps in <MemoryRouter> at the captured path when the app uses react-router", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-router-"));
    cleanups.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "react-router-dom": "^7.0.0" } }),
    );
    const wrapper = await generateSandboxWrapper({
      repoRoot: root,
      appDir: "",
      pinId: "homepage-x1",
      contextSnapshot: {
        props: {},
        contexts: [],
        adapters: { "theme:mode": "dark" },
        capturedPath: "/trips",
      },
    });
    expect(wrapper).toContain('import { MemoryRouter } from "react-router-dom";');
    expect(wrapper).toContain('<MemoryRouter initialEntries={["/trips"]}>');
    expect(wrapper).toContain("</MemoryRouter>");
    // Router is OUTERMOST — above the theme div.
    expect(wrapper.indexOf("<MemoryRouter")).toBeLessThan(
      wrapper.indexOf("designbook-theme"),
    );
  });

  it("imports MemoryRouter from react-router when only the core package is a dep", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-router-"));
    cleanups.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "react-router": "^7.0.0" } }),
    );
    const wrapper = await generateSandboxWrapper({
      repoRoot: root,
      appDir: "",
      pinId: "p1",
      contextSnapshot: { props: {}, contexts: [], adapters: {} },
    });
    expect(wrapper).toContain('import { MemoryRouter } from "react-router";');
    // No captured path → defaults to "/".
    expect(wrapper).toContain('<MemoryRouter initialEntries={["/"]}>');
  });

  it("emits NO router when the app has no react-router dep", async () => {
    const repoRoot = await makeRepo(); // package.json-less repo
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "p1",
      contextSnapshot: {
        props: {},
        contexts: [],
        adapters: {},
        capturedPath: "/trips",
      },
    });
    expect(wrapper).not.toContain("MemoryRouter");
  });

  it("router codegen stays DETERMINISTIC (same snapshot → byte-identical)", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-router-"));
    cleanups.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "react-router-dom": "^7.0.0" } }),
    );
    const snapshot = {
      props: {},
      contexts: [],
      adapters: {},
      capturedPath: "/trips/42",
    };
    const first = await generateSandboxWrapper({
      repoRoot: root,
      appDir: "",
      pinId: "aa",
      contextSnapshot: snapshot,
    });
    const second = await generateSandboxWrapper({
      repoRoot: root,
      appDir: "",
      pinId: "bb",
      contextSnapshot: snapshot,
    });
    expect(second).toBe(first);
    expect(first).toContain('initialEntries={["/trips/42"]}');
  });

  /** Fixture: an app whose captured provider (`App`) renders its OWN
   * BrowserRouter (and also provides a plain ThemeContext). Re-instantiating it
   * under the wrapper's MemoryRouter would crash react-router. */
  async function makeAppRendersRouterRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "db-router-nest-"));
    cleanups.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "react-router-dom": "^7.0.0" } }),
    );
    await writeFile(
      join(root, "src/App.tsx"),
      [
        "import { BrowserRouter } from 'react-router-dom';",
        "import { createContext } from 'react';",
        "export const ThemeContext = createContext(undefined);",
        "export function App({ children }) {",
        "  return (",
        "    <BrowserRouter>",
        "      <ThemeContext value={{ mode: 'dark' }}>{children}</ThemeContext>",
        "    </BrowserRouter>",
        "  );",
        "}",
        "",
      ].join("\n"),
    );
    return root;
  }

  it("EXCLUDES a captured provider that renders its own Router; keeps MemoryRouter", async () => {
    const repoRoot = await makeAppRendersRouterRepo();
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "homepage-x1",
      contextSnapshot: {
        props: {},
        contexts: [
          // The router context entry the capture attributes to <App> (App is the
          // component that renders BrowserRouter inline). ThemeContext lives on
          // the SAME owner, so its value must survive as a literal.
          {
            name: "ThemeContext",
            value: { mode: "dark" },
            ownerName: "App",
            ownerFile: "src/App.tsx",
            providerName: "App",
            providerProps: {},
          },
        ],
        adapters: {},
        capturedPath: "/trips",
      },
    });
    // <App> is NOT re-instantiated (no import, no JSX layer, documented note).
    expect(wrapper).not.toContain('import { App }');
    expect(wrapper).not.toContain("</App>");
    expect(wrapper).toContain("NOT re-instantiated (renders its own Router");
    // The wrapper still emits its OWN MemoryRouter at the captured route.
    expect(wrapper).toContain('import { MemoryRouter } from "react-router-dom";');
    expect(wrapper).toContain('<MemoryRouter initialEntries={["/trips"]}>');
    // The non-router context App provided degrades to a literal (value kept).
    expect(wrapper).toContain(
      'import { ThemeContext } from "../../../src/App";',
    );
    expect(wrapper).toContain('<ThemeContext.Provider value={{"mode":"dark"}}>');
  });

  it("router-exclusion output stays DETERMINISTIC (byte-identical)", async () => {
    const repoRoot = await makeAppRendersRouterRepo();
    const snapshot = {
      props: {},
      contexts: [
        {
          name: "ThemeContext",
          value: { mode: "dark" },
          ownerName: "App",
          ownerFile: "src/App.tsx",
          providerName: "App",
          providerProps: {},
        },
      ],
      adapters: {},
      capturedPath: "/trips",
    };
    const first = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "aa",
      contextSnapshot: snapshot,
    });
    const second = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "bb",
      contextSnapshot: snapshot,
    });
    expect(second).toBe(first);
  });

  it("EXCLUDES a provider whose identity IS a react-router Router export", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-router-id-"));
    cleanups.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    // The app re-exports BrowserRouter under its own name (resolvable in source).
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "react-router-dom": "^7.0.0" } }),
    );
    await writeFile(
      join(root, "src/routing.tsx"),
      "export { BrowserRouter } from 'react-router-dom';\n",
    );
    const wrapper = await generateSandboxWrapper({
      repoRoot: root,
      appDir: "",
      pinId: "p1",
      contextSnapshot: {
        props: {},
        contexts: [
          {
            name: "Context",
            value: {},
            providerName: "BrowserRouter",
            providerFile: "src/routing.tsx",
            providerProps: {},
          },
        ],
        adapters: {},
        capturedPath: "/",
      },
    });
    expect(wrapper).not.toContain('import { BrowserRouter } from "../');
    expect(wrapper).not.toContain("</BrowserRouter>");
    expect(wrapper).toContain("NOT re-instantiated (renders its own Router");
    expect(wrapper).toContain('<MemoryRouter initialEntries={["/"]}>');
  });

  it("does NOT double-wrap: a Router provider WITHOUT a router dep still yields ONE Router", async () => {
    // No package.json → buildRouterSection's secondary signal (a captured
    // `*Router` provider) fires and emits MemoryRouter; that same provider is
    // then excluded, so exactly one Router exists.
    const repoRoot = await makeRepo(); // package.json-less repo
    const wrapper = await generateSandboxWrapper({
      repoRoot,
      appDir: "",
      pinId: "p1",
      contextSnapshot: {
        props: {},
        contexts: [
          {
            name: "Context",
            value: {},
            providerName: "AppRouter",
            ownerName: "AppRouter",
          },
        ],
        adapters: {},
        capturedPath: "/home",
      },
    });
    expect(wrapper).toContain('<MemoryRouter initialEntries={["/home"]}>');
    // The AppRouter provider is not re-instantiated (name heuristic, source
    // unreadable) — no second Router.
    expect(wrapper).not.toContain("<AppRouter>");
    expect((wrapper.match(/MemoryRouter initialEntries/g) ?? []).length).toBe(1);
  });
});

describe("prompt builders", () => {
  it("director prompt asks for directions ONLY (the wrapper is generated in code)", () => {
    const prompt = buildSandboxDirectorPrompt({
      pin: PIN,
      appDir: "examples/demo",
      count: 2,
      request: "make variants",
      sourceContext: "--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---\ncode",
    });
    // The director NEVER writes wrapper.tsx anymore (live-eval finding).
    expect(prompt).not.toContain("Write the sandbox context wrapper");
    expect(prompt).not.toContain("wrapper.tsx");
    expect(prompt).toContain("designbook generates the context wrapper itself");
    expect(prompt).toContain("ONLY a JSON array");
    // Enrichment: quality contract + captured context + original source.
    expect(prompt).toContain("Quality contract:");
    expect(prompt).toContain("Captured props");
    expect(prompt).toContain("--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---");
  });

  it("variant prompt is TRANSPARENT (L2): edits the REAL path, no path-discipline rules, FIXED wrapper", () => {
    const prompt = buildSandboxVariantPrompt({
      pin: PIN,
      appDir: "",
      slug: "bold",
      intent: "bigger emphasis",
      request: "louder",
      sourceContext: "--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---\ncode",
    });
    // L2: the agent edits the REAL module path; the overlay stages it.
    expect(prompt).toContain(`Apply the design by EDITING ${PIN.target.file}`);
    expect(prompt).toContain("redesign the ProductCard component");
    expect(prompt).toContain("Keep every export the module has today");
    // Every WHERE-files-live rule died with the overlay toolset.
    expect(prompt).not.toContain("EXACTLY this file");
    expect(prompt).not.toContain("drop-in replacement");
    expect(prompt).not.toContain("Do not create, edit, or delete ANY file");
    expect(prompt).not.toContain("ADAPTER-DATA EXCEPTION");
    expect(prompt).not.toContain("NEVER import");
    expect(prompt).not.toContain(".designbook/changesets");
    // The soft data-quality line survives (no mechanism talk).
    expect(prompt).toContain("add NEW keys to the app's data files");
    expect(prompt).toContain("no i18n.addResource");
    expect(prompt).toContain("CAPTURED state");
    expect(prompt).toContain("title:");
    expect(prompt).toContain("<unserializable: function onAdd>");
    // The wrapper is FIXED given code — documented, never re-authored.
    expect(prompt).toContain(
      "code-generated wrapper at .designbook/sandbox/productcard-x1/wrapper.tsx",
    );
    expect(prompt).toContain("<SandboxProviders><ProductCard {...capturedProps} /></SandboxProviders>");
    expect(prompt).toContain("Quality contract:");
    expect(prompt).toContain("--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---");
  });

  it("render-fix prompt carries the error and targets the REAL path (component pins)", () => {
    const prompt = buildSandboxRenderFixPrompt({
      pin: PIN,
      variant: PIN.variants[0],
      renderError: "useLanguage must be used inside a LanguageProvider.",
    });
    expect(prompt).toContain("THROWS when rendered");
    expect(prompt).toContain("useLanguage must be used inside a LanguageProvider.");
    // L2: the component variant lives AT the module path in the session's
    // view — the fix targets the real path, and the fences died.
    expect(prompt).toContain(`file: ${PIN.target.file}`);
    expect(prompt).not.toContain(PIN.variants[0].file);
    expect(prompt).not.toContain("Do not create, edit, or delete ANY file");
    expect(prompt).toContain("named ProductCard");
  });

  it("bake-merge prompt (the ONE merge-agent turn) names all three sides", () => {
    const prompt = buildBakeMergePrompt({
      module: "src/Card.tsx",
      baseFile: ".designbook/changesets/cs-x/base/src/Card.tsx",
      layeredFile: ".designbook/changesets/cs-x/alts/bold/src/Card.tsx",
      conflictSummary: "<<<<<<< current",
    });
    expect(prompt).toContain("REAL source to edit");
    expect(prompt).toContain("BASE snapshot");
    expect(prompt).toContain("CHANGESET design");
    expect(prompt).toContain(".designbook/changesets/cs-x/base/src/Card.tsx");
    expect(prompt).toContain(".designbook/changesets/cs-x/alts/bold/src/Card.tsx");
    expect(prompt).toContain("PRESERVE the file's exported prop interface");
    expect(prompt).toContain("no imports from .designbook/");
    expect(prompt).toContain("<<<<<<< current");
  });
});

describe("element prompt builders (docs/specs/sandbox.md v2)", () => {
  it("element DIRECTOR prompt demands both artifacts, the from: mapping, and directions JSON", () => {
    const prompt = buildElementDirectorPrompt({
      pin: ELEMENT_PIN,
      appDir: "",
      count: 3,
      request: "variations of this section",
      sourceContext: "--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---\ncode",
    });
    // Artifact 1: the extracted span component.
    expect(prompt).toContain(".designbook/sandbox/productcard-e1/original.tsx");
    expect(prompt).toContain("named Original");
    // Artifact 2: the controller — real hooks, inlined locals, mapping.
    expect(prompt).toContain(".designbook/sandbox/productcard-e1/controller.tsx");
    expect(prompt).toContain("named Controller");
    expect(prompt).toContain("REAL hooks");
    expect(prompt).toContain("// from: <the exact expression the original span used>");
    expect(prompt).toContain("<V {...props} />");
    expect(prompt).toContain("NEVER inline a resolved string");
    // The wrapper stays code-generated — the director must not touch it.
    expect(prompt).toContain("do NOT create, edit, or import the wrapper");
    // Directions contract unchanged.
    expect(prompt).toContain("ONLY a JSON array");
    expect(prompt).toContain("Quality contract:");
    // Locator signals + captured element values are all present.
    expect(prompt).toContain("Selected ELEMENT locator");
    expect(prompt).toContain(LOCATOR.outerHtml);
    expect(prompt).toContain("element-child index path");
    expect(prompt).toContain("Selected element subtree");
    expect(prompt).toContain("--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---");
    // L2: the file fence died (the artifacts ARE the task; overlays catch
    // strays mechanically).
    expect(prompt).not.toContain("Do not create, edit, or delete ANY file");
  });

  it("element VARIANT prompt embeds the contract and mounts through the controller", () => {
    const prompt = buildElementVariantPrompt({
      pin: ELEMENT_PIN,
      appDir: "",
      targetPath: ".designbook/sandbox/productcard-e1/stacked.tsx",
      slug: "stacked",
      intent: "vertical price stack",
      request: "variations of this section",
      originalSource: "export function Original({ price }: { price: string }) {}",
      controllerSource: 'const props = { price: t("p.price"), // from: t("p.price")\n};',
    });
    expect(prompt).toContain(
      "Write the variant to EXACTLY this file: .designbook/sandbox/productcard-e1/stacked.tsx",
    );
    expect(prompt).toContain("named Original");
    expect(prompt).toContain("SAME props contract");
    expect(prompt).toContain("do NOT re-create providers");
    expect(prompt).toContain("--- EXTRACTED ORIGINAL");
    expect(prompt).toContain("export function Original({ price }");
    expect(prompt).toContain("--- CONTROLLER");
    expect(prompt).toContain('// from: t("p.price")');
    expect(prompt).toContain("Quality contract:");
  });

  it("iterate/render-fix prompts use the element export name and target the span artifact", () => {
    const iterate = buildSandboxIteratePrompt({
      pin: ELEMENT_PIN,
      variant: ELEMENT_PIN.variants[0],
      request: "tighter",
    });
    // Element span variants stay standalone artifacts; the fence died (L2).
    expect(iterate).toContain("named Original");
    expect(iterate).toContain(`edit ${ELEMENT_PIN.variants[0].file}`);
    expect(iterate).not.toContain("Do not create, edit, or delete ANY file");
    const fix = buildSandboxRenderFixPrompt({
      pin: ELEMENT_PIN,
      variant: ELEMENT_PIN.variants[0],
      renderError: "boom",
    });
    // The render-fix loop covers controller crashes too (spec: alike).
    expect(fix).toContain("named Original");
    expect(fix).toContain(ELEMENT_PIN.controllerFile!);
    expect(fix).toContain("`// from:` mapping comment");
  });

  it("iterate prompt folds in the canvas element descriptor when present", () => {
    const element = {
      tag: "div",
      classes: ["flex", "gap-2"],
      label: "div.flex",
      text: "$12.99",
      outerHtml: '<div class="flex gap-2">$12.99</div>',
      componentHint: "ProductPrice",
    };
    const prompt = buildSandboxIteratePrompt({
      pin: ELEMENT_PIN,
      variant: ELEMENT_PIN.variants[0],
      request: "uppercase the text",
      element,
    });
    expect(prompt).toContain("selected a specific ELEMENT");
    expect(prompt).toContain("apply the request to that element");
    expect(prompt).toContain("Selected element: <div> classes: flex gap-2");
    expect(prompt).toContain("(component: ProductPrice)");
    expect(prompt).toContain("Rendered text: $12.99");
    expect(prompt).toContain('<div class="flex gap-2">$12.99</div>');
    // Element context lands BEFORE the hard rules (context, not a rule).
    expect(prompt.indexOf("Selected element:")).toBeLessThan(
      prompt.indexOf("Hard rules:"),
    );
    // Without a descriptor the prompt stays element-free (frame iterate).
    const plain = buildSandboxIteratePrompt({
      pin: ELEMENT_PIN,
      variant: ELEMENT_PIN.variants[0],
      request: "uppercase the text",
    });
    expect(plain).not.toContain("Selected element:");
  });
});

describe("sanitizeIterateElement", () => {
  it("passes a well-formed descriptor through", () => {
    expect(
      sanitizeIterateElement({
        tag: "span",
        id: "price",
        classes: ["font-bold"],
        label: "span.font-bold",
        text: " $9 ",
        outerHtml: "<span>$9</span>",
        componentHint: "ProductPrice",
      }),
    ).toEqual({
      tag: "span",
      id: "price",
      classes: ["font-bold"],
      label: "span.font-bold",
      text: "$9",
      outerHtml: "<span>$9</span>",
      componentHint: "ProductPrice",
    });
  });

  it("rejects wrong shapes and bad tags (degrade to frame iterate)", () => {
    expect(sanitizeIterateElement(undefined)).toBeUndefined();
    expect(sanitizeIterateElement("div")).toBeUndefined();
    expect(sanitizeIterateElement({ tag: "DIV<script>", label: "x" })).toBeUndefined();
    expect(sanitizeIterateElement({ tag: "div", label: "  " })).toBeUndefined();
  });

  it("re-applies caps server-side", () => {
    const sanitized = sanitizeIterateElement({
      tag: "div",
      label: "d".repeat(500),
      text: "t".repeat(5000),
      outerHtml: "<div>" + "y".repeat(5000) + "</div>",
      classes: Array.from({ length: 50 }, (_, i) => "c" + i),
    })!;
    expect(sanitized.label.length).toBe(120);
    expect(sanitized.text!.length).toBe(300);
    expect(sanitized.outerHtml!.length).toBe(1024);
    expect(sanitized.classes!.length).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator state machine (fake turns, temp repo).
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
/** Each harness's orchestrator.settle — drained before the temp repos go. */
const settlers: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Flush every orchestrator's queued index/meta writes FIRST: a
  // fire-and-forget persist (createPin, retry, position) still in flight
  // re-creates .designbook mid-teardown and the recursive rm below dies
  // with ENOTEMPTY under parallel load.
  while (settlers.length > 0) {
    await settlers.pop()!();
  }
  while (cleanups.length > 0) {
    const root = cleanups.pop()!;
    // Belt for writers settle() cannot see (a persist queued between the
    // drain above and the rm — e.g. a title turn still running): rm is
    // idempotent, so retry the teardown a few times instead of failing the
    // test on a torn-down tmp dir.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
});

/** A REAL git repo fixture (G1: git is the truth plane — the fake-fs
 * harness died with the overlay). One committed source file on `main`. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "db-sandbox-"));
  cleanups.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/Card.tsx"),
    "export function ProductCard() { return null; }\n",
  );
  await execFileAsync("git", ["init", "-q", "-b", "main", root]);
  await gitCommitAll(root, "init");
  return root;
}

/** Commit every pending change (test setup files must be in git history —
 * worktrees + base blobs derive from commits, not the working tree). */
async function gitCommitAll(root: string, message = "setup"): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message, "--allow-empty"],
    { cwd: root },
  );
}

type Emitted = { type?: string; [key: string]: unknown };

function harness(options: {
  runTurn: SandboxRunTurn;
  runTypecheck?: SandboxTypecheck;
  onOverridesChanged?: (redirects: Record<string, string>) => void;
  /** Fake branch prober (layer tagging/visibility) — default "main". */
  gitInfo?: (repoRoot: string) => Promise<{ branch: string; commit: string }>;
  /** Fake 3-way merge — default: clean when current === base (no drift),
   * conflicted otherwise (tests choose the merge-agent path explicitly). */
  mergeFile?: (
    base: string,
    current: string,
    layered: string,
  ) => Promise<{ content: string; conflicted: boolean }>;
}) {
  const events: Emitted[] = [];
  const sleeps: number[] = [];
  const orchestrator = createSandboxOrchestrator({
    runTurn: options.runTurn,
    runTypecheck: options.runTypecheck ?? (async () => ({ ok: true })),
    broadcast: (eventName, payload) => {
      if (eventName === "sandbox-event") events.push(payload as Emitted);
    },
    log: () => {},
    // Default = REAL git (makeRepo is a real repo); foreign-branch tests
    // inject a fake to shift the home's branch tag.
    ...(options.gitInfo ? { gitInfo: options.gitInfo } : {}),
    mergeFile:
      options.mergeFile ??
      (async (base, current, layered) =>
        current === base
          ? { content: layered, conflicted: false }
          : { content: `<<<<<<< current\n${current}=======\n${layered}>>>>>>> layered\n`, conflicted: true }),
    ...(options.onOverridesChanged
      ? { onOverridesChanged: options.onOverridesChanged }
      : {}),
    // Instant, recorded backoff — retry tests stay fast and assert delays.
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  settlers.push(() => orchestrator.settle());
  return { events, orchestrator, sleeps };
}

async function until(
  predicate: () => boolean,
  label: string,
  tries = 400,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const TARGET = {
  file: "src/Card.tsx",
  exportName: "ProductCard",
  name: "Product Card",
};

/**
 * G1 fakes: simulate the agent editing a REAL path with the built-in tools
 * — the turn's cwd IS a changeset worktree, so the write lands there and
 * the orchestrator's turn-end commit + projection carry it; the real tree
 * is untouched.
 */
type FakeTurnParams = Parameters<SandboxRunTurn>[0];
async function agentWrite(
  params: FakeTurnParams,
  rel: string,
  content: string,
): Promise<void> {
  const abs = join(params.cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  // The per-write commit seam (api.ts feeds tool_execution_end here).
  await params.capture?.noteToolEnd({
    toolCallId: `t-${Math.random().toString(36).slice(2, 8)}`,
    toolName: "write",
  });
}

/** The read a live agent's read tool would perform (worktree cwd). */
async function agentRead(
  params: FakeTurnParams,
  rel: string,
): Promise<string | undefined> {
  return readFile(join(params.cwd, rel), "utf8").catch(() => undefined);
}

describe("createPin", () => {
  it("creates a durable pin and rejects escapes", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async () => ({ text: "" }),
    });
    const created = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: { props: {} },
    });
    expect(created.error).toBeUndefined();
    expect(created.id).toBeDefined();
    expect(events[0]?.type).toBe("pin-created");
    await until(
      () => parsePins(readIndexSync(repoRoot)).length === 1,
      "index write",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.target).toMatchObject(TARGET);
    expect(record.resolved).toBe(false);

    expect(
      (
        await orchestrator.createPin({
          repoRoot,
          appDir: "",
          target: { ...TARGET, file: "../outside.tsx" },
          contextSnapshot: {},
        })
      ).error,
    ).toBeDefined();
    expect(
      (
        await orchestrator.createPin({
          repoRoot,
          appDir: "",
          target: { ...TARGET, file: ".designbook/sandbox/x/y.tsx" },
          contextSnapshot: {},
        })
      ).error,
    ).toBeDefined();
  });

  it("U5: COMPONENT pins keep an optional best-effort locator; garbage is dropped, never a gate", async () => {
    const repoRoot = await makeRepo();
    const { orchestrator } = harness({ runTurn: async () => ({ text: "" }) });
    const created = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
      locator: {
        tag: "section",
        outerHtml: '<section class="card">Vase</section>',
        childIndexPath: [1],
        textHash: "ab12",
        text: "Vase",
        className: "card",
      },
    });
    expect(created.error).toBeUndefined();
    // An unusable locator on a component pin is dropped silently.
    const bare = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
      locator: { tag: "NOT A TAG" },
    });
    expect(bare.error).toBeUndefined();
    await until(
      () => parsePins(readIndexSync(repoRoot)).length === 2,
      "index write",
    );
    const records = parsePins(readIndexSync(repoRoot));
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    expect(byId[created.id!].kind).toBe("component");
    expect(byId[created.id!].locator).toMatchObject({
      tag: "section",
      textHash: "ab12",
      className: "card",
    });
    expect(byId[bare.id!].locator).toBeUndefined();
  });

  it("REVIVE COMPAT: records without entryId parse and revive as-is", () => {
    const record: SandboxPin = {
      ...PIN,
      target: {
        file: "src/pages/HomePage.tsx",
        exportName: "HomePage",
        name: "section.rounded-xl",
        // No entryId — a source-owner pin (unregistered authoring component).
        instancePath: "src:HomePage::dom:1",
      },
    };
    const [parsed] = parsePins(serializePins([record]));
    expect(parsed.target.entryId).toBeUndefined();
    expect(parsed.target.file).toBe("src/pages/HomePage.tsx");
    expect(parsed.kind).toBe("component");
  });

  it("SOURCE-OWNER FALLBACK: resolves an element pin's file from ownerNames", async () => {
    const repoRoot = await makeRepo();
    await mkdir(join(repoRoot, "src/pages"), { recursive: true });
    await writeFile(
      join(repoRoot, "src/pages/HomePage.tsx"),
      "function HomePage() { return <section className=\"rounded-xl\" />; }\nexport { HomePage };\n",
    );
    const { orchestrator } = harness({ runTurn: async () => ({ text: "" }) });
    const locator = {
      tag: "section",
      outerHtml: '<section class="rounded-xl"></section>',
      childIndexPath: [0],
      textHash: "aa",
      className: "rounded-xl",
    };
    // Nearest owner "Link" exports nowhere in the app — the chain's next
    // name (the page shell) resolves and becomes the pin's export.
    const created = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: { file: "", exportName: "Link", name: "section.rounded-xl" },
      contextSnapshot: {},
      kind: "element",
      locator,
      ownerNames: ["Link", "HomePage", "App"],
    });
    expect(created.error).toBeUndefined();
    await until(
      () => parsePins(readIndexSync(repoRoot)).length === 1,
      "index write",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.target.file).toBe("src/pages/HomePage.tsx");
    expect(record.target.exportName).toBe("HomePage");
    expect(record.target.entryId).toBeUndefined();
    expect(record.kind).toBe("element");

    // Nothing on the chain resolves → a readable error, no pin.
    const unresolved = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: { file: "", exportName: "Nowhere", name: "div" },
      contextSnapshot: {},
      kind: "element",
      locator,
      ownerNames: ["AlsoNowhere"],
    });
    expect(unresolved.id).toBeUndefined();
    expect(unresolved.error).toContain("Nowhere");

    // COMPONENT pins never scan — a missing file stays an error (unchanged).
    const component = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: { file: "", exportName: "HomePage", name: "HomePage" },
      contextSnapshot: {},
    });
    expect(component.error).toBeDefined();
  });
});

function readIndexSync(repoRoot: string): string {
  try {
    return readFileSync(join(repoRoot, sandboxIndexFile("")), "utf8");
  } catch {
    return "";
  }
}

describe("variants generation", () => {
  it("director plans, fallback wrapper lands, variants land per file-verify", async () => {
    const repoRoot = await makeRepo();
    const turns: Array<{ mode: string; prompt: string }> = [];
    const { events, orchestrator } = harness({
      // Director replies with directions but "forgets" the wrapper; variant
      // turns edit the REAL target THROUGH their overlay (L2) — the write
      // stages as the variant's alternative.
      runTurn: async (params) => {
        const { mode, prompt } = params;
        turns.push({ mode, prompt });
        if (mode === "variant") {
          const slug = prompt.match(/Design direction "([^"]+)"/)![1];
          if (slug !== "fails") {
            await agentWrite(
              params,
              TARGET.file,
              "export function ProductCard(){return null;}\n",
            );
          }
          return { text: slug === "fails" ? "could not" : "done" };
        }
        return {
          text: '[{"slug":"compact","intent":"denser"},{"slug":"fails","intent":"boom"}]',
        };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: { props: { a: 1 } },
    });
    expect(orchestrator.prompt({ pinId: id!, prompt: "variants please", mode: "variants", count: 2 }).error).toBeUndefined();
    // Double-start guard while busy.
    expect(
      orchestrator.prompt({ pinId: id!, prompt: "again", mode: "variants" })
        .error,
    ).toBeDefined();
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    const ready = events.find((event) => event.type === "variant-ready")!;
    expect(ready.variantId).toBe("compact");
    // LAYERS: component variants land at the MIRRORED path inside the
    // pin's layer (full drop-in modules the canvas imports directly).
    expect(ready.absPath).toBe(
      join(repoRoot, moduleAltPath("", id!, "compact", TARGET.file)),
    );
    expect(typeof ready.x).toBe("number");
    const failed = events.find((event) => event.type === "variant-failed")!;
    expect(failed.variantId).toBe("fails");
    expect(String(failed.error)).toContain("without writing");
    // The wrapper fallback landed because the director didn't write one.
    const wrapper = await readFile(
      join(repoRoot, wrapperPath("", id!)),
      "utf8",
    );
    expect(wrapper).toContain("export const capturedProps");
    // Durable record has the final statuses + positions.
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants.length === 2,
      "index variants",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    const statuses = Object.fromEntries(
      record.variants.map((variant) => [variant.id, variant.status]),
    );
    expect(statuses).toEqual({ compact: "ready", fails: "failed" });
    // Director prompt carried the captured context.
    expect(turns[0].mode).toBe("director");
    expect(turns[0].prompt).toContain("Captured props");
  });

  it("surfaces turn-level provider errors on the failed variant", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async ({ mode }) =>
        mode === "director"
          ? { text: '[{"slug":"compact","intent":"denser"}]' }
          : { text: "", errorMessage: "You're out of extra usage" },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "variant-failed"),
      "variant-failed",
    );
    expect(
      String(events.find((event) => event.type === "variant-failed")!.error),
    ).toContain("out of extra usage");
  });
});

describe("turn-activity relay (U4 transparency)", () => {
  it("coalesces thinking deltas, flushes on tool boundaries + flush()", () => {
    const out: SandboxTurnActivity[] = [];
    const relay = createTurnActivityRelay((entry) => out.push(entry));
    // Small deltas buffer (below the flush threshold — no event yet).
    relay.handle({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Reading " },
    });
    relay.handle({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "the card." },
    });
    expect(out).toEqual([]);
    // A tool start flushes the buffered thinking FIRST, then the tool row.
    relay.handle({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: { path: "src/Card.tsx" },
    });
    expect(out).toEqual([
      { kind: "thinking", text: "Reading the card." },
      { kind: "tool", id: "t1", name: "read", status: "running", detail: "src/Card.tsx" },
    ]);
    relay.handle({ type: "tool_execution_end", toolCallId: "t1", toolName: "read" });
    expect(out[2]).toEqual({ kind: "tool", id: "t1", name: "read", status: "done" });
    relay.handle({
      type: "tool_execution_end",
      toolCallId: "t2",
      toolName: "edit",
      isError: true,
    });
    expect(out[3]).toMatchObject({ kind: "tool", id: "t2", status: "error" });
    // A big delta crosses the threshold and flushes on its own.
    relay.handle({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(250) },
    });
    expect(out[4]).toEqual({ kind: "thinking", text: "x".repeat(250) });
    // Trailing partial thinking lands on flush() (turn end).
    relay.handle({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "tail" },
    });
    relay.flush();
    expect(out[5]).toEqual({ kind: "thinking", text: "tail" });
    // Non-activity events are dropped (text deltas ship via the thread).
    relay.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "final reply" },
    });
    relay.flush();
    expect(out.length).toBe(6);
  });

  it("stops relaying thinking past the per-turn budget; tools keep flowing", () => {
    const out: SandboxTurnActivity[] = [];
    const relay = createTurnActivityRelay((entry) => out.push(entry));
    for (let i = 0; i < 100; i += 1) {
      relay.handle({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "y".repeat(250) },
      });
    }
    const thinkingChars = out
      .filter((entry) => entry.kind === "thinking")
      .reduce((sum, entry) => sum + (entry as { text: string }).text.length, 0);
    expect(thinkingChars).toBeLessThanOrEqual(12_250);
    relay.handle({ type: "tool_execution_start", toolCallId: "t9", toolName: "bash" });
    expect(out.at(-1)).toMatchObject({ kind: "tool", id: "t9" });
  });

  it("orchestrator: director + variant sessions report keyed session-activity", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        const { mode, onActivity } = params;
        if (mode === "director") {
          onActivity?.({ kind: "thinking", text: "planning directions" });
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        onActivity?.({
          kind: "tool",
          id: "t1",
          name: "write",
          status: "running",
          detail: "compact.tsx",
        });
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    const activity = events.filter((event) => event.type === "session-activity");
    expect(activity[0]).toMatchObject({
      pinId: id,
      sessionRole: "director",
      entry: { kind: "thinking", text: "planning directions" },
    });
    expect(activity[0].variantId).toBeUndefined();
    expect(activity[1]).toMatchObject({
      pinId: id,
      sessionRole: "variant",
      variantId: "compact",
      entry: { kind: "tool", id: "t1", name: "write", status: "running" },
    });
  });
});

describe("turn-failure classification", () => {
  it("classifies infrastructure hiccups as transient", () => {
    for (const message of [
      "stream ended unexpectedly",
      "The response ended early",
      "socket hang up",
      "fetch failed",
      "request timed out",
      "ETIMEDOUT",
      "ECONNRESET while streaming",
      "500 Internal Server Error",
      "503 Service Unavailable",
      "Overloaded",
      "429 rate limit exceeded",
    ]) {
      expect(classifySandboxTurnFailure(message), message).toBe("transient");
    }
  });

  it("classifies auth/quota/4xx (and unknowns) as permanent", () => {
    for (const message of [
      "You're out of extra usage",
      "quota exceeded",
      "invalid api key",
      "401 unauthorized",
      "403 Forbidden",
      "monthly credit exhausted",
      // Quota wins even when a retryable-looking status code tags along.
      "429: out of extra usage this month",
      // Unknown failures fail fast with the real message.
      "something inexplicable happened",
    ]) {
      expect(classifySandboxTurnFailure(message), message).toBe("permanent");
    }
  });
});

describe("variant turn auto-retry", () => {
  async function pinned(runTurn: SandboxRunTurn) {
    const repoRoot = await makeRepo();
    const h = harness({ runTurn });
    const { id } = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    return { ...h, repoRoot, id: id! };
  }

  function writeVariant(params: FakeTurnParams) {
    return agentWrite(
      params,
      TARGET.file,
      "export function ProductCard(){return null;}\n",
    );
  }

  it("retries a TRANSIENT failure (with backoff + variant-retrying) and lands", async () => {
    let variantTurns = 0;
    const { events, orchestrator, sleeps, id } = await pinned(
      async (params) => {
        if (params.mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        variantTurns += 1;
        if (variantTurns === 1) {
          return { text: "", errorMessage: "stream ended unexpectedly (socket hang up)" };
        }
        await writeVariant(params);
        return { text: "done" };
      },
    );
    orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    expect(variantTurns).toBe(2);
    const retrying = events.find((event) => event.type === "variant-retrying")!;
    expect(retrying.variantId).toBe("compact");
    expect(retrying.attempt).toBe(2);
    expect(String(retrying.error)).toContain("stream ended");
    expect(sleeps).toEqual([500]);
    expect(events.some((event) => event.type === "variant-ready")).toBe(true);
    expect(events.some((event) => event.type === "variant-failed")).toBe(false);
  });

  it("gives up after 2 auto-retries, failing with the last diagnostic", async () => {
    let variantTurns = 0;
    const { events, orchestrator, sleeps, id } = await pinned(async ({ mode }) => {
      if (mode === "director") {
        return { text: '[{"slug":"compact","intent":"denser"}]' };
      }
      variantTurns += 1;
      return { text: "", errorMessage: "503 Service Unavailable" };
    });
    orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "variant-failed"),
      "variant-failed",
    );
    expect(variantTurns).toBe(3); // 1 + MAX_TRANSIENT_RETRIES
    expect(sleeps).toEqual([500, 1500]);
    expect(
      events.filter((event) => event.type === "variant-retrying"),
    ).toHaveLength(2);
    expect(
      String(events.find((event) => event.type === "variant-failed")!.error),
    ).toContain("503");
  });

  it("fails PERMANENT failures immediately (no retry, real message)", async () => {
    let variantTurns = 0;
    const { events, orchestrator, sleeps, id } = await pinned(async ({ mode }) => {
      if (mode === "director") {
        return { text: '[{"slug":"compact","intent":"denser"}]' };
      }
      variantTurns += 1;
      return { text: "", errorMessage: "You're out of extra usage" };
    });
    orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "variant-failed"),
      "variant-failed",
    );
    expect(variantTurns).toBe(1);
    expect(sleeps).toEqual([]);
    expect(events.some((event) => event.type === "variant-retrying")).toBe(false);
    expect(
      String(events.find((event) => event.type === "variant-failed")!.error),
    ).toContain("out of extra usage");
  });

  it("retries a THROWN network error from the turn seam", async () => {
    let variantTurns = 0;
    const { events, orchestrator, id } = await pinned(
      async (params) => {
        if (params.mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        variantTurns += 1;
        if (variantTurns === 1) throw new Error("fetch failed: ECONNRESET");
        await writeVariant(params);
        return { text: "done" };
      },
    );
    orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "variant-ready"),
      "variant-ready",
    );
    expect(variantTurns).toBe(2);
  });
});

describe("manual retry", () => {
  it("re-runs a failed variant with the ORIGINAL request and lands it", async () => {
    const repoRoot = await makeRepo();
    let failNext = true;
    const variantPrompts: string[] = [];
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        variantPrompts.push(prompt);
        if (failNext) {
          failNext = false;
          // PERMANENT so the auto-retry loop stays out of this test.
          return { text: "", errorMessage: "You're out of extra usage" };
        }
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({
      pinId: id!,
      prompt: "make it pop",
      mode: "variants",
      count: 1,
    });
    await until(
      () => events.some((event) => event.type === "variant-failed"),
      "variant-failed",
    );

    // Guards: unknown variant / non-failed variants refuse.
    expect(
      orchestrator.retry({ pinId: id!, variantId: "nope" }).error,
    ).toBeDefined();

    await until(
      () => events.some((event) => event.type === "run-complete"),
      "first run-complete",
    );
    expect(
      orchestrator.retry({ pinId: id!, variantId: "compact" }).error,
    ).toBeUndefined();
    // Busy guard while the retry runs.
    expect(
      orchestrator.retry({ pinId: id!, variantId: "compact" }).error,
    ).toBeDefined();
    await until(
      () => events.some((event) => event.type === "variant-ready"),
      "variant-ready after retry",
    );
    // The manual retry announced itself and re-ran with the SAME request.
    const retrying = events.find((event) => event.type === "variant-retrying")!;
    expect(retrying.variantId).toBe("compact");
    expect(retrying.attempt).toBe(1);
    expect(variantPrompts).toHaveLength(2);
    expect(variantPrompts[1]).toContain("make it pop");
    // Ready variants refuse a retry.
    expect(
      orchestrator.retry({ pinId: id!, variantId: "compact" }).error,
    ).toBeDefined();
    // Durable record landed as ready.
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.status ===
        "ready",
      "index ready",
    );
  });
});

describe("render-failure feedback loop", () => {
  const RENDER_ERROR = "useLanguage must be used inside a LanguageProvider.";

  /** A pin with one READY variant + a fake turn that records fix prompts. */
  async function readyVariantPin(options?: { fixTurnError?: string }) {
    const repoRoot = await makeRepo();
    const fixPrompts: string[] = [];
    let turns = 0;
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        turns += 1;
        if (prompt.includes("THROWS when rendered")) {
          fixPrompts.push(prompt);
          if (options?.fixTurnError) {
            return { text: "", errorMessage: options.fixTurnError };
          }
          return { text: "fixed" };
        }
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    return {
      repoRoot,
      events,
      orchestrator,
      id: id!,
      fixPrompts,
      turnCount: () => turns,
    };
  }

  it("marks failed + auto-fixes ONCE, then stays failed on a second failure", async () => {
    const { repoRoot, events, orchestrator, id, fixPrompts } =
      await readyVariantPin();

    // First report: failed (diagnostics) → one fix turn → ready again (rev 2).
    expect(
      orchestrator.renderFailure({
        pinId: id,
        variantId: "compact",
        error: RENDER_ERROR,
      }).error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.type === "variant-updated"),
      "variant-updated after auto-fix",
    );
    const failed = events.find((event) => event.type === "variant-failed")!;
    expect(String(failed.error)).toContain("crashed while rendering");
    expect(String(failed.error)).toContain(RENDER_ERROR);
    expect(
      events.some(
        (event) => event.type === "variant-retrying" && event.attempt === 1,
      ),
    ).toBe(true);
    expect(fixPrompts).toHaveLength(1);
    expect(fixPrompts[0]).toContain(RENDER_ERROR);
    const updated = events.find((event) => event.type === "variant-updated")!;
    expect(updated.rev).toBe(2);
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.renderFixes ===
        1,
      "renderFixes persisted",
    );

    // Second report on the SAME generation: budget exhausted — stays failed,
    // NO second fix turn (the debounce that prevents loops).
    expect(
      orchestrator.renderFailure({
        pinId: id,
        variantId: "compact",
        error: RENDER_ERROR,
      }).error,
    ).toBeUndefined();
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.status ===
        "failed",
      "failed persisted",
    );
    expect(fixPrompts).toHaveLength(1);

    // A report against a non-READY variant is a stale no-op.
    expect(
      orchestrator.renderFailure({
        pinId: id,
        variantId: "compact",
        error: RENDER_ERROR,
      }).error,
    ).toBeUndefined();
    expect(fixPrompts).toHaveLength(1);

    // Manual Retry stays available and RESETS the auto-fix budget.
    expect(
      orchestrator.retry({ pinId: id, variantId: "compact" }).error,
    ).toBeUndefined();
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.status ===
          "ready" &&
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]
          ?.renderFixes === 0,
      "retry landed with a fresh budget",
    );

    // Unknown variants refuse.
    expect(
      orchestrator.renderFailure({ pinId: id, variantId: "nope", error: "x" })
        .error,
    ).toBeDefined();
  });

  it("keeps the render diagnostics when the auto-fix turn itself fails", async () => {
    const { repoRoot, events, orchestrator, id } = await readyVariantPin({
      fixTurnError: "You're out of extra usage",
    });
    orchestrator.renderFailure({
      pinId: id,
      variantId: "compact",
      error: RENDER_ERROR,
    });
    // Wait for the SECOND failure (the fix turn's) — polling the index for
    // "failed" alone can catch the first failed persist before the auto-fix
    // retry flips the variant back to generating (load-dependent race).
    await until(
      () =>
        events.some(
          (event) =>
            event.type === "variant-failed" &&
            String(event.error).includes("out of extra usage"),
        ),
      "failed after fix-turn failure",
    );
    const failures = events.filter((event) => event.type === "variant-failed");
    const last = failures[failures.length - 1]!;
    expect(String(last.error)).toContain("out of extra usage");
    expect(String(last.error)).toContain(RENDER_ERROR);
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.status ===
        "failed",
      "final failed status persisted",
    );
  });
});

describe("buildSandboxSourceContext", () => {
  it("includes the original in full plus locally-imported modules, capped", async () => {
    const repoRoot = await makeRepo();
    await writeFile(
      join(repoRoot, "src/atoms.tsx"),
      [
        'import { useProduct } from "./context";',
        "export function ProductTitle() {",
        "  const { product } = useProduct();",
        "  return <h3>{product.title}</h3>;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      [
        'import { ProductTitle } from "./atoms";',
        'import { missing } from "./not-there";',
        'import { external } from "some-package";',
        "export function ProductCard() { return <ProductTitle />; }",
        "",
      ].join("\n"),
    );
    const context = await buildSandboxSourceContext(repoRoot, "src/Card.tsx");
    expect(context).toContain("--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---");
    expect(context).toContain("export function ProductCard()");
    // Local import followed (names + resolved path), body included.
    expect(context).toContain('{ ProductTitle } from "./atoms" (src/atoms.tsx)');
    expect(context).toContain("export function ProductTitle()");
    // Unresolvable + package imports get no section of their own.
    expect(context).not.toContain('IMPORTED BY THE ORIGINAL: { missing }');
    expect(context).not.toContain('IMPORTED BY THE ORIGINAL: { external }');
    // Hard cap ~8KB.
    expect(context.length).toBeLessThanOrEqual(9 * 1024);
  });

  it("truncates oversized atom bodies to signatures", async () => {
    const repoRoot = await makeRepo();
    const bigBody = `function filler() {\n  return ${JSON.stringify("x".repeat(9000))};\n}\n`;
    await writeFile(
      join(repoRoot, "src/atoms.tsx"),
      `${bigBody}export function ProductTitle() { return null; }\n`,
    );
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      'import { ProductTitle } from "./atoms";\nexport function ProductCard() { return <ProductTitle />; }\n',
    );
    const context = await buildSandboxSourceContext(repoRoot, "src/Card.tsx");
    expect(context).toContain("signatures only");
    expect(context).toContain("export function ProductTitle()");
    expect(context.length).toBeLessThanOrEqual(9 * 1024);
  });
});

describe("edit mode", () => {
  it("runs one turn (answer-only): thread recorded, NO real write, NO changeset, no dangling copy (O3)", async () => {
    const repoRoot = await makeRepo();
    const realBefore = await readFile(join(repoRoot, "src/Card.tsx"), "utf8");
    const prompts: string[] = [];
    const { events, orchestrator } = harness({
      runTurn: async ({ mode, prompt }) => {
        expect(mode).toBe("edit");
        prompts.push(prompt);
        return { text: "Tightened the paddings." };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "tighten it", mode: "edit" });
    await until(
      () => events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    const threads = events.filter((event) => event.type === "thread");
    expect(threads.map((event) => (event.message as { role: string }).role))
      .toEqual(["user", "assistant"]);
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.thread.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // L2 TRANSPARENCY: the prompt names the REAL path (the overlay stages
    // any edit); no layer path, no fence, no fresh-copy framing.
    const editTarget = moduleAltPath("", id!, "edit", TARGET.file);
    expect(prompts[0]).toContain(`editing ${TARGET.file}`);
    expect(prompts[0]).not.toContain(".designbook/changesets");
    expect(prompts[0]).not.toContain("fresh copy");
    expect(prompts[0]).not.toContain("Do not create, edit, or delete ANY file");
    expect(await readFile(join(repoRoot, "src/Card.tsx"), "utf8")).toBe(
      realBefore,
    );
    // The agent wrote nothing → no layer, nothing staged — and no husk dirs.
    expect(existsSync(join(repoRoot, editTarget))).toBe(false);
    expect(
      existsSync(
        join(repoRoot, `.designbook/changesets/${changesetIdForPin(id!)}`),
      ),
    ).toBe(false);
    expect(record.variants).toEqual([]);
  });

  it("a THROWING fresh turn unwinds the scaffold copy AND its empty pin dir", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async () => {
        throw new Error("fetch failed: provider dead");
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "tighten it", mode: "edit" });
    await until(
      () => events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    const turnEnd = events.find((event) => event.type === "turn-end")!;
    expect(String(turnEnd.error)).toContain("provider dead");
    // The pre-seeded edit copy and the layer dir it scaffolded are BOTH
    // gone — repeated dead-provider asks must not litter the layer home.
    expect(
      existsSync(join(repoRoot, moduleAltPath("", id!, "edit", TARGET.file))),
    ).toBe(false);
    expect(
      existsSync(
        join(repoRoot, `.designbook/changesets/${changesetIdForPin(id!)}`),
      ),
    ).toBe(false);
  });
});

describe("iterate", () => {
  it("revises one ready variant and bumps its rev", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        if (params.mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        // Generation AND iterate turns edit the REAL path through the
        // overlay (iterate's staging is the variant's own alternative).
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "revised" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    expect(
      orchestrator.iterate({ pinId: id!, variantId: "nope", prompt: "x" })
        .error,
    ).toBeDefined();
    expect(
      orchestrator.iterate({ pinId: id!, variantId: "compact", prompt: "rounder" })
        .error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.type === "variant-updated"),
      "variant-updated",
    );
    const updated = events.find((event) => event.type === "variant-updated")!;
    expect(updated.rev).toBe(2);
  });

  it("threads the canvas element descriptor into the turn prompt + thread label", async () => {
    const repoRoot = await makeRepo();
    const variantPrompts: string[] = [];
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        variantPrompts.push(prompt);
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "revised" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    expect(
      orchestrator.iterate({
        pinId: id!,
        variantId: "compact",
        prompt: "make just this uppercase",
        element: {
          tag: "div",
          classes: ["flex"],
          label: "div.flex",
          text: "$12.99",
          outerHtml: '<div class="flex">$12.99</div>',
        },
      }).error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.type === "variant-updated"),
      "variant-updated",
    );
    const iteratePrompt = variantPrompts[variantPrompts.length - 1];
    expect(iteratePrompt).toContain("selected a specific ELEMENT");
    expect(iteratePrompt).toContain("Selected element: <div> classes: flex");
    expect(iteratePrompt).toContain('<div class="flex">$12.99</div>');
    // The pin thread labels the note with variant AND element.
    const threadTexts = events
      .filter((event) => event.type === "thread")
      .map((event) => (event.message as { text: string }).text);
    expect(threadTexts).toContain("[compact · div.flex] make just this uppercase");
  });
});

describe("replace (deterministic bake sugar under layers)", () => {
  async function readyPin(options: {
    runTypecheck: SandboxTypecheck;
    replaceTurn?: (prompt: string, cwd: string) => Promise<{ text: string; errorMessage?: string }>;
  }) {
    const repoRoot = await makeRepo();
    const turns: Array<{ mode: string; prompt: string }> = [];
    const { events, orchestrator } = harness({
      runTypecheck: options.runTypecheck,
      runTurn: async (params) => {
        const { mode, prompt, cwd } = params;
        turns.push({ mode, prompt });
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        if (mode === "replace") {
          return options.replaceTurn
            ? options.replaceTurn(prompt, cwd)
            : { text: "merged it" };
        }
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;} // compact design\n",
        );
        return { text: "done" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    return { repoRoot, events, orchestrator, id: id!, turns };
  }

  it("clean bake: DETERMINISTIC copy of the alternative — no model turn, pin resolved, layer dir deleted", async () => {
    const { repoRoot, events, orchestrator, id, turns } = await readyPin({
      runTypecheck: async () => ({ ok: true }),
    });
    expect(
      orchestrator.replace({ pinId: id, variantId: "compact" }).error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.type === "replaced"),
      "replaced",
    );
    // NO LLM turn ran for the clean bake (spec: the replace turn is dead).
    expect(turns.filter((turn) => turn.mode === "replace")).toEqual([]);
    // The real file IS the alternative, byte-for-byte.
    expect(readFileSync(join(repoRoot, "src/Card.tsx"), "utf8")).toBe(
      "export function ProductCard(){return null;} // compact design\n",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.resolved).toBe(true);
    // Dissolve = layer dir DELETED (files are dead after bake).
    expect(
      existsSync(join(repoRoot, `.designbook/changesets/${changesetIdForPin(id)}`)),
    ).toBe(false);
    // Resolved pins refuse further prompts/replaces.
    expect(
      orchestrator.prompt({ pinId: id, prompt: "more", mode: "variants" })
        .error,
    ).toBeDefined();
    expect(
      orchestrator.replace({ pinId: id, variantId: "compact" }).error,
    ).toBeDefined();
  });

  it("does NOT resolve when the typecheck gate fails, and says why", async () => {
    const { repoRoot, events, orchestrator, id } = await readyPin({
      runTypecheck: async () => ({
        ok: false,
        output: "src/Card.tsx(3,1): error TS2322: nope",
      }),
    });
    orchestrator.replace({ pinId: id, variantId: "compact" });
    await until(
      () => events.some((event) => event.type === "replace-failed"),
      "replace-failed",
    );
    const failed = events.find((event) => event.type === "replace-failed")!;
    expect(String(failed.error)).toContain("typecheck failed");
    expect(String(failed.error)).toContain("TS2322");
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.resolved).toBe(false);
    // The layer survives a gate failure (nothing dissolved).
    expect(
      existsSync(join(repoRoot, `.designbook/changesets/${changesetIdForPin(id)}`)),
    ).toBe(true);
    // The failure landed in the pin thread (visible "why").
    expect(
      record.thread.some((message) => message.text.includes("typecheck failed")),
    ).toBe(true);
  });

  it("drifted + conflicted merge: exactly ONE merge-agent turn (replace routes drift into the 3-way path)", async () => {
    const { repoRoot, events, orchestrator, id, turns } = await readyPin({
      runTypecheck: async () => ({ ok: true }),
      replaceTurn: async (_prompt, cwd) => {
        await writeFile(
          join(cwd, "src/Card.tsx"),
          "export function ProductCard(){return null;} // merged by agent\n",
        );
        return { text: "merged" };
      },
    });
    // Out-of-band drift AFTER the variant landed.
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      "export function ProductCard(){return null;} // drifted\n",
    );
    orchestrator.replace({ pinId: id, variantId: "compact" });
    await until(
      () => events.some((event) => event.type === "replaced"),
      "replaced",
    );
    // The default fake mergeFile conflicts on drift → ONE merge-agent turn.
    const mergeTurns = turns.filter((turn) => turn.mode === "replace");
    expect(mergeTurns.length).toBe(1);
    expect(mergeTurns[0].prompt).toContain("3-way merge reported conflicts");
    expect(events.some((event) => event.type === "bake-merge-turn")).toBe(true);
    expect(readFileSync(join(repoRoot, "src/Card.tsx"), "utf8")).toContain(
      "merged by agent",
    );
  });
});

describe("element pin orchestration (v2)", () => {
  const RAW_LOCATOR = {
    tag: "div",
    outerHtml: '<div class="row"><span>$29</span></div>',
    childIndexPath: [0, 2],
    textHash: "1a2b3c",
    text: "$29",
    className: "row",
  };

  const CONTROLLER_SOURCE = [
    'import { useTranslation } from "react-i18next";',
    "export function Controller({ V }: { V: React.ComponentType<any> }) {",
    "  const { t } = useTranslation();",
    "  const props = {",
    '    price: t("product.price"), // from: t("product.price")',
    '    badge: "sale", // from: badge (loop item)',
    "  };",
    "  return <V {...props} />;",
    "}",
    "",
  ].join("\n");

  function elementHarness(options?: {
    skipController?: boolean;
    controllerSource?: string;
  }) {
    const turns: Array<{ mode: string; prompt: string }> = [];
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt, cwd } = params;
        turns.push({ mode, prompt });
        if (mode === "director") {
          // The element director writes BOTH artifacts, then replies with
          // the directions JSON (single turn — E1/E2). The pin dir passes
          // THROUGH the overlay — real writes, as before.
          const original = prompt.match(/Write (\S+\/original\.tsx)/)![1];
          await mkdir(join(cwd, dirname(original)), { recursive: true });
          await writeFile(
            join(cwd, original),
            "export function Original({ price }: { price: string }) { return <div>{price}</div>; }\n",
          );
          if (!options?.skipController) {
            const controller = prompt.match(/Write (\S+\/controller\.tsx)/)![1];
            await writeFile(
              join(cwd, controller),
              options?.controllerSource ?? CONTROLLER_SOURCE,
            );
          }
          return { text: '[{"slug":"stacked","intent":"vertical stack"}]' };
        }
        if (mode === "replace") {
          // The module re-inline turn (L2): the agent EDITS the real owner
          // path; the overlay stages the mirrored full-module alternative.
          const target = prompt.match(/EDIT (\S+) so the exact JSX span/);
          if (target) {
            await agentWrite(
              params,
              target[1],
              "export function ProductCard(){return null;} // re-inlined\n",
            );
          }
          return { text: "re-inlined" };
        }
        // Element SPAN variants keep their pass-through gallery artifact.
        const match = prompt.match(/EXACTLY this file: (\S+)/);
        await mkdir(join(cwd, dirname(match![1])), { recursive: true });
        await writeFile(
          join(cwd, match![1]),
          "export function Original(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    return { ...h, turns };
  }

  async function elementPin(h: ReturnType<typeof elementHarness>) {
    const repoRoot = await makeRepo();
    const created = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: { element: { tag: "div", text: "$29" } },
      kind: "element",
      locator: RAW_LOCATOR,
    });
    expect(created.error).toBeUndefined();
    return { repoRoot, id: created.id! };
  }

  it("rejects an element pin without a usable locator", async () => {
    const repoRoot = await makeRepo();
    const { orchestrator } = harness({ runTurn: async () => ({ text: "" }) });
    expect(
      (
        await orchestrator.createPin({
          repoRoot,
          appDir: "",
          target: TARGET,
          contextSnapshot: {},
          kind: "element",
        })
      ).error,
    ).toContain("locator");
    // Component pins never require one (E3 — unchanged).
    expect(
      (
        await orchestrator.createPin({
          repoRoot,
          appDir: "",
          target: TARGET,
          contextSnapshot: {},
        })
      ).error,
    ).toBeUndefined();
  });

  it("director lands artifacts + directions; variants mount through the controller", async () => {
    const h = elementHarness();
    const { repoRoot, id } = await elementPin(h);
    expect(
      h.orchestrator.prompt({
        pinId: id,
        prompt: "variations of this section",
        mode: "variants",
        count: 1,
      }).error,
    ).toBeUndefined();
    await until(
      () => h.events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    // Wrapper stayed code-generated (deterministic layer 1).
    const wrapper = await readFile(join(repoRoot, wrapperPath("", id)), "utf8");
    expect(wrapper).toContain("export function SandboxProviders");
    // Both artifacts landed and the record carries the contract.
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.controllerFile !==
        undefined,
      "controllerFile persisted",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.kind).toBe("element");
    expect(record.locator?.tag).toBe("div");
    expect(record.controllerFile).toBe(controllerPath("", id));
    expect(
      await readFile(join(repoRoot, originalPath("", id)), "utf8"),
    ).toContain("export function Original");
    // The variant landed THROUGH the contract: ready event carries the
    // controller path for the canvas's three-layer mount.
    const ready = h.events.find((event) => event.type === "variant-ready")!;
    expect(ready.controllerAbsPath).toBe(
      join(repoRoot, controllerPath("", id)),
    );
    // Variant prompts embedded the original + controller sources.
    const variantTurn = h.turns.find(
      (turn) => turn.mode === "variant" && turn.prompt.includes("stacked"),
    )!;
    expect(variantTurn.prompt).toContain("--- EXTRACTED ORIGINAL");
    expect(variantTurn.prompt).toContain("--- CONTROLLER");
    expect(variantTurn.prompt).toContain('// from: t("product.price")');
  });

  it("FAILS the run when the director skips the controller (no doomed fan-out)", async () => {
    const h = elementHarness({ skipController: true });
    const { repoRoot, id } = await elementPin(h);
    h.orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => h.events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    expect(h.events.some((event) => event.type === "variants-planned")).toBe(false);
    const end = h.events.find((event) => event.type === "turn-end")!;
    expect(String(end.error)).toContain("controller.tsx");
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.variants).toHaveLength(0);
    expect(
      record.thread.some((message) =>
        message.text.includes("Element extraction failed"),
      ),
    ).toBe(true);
    // The pin is NOT bricked: a fresh prompt can run again (and the retry run
    // is awaited so cleanup never races its writes).
    expect(
      h.orchestrator.prompt({ pinId: id, prompt: "again", mode: "variants" })
        .error,
    ).toBeUndefined();
    await until(
      () =>
        h.events.filter((event) => event.type === "run-complete").length === 2,
      "second run-complete",
    );
  });

  it("FAILS the run when the controller passes props WITHOUT the from: mapping (Replace contract)", async () => {
    const h = elementHarness({
      controllerSource: [
        "export function Controller({ V }: { V: any }) {",
        '  const props = { price: "$29" };',
        "  return <V {...props} />;",
        "}",
        "",
      ].join("\n"),
    });
    const { id } = await elementPin(h);
    h.orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => h.events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    const end = h.events.find((event) => event.type === "turn-end")!;
    expect(String(end.error)).toContain("Replace contract");
  });

  it("ACCEPTS a zero-free-variable controller (empty props, no mapping to make)", async () => {
    // Live-run finding: a span with no free variables (badges container div)
    // yields an empty props object — a legitimate controller.
    const h = elementHarness({
      controllerSource: [
        "export function Controller({ V }: { V: any }) {",
        "  const props = {",
        "  };",
        "  return <V {...props} />;",
        "}",
        "",
      ].join("\n"),
    });
    const { id } = await elementPin(h);
    h.orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => h.events.some((event) => event.type === "variant-ready"),
      "variant-ready",
    );
    // Let the async module re-inline + layer registration settle before the
    // temp repo is removed (cleanup must not race the meta write).
    await until(
      () => h.events.some((event) => event.type === "module-variant-ready"),
      "module-variant-ready",
    );
  });

  it("replace bakes the FULL-MODULE artifact deterministically (the re-inline turn ran at landing)", async () => {
    const h = elementHarness();
    const { repoRoot, id } = await elementPin(h);
    h.orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => h.events.some((event) => event.type === "module-variant-ready"),
      "module-variant-ready",
    );
    // Busy releases only at run-complete (the re-inline runs inside the
    // generation) — wait for it before admitting the replace.
    await until(
      () => h.events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    // The ONE re-inline turn happened at landing time and carried the
    // mapping contract; replace itself is a deterministic copy.
    const reInline = h.turns.filter((turn) => turn.mode === "replace");
    expect(reInline.length).toBe(1);
    expect(reInline[0].prompt).toContain("RE-WIRE every prop reference");
    expect(reInline[0].prompt).toContain(controllerPath("", id));
    expect(
      h.orchestrator.replace({ pinId: id, variantId: "stacked" }).error,
    ).toBeUndefined();
    await until(
      () => h.events.some((event) => event.type === "replaced"),
      "replaced",
    );
    // No FURTHER model turn: the bake copied the previewed module artifact.
    expect(h.turns.filter((turn) => turn.mode === "replace").length).toBe(1);
    expect(readFileSync(join(repoRoot, "src/Card.tsx"), "utf8")).toContain(
      "re-inlined",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.resolved).toBe(true);
  });

  it("PAGE-COMPONENT OWNER: a source-owner pin flows through the element run against the resolved file", async () => {
    // The unregistered-owner path end to end: the pin arrives with NO file
    // (client couldn't resolve the page shell) and no entryId; the export
    // scan picks src/pages/HomePage.tsx; the director prompt then names that
    // owner file and the variant lands through the normal contract.
    const h = elementHarness();
    const repoRoot = await makeRepo();
    await mkdir(join(repoRoot, "src/pages"), { recursive: true });
    await writeFile(
      join(repoRoot, "src/pages/HomePage.tsx"),
      "function HomePage() { return <section className=\"rounded-xl\" />; }\nexport { HomePage };\n",
    );
    const created = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: { file: "", exportName: "HomePage", name: "section.rounded-xl" },
      contextSnapshot: { element: { tag: "section" } },
      kind: "element",
      locator: {
        tag: "section",
        outerHtml: '<section class="rounded-xl border bg-card p-10"></section>',
        childIndexPath: [0],
        textHash: "aa",
        className: "rounded-xl border bg-card p-10",
      },
      ownerNames: ["HomePage", "App"],
    });
    expect(created.error).toBeUndefined();
    const id = created.id!;
    expect(
      h.orchestrator.prompt({ pinId: id, prompt: "hero variants", mode: "variants", count: 1 })
        .error,
    ).toBeUndefined();
    await until(
      () => h.events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    // The element director got the RESOLVED page-component owner file.
    const director = h.turns.find((turn) => turn.mode === "director")!;
    expect(director.prompt).toContain('component "HomePage"');
    expect(director.prompt).toContain("owner source file: src/pages/HomePage.tsx");
    expect(director.prompt).toContain("--- ORIGINAL COMPONENT SOURCE: src/pages/HomePage.tsx ---");
    expect(h.events.some((event) => event.type === "variant-ready")).toBe(true);
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.target).toMatchObject({
      file: "src/pages/HomePage.tsx",
      exportName: "HomePage",
      name: "section.rounded-xl",
    });
    expect(record.target.entryId).toBeUndefined();
  });
});

describe("replace-crash report (E4, non-blocking)", () => {
  async function resolvedPin() {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        const { mode, prompt, cwd } = params;
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        if (mode === "replace") return { text: "rewrote it" };
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    return { repoRoot, events, orchestrator, id: id! };
  }

  it("appends a WARNING to the pin thread; the resolve stands", async () => {
    const { repoRoot, events, orchestrator, id } = await resolvedPin();

    // Before a replace landed, a crash report means nothing.
    expect(
      orchestrator.replaceCrash({ pinId: id, error: "boom" }).error,
    ).toBeDefined();

    orchestrator.replace({ pinId: id, variantId: "compact" });
    await until(
      () => events.some((event) => event.type === "replaced"),
      "replaced",
    );
    expect(
      orchestrator.replaceCrash({
        pinId: id,
        error: "TypeError: t is not a function",
      }).error,
    ).toBeUndefined();
    const crash = events.find((event) => event.type === "replace-crash")!;
    expect(String(crash.error)).toContain("t is not a function");
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.thread.some((message) =>
          message.text.startsWith("Warning:"),
        ) ?? false,
      "warning persisted",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    // Resolve is NOT undone (recovery = HMR + Changes-tab revert).
    expect(record.resolved).toBe(true);

    // Duplicate reports (several clients, same SSE) collapse.
    orchestrator.replaceCrash({
      pinId: id,
      error: "TypeError: t is not a function",
    });
    const warnings = parsePins(readIndexSync(repoRoot))[0].thread.filter(
      (message) => message.text.startsWith("Warning:"),
    );
    expect(warnings).toHaveLength(1);

    // Unknown pins refuse.
    expect(orchestrator.replaceCrash({ pinId: "nope", error: "x" }).error).toBeDefined();
  });
});

describe("position + revive", () => {
  it("persists drags and revives pins (in-flight variants fail on restart)", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        const { mode, prompt, cwd } = params;
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    expect(
      orchestrator.position({ pinId: id!, variantId: "compact", x: 300, y: 150 })
        .error,
    ).toBeUndefined();
    expect(
      orchestrator.position({ pinId: id!, variantId: "compact", x: NaN, y: 0 })
        .error,
    ).toBeDefined();
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.x === 300,
      "position persisted",
    );

    // A FRESH orchestrator (server restart) revives from the index.
    const fresh = harness({ runTurn: async () => ({ text: "" }) });
    const status = await fresh.orchestrator.status(repoRoot, "");
    expect(status.pins).toHaveLength(1);
    expect(status.pins[0].id).toBe(id);
    expect(status.pins[0].variants[0]).toMatchObject({
      id: "compact",
      x: 300,
      y: 150,
      status: "ready",
    });
    expect(status.pins[0].variants[0].absPath).toBe(
      join(repoRoot, moduleAltPath("", id!, "compact", TARGET.file)),
    );

    // Restart mid-generation: a "generating" record revives as failed.
    const index = parsePins(readIndexSync(repoRoot));
    index[0].variants.push({
      id: "midflight",
      intent: "x",
      file: variantFilePath("", id!, "midflight"),
      x: 0,
      y: 0,
      status: "generating",
      rev: 0,
    });
    await writeFile(
      join(repoRoot, sandboxIndexFile("")),
      serializePins(index),
      "utf8",
    );
    const again = harness({ runTurn: async () => ({ text: "" }) });
    const revived = await again.orchestrator.status(repoRoot, "");
    const midflight = revived.pins[0].variants.find(
      (variant) => variant.id === "midflight",
    )!;
    expect(midflight.status).toBe("failed");
    expect(midflight.error).toContain("restarted");
  });

  it("persists a frame resize (w/h), resets to auto, and revives w/h", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness({
      runTurn: async (params) => {
        const { mode, prompt, cwd } = params;
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.prompt({ pinId: id!, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );

    // Resize: an explicit w/h lands on the record (clamped), alongside x/y.
    expect(
      orchestrator.position({
        pinId: id!,
        variantId: "compact",
        x: 40,
        y: 60,
        w: 520,
        h: 400,
      }).error,
    ).toBeUndefined();
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.w === 520,
      "size persisted",
    );
    expect(parsePins(readIndexSync(repoRoot))[0].variants[0]).toMatchObject(
      { x: 40, y: 60, w: 520, h: 400 },
    );

    // A FRESH orchestrator revives the size from the index.
    const fresh = harness({ runTurn: async () => ({ text: "" }) });
    const revived = await fresh.orchestrator.status(repoRoot, "");
    expect(revived.pins[0].variants[0]).toMatchObject({ w: 520, h: 400 });

    // Double-click reset: w/h: null clears the record back to auto-size.
    expect(
      orchestrator.position({
        pinId: id!,
        variantId: "compact",
        x: 40,
        y: 60,
        w: null,
        h: null,
      }).error,
    ).toBeUndefined();
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.w ===
        undefined,
      "size reset to auto",
    );
    const record = parsePins(readIndexSync(repoRoot))[0].variants[0];
    expect(record.w).toBeUndefined();
    expect(record.h).toBeUndefined();
    // Position is untouched by the reset.
    expect(record).toMatchObject({ x: 40, y: 60 });

    // A plain move (no w/h) leaves an existing size alone.
    orchestrator.position({ pinId: id!, variantId: "compact", x: 40, y: 60, w: 300, h: 300 });
    orchestrator.position({ pinId: id!, variantId: "compact", x: 99, y: 99 });
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.x === 99,
      "move without size",
    );
    expect(parsePins(readIndexSync(repoRoot))[0].variants[0]).toMatchObject(
      { x: 99, y: 99, w: 300, h: 300 },
    );
  });

  it("REVIVE COMPAT: a legacy variant record without w/h revives as auto-size", async () => {
    const repoRoot = await makeRepo();
    // Hand-write an index whose variant carries NO w/h (pre-resize shape).
    const legacy: SandboxPin = {
      ...PIN,
      variants: [
        {
          id: "compact",
          intent: "denser",
          file: variantFilePath("", PIN.id, "compact"),
          x: 12,
          y: 12,
          status: "ready",
          rev: 1,
        },
      ],
    };
    await mkdir(join(repoRoot, sandboxDir("")), { recursive: true });
    await writeFile(
      join(repoRoot, sandboxIndexFile("")),
      serializePins([legacy]),
      "utf8",
    );
    const [parsed] = parsePins(readIndexSync(repoRoot));
    expect(parsed.variants[0].w).toBeUndefined();
    expect(parsed.variants[0].h).toBeUndefined();

    const fresh = harness({ runTurn: async () => ({ text: "" }) });
    const revived = await fresh.orchestrator.status(repoRoot, "");
    expect(revived.pins[0].variants[0]).toMatchObject({ id: "compact", x: 12 });
    expect(revived.pins[0].variants[0].w).toBeUndefined();
    expect(revived.pins[0].variants[0].h).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UX v3 (docs/specs/sandbox.md §UX v3): intent routing (U3) + titles (U2).
// ---------------------------------------------------------------------------

describe("parseIntentReply", () => {
  it("routes ONLY an explicit variants=yes to the variants pipeline", () => {
    expect(parseIntentReply('{"variants":true,"n":3}')).toEqual({
      intent: "variants",
      n: 3,
    });
    // Prose/fence-wrapped JSON still parses.
    expect(
      parseIntentReply('Sure!\n```json\n{"variants":true,"n":2}\n```'),
    ).toEqual({ intent: "variants", n: 2 });
    // n clamps to the cap; a missing n takes the spec default (3).
    expect(parseIntentReply('{"variants":true,"n":9}')).toEqual({
      intent: "variants",
      n: 5,
    });
    expect(parseIntentReply('{"variants":true}')).toEqual({
      intent: "variants",
      n: 3,
    });
    expect(parseIntentReply('{"variants":true,"n":0}')).toEqual({
      intent: "variants",
      n: 3,
    });
  });

  it("EVERYTHING else is a normal turn — the safe default", () => {
    expect(parseIntentReply('{"variants":false}')).toEqual({ intent: "turn" });
    expect(parseIntentReply("edit")).toEqual({ intent: "turn" });
    expect(parseIntentReply("")).toEqual({ intent: "turn" });
    expect(parseIntentReply('{"variants":"yes"}')).toEqual({ intent: "turn" });
    expect(parseIntentReply("{broken json")).toEqual({ intent: "turn" });
  });
});

describe("sanitizeTitle", () => {
  it("takes the first line, strips quotes/trailing punctuation, caps length", () => {
    expect(sanitizeTitle('"Playful Hero Tagline."\nextra')).toBe(
      "Playful Hero Tagline",
    );
    expect(sanitizeTitle("  \n Tighter card layout \n")).toBe(
      "Tighter card layout",
    );
    expect(sanitizeTitle("")).toBeUndefined();
    expect(sanitizeTitle('""')).toBeUndefined();
    const long = sanitizeTitle("x".repeat(200))!;
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("UX v3 prompt builders", () => {
  it("intent prompt asks ONLY the variants question with the caps/defaults", () => {
    const prompt = buildSandboxIntentPrompt({ pin: PIN, request: "hello" });
    expect(prompt).toContain('"variants":false');
    expect(prompt).toContain('"variants":true');
    expect(prompt).toContain("anything ambiguous are");
    expect(prompt).toContain("cap 5");
    expect(prompt).toContain("use 3");
    expect(prompt).toContain("Do not read or write any files.");
  });

  it("turn prompt has NO forced-edit framing — and targets the REAL path (L2 transparency)", () => {
    const prompt = buildSandboxTurnPrompt({
      pin: PIN,
      request: "why is this card so wide?",
    });
    expect(prompt).toContain(PIN.target.file);
    expect(prompt).toContain("why is this card so wide?");
    expect(prompt).toContain("Use your judgment");
    expect(prompt).toContain("Not every message needs a file edit.");
    expect(prompt).not.toContain("Apply the request");
    // L2: the agent just edits the real path; every WHERE rule died.
    expect(prompt).toContain(`editing ${PIN.target.file}`);
    expect(prompt).not.toContain("EXACTLY this file");
    expect(prompt).not.toContain("fresh copy");
    expect(prompt).not.toContain("NEVER edit");
    expect(prompt).not.toContain("ADAPTER-DATA EXCEPTION");
    expect(prompt).not.toContain(".designbook/changesets");
    // The soft data-quality note survives.
    expect(prompt).toContain("add NEW keys to the app's data files");
    // The selection context still rides along.
    expect(prompt).toContain("Selection context (captured at pin time):");
  });

  it("edit prompt keeps the forced framing; targets the REAL path; variation framing on demand (L2)", () => {
    const prompt = buildSandboxEditPrompt({
      pin: PIN,
      request: "tighten it",
    });
    expect(prompt).toContain("Apply the request.");
    expect(prompt).toContain(`editing ${PIN.target.file}`);
    expect(prompt).not.toContain("EXACTLY this file");
    expect(prompt).not.toContain("LIVE-RESOLVED");
    expect(prompt).not.toContain("fresh copy");
    const variation = buildSandboxEditPrompt({
      pin: PIN,
      request: "one variation please",
      variation: true,
    });
    expect(variation).toContain("ONE design variation");
    expect(variation).toContain("RECOGNIZABLE variation");
  });
});

describe("ask (U3 routing + U2 titles)", () => {
  /** Fake turn runner: classifier reply is scripted; edit turns reply with
   * text; title turns reply with a title. Records every call. */
  function scriptedTurns(replies: {
    intent?: string;
    intentThrows?: boolean;
    title?: string;
    titleError?: string;
  }) {
    const turns: Array<{ mode: string; prompt: string }> = [];
    const runTurn: SandboxRunTurn = async (params) => {
      const { mode, prompt } = params;
      turns.push({ mode, prompt });
      if (mode === "intent") {
        if (replies.intentThrows) throw new Error("classifier exploded");
        return { text: replies.intent ?? '{"variants":false}' };
      }
      if (mode === "title") {
        if (replies.titleError) {
          return { text: "", errorMessage: replies.titleError };
        }
        return { text: replies.title ?? "Untitled" };
      }
      if (mode === "director") {
        return {
          text: '[{"slug":"a","intent":"one"},{"slug":"b","intent":"two"},{"slug":"c","intent":"three"}]',
        };
      }
      if (mode === "variant") {
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      }
      // The routed normal turn (mode "edit" on the seam).
      return { text: "It is wide because of the max-w class." };
    };
    return { runTurn, turns };
  }

  it("edit-y prompt → classifier no → NORMAL turn (judgment framing), then a persisted title", async () => {
    const repoRoot = await makeRepo();
    const { runTurn, turns } = scriptedTurns({
      intent: '{"variants":false}',
      title: '"Punchier tagline"',
    });
    const { events, orchestrator } = harness({ runTurn });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    expect(
      orchestrator.ask({ pinId: id!, prompt: "make the tagline more playful" })
        .error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.type === "pin-title"),
      "pin-title",
    );

    // Routed as a turn, broadcast for the thread UI.
    const routed = events.find((event) => event.type === "intent-routed")!;
    expect(routed.intent).toBe("turn");
    expect(routed.n).toBeUndefined();
    // The classification ran on the cheap seam, then ONE normal agent turn
    // with the judgment framing (not the forced-edit prompt).
    expect(turns.map((turn) => turn.mode)).toEqual(["intent", "edit", "title"]);
    expect(turns[1].prompt).toContain("Use your judgment");
    expect(turns[1].prompt).not.toContain("Apply the request");
    // Thread carries the exchange; the title landed + persisted + revives.
    const titled = events.find((event) => event.type === "pin-title")!;
    expect(titled.title).toBe("Punchier tagline");
    await until(
      () => parsePins(readIndexSync(repoRoot))[0]?.title !== undefined,
      "title persisted",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.title).toBe("Punchier tagline");
    expect(record.thread.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // The status payload (thread-list source) carries the title too.
    const fresh = harness({ runTurn: async () => ({ text: "" }) });
    const revived = await fresh.orchestrator.status(repoRoot, "");
    expect(revived.pins[0].title).toBe("Punchier tagline");
  });

  it('"give me 3 options" → variants n=3 through the existing pipeline', async () => {
    const repoRoot = await makeRepo();
    const { runTurn, turns } = scriptedTurns({
      intent: '{"variants":true,"n":3}',
      title: "Card options",
    });
    const { events, orchestrator } = harness({ runTurn });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.ask({ pinId: id!, prompt: "give me 3 options for this card" });
    await until(
      () => events.some((event) => event.type === "run-complete"),
      "run-complete",
    );
    const routed = events.find((event) => event.type === "intent-routed")!;
    expect(routed).toMatchObject({ intent: "variants", n: 3 });
    const planned = events.find((event) => event.type === "variants-planned")!;
    expect((planned.variants as unknown[]).length).toBe(3);
    expect(
      events.filter((event) => event.type === "variant-ready").length,
    ).toBe(3);
    // Director → 3 variant turns, all after the intent step.
    expect(turns[0].mode).toBe("intent");
    expect(turns.filter((turn) => turn.mode === "variant").length).toBe(3);
  });

  it("pure question → normal turn: answer lands in the thread, NO variants, no files", async () => {
    const repoRoot = await makeRepo();
    const { runTurn, turns } = scriptedTurns({
      intent: '{"variants":false}',
      title: "Width question",
    });
    const { events, orchestrator } = harness({ runTurn });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.ask({ pinId: id!, prompt: "why is this card so wide?" });
    await until(
      () => events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    expect(events.some((event) => event.type === "variants-planned")).toBe(false);
    expect(events.some((event) => event.type === "director-started")).toBe(false);
    expect(turns.some((turn) => turn.mode === "director")).toBe(false);
    // The index rewrites concurrently (title turn follows) — poll the parse.
    await until(
      () => parsePins(readIndexSync(repoRoot))[0]?.thread.length === 2,
      "thread persisted",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.thread.at(-1)).toMatchObject({
      role: "assistant",
      text: "It is wide because of the max-w class.",
    });
    expect(record.variants).toEqual([]);
  });

  it("ambiguous/vague-options reply and classifier failures both default to a normal turn", async () => {
    const repoRoot = await makeRepo();
    // The classifier hedges with prose (unparseable) — never variants.
    const hedge = scriptedTurns({ intent: "maybe options would help?" });
    const first = harness({ runTurn: hedge.runTurn });
    const created = await first.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    first.orchestrator.ask({
      pinId: created.id!,
      prompt: "maybe some options here could be nicer",
    });
    await until(
      () => first.events.some((event) => event.type === "turn-end"),
      "turn-end (hedge)",
    );
    expect(
      first.events.find((event) => event.type === "intent-routed")!.intent,
    ).toBe("turn");
    expect(
      first.events.some((event) => event.type === "variants-planned"),
    ).toBe(false);

    // The classifier THROWING can never block the request either.
    const boom = scriptedTurns({ intentThrows: true });
    const second = harness({ runTurn: boom.runTurn });
    const pin2 = await second.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    second.orchestrator.ask({ pinId: pin2.id!, prompt: "hmm" });
    await until(
      () => second.events.some((event) => event.type === "turn-end"),
      "turn-end (throw)",
    );
    expect(
      second.events.find((event) => event.type === "intent-routed")!.intent,
    ).toBe("turn");
  });

  it("a failed title turn keeps the fallback (no title, no event, no crash)", async () => {
    const repoRoot = await makeRepo();
    const { runTurn } = scriptedTurns({
      intent: '{"variants":false}',
      titleError: "quota exceeded",
    });
    const { events, orchestrator } = harness({ runTurn });
    const { id } = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    orchestrator.ask({ pinId: id!, prompt: "tighten this up" });
    await until(
      () => events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    // Give the (failing) title turn a beat, then assert nothing landed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.some((event) => event.type === "pin-title")).toBe(false);
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.title).toBeUndefined();
  });

  it("REVIVE COMPAT: pre-v3 records (no title) parse; titled records keep it", () => {
    const untitled = parsePins(serializePins([PIN]));
    expect(untitled[0].title).toBeUndefined();
    const titled = parsePins(
      serializePins([{ ...PIN, title: "Denser card" }]),
    );
    expect(titled[0].title).toBe("Denser card");
  });
});

// ---------------------------------------------------------------------------
// Seam guards (source scans) — the api.ts wiring discipline.
// ---------------------------------------------------------------------------

describe("api.ts sandbox seams", () => {
  const apiSource = readFileSync(join(here, "api.ts"), "utf8");

  it("sandbox handlers resolve their root via activeRepoRoot()", () => {
    for (const handler of [
      "handleSandboxStatus",
      "handleSandboxPin",
    ]) {
      const start = apiSource.indexOf(`async function ${handler}`);
      expect(start, `${handler} present`).toBeGreaterThan(-1);
      const chunk = apiSource.slice(start, start + 1600);
      expect(chunk, `${handler} uses activeRepoRoot()`).toContain(
        "activeRepoRoot()",
      );
    }
  });

  it("ephemeral pin sessions are restricted, log-only, and disposed", () => {
    const start = apiSource.indexOf("async function runSandboxTurn");
    expect(start).toBeGreaterThan(-1);
    const chunk = apiSource.slice(start, apiSource.indexOf("const sandbox ="));
    expect(chunk).toContain("VARIANT_TOOL_NAMES");
    // pi-events stay LOG-ONLY (U4 relays COALESCED activity via the
    // orchestrator's sandbox-event channel, never broadcast() here).
    expect(chunk).toContain("logPiEvent(event)");
    expect(chunk).toContain("createTurnActivityRelay");
    expect(chunk).not.toContain("broadcast(");
    expect(chunk).toContain("session.dispose()");
    expect(chunk).toContain("extractTurnErrorMessage(");
  });

  it("the replace gate never shells out via npx tsc (placeholder-package trap)", () => {
    // `npx tsc` resolves npm's placeholder package named "tsc" when the repo
    // doesn't hoist a real TypeScript bin (live-run finding) — the gate must
    // resolve the APP's own typescript/bin/tsc instead.
    const start = apiSource.indexOf("async function runSandboxTypecheck");
    expect(start).toBeGreaterThan(-1);
    const chunk = apiSource.slice(start, start + 2400);
    expect(chunk).not.toContain('"npx"');
    expect(chunk).toContain('resolve(\n        "typescript/bin/tsc",\n      )');
    expect(chunk).toContain("appDir");
  });

  it("all sandbox write endpoints are blocked in --read-only mode", () => {
    for (const route of [
      "POST /api/sandbox/pin",
      "POST /api/sandbox/prompt",
      "POST /api/sandbox/ask",
      "POST /api/sandbox/iterate",
      "POST /api/sandbox/retry",
      "POST /api/sandbox/render-failure",
      "POST /api/sandbox/replace",
      "POST /api/sandbox/replace-crash",
      "POST /api/sandbox/position",
    ]) {
      expect(READ_ONLY_BLOCKED_ROUTES.has(route), route).toBe(true);
    }
  });

  it("the replace-crash route is registered (injected client reporting, E4)", () => {
    expect(apiSource).toContain('"/api/sandbox/replace-crash"');
    expect(apiSource).toContain("handleSandboxReplaceCrash");
  });

  it("UX v3 routes are registered (ask + thread listing/transcript)", () => {
    expect(apiSource).toContain('"/api/sandbox/ask"');
    expect(apiSource).toContain("handleSandboxAsk");
    expect(apiSource).toContain('"/api/sandbox/threads"');
    expect(apiSource).toContain("handleSandboxThreads");
    expect(apiSource).toContain('"/api/sandbox/thread"');
    expect(apiSource).toContain("handleSandboxThreadTranscript");
  });

  it("sandbox turns persist to the EPHEMERAL session subdir; cheap turns are read-only", () => {
    const start = apiSource.indexOf("async function runSandboxTurn");
    const chunk = apiSource.slice(start, apiSource.indexOf("const sandbox ="));
    // Machine turns never pollute the drawer's chat-history listing…
    expect(chunk).toContain("ephemeralSandboxSessionDir(repoRoot)");
    // …and the intent/title turns get no write tools.
    expect(chunk).toContain(
      "cheapTurn ? READ_ONLY_TOOL_NAMES : VARIANT_TOOL_NAMES",
    );
  });
});

// ---------------------------------------------------------------------------
// Sandbox overrides O1 (docs/specs/sandbox-overrides.md): changesets,
// switches, shim regeneration, redirect table.
// ---------------------------------------------------------------------------
// Changeset LAYERS (docs/specs/changeset-layers.md, L1): storage + meta,
// file-level resolution, activation/selection flips, conflicts, serve-time
// data merge, deterministic bake, discard, drift. Replaces the shim/switch
// (O1–O3) coverage — same behaviors, new engine.
// ---------------------------------------------------------------------------

function readMetaSync(repoRoot: string, changesetId: string): ChangesetLayer {
  return parseLayerMeta(
    readFileSync(join(repoRoot, changesetMetaPath("", changesetId)), "utf8"),
  )!;
}

/** Standard component-variant fake (L2): director plans one "compact"
 * direction; variant turns edit the REAL target THROUGH the overlay (the
 * write stages as the variant's alternative); optional extra work per
 * variant turn (overlay data writes for the capture tests). */
function componentTurnFake(options?: {
  onVariantTurn?: (params: FakeTurnParams) => Promise<void>;
  variantSource?: string;
  slugs?: string[];
}): SandboxRunTurn {
  const slugs = options?.slugs ?? ["compact"];
  return async (params) => {
    const { mode, prompt } = params;
    if (mode === "variant") {
      await agentWrite(
        params,
        TARGET.file,
        options?.variantSource ??
          "export function ProductCard(){return null;} // layered design\n",
      );
      await options?.onVariantTurn?.(params);
      return { text: "done" };
    }
    return {
      text: JSON.stringify(
        slugs.map((slug) => ({ slug, intent: `${slug} design` })),
      ),
    };
  };
}

/** Create a pin and run one variant generation to a landed layer. */
async function landedLayerPin(
  h: ReturnType<typeof harness>,
  repoRoot: string,
  count = 1,
): Promise<string> {
  const { id } = await h.orchestrator.createPin({
    repoRoot,
    appDir: "",
    target: TARGET,
    contextSnapshot: {},
  });
  h.orchestrator.prompt({
    pinId: id!,
    prompt: "variants",
    mode: "variants",
    count,
  });
  await until(
    () => h.events.some((event) => event.type === "run-complete"),
    "run-complete",
  );
  return id!;
}

describe("changeset layers (L1): storage + meta", () => {
  it("layer paths mirror the repo under alts/<altId>/ (appDir stripped)", () => {
    expect(changesetsDir("")).toBe(".designbook/changesets");
    expect(changesetsDir("examples/demo")).toBe(
      "examples/demo/.designbook/changesets",
    );
    expect(altFilePath("", "cs-x", "bold", "src/Card.tsx")).toBe(
      ".designbook/changesets/cs-x/alts/bold/src/Card.tsx",
    );
    // appDir prefixes are stripped so the mirror stays inside the home.
    expect(
      altFilePath("examples/demo", "cs-x", "bold", "examples/demo/src/Card.tsx"),
    ).toBe(
      "examples/demo/.designbook/changesets/cs-x/alts/bold/src/Card.tsx",
    );
    expect(baseFilePath("", "cs-x", "src/Card.tsx")).toBe(
      ".designbook/changesets/cs-x/base/src/Card.tsx",
    );
    expect(changesetMetaPath("", "cs-x")).toBe(
      ".designbook/changesets/cs-x/meta.json",
    );
    expect(mergedDataPath("", "locales/en.json")).toBe(
      ".designbook/changesets/_merged/locales/en.json",
    );
    expect(moduleAltPath("", "card-x1", "edit", "src/Card.tsx")).toBe(
      ".designbook/changesets/cs-card-x1/alts/edit/src/Card.tsx",
    );
  });

  it("meta round-trips (selection, addedKeys, bases, drifted); junk tolerated", () => {
    const meta: ChangesetLayer = {
      id: "cs-x",
      pinId: "x",
      title: "Bold cards",
      branch: "main",
      baseCommit: "abc123",
      createdAt: 7,
      active: true,
      order: 3,
      baseHashes: { "src/Card.tsx": "ab".repeat(32) },
      overrides: {
        "src/Card.tsx": { selection: "bold", alternatives: ["bold", "soft"] },
        "locales/en.json": {
          selection: DATA_ALT_ID,
          alternatives: [DATA_ALT_ID],
          addedKeys: ["product.sale"],
        },
      },
      bases: ["cs-a", "cs-b"],
      drifted: true,
    };
    expect(parseLayerMeta(serializeLayerMeta(meta))).toEqual(meta);
    // A selection naming a MISSING alternative is dropped; junk is skipped.
    const repaired = parseLayerMeta(
      JSON.stringify({
        id: "cs-y",
        pinId: "y",
        overrides: {
          "src/A.tsx": { selection: "gone", alternatives: ["kept"] },
          "src/B.tsx": "junk",
        },
      }),
    )!;
    expect(repaired.overrides["src/A.tsx"]).toEqual({
      alternatives: ["kept"],
    });
    expect(repaired.overrides["src/B.tsx"]).toBeUndefined();
    expect(parseLayerMeta("not json")).toBeUndefined();
    expect(parseLayerMeta('{"pinId":"x"}')).toBeUndefined();
  });

  it("the L1 index carries pins only; legacy array + O1 object shapes revive their pins", () => {
    const index = { pins: [PIN] };
    expect(parseSandboxIndex(serializeSandboxIndex(index))).toEqual(index);
    // Legacy pins ARRAY.
    const legacy = `${"// legacy\nexport const sandbox =\n"}${JSON.stringify([PIN], null, 2)};\n`;
    expect(parseSandboxIndex(legacy).pins).toHaveLength(1);
    // O1 object shape: the shim-era changesets/switches slices are DROPPED
    // (dead machinery), the pins revive.
    const o1 = `${"// o1\nexport const sandbox =\n"}${JSON.stringify(
      { pins: [PIN], changesets: [{ id: "cs-old" }], switches: { "a#B": {} } },
      null,
      2,
    )};\n`;
    const revived = parseSandboxIndex(o1);
    expect(revived.pins).toHaveLength(1);
    expect(revived).toEqual({ pins: revived.pins });
  });
});

describe("changeset layers (L1): registration + flips", () => {
  it("a landed variant registers its LAYER: meta.json + base snapshot + branch tag; DORMANT until a card flips", async () => {
    const repoRoot = await makeRepo();
    const pushes: Array<Record<string, string>> = [];
    const h = harness({
      runTurn: componentTurnFake(),
      onOverridesChanged: (redirects) => pushes.push(redirects),
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csId))),
      "meta written",
    );
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.id).toBe(csId);
    expect(meta.pinId).toBe(id);
    expect(meta.branch).toBe("main");
    // G1: baseCommit = the repo's HEAD at creation, captured in the hidden
    // base ref (git for-each-ref agrees).
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
    ).stdout.trim();
    expect(meta.baseCommit).toBe(head);
    const refs = (
      await execFileAsync(
        "git",
        ["for-each-ref", "refs/designbook/changesets", "--format=%(refname)"],
        { cwd: repoRoot },
      )
    ).stdout;
    expect(refs).toContain(`refs/designbook/changesets/${csId}/base`);
    expect(refs).toContain(`refs/designbook/changesets/${csId}/trunk`);
    expect(refs).toContain(`refs/designbook/changesets/${csId}/v/compact`);
    expect(refs).not.toContain("refs/heads");
    expect(meta.active).toBe(true);
    expect(meta.order).toBeGreaterThan(0);
    expect(meta.overrides["src/Card.tsx"]).toEqual({
      alternatives: ["compact"],
    });
    expect(meta.baseHashes["src/Card.tsx"]).toMatch(/^[0-9a-f]{64}$/);
    // G1: NO stored base snapshot — the 3-way merge input is the baseCommit
    // blob in git.
    expect(
      existsSync(join(repoRoot, baseFilePath("", csId, "src/Card.tsx"))),
    ).toBe(false);
    // The alternative lives at the MIRRORED path (imports stay valid).
    expect(
      existsSync(
        join(repoRoot, altFilePath("", csId, "compact", "src/Card.tsx")),
      ),
    ).toBe(true);
    // NO selection yet → the layer is dormant: no redirect pushed.
    expect(pushes).toEqual([]);
    const table = await h.orchestrator.redirects(repoRoot, "");
    expect(table.redirects).toEqual({});
    // The wire shape carries alternatives + threadPinId compat.
    const status = await h.orchestrator.status(repoRoot, "");
    expect(status.changesets).toHaveLength(1);
    expect(status.changesets[0].threadPinId).toBe(id);
    expect(status.changesets[0].overrides[0]).toMatchObject({
      module: "src/Card.tsx",
      exportName: "ProductCard",
      alternatives: ["compact"],
    });
    expect(status.conflicts).toEqual([]);
  });

  it("selection flips resolve the alternative (ONE batched push per flip, hot-only); original clears it; foreign selections are rejected", async () => {
    const repoRoot = await makeRepo();
    const pushes: Array<Record<string, string>> = [];
    const h = harness({
      runTurn: componentTurnFake(),
      onOverridesChanged: (redirects) => pushes.push(redirects),
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csId))),
      "meta written",
    );
    // Unknown changeset/variant → rejected.
    expect(
      (
        await h.orchestrator.switchSelect({
          repoRoot,
          appDir: "",
          component: "src/Card.tsx#ProductCard",
          selection: { changesetId: csId, variantId: "nope" },
        })
      ).error,
    ).toBeDefined();
    // Flip ON: selection persists in the meta, ONE redirect push lands.
    expect(
      (
        await h.orchestrator.switchSelect({
          repoRoot,
          appDir: "",
          component: "src/Card.tsx#ProductCard",
          selection: { changesetId: csId, variantId: "compact" },
        })
      ).error,
    ).toBeUndefined();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual({
      [join(repoRoot, "src/Card.tsx")]: join(
        repoRoot,
        altFilePath("", csId, "compact", "src/Card.tsx"),
      ),
    });
    expect(readMetaSync(repoRoot, csId).overrides["src/Card.tsx"].selection).toBe(
      "compact",
    );
    // The synthesized switch snapshot broadcast + endpoint agree.
    const flipEvent = h.events.findLast(
      (event) => event.type === "switch-changed",
    )!;
    expect(flipEvent.switches).toEqual({
      "src/Card.tsx#ProductCard": { changesetId: csId, variantId: "compact" },
    });
    expect(
      (await h.orchestrator.switches(repoRoot, "")).switches[
        "src/Card.tsx#ProductCard"
      ],
    ).toEqual({ changesetId: csId, variantId: "compact" });
    // Flip to ORIGINAL: the selection clears (layer stays active/landed),
    // the redirect drops in ONE more push.
    expect(
      (
        await h.orchestrator.switchSelect({
          repoRoot,
          appDir: "",
          component: "src/Card.tsx#ProductCard",
          selection: null,
        })
      ).error,
    ).toBeUndefined();
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toEqual({});
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.active).toBe(true);
    expect(meta.overrides["src/Card.tsx"].selection).toBeUndefined();
  });

  it("REVIVE: a restart re-reads layer metas and re-pushes redirects for selected layers", async () => {
    const repoRoot = await makeRepo();
    const h1 = harness({ runTurn: componentTurnFake() });
    const id = await landedLayerPin(h1, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csId))),
      "meta written",
    );
    await h1.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: { changesetId: csId, variantId: "compact" },
    });
    // A fresh orchestrator (server restart) over the same repo.
    const pushes: Array<Record<string, string>> = [];
    const h2 = harness({
      runTurn: async () => ({ text: "unused" }),
      onOverridesChanged: (redirects) => pushes.push(redirects),
    });
    const status = await h2.orchestrator.status(repoRoot, "");
    expect(status.changesets).toHaveLength(1);
    expect(status.changesets[0].id).toBe(csId);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual({
      [join(repoRoot, "src/Card.tsx")]: join(
        repoRoot,
        altFilePath("", csId, "compact", "src/Card.tsx"),
      ),
    });
  });

  it("ATOMIC cross-module flip: a multi-file layer (incl. a layer-only NEW file) activates in ONE push", async () => {
    const repoRoot = await makeRepo();
    // Hand-crafted layer: two module overrides, one of them a file that
    // does NOT exist in the real tree (a variant added a module).
    const csId = "cs-multi";
    const altCard = altFilePath("", csId, "v1", "src/Card.tsx");
    const altNew = altFilePath("", csId, "v1", "src/New.tsx");
    for (const rel of [altCard, altNew]) {
      await mkdir(join(repoRoot, dirname(rel)), { recursive: true });
      await writeFile(join(repoRoot, rel), "export const x = 1;\n");
    }
    const meta: ChangesetLayer = {
      id: csId,
      pinId: "multi-pin",
      branch: "main",
      baseCommit: "c0",
      createdAt: 1,
      active: false,
      order: 1,
      baseHashes: {},
      overrides: {
        "src/Card.tsx": { selection: "v1", alternatives: ["v1"] },
        "src/New.tsx": { selection: "v1", alternatives: ["v1"] },
      },
    };
    await mkdir(join(repoRoot, dirname(changesetMetaPath("", csId))), {
      recursive: true,
    });
    await writeFile(
      join(repoRoot, changesetMetaPath("", csId)),
      serializeLayerMeta(meta),
    );
    const pushes: Array<Record<string, string>> = [];
    const h = harness({
      runTurn: async () => ({ text: "unused" }),
      onOverridesChanged: (redirects) => pushes.push(redirects),
    });
    await h.orchestrator.status(repoRoot, ""); // revive (inactive → no push)
    expect(pushes).toEqual([]);
    expect(
      (
        await h.orchestrator.activate({
          repoRoot,
          appDir: "",
          changesetId: csId,
          active: true,
        })
      ).error,
    ).toBeUndefined();
    // BOTH modules flipped in ONE batched table push — never mixed state.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual({
      [join(repoRoot, "src/Card.tsx")]: join(repoRoot, altCard),
      [join(repoRoot, "src/New.tsx")]: join(repoRoot, altNew),
    });
    // Deactivate: both drop atomically too.
    await h.orchestrator.activate({
      repoRoot,
      appDir: "",
      changesetId: csId,
      active: false,
    });
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toEqual({});
  });

  it("HIDE-FOREIGN-BRANCH: layers tagged to another branch are invisible and never resolved", async () => {
    const repoRoot = await makeRepo();
    const csId = "cs-foreign";
    const alt = altFilePath("", csId, "v1", "src/Card.tsx");
    await mkdir(join(repoRoot, dirname(alt)), { recursive: true });
    await writeFile(join(repoRoot, alt), "export const x = 1;\n");
    await mkdir(join(repoRoot, dirname(changesetMetaPath("", csId))), {
      recursive: true,
    });
    await writeFile(
      join(repoRoot, changesetMetaPath("", csId)),
      serializeLayerMeta({
        id: csId,
        pinId: "foreign-pin",
        branch: "feature/elsewhere",
        baseCommit: "zz",
        createdAt: 1,
        active: true,
        order: 1,
        baseHashes: {},
        overrides: {
          "src/Card.tsx": { selection: "v1", alternatives: ["v1"] },
        },
      }),
    );
    const pushes: Array<Record<string, string>> = [];
    const h = harness({
      runTurn: async () => ({ text: "unused" }),
      onOverridesChanged: (redirects) => pushes.push(redirects),
    });
    const status = await h.orchestrator.status(repoRoot, "");
    // Hidden from every listing; never resolved; not flippable.
    expect(status.changesets).toEqual([]);
    expect(pushes).toEqual([]);
    expect((await h.orchestrator.redirects(repoRoot, "")).redirects).toEqual(
      {},
    );
    expect(
      (
        await h.orchestrator.activate({
          repoRoot,
          appDir: "",
          changesetId: csId,
          active: false,
        })
      ).error,
    ).toBeDefined();
    // The record is TOLERATED on disk (untouched for its own branch).
    expect(readMetaSync(repoRoot, csId).active).toBe(true);
  });

  it("CONFLICT: the same file overridden by two ACTIVE layers — surfaced via status + SSE; choose (deactivate one) clears it; topmost wins", async () => {
    const repoRoot = await makeRepo();
    const pushes: Array<Record<string, string>> = [];
    const h = harness({
      runTurn: componentTurnFake(),
      onOverridesChanged: (redirects) => pushes.push(redirects),
    });
    const idA = await landedLayerPin(h, repoRoot);
    h.events.length = 0;
    const idB = await landedLayerPin(h, repoRoot);
    const csA = changesetIdForPin(idA);
    const csB = changesetIdForPin(idB);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csB))),
      "second meta written",
    );
    // Both layers landed on src/Card.tsx → file-level conflict, active both.
    const status = await h.orchestrator.status(repoRoot, "");
    expect(status.conflicts).toEqual([
      { file: "src/Card.tsx", changesetIds: [csA, csB] },
    ]);
    // The changesets-changed broadcast carries the conflicts too (badges).
    const changed = h.events.findLast(
      (event) => event.type === "changesets-changed",
    )!;
    expect(changed.conflicts).toEqual([
      { file: "src/Card.tsx", changesetIds: [csA, csB] },
    ]);
    // Select A then B: TOPMOST (most recently flipped) wins the redirect.
    await h.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: { changesetId: csA, variantId: "compact" },
    });
    await h.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: { changesetId: csB, variantId: "compact" },
    });
    const table = await h.orchestrator.redirects(repoRoot, "");
    expect(table.redirects[join(repoRoot, "src/Card.tsx")]).toBe(
      join(repoRoot, altFilePath("", csB, "compact", "src/Card.tsx")),
    );
    // CHOOSE = deactivate one: the conflict clears, the survivor resolves.
    await h.orchestrator.activate({
      repoRoot,
      appDir: "",
      changesetId: csB,
      active: false,
    });
    const after = await h.orchestrator.status(repoRoot, "");
    expect(after.conflicts).toEqual([]);
    expect(
      (await h.orchestrator.redirects(repoRoot, "")).redirects[
        join(repoRoot, "src/Card.tsx")
      ],
    ).toBe(join(repoRoot, altFilePath("", csA, "compact", "src/Card.tsx")));
  });
});

describe("changeset layers (L1): serve-time data merge", () => {
  const EN_BEFORE = `${JSON.stringify({ product: { title: "Vase" } }, null, 2)}\n`;

  async function makeI18nRepo(): Promise<string> {
    const repoRoot = await makeRepo();
    await mkdir(join(repoRoot, "locales"), { recursive: true });
    await writeFile(join(repoRoot, "locales/en.json"), EN_BEFORE);
    await gitCommitAll(repoRoot); // Base blobs derive from commits (G1).
    return repoRoot;
  }

  it("an ADDED i18n key lifts into the layer: real file restored byte-clean, merged artifact served, discard drops it all", async () => {
    const repoRoot = await makeI18nRepo();
    const h = harness({
      runTurn: componentTurnFake({
        onVariantTurn: async (params) => {
          // L2: the turn adds a key THROUGH the overlay — the write stages
          // in the layer and the real locale file is never touched.
          await agentWrite(
            params,
            "locales/en.json",
            `${JSON.stringify(
              { product: { title: "Vase", sale: "Sale!" } },
              null,
              2,
            )}\n`,
          );
        },
      }),
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () =>
        readMetaSync(repoRoot, csId)?.overrides["locales/en.json"] !==
        undefined,
      "data override lifted",
    );
    // Real file restored BYTE-CLEAN; the addition lives in the layer.
    expect(await readFile(join(repoRoot, "locales/en.json"), "utf8")).toBe(
      EN_BEFORE,
    );
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.overrides["locales/en.json"]).toEqual({
      selection: DATA_ALT_ID,
      alternatives: [DATA_ALT_ID],
      addedKeys: ["product.sale"],
    });
    // Data files never flag drift (merge runs against the current file).
    expect(meta.baseHashes["locales/en.json"]).toBeUndefined();
    // The SERVED module is the merged artifact (base + addition).
    const mergedRel = mergedDataPath("", "locales/en.json");
    await until(
      () => existsSync(join(repoRoot, mergedRel)),
      "merged artifact",
    );
    const merged = JSON.parse(
      await readFile(join(repoRoot, mergedRel), "utf8"),
    );
    expect(merged.product).toEqual({ title: "Vase", sale: "Sale!" });
    const table = await h.orchestrator.redirects(repoRoot, "");
    expect(table.redirects[join(repoRoot, "locales/en.json")]).toBe(
      join(repoRoot, mergedRel),
    );
    // Badge parity: the wire dataAdditionCount counts lifted keys.
    const status = await h.orchestrator.status(repoRoot, "");
    expect(status.changesets[0].dataAdditionCount).toBe(1);
    // DISCARD = drop the layer: dir gone, redirect gone, real still clean.
    expect(
      (
        await h.orchestrator.discard({
          repoRoot,
          appDir: "",
          changesetId: csId,
        })
      ).error,
    ).toBeUndefined();
    expect(
      existsSync(join(repoRoot, `.designbook/changesets/${csId}`)),
    ).toBe(false);
    expect((await h.orchestrator.redirects(repoRoot, "")).redirects).toEqual(
      {},
    );
    expect(await readFile(join(repoRoot, "locales/en.json"), "utf8")).toBe(
      EN_BEFORE,
    );
  });

  it("SAME KEY, DIFFERENT VALUES across two active layers = data conflict (surfaced, bottom-most wins in the served output)", async () => {
    const repoRoot = await makeI18nRepo();
    let saleValue = "A!";
    const h = harness({
      runTurn: componentTurnFake({
        onVariantTurn: async (params) => {
          // Layer B's agent SEES A's merged addition and re-values the same
          // key — the same-key-different-value conflict case.
          await agentWrite(
            params,
            "locales/en.json",
            `${JSON.stringify(
              { product: { title: "Vase", sale: saleValue } },
              null,
              2,
            )}\n`,
          );
        },
      }),
    });
    const idA = await landedLayerPin(h, repoRoot);
    h.events.length = 0;
    saleValue = "B!";
    const idB = await landedLayerPin(h, repoRoot);
    const csA = changesetIdForPin(idA);
    const csB = changesetIdForPin(idB);
    await until(
      () =>
        readMetaSync(repoRoot, csB)?.overrides["locales/en.json"] !==
        undefined,
      "second lift",
    );
    const status = await h.orchestrator.status(repoRoot, "");
    expect(status.dataConflicts).toEqual([
      { file: "locales/en.json", key: "product.sale", changesetIds: [csA, csB] },
    ]);
    // Deterministic served output: the bottom-most layer's value stays.
    const merged = JSON.parse(
      await readFile(
        join(repoRoot, mergedDataPath("", "locales/en.json")),
        "utf8",
      ),
    );
    expect(merged.product.sale).toBe("A!");
    // The collision also warned into the second thread at lift time.
    expect(
      h.events.some(
        (event) =>
          event.type === "data-warning" &&
          JSON.stringify(event.warnings).includes("also added by changeset"),
      ),
    ).toBe(true);
  });

  it("MUTATING a shared key is a first-class layer override (round-2 policy): lifted key-level, layer-wins while active, discard reverts", async () => {
    const repoRoot = await makeI18nRepo();
    const h = harness({
      runTurn: componentTurnFake({
        onVariantTurn: async (params) => {
          await agentWrite(
            params,
            "locales/en.json",
            `${JSON.stringify({ product: { title: "MUTATED" } }, null, 2)}\n`,
          );
        },
      }),
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () =>
        readMetaSync(repoRoot, csId)?.overrides["locales/en.json"] !==
        undefined,
      "mutation lifted",
    );
    // The REAL file stays byte-clean; the mutation lives in the layer,
    // recorded key-level exactly like an addition.
    expect(await readFile(join(repoRoot, "locales/en.json"), "utf8")).toBe(
      EN_BEFORE,
    );
    expect(readMetaSync(repoRoot, csId).overrides["locales/en.json"]).toEqual({
      selection: DATA_ALT_ID,
      alternatives: [DATA_ALT_ID],
      addedKeys: ["product.title"],
    });
    // No additive-only warning anymore — the prohibition died with round 2.
    expect(h.events.some((event) => event.type === "data-warning")).toBe(false);
    // Serve-time: the layer's value WINS in the merged artifact.
    const mergedRel = mergedDataPath("", "locales/en.json");
    await until(() => existsSync(join(repoRoot, mergedRel)), "merged artifact");
    const merged = JSON.parse(
      await readFile(join(repoRoot, mergedRel), "utf8"),
    );
    expect(merged.product.title).toBe("MUTATED");
    // Discard reverts: layer gone, redirect gone, real file untouched.
    expect(
      (
        await h.orchestrator.discard({
          repoRoot,
          appDir: "",
          changesetId: csId,
        })
      ).error,
    ).toBeUndefined();
    expect((await h.orchestrator.redirects(repoRoot, "")).redirects).toEqual(
      {},
    );
    expect(await readFile(join(repoRoot, "locales/en.json"), "utf8")).toBe(
      EN_BEFORE,
    );
  });

  it("EDITS-FOLLOW-RESOLUTION: an ask from a pin with NO layer lifts data into the layer OWNING the resolved target", async () => {
    const repoRoot = await makeI18nRepo();
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt, cwd } = params;
        if (mode === "intent") return { text: '{"variants":"no"}' };
        if (mode === "title") return { text: "Ribbon" };
        if (mode === "edit") {
          // L2: the agent edits the REAL path; the overlay's read resolves
          // to A's live alternative (edits-follow-resolution) and the write
          // lands right back on it.
          const current = (await agentRead(params, TARGET.file))!;
          await agentWrite(params, TARGET.file, `${current}// ribbon\n`);
          await agentWrite(
            params,
            "locales/en.json",
            `${JSON.stringify(
              { product: { title: "Vase", ribbon: "Limited!" } },
              null,
              2,
            )}\n`,
          );
          return { text: "added the ribbon" };
        }
        return componentTurnFake()(params);
      },
    });
    // Pin A lands a variant and selects it (the active resolution).
    const idA = await landedLayerPin(h, repoRoot);
    const csA = changesetIdForPin(idA);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csA))),
      "meta A",
    );
    await h.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: { changesetId: csA, variantId: "compact" },
    });
    // Pin B (no layer of its own) asks an edit: the turn edits A's resolved
    // alternative AND adds an i18n key.
    const { id: idB } = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    h.events.length = 0;
    h.orchestrator.ask({ pinId: idB!, prompt: "add a ribbon" });
    await until(
      () => h.events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    // The addition lifted into A's layer (the edit target's owner), the
    // real locale file restored byte-clean, and NO layer exists for B.
    const metaA = readMetaSync(repoRoot, csA);
    expect(metaA.overrides["locales/en.json"]?.addedKeys).toEqual([
      "product.ribbon",
    ]);
    expect(
      metaA.overrides["src/Card.tsx"].alternatives,
    ).toEqual(["compact"]);
    expect(await readFile(join(repoRoot, "locales/en.json"), "utf8")).toBe(
      EN_BEFORE,
    );
    expect(
      existsSync(join(repoRoot, changesetMetaPath("", changesetIdForPin(idB!)))),
    ).toBe(false);
  });

  it("a turn that writes NO data lifts nothing (manual/real-layer edits bypass entirely)", async () => {
    const repoRoot = await makeI18nRepo();
    const h = harness({ runTurn: componentTurnFake() });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csId))),
      "meta written",
    );
    expect(readMetaSync(repoRoot, csId).overrides["locales/en.json"]).toBeUndefined();
    expect(h.events.some((event) => event.type === "data-warning")).toBe(false);
  });

  it("pure merge machinery: additions compute/apply for json + po + cssvar", () => {
    // JSON.
    const additions = computeDataAdditions(
      "json",
      '{"a":{"x":"1"}}',
      '{"a":{"x":"1","y":"2"}}',
    );
    expect([...additions.keys()]).toEqual(["a.y"]);
    expect(
      JSON.parse(applyDataAdditions("json", '{"a":{"x":"1"}}', additions)),
    ).toEqual({ a: { x: "1", y: "2" } });
    // Existing keys always win over a stale layer copy.
    expect(
      JSON.parse(
        applyDataAdditions(
          "json",
          '{"a":{"x":"1","y":"REAL"}}',
          additions,
        ),
      ).a.y,
    ).toBe("REAL");
    // PO: appended entries.
    const po = applyDataAdditions(
      "po",
      'msgid "hello"\nmsgstr "Hello"\n',
      new Map([["new.key", "New!"]]),
    );
    expect(po).toContain('msgid "new.key"');
    expect(po).toContain('msgstr "New!"');
    // CSSVAR: declaration inserted into the matching selector block.
    const css = applyDataAdditions(
      "cssvar",
      ":root {\n  --a: 1px;\n}\n",
      new Map([[":root --b", "2px"]]),
    );
    expect(css).toContain("--a: 1px;");
    expect(css).toContain("--b: 2px;");
    // Multi-layer merge: same key/same value lands once, different values
    // conflict with the bottom-most winning.
    const merged = mergeDataLayers({
      format: "json",
      file: "en.json",
      current: "{}",
      layers: [
        { changesetId: "cs-a", additions: new Map([["k", '"A"']]) },
        { changesetId: "cs-b", additions: new Map([["k", '"B"']]) },
        { changesetId: "cs-c", additions: new Map([["j", '"J"']]) },
      ],
    });
    expect(JSON.parse(merged.content)).toEqual({ k: "A", j: "J" });
    expect(merged.conflicts).toEqual([
      { file: "en.json", key: "k", changesetIds: ["cs-a", "cs-b"] },
    ]);
  });
});

describe("changeset layers (L1): bake, discard, drift", () => {
  const EN_BEFORE = `${JSON.stringify({ product: { title: "Vase" } }, null, 2)}\n`;

  it("BAKE deterministic: unchanged base → byte copy + structured data merge, NO model turn; dissolve DELETES the layer dir", async () => {
    const repoRoot = await makeRepo();
    await mkdir(join(repoRoot, "locales"), { recursive: true });
    await writeFile(join(repoRoot, "locales/en.json"), EN_BEFORE);
    await gitCommitAll(repoRoot);
    const turns: string[] = [];
    const h = harness({
      runTurn: async (params) => {
        turns.push(params.mode);
        return componentTurnFake({
          onVariantTurn: async (turn) => {
            await agentWrite(
              turn,
              "locales/en.json",
              `${JSON.stringify(
                { product: { title: "Vase", sale: "Sale!" } },
                null,
                2,
              )}\n`,
            );
          },
        })(params);
      },
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () =>
        readMetaSync(repoRoot, csId)?.overrides["locales/en.json"] !==
        undefined,
      "data lift",
    );
    turns.length = 0;
    const result = await h.orchestrator.bake({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(result.error).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) => event.type === "bake-status" && event.status === "done",
        ),
      "bake done",
    );
    // Statuses streamed in order.
    const statuses = h.events
      .filter((event) => event.type === "bake-status")
      .map((event) => event.status);
    expect(statuses).toEqual(["queued", "running", "gated", "done"]);
    // NO model turn ran (deterministic copy + structured data merge).
    expect(turns).toEqual([]);
    // Real module = the alternative, byte-for-byte.
    expect(await readFile(join(repoRoot, "src/Card.tsx"), "utf8")).toBe(
      "export function ProductCard(){return null;} // layered design\n",
    );
    // Data additions merged into the real file.
    expect(
      JSON.parse(await readFile(join(repoRoot, "locales/en.json"), "utf8"))
        .product.sale,
    ).toBe("Sale!");
    // Dissolve: layer dir DELETED, pin resolved, redirects dropped.
    expect(
      existsSync(join(repoRoot, `.designbook/changesets/${csId}`)),
    ).toBe(false);
    expect((await h.orchestrator.redirects(repoRoot, "")).redirects).toEqual(
      {},
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.resolved).toBe(true);
    expect(h.events.some((event) => event.type === "baked")).toBe(true);
  });

  it("BAKE with multiple alternatives needs a selection; the selected one wins", async () => {
    const repoRoot = await makeRepo();
    // Slug-distinct content lands PER BRANCH via git (the projected alt
    // files are a derived cache now — bake reads base..tip from git).
    const h = harness({
      runTurn: async (params) => {
        if (params.mode === "variant") {
          const slug = /airy/.test(params.prompt) ? "airy" : "compact";
          await agentWrite(
            params,
            TARGET.file,
            `export function ProductCard(){return null;} // ${slug} design\n`,
          );
          return { text: "done" };
        }
        return {
          text: JSON.stringify([
            { slug: "compact", intent: "compact design" },
            { slug: "airy", intent: "airy design" },
          ]),
        };
      },
    });
    const id = await landedLayerPin(h, repoRoot, 2);
    const csId = changesetIdForPin(id);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csId))),
      "meta written",
    );
    // Two landed alternatives, no selection → the caller must choose.
    const refused = await h.orchestrator.bake({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(refused.error).toContain("Choose a variant");
    await h.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: { changesetId: csId, variantId: "airy" },
    });
    expect(
      (
        await h.orchestrator.bake({ repoRoot, appDir: "", changesetId: csId })
      ).error,
    ).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) => event.type === "bake-status" && event.status === "done",
        ),
      "bake done",
    );
    expect(await readFile(join(repoRoot, "src/Card.tsx"), "utf8")).toContain(
      "airy design",
    );
  });

  it("BAKE QUEUE: two bakes serialize; a gate failure keeps its layer and the queue moves on", async () => {
    const repoRoot = await makeRepo();
    await writeFile(
      join(repoRoot, "src/Other.tsx"),
      "export function OtherCard() { return null; }\n",
    );
    await gitCommitAll(repoRoot);
    let failNext = true;
    const gates: string[] = [];
    const h = harness({
      runTypecheck: async () => {
        const fail = failNext;
        failNext = false;
        gates.push(fail ? "fail" : "ok");
        return fail
          ? { ok: false, output: "error TS1: broken" }
          : { ok: true };
      },
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "variant") {
          const target = prompt.match(/by EDITING (\S+):/)![1];
          const exportName = target.includes("Other")
            ? "OtherCard"
            : "ProductCard";
          await agentWrite(
            params,
            target,
            `export function ${exportName}(){return null;} // baked\n`,
          );
          return { text: "done" };
        }
        return { text: '[{"slug":"compact","intent":"denser"}]' };
      },
    });
    const idA = await landedLayerPin(h, repoRoot);
    h.events.length = 0;
    const { id: idB } = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: { file: "src/Other.tsx", exportName: "OtherCard", name: "Other" },
      contextSnapshot: {},
    });
    h.orchestrator.prompt({
      pinId: idB!,
      prompt: "variants",
      mode: "variants",
      count: 1,
    });
    await until(
      () => h.events.some((event) => event.type === "run-complete"),
      "second run-complete",
    );
    const csA = changesetIdForPin(idA);
    const csB = changesetIdForPin(idB!);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csB))),
      "second meta",
    );
    // Queue both: A fails its gate, B lands after it.
    expect(
      (await h.orchestrator.bake({ repoRoot, appDir: "", changesetId: csA }))
        .error,
    ).toBeUndefined();
    // Re-admission while queued is refused.
    expect(
      (await h.orchestrator.bake({ repoRoot, appDir: "", changesetId: csA }))
        .error,
    ).toBeDefined();
    expect(
      (await h.orchestrator.bake({ repoRoot, appDir: "", changesetId: csB }))
        .error,
    ).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) =>
            event.type === "bake-status" &&
            event.status === "done" &&
            event.changesetId === csB,
        ),
      "queue drained",
    );
    expect(gates).toEqual(["fail", "ok"]);
    // A's failure kept its layer; B dissolved.
    expect(
      h.events.some(
        (event) =>
          event.type === "bake-status" &&
          event.status === "failed" &&
          event.changesetId === csA,
      ),
    ).toBe(true);
    expect(
      existsSync(join(repoRoot, `.designbook/changesets/${csA}`)),
    ).toBe(true);
    expect(
      existsSync(join(repoRoot, `.designbook/changesets/${csB}`)),
    ).toBe(false);
    expect(await readFile(join(repoRoot, "src/Other.tsx"), "utf8")).toContain(
      "// baked",
    );
  });

  it("DRIFT: lazy status flag + 409-unless-force; force 3-way merges with the stored base (clean merge = still no model turn)", async () => {
    const repoRoot = await makeRepo();
    const turns: string[] = [];
    const h = harness({
      runTurn: async (params) => {
        turns.push(params.mode);
        return componentTurnFake()(params);
      },
      // A clean 3-way merge fake: current + a marker proving all three
      // sides reached it.
      mergeFile: async (base, current, layered) => ({
        content: `${layered.trimEnd()} // merged-over(${base.length},${current.length})\n`,
        conflicted: false,
      }),
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csId))),
      "meta written",
    );
    // Out-of-band edit AFTER capture → drift.
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      "export function ProductCard(){return null;} // drifted\n",
    );
    const status = await h.orchestrator.status(repoRoot, "");
    expect(status.changesets[0].drifted).toBe(true);
    // A NEW drift pushed a thread warning.
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(
      record.thread.some((message) => message.text.includes("changed outside")),
    ).toBe(true);
    // 409 without force.
    const refused = await h.orchestrator.bake({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(refused.status).toBe(409);
    expect(refused.error).toContain("drifted");
    // Force → the 3-way merge path (clean here: NO model turn).
    turns.length = 0;
    expect(
      (
        await h.orchestrator.bake({
          repoRoot,
          appDir: "",
          changesetId: csId,
          force: true,
        })
      ).error,
    ).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) => event.type === "bake-status" && event.status === "done",
        ),
      "forced bake done",
    );
    expect(turns).toEqual([]);
    const baked = await readFile(join(repoRoot, "src/Card.tsx"), "utf8");
    expect(baked).toContain("// layered design");
    expect(baked).toContain("// merged-over(");
    // Reverting the out-of-band edit CLEARS a stale drift flag (parity).
    // G1: drift is measured against the baseCommit BLOB — commit the baked
    // state first so the new changeset captures it as its base.
    await gitCommitAll(repoRoot, "baked");
    const h2 = harness({ runTurn: componentTurnFake() });
    const id2 = await landedLayerPin(h2, repoRoot);
    const cs2 = changesetIdForPin(id2);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", cs2))),
      "meta 2",
    );
    const before = await readFile(join(repoRoot, "src/Card.tsx"), "utf8");
    await writeFile(join(repoRoot, "src/Card.tsx"), `${before}// touch\n`);
    expect(
      (await h2.orchestrator.status(repoRoot, "")).changesets[0].drifted,
    ).toBe(true);
    await writeFile(join(repoRoot, "src/Card.tsx"), before);
    expect(
      (await h2.orchestrator.status(repoRoot, "")).changesets[0].drifted,
    ).toBe(false);
  });
});

describe("changeset layers (L1): edits, element pins, stacking, compose", () => {
  it("EDIT ask: the lazy edit-variant is seeded VERBATIM at the MIRRORED path; selection ON; the second ask continues the SAME file", async () => {
    const repoRoot = await makeRepo();
    // A relative import proves VERBATIM seeding (no re-pointing needed at
    // the mirrored path — the layer engine kills that bug class).
    const original = [
      'import { helper } from "./helper";',
      "export function ProductCard(){ return helper(); }",
      "",
    ].join("\n");
    await writeFile(join(repoRoot, "src/Card.tsx"), original);
    await writeFile(
      join(repoRoot, "src/helper.ts"),
      "export const helper = () => null;\n",
    );
    await gitCommitAll(repoRoot);
    const editTargets: string[] = [];
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "intent") return { text: '{"variants":"no"}' };
        if (mode === "title") return { text: "Edit thread" };
        // L2: the prompt names the REAL path; the overlay resolves the read
        // (copy-up) and stages the write.
        const target = prompt.match(/by editing (\S+) \(read it first\)/)![1];
        editTargets.push(target);
        const current = (await agentRead(params, target))!;
        await agentWrite(params, target, `${current}// edited\n`);
        return { text: "tightened" };
      },
    });
    const { id } = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    expect(h.orchestrator.ask({ pinId: id!, prompt: "tighten" }).error).toBeUndefined();
    await until(
      () => h.events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    const csId = changesetIdForPin(id!);
    const editRel = moduleAltPath("", id!, "edit", "src/Card.tsx");
    // L2 transparency: the prompt named the REAL path...
    expect(editTargets[0]).toBe("src/Card.tsx");
    // ...and the copy-up staged the edit VERBATIM over the original at the
    // MIRRORED path (relative imports resolve identically — no re-pointing).
    expect(await readFile(join(repoRoot, editRel), "utf8")).toBe(
      `${original}// edited\n`,
    );
    // Real source untouched; layer registered + SELECTED (previews live).
    expect(await readFile(join(repoRoot, "src/Card.tsx"), "utf8")).toBe(
      original,
    );
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.overrides["src/Card.tsx"]).toEqual({
      selection: "edit",
      alternatives: ["edit"],
    });
    expect(
      (await h.orchestrator.redirects(repoRoot, "")).redirects[
        join(repoRoot, "src/Card.tsx")
      ],
    ).toBe(join(repoRoot, editRel));
    // The edit-variant registers as a gallery variant too (full module).
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.variants).toHaveLength(1);
    expect(record.variants[0]).toMatchObject({
      id: "edit",
      file: editRel,
      moduleFile: editRel,
      status: "ready",
    });
    // SECOND ask: edits-follow-resolution — the SAME file, still one variant.
    h.events.length = 0;
    h.orchestrator.ask({ pinId: id!, prompt: "more" });
    await until(
      () => h.events.some((event) => event.type === "turn-end"),
      "second turn-end",
    );
    expect(editTargets).toEqual(["src/Card.tsx", "src/Card.tsx"]);
    expect(parsePins(readIndexSync(repoRoot))[0].variants).toHaveLength(1);
    expect(
      h.events.some((event) => event.type === "variant-updated"),
    ).toBe(true);
  });

  it('SINGLE-variation ask ("1 design variation") routes to the changeset edit turn — no director fan-out', async () => {
    const repoRoot = await makeRepo();
    const modes: string[] = [];
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        modes.push(mode);
        if (mode === "intent") return { text: '{"variants":"yes","n":1}' };
        if (mode === "title") return { text: "One variation" };
        const target = prompt.match(/by editing (\S+) \(read it first\)/)![1];
        const current = (await agentRead(params, target))!;
        await agentWrite(params, target, `${current}// variation\n`);
        return { text: "one variation made" };
      },
    });
    const { id } = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    h.orchestrator.ask({ pinId: id!, prompt: "give me 1 design variation" });
    await until(
      () => h.events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    // Routed as a TURN (wire) — never the director pipeline.
    expect(modes).not.toContain("director");
    const routed = h.events.find((event) => event.type === "intent-routed")!;
    expect(routed.intent).toBe("turn");
    const meta = readMetaSync(repoRoot, changesetIdForPin(id!));
    expect(meta.overrides["src/Card.tsx"].selection).toBe("edit");
  });

  it("ELEMENT pins: the landed span variant's re-inline turn registers the FULL-MODULE alternative at the mirrored path", async () => {
    const repoRoot = await makeRepo();
    const turns: Array<{ mode: string; prompt: string }> = [];
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt, cwd } = params;
        turns.push({ mode, prompt });
        if (mode === "director") {
          const original = prompt.match(/Write (\S+\/original\.tsx)/)![1];
          await mkdir(join(cwd, dirname(original)), { recursive: true });
          await writeFile(
            join(cwd, original),
            "export function Original(){ return null; }\n",
          );
          const controller = prompt.match(/Write (\S+\/controller\.tsx)/)![1];
          await writeFile(
            join(cwd, controller),
            "export function Controller({ V }: { V: any }) { return <V />; }\n",
          );
          return { text: '[{"slug":"stacked","intent":"vertical"}]' };
        }
        if (mode === "replace") {
          // L2: the re-inline turn EDITS the real owner path; the overlay
          // stages the full-module alternative at the mirrored path.
          const target = prompt.match(/EDIT (\S+) so the exact JSX span/)![1];
          await agentWrite(
            params,
            target,
            "export function ProductCard(){return null;} // re-inlined\n",
          );
          return { text: "re-inlined" };
        }
        const match = prompt.match(/EXACTLY this file: (\S+)/)!;
        await mkdir(join(cwd, dirname(match[1])), { recursive: true });
        await writeFile(
          join(cwd, match[1]),
          "export function Original(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const created = await h.orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
      kind: "element",
      locator: {
        tag: "div",
        outerHtml: "<div>$29</div>",
        childIndexPath: [0],
        textHash: "x",
      },
    });
    const id = created.id!;
    h.orchestrator.prompt({ pinId: id, prompt: "go", mode: "variants", count: 1 });
    await until(
      () => h.events.some((event) => event.type === "module-variant-ready"),
      "module-variant-ready",
    );
    const csId = changesetIdForPin(id);
    const moduleRel = moduleAltPath("", id, "stacked", "src/Card.tsx");
    // L2: the re-inline prompt targets the REAL owner path — the overlay
    // stages the mirrored alternative; path rules are gone.
    const reInline = turns.find((turn) => turn.mode === "replace")!;
    expect(reInline.prompt).toContain("EDIT src/Card.tsx so the exact JSX span");
    expect(reInline.prompt).not.toContain(".designbook/changesets");
    expect(reInline.prompt).not.toContain("Do not create, edit, or delete ANY file");
    // The layer registers the module alternative; the span variant stays a
    // pin-dir gallery artifact.
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.overrides["src/Card.tsx"]).toEqual({
      alternatives: ["stacked"],
    });
    // The index write is queued — wait for the record to flush.
    await until(
      () =>
        parsePins(readIndexSync(repoRoot))[0]?.variants[0]?.moduleFile !==
        undefined,
      "index flushed",
    );
    const [record] = parsePins(readIndexSync(repoRoot));
    expect(record.variants[0].file).toBe(variantFilePath("", id, "stacked"));
    expect(record.variants[0].moduleFile).toBe(moduleRel);
  });

  it("STACKING: a new run over an ACTIVE resolution reads the RESOLVED alternative as its original", async () => {
    const repoRoot = await makeRepo();
    const directorPrompts: string[] = [];
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "director") {
          directorPrompts.push(prompt);
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;} // STACK-BASE-DESIGN\n",
        );
        return { text: "done" };
      },
    });
    const idA = await landedLayerPin(h, repoRoot);
    const csA = changesetIdForPin(idA);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csA))),
      "meta A",
    );
    await h.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: { changesetId: csA, variantId: "compact" },
    });
    // A second pin's run now builds ON the active resolution.
    h.events.length = 0;
    await landedLayerPin(h, repoRoot);
    expect(directorPrompts).toHaveLength(2);
    // The embedded source context reads THROUGH A's layer (the resolved
    // design) but is LABELED with the real module path — no layer paths
    // leak into prompts (L2 stacking).
    expect(directorPrompts[1]).toContain("STACK-BASE-DESIGN");
    expect(directorPrompts[1]).toContain(
      "--- ORIGINAL COMPONENT SOURCE: src/Card.tsx ---",
    );
    expect(directorPrompts[1]).not.toContain(".designbook/changesets");
  });

  it("COMPOSE: one merge-agent turn → a NEW layer based on BOTH parents, selected on top; gate failure surfaces diagnostics", async () => {
    const repoRoot = await makeRepo();
    let composeShouldFail = true;
    const composePrompts: string[] = [];
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "director") {
          return { text: '[{"slug":"compact","intent":"denser"}]' };
        }
        if (prompt.includes("COMPOSE them")) {
          composePrompts.push(prompt);
          if (composeShouldFail) {
            return { text: "", errorMessage: "stream ended early" };
          }
          const target = prompt.match(/EDIT (\S+) into ONE design/)![1];
          await agentWrite(
            params,
            target,
            "export function ProductCard(){return null;} // composed\n",
          );
          return { text: "composed" };
        }
        await agentWrite(
          params,
          TARGET.file,
          "export function ProductCard(){return null;}\n",
        );
        return { text: "done" };
      },
    });
    const idA = await landedLayerPin(h, repoRoot);
    h.events.length = 0;
    const idB = await landedLayerPin(h, repoRoot);
    const csA = changesetIdForPin(idA);
    const csB = changesetIdForPin(idB);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csB))),
      "meta B",
    );
    // FAILURE first: diagnostics in the new thread, parents untouched.
    h.events.length = 0;
    const failed = await h.orchestrator.compose({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
    });
    expect(failed.id).toBeDefined();
    await until(
      () => h.events.some((event) => event.type === "variant-failed"),
      "compose failure",
    );
    expect(readMetaSync(repoRoot, csA).active).toBe(true);
    expect(readMetaSync(repoRoot, csB).active).toBe(true);
    // SETTLE the failed compose before moving on: its pipeline emits a
    // trailing run-complete AFTER variant-failed (with a persist between) —
    // under parallel load that stale event can land after the reset below
    // and satisfy the success-phase wait before the second compose turn ran.
    await until(
      () =>
        h.events.some(
          (event) =>
            event.type === "run-complete" && event.pinId === failed.id,
        ),
      "failed compose settled",
    );
    // SUCCESS: the composed layer records BOTH parents and resolves on top.
    composeShouldFail = false;
    h.events.length = 0;
    const composed = await h.orchestrator.compose({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      changesetIds: [csA, csB],
    });
    expect(composed.error).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) =>
            event.type === "run-complete" && event.pinId === composed.id,
        ),
      "compose complete",
    );
    expect(composePrompts.length).toBe(2);
    const csC = changesetIdForPin(composed.id!);
    const meta = readMetaSync(repoRoot, csC);
    expect(meta.bases).toEqual([csA, csB]);
    expect(meta.overrides["src/Card.tsx"].selection).toBe("composed");
    // Topmost: the composed layer's order beats both parents.
    expect(meta.order).toBeGreaterThan(readMetaSync(repoRoot, csA).order);
    expect(meta.order).toBeGreaterThan(readMetaSync(repoRoot, csB).order);
    expect(
      (await h.orchestrator.redirects(repoRoot, "")).redirects[
        join(repoRoot, "src/Card.tsx")
      ],
    ).toBe(
      join(repoRoot, altFilePath("", csC, "composed", "src/Card.tsx")),
    );
    // Deactivating a PARENT flags the composed layer (basedOnInactive).
    await h.orchestrator.activate({
      repoRoot,
      appDir: "",
      changesetId: csA,
      active: false,
    });
    const status = await h.orchestrator.status(repoRoot, "");
    expect(
      status.changesets.find((changeset) => changeset.id === csC)!
        .basedOnInactive,
    ).toBe(true);
  });

  it("L1 routes are registered and blocked in --read-only mode", () => {
    const apiSource = readFileSync(join(here, "api.ts"), "utf8");
    for (const [route, handler] of [
      ['"/api/sandbox/switch"', "handleSandboxSwitch"],
      ['"/api/sandbox/activate"', "handleSandboxActivate"],
      ['"/api/sandbox/bake"', "handleSandboxBake"],
      ['"/api/sandbox/discard"', "handleSandboxDiscard"],
      ['"/api/sandbox/compose"', "handleSandboxCompose"],
      ['"/api/sandbox/redirects"', "handleSandboxRedirects"],
    ]) {
      expect(apiSource).toContain(route);
      expect(apiSource).toContain(handler);
    }
    for (const route of [
      "POST /api/sandbox/switch",
      "POST /api/sandbox/activate",
      "POST /api/sandbox/bake",
      "POST /api/sandbox/discard",
      "POST /api/sandbox/compose",
    ]) {
      expect(READ_ONLY_BLOCKED_ROUTES.has(route), route).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Changeset layers L2 — overlay-bound turns (docs/specs/changeset-layers.md
// §Agent transparency): parallel variant isolation, extra-module capture,
// mid-turn real-file cleanliness.
// ---------------------------------------------------------------------------

describe("changeset layers (L2): overlay turns", () => {
  it("PARALLEL variant turns: N turns edit the SAME real path, land as N distinct alternatives; the real file is byte-clean THROUGHOUT", async () => {
    const repoRoot = await makeRepo();
    const original = await readFile(join(repoRoot, "src/Card.tsx"), "utf8");
    const midTurnRealReads: string[] = [];
    const h = harness({
      runTurn: async (params) => {
        const { mode, prompt } = params;
        if (mode === "director") {
          return {
            text: '[{"slug":"aa","intent":"one"},{"slug":"bb","intent":"two"}]',
          };
        }
        const slug = prompt.match(/Design direction "([^"]+)"/)![1];
        await agentWrite(
          params,
          TARGET.file,
          `export function ProductCard(){return null;} // design-${slug}\n`,
        );
        // MID-TURN check: the write is staged; the real file is untouched
        // while the turn is still running.
        midTurnRealReads.push(
          await readFile(join(repoRoot, TARGET.file), "utf8"),
        );
        // And the turn's own read of the real path sees ITS design.
        expect(await agentRead(params, TARGET.file)).toContain(
          `design-${slug}`,
        );
        return { text: "done" };
      },
    });
    const id = await landedLayerPin(h, repoRoot, 2);
    const csId = changesetIdForPin(id);
    expect(midTurnRealReads).toEqual([original, original]);
    expect(await readFile(join(repoRoot, TARGET.file), "utf8")).toBe(original);
    // Each turn's staging landed as ITS OWN alternative — no collision.
    expect(
      await readFile(
        join(repoRoot, moduleAltPath("", id, "aa", TARGET.file)),
        "utf8",
      ),
    ).toContain("design-aa");
    expect(
      await readFile(
        join(repoRoot, moduleAltPath("", id, "bb", TARGET.file)),
        "utf8",
      ),
    ).toContain("design-bb");
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.overrides[TARGET.file].alternatives).toEqual(["aa", "bb"]);
  });

  it("EXTRA MODULE capture: a variant adding a helper registers it under the variant's alt id; flips FOLLOW the target", async () => {
    const repoRoot = await makeRepo();
    const h = harness({
      runTurn: componentTurnFake({
        onVariantTurn: async (turn) => {
          await agentWrite(
            turn,
            "src/CardBits.tsx",
            "export const Bits = 1; // helper\n",
          );
        },
      }),
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () =>
        readMetaSync(repoRoot, csId)?.overrides["src/CardBits.tsx"] !==
        undefined,
      "extra module captured",
    );
    // Registered under the variant's alt id, staged at the mirrored path,
    // base captured for the 3-way bake; DORMANT until the variant flips.
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.overrides["src/CardBits.tsx"]).toEqual({
      alternatives: ["compact"],
    });
    expect(
      existsSync(join(repoRoot, altFilePath("", csId, "compact", "src/CardBits.tsx"))),
    ).toBe(true);
    expect(existsSync(join(repoRoot, "src/CardBits.tsx"))).toBe(false);
    expect(
      (await h.orchestrator.redirects(repoRoot, "")).redirects,
    ).toEqual({});
    // Selecting the variant flips BOTH files (atomic cross-module flip).
    await h.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: { changesetId: csId, variantId: "compact" },
    });
    const flipped = readMetaSync(repoRoot, csId);
    expect(flipped.overrides["src/Card.tsx"].selection).toBe("compact");
    expect(flipped.overrides["src/CardBits.tsx"].selection).toBe("compact");
    const table = (await h.orchestrator.redirects(repoRoot, "")).redirects;
    expect(table[join(repoRoot, "src/CardBits.tsx")]).toBe(
      join(repoRoot, altFilePath("", csId, "compact", "src/CardBits.tsx")),
    );
    // Back to original: the sibling clears with the target.
    await h.orchestrator.switchSelect({
      repoRoot,
      appDir: "",
      component: "src/Card.tsx#ProductCard",
      selection: null,
    });
    const cleared = readMetaSync(repoRoot, csId);
    expect(cleared.overrides["src/Card.tsx"].selection).toBeUndefined();
    expect(cleared.overrides["src/CardBits.tsx"].selection).toBeUndefined();
  });

  it("DATA mid-turn cleanliness: an i18n-adding turn NEVER touches the real locale file, and the staged copy leaves no code-style shadow", async () => {
    const repoRoot = await makeRepo();
    const EN = `${JSON.stringify({ product: { title: "Vase" } }, null, 2)}\n`;
    await mkdir(join(repoRoot, "locales"), { recursive: true });
    await writeFile(join(repoRoot, "locales/en.json"), EN);
    await gitCommitAll(repoRoot);
    const midTurnReads: string[] = [];
    const h = harness({
      runTurn: componentTurnFake({
        onVariantTurn: async (turn) => {
          await agentWrite(
            turn,
            "locales/en.json",
            `${JSON.stringify(
              { product: { title: "Vase", cta: "Buy now" } },
              null,
              2,
            )}\n`,
          );
          // MID-TURN: real file byte-clean; the turn's read sees its key.
          midTurnReads.push(
            await readFile(join(repoRoot, "locales/en.json"), "utf8"),
          );
          expect(await agentRead(turn, "locales/en.json")).toContain(
            "Buy now",
          );
        },
      }),
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () =>
        readMetaSync(repoRoot, csId)?.overrides["locales/en.json"] !==
        undefined,
      "data captured",
    );
    expect(midTurnReads).toEqual([EN]);
    expect(await readFile(join(repoRoot, "locales/en.json"), "utf8")).toBe(EN);
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.overrides["locales/en.json"]).toEqual({
      selection: DATA_ALT_ID,
      alternatives: [DATA_ALT_ID],
      addedKeys: ["product.cta"],
    });
    // The staged code-style copy under the VARIANT's alt id is gone — data
    // lives in the DATA alternative only.
    expect(
      existsSync(
        join(repoRoot, altFilePath("", csId, "compact", "locales/en.json")),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(repoRoot, altFilePath("", csId, DATA_ALT_ID, "locales/en.json")),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Changesets on git — G3: drift→rebase, bake via merge, bake-to-branch
// (docs/specs/changesets-on-git.md §Drift / bake / bake-to-branch).
// ---------------------------------------------------------------------------

describe("changesets on git (G3): rebase, bake via merge, bake-to-branch", () => {
  /** Padded target source: the design line and the drift line are far
   * enough apart that a real 3-way merge settles both cleanly. */
  const PADDED = `${[
    "// hd",
    "// p1",
    "// p2",
    "// p3",
    "// p4",
    "export function ProductCard() { return null; }",
    "// f1",
    "// f2",
    "// f3",
    "// f4",
  ].join("\n")}\n`;
  const DESIGNED = PADDED.replace("return null", "return 'design'");

  async function sh(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  }

  /** A repo whose target file is the padded source, plus one landed layer.
   * The runTurn fake also answers the G3 merge turns: rebase conflicts
   * (mode "edit", worktree cwd) resolve to `resolution`; bake merge
   * conflicts (mode "replace", repo cwd) write `bakeMerge`. */
  async function g3Fixture(options?: {
    resolution?: string;
    failRebaseTurn?: boolean;
    bakeMerge?: string;
    runTypecheck?: SandboxTypecheck;
  }) {
    const repoRoot = await makeRepo();
    await writeFile(join(repoRoot, "src/Card.tsx"), PADDED);
    await gitCommitAll(repoRoot, "padded");
    const turns: Array<{ mode: string; prompt: string }> = [];
    const h = harness({
      ...(options?.runTypecheck ? { runTypecheck: options.runTypecheck } : {}),
      runTurn: async (params) => {
        turns.push({ mode: params.mode, prompt: params.prompt });
        if (params.mode === "variant") {
          await agentWrite(params, TARGET.file, DESIGNED);
          return { text: "done" };
        }
        if (
          params.mode === "edit" &&
          params.prompt.includes("git rebase conflict")
        ) {
          // The rebase merge turn: resolve in the WORKTREE (cwd) or fail.
          if (options?.failRebaseTurn) {
            return { text: "", errorMessage: "merge model unavailable" };
          }
          await writeFile(
            join(params.cwd, TARGET.file),
            options?.resolution ?? PADDED,
          );
          return { text: "resolved" };
        }
        if (
          params.mode === "replace" &&
          params.prompt.includes("Merge a designbook changeset")
        ) {
          // The bake merge turn: rewrite the REAL module (cwd = repo root).
          await writeFile(
            join(params.cwd, TARGET.file),
            options?.bakeMerge ?? DESIGNED,
          );
          return { text: "merged" };
        }
        return { text: '[{"slug":"compact","intent":"denser"}]' };
      },
    });
    const id = await landedLayerPin(h, repoRoot);
    const csId = changesetIdForPin(id);
    await until(
      () => existsSync(join(repoRoot, changesetMetaPath("", csId))),
      "meta written",
    );
    turns.length = 0;
    return { repoRoot, h, id, csId, turns };
  }

  it("REBASE clean: uncommitted drift snapshots into a new base; branches replay; drift clears; baselines remap", async () => {
    const { repoRoot, h, csId, turns } = await g3Fixture();
    const trunkRef = `refs/designbook/changesets/${csId}/trunk`;
    const variantRef = `refs/designbook/changesets/${csId}/v/compact`;
    const oldBase = await sh(repoRoot, [
      "rev-parse",
      `refs/designbook/changesets/${csId}/base`,
    ]);
    // Out-of-band UNCOMMITTED edit far from the design line → drift.
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      PADDED.replace("// hd", "// hd EDITED"),
    );
    expect(
      (await h.orchestrator.status(repoRoot, "")).changesets[0].drifted,
    ).toBe(true);
    const result = await h.orchestrator.rebase({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(result.error).toBeUndefined();
    expect(result.rebased).toBe(true);
    // Zero model turns on the clean path.
    expect(turns).toEqual([]);
    // The base ref moved to a snapshot CHILD of HEAD carrying the dirt.
    const newBase = await sh(repoRoot, [
      "rev-parse",
      `refs/designbook/changesets/${csId}/base`,
    ]);
    expect(newBase).not.toBe(oldBase);
    expect(await sh(repoRoot, ["rev-parse", `${newBase}^`])).toBe(
      await sh(repoRoot, ["rev-parse", "HEAD"]),
    );
    // The variant branch replayed: its blob carries BOTH changes.
    const variantBlob = await sh(repoRoot, [
      "show",
      `${variantRef}:src/Card.tsx`,
    ]);
    expect(variantBlob).toContain("// hd EDITED");
    expect(variantBlob).toContain("'design'");
    // Drift cleared mechanically (baseHashes re-derive from the new base).
    expect(
      (await h.orchestrator.status(repoRoot, "")).changesets[0].drifted,
    ).toBe(false);
    // The projected alternative re-derived with both changes.
    const alt = await readFile(
      join(repoRoot, altFilePath("", csId, "compact", "src/Card.tsx")),
      "utf8",
    );
    expect(alt).toContain("// hd EDITED");
    expect(alt).toContain("'design'");
    // The generation baseline remapped onto the rebased tip.
    const meta = readMetaSync(repoRoot, csId);
    expect(meta.generatedTips?.compact).toBe(
      await sh(repoRoot, ["rev-parse", variantRef]),
    );
    expect(meta.baseCommit).toBe(newBase);
    // Trunk (no own commits) fast-forwarded onto the new base.
    expect(await sh(repoRoot, ["rev-parse", trunkRef])).toBe(newBase);
    // The user's own surfaces stayed put.
    expect(await sh(repoRoot, ["diff", "--cached", "--name-only"])).toBe("");
    expect(
      h.events.some(
        (event) => event.type === "rebase-status" && event.status === "done",
      ),
    ).toBe(true);
  });

  it("REBASE conflict: ONE merge turn (worktree cwd) resolves and the sequence continues", async () => {
    const { repoRoot, h, csId, turns } = await g3Fixture({
      resolution: PADDED.replace("return null", "return 'design+outside'"),
    });
    // Overlapping drift: the SAME line the design rewrote.
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      PADDED.replace("return null", "return 'outside'"),
    );
    const result = await h.orchestrator.rebase({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(result.error).toBeUndefined();
    expect(result.rebased).toBe(true);
    // Exactly ONE merge turn ran, in the changeset worktree.
    expect(turns).toHaveLength(1);
    expect(turns[0].mode).toBe("edit");
    const variantBlob = await sh(repoRoot, [
      "show",
      `refs/designbook/changesets/${csId}/v/compact:src/Card.tsx`,
    ]);
    expect(variantBlob).toContain("design+outside");
    expect(
      h.events.some(
        (event) =>
          event.type === "rebase-status" && event.status === "conflict",
      ),
    ).toBe(true);
    expect(
      (await h.orchestrator.status(repoRoot, "")).changesets[0].drifted,
    ).toBe(false);
  });

  it("REBASE abort: an unresolved merge turn restores every pre-rebase tip; drift stays flagged", async () => {
    const { repoRoot, h, csId } = await g3Fixture({ failRebaseTurn: true });
    const variantRef = `refs/designbook/changesets/${csId}/v/compact`;
    const baseRef = `refs/designbook/changesets/${csId}/base`;
    const tipBefore = await sh(repoRoot, ["rev-parse", variantRef]);
    const baseBefore = await sh(repoRoot, ["rev-parse", baseRef]);
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      PADDED.replace("return null", "return 'outside'"),
    );
    const result = await h.orchestrator.rebase({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(result.error).toBeDefined();
    // Everything restored exactly as before.
    expect(await sh(repoRoot, ["rev-parse", variantRef])).toBe(tipBefore);
    expect(await sh(repoRoot, ["rev-parse", baseRef])).toBe(baseBefore);
    expect(
      h.events.some(
        (event) => event.type === "rebase-status" && event.status === "failed",
      ),
    ).toBe(true);
    expect(
      (await h.orchestrator.status(repoRoot, "")).changesets[0].drifted,
    ).toBe(true);
    // The projected alternative still serves the ORIGINAL design.
    expect(
      await readFile(
        join(repoRoot, altFilePath("", csId, "compact", "src/Card.tsx")),
        "utf8",
      ),
    ).toBe(DESIGNED);
  });

  it("BAKE onto a DIRTY tree: the squashed diff 3-way-applies (zero turns), unrelated dirt survives, dissolve leaves ZERO refs", async () => {
    const { repoRoot, h, csId, turns } = await g3Fixture();
    // Unrelated dirty file + non-overlapping drift in the target.
    await writeFile(join(repoRoot, "notes.txt"), "user scratch\n");
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      PADDED.replace("// hd", "// hd EDITED"),
    );
    const result = await h.orchestrator.bake({
      repoRoot,
      appDir: "",
      changesetId: csId,
      force: true, // Drifted — explicit confirm (the 409 gate stays).
    });
    expect(result.error).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) => event.type === "bake-status" && event.status === "done",
        ),
      "bake done",
    );
    // ZERO model turns on the apply path.
    expect(turns).toEqual([]);
    const baked = await readFile(join(repoRoot, "src/Card.tsx"), "utf8");
    expect(baked).toContain("// hd EDITED");
    expect(baked).toContain("'design'");
    expect(await readFile(join(repoRoot, "notes.txt"), "utf8")).toBe(
      "user scratch\n",
    );
    // The user's index gained nothing; no designbook refs/worktrees remain.
    expect(await sh(repoRoot, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await sh(repoRoot, ["for-each-ref", "refs/designbook"])).toBe("");
    expect(existsSync(join(repoRoot, `.designbook/changesets/${csId}`))).toBe(
      false,
    );
    expect(existsSync(join(repoRoot, `.designbook/worktrees/${csId}`))).toBe(
      false,
    );
  });

  it("BAKE conflict: overlapping drift falls back per-file to ONE merge turn", async () => {
    const merged = PADDED.replace("return null", "return 'merged by turn'");
    const { repoRoot, h, csId, turns } = await g3Fixture({ bakeMerge: merged });
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      PADDED.replace("return null", "return 'outside'"),
    );
    const result = await h.orchestrator.bake({
      repoRoot,
      appDir: "",
      changesetId: csId,
      force: true,
    });
    expect(result.error).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) => event.type === "bake-status" && event.status === "done",
        ),
      "bake done",
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].mode).toBe("replace");
    expect(await readFile(join(repoRoot, "src/Card.tsx"), "utf8")).toContain(
      "merged by turn",
    );
    expect(
      h.events.some((event) => event.type === "bake-merge-turn"),
    ).toBe(true);
    expect(await sh(repoRoot, ["for-each-ref", "refs/designbook"])).toBe("");
  });

  it("DISCARD leaves zero refs, no worktree, no cache dir", async () => {
    const { repoRoot, h, csId } = await g3Fixture();
    expect(
      (await h.orchestrator.discard({ repoRoot, appDir: "", changesetId: csId }))
        .error,
    ).toBeUndefined();
    expect(await sh(repoRoot, ["for-each-ref", "refs/designbook"])).toBe("");
    expect(existsSync(join(repoRoot, `.designbook/changesets/${csId}`))).toBe(
      false,
    );
    expect(existsSync(join(repoRoot, `.designbook/worktrees/${csId}`))).toBe(
      false,
    );
  });

  it("BAKE-TO-BRANCH: default name, real branch off HEAD, changeset stays ACTIVE with bakedTo; re-bake stacks; gate skippable; user tree untouched", async () => {
    const gates: string[] = [];
    const { repoRoot, h, csId, turns } = await g3Fixture({
      runTypecheck: async (root) => {
        gates.push(root);
        return { ok: true };
      },
    });
    const head = await sh(repoRoot, ["rev-parse", "HEAD"]);
    const before = await readFile(join(repoRoot, "src/Card.tsx"), "utf8");
    const result = await h.orchestrator.bakeToBranch({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(result.error).toBeUndefined();
    expect(result.branch).toMatch(/^designbook\//);
    const branch = result.branch!;
    await until(
      () =>
        h.events.some(
          (event) =>
            event.type === "baked-to-branch" && event.targetBranch === branch,
        ),
      "branch bake done",
    );
    // A REAL, visible branch exists; its commit is cut from HEAD.
    expect(await sh(repoRoot, ["branch", "--list", "designbook/*"])).toContain(
      branch,
    );
    const tip1 = await sh(repoRoot, ["rev-parse", `refs/heads/${branch}`]);
    expect(await sh(repoRoot, ["rev-parse", `${tip1}^`])).toBe(head);
    expect(await sh(repoRoot, ["show", `${tip1}:src/Card.tsx`])).toContain(
      "'design'",
    );
    // The gate ran in a TEMP worktree, never the repo root.
    expect(gates).toHaveLength(1);
    expect(gates[0]).not.toBe(repoRoot);
    // The user's tree/HEAD are untouched; the changeset is still ACTIVE.
    expect(await readFile(join(repoRoot, "src/Card.tsx"), "utf8")).toBe(before);
    expect(await sh(repoRoot, ["rev-parse", "HEAD"])).toBe(head);
    expect(await sh(repoRoot, ["status", "--porcelain", "src"])).toBe("");
    const status = await h.orchestrator.status(repoRoot, "");
    expect(status.changesets[0].active).toBe(true);
    expect(
      (status.changesets[0] as { bakedTo?: { branch: string } }).bakedTo
        ?.branch,
    ).toBe(branch);
    expect(readMetaSync(repoRoot, csId).bakedTo?.branch).toBe(branch);
    // Zero model turns; hidden refs still alive (no dissolve).
    expect(turns).toEqual([]);
    expect(
      await sh(repoRoot, ["for-each-ref", "refs/designbook"]),
    ).not.toBe("");

    // RE-BAKE to the same (default) branch = a NEW commit stacked on it.
    h.events.length = 0;
    expect(
      (
        await h.orchestrator.bakeToBranch({
          repoRoot,
          appDir: "",
          changesetId: csId,
          skipGate: true,
        })
      ).error,
    ).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) =>
            event.type === "baked-to-branch" && event.targetBranch === branch,
        ),
      "re-bake done",
    );
    const tip2 = await sh(repoRoot, ["rev-parse", `refs/heads/${branch}`]);
    expect(tip2).not.toBe(tip1);
    expect(await sh(repoRoot, ["rev-parse", `${tip2}^`])).toBe(tip1);
    // skipGate honored: the gate count did not move.
    expect(gates).toHaveLength(1);

    // Custom name; the CURRENT branch is refused.
    h.events.length = 0;
    expect(
      (
        await h.orchestrator.bakeToBranch({
          repoRoot,
          appDir: "",
          changesetId: csId,
          name: "designbook/custom-x",
          skipGate: true,
        })
      ).error,
    ).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) =>
            event.type === "baked-to-branch" &&
            event.targetBranch === "designbook/custom-x",
        ),
      "custom bake done",
    );
    expect(
      await sh(repoRoot, ["rev-parse", "refs/heads/designbook/custom-x"]),
    ).toBeTruthy();
    expect(
      (
        await h.orchestrator.bakeToBranch({
          repoRoot,
          appDir: "",
          changesetId: csId,
          name: "main",
        })
      ).error,
    ).toContain("current branch");
    expect(
      (
        await h.orchestrator.bakeToBranch({
          repoRoot,
          appDir: "",
          changesetId: csId,
          name: "bad..name",
        })
      ).error,
    ).toContain("not a valid branch name");
  });

  it("BAKE-TO-BRANCH refuses un-rebased drift without force; with force an apply conflict fails with a Rebase pointer", async () => {
    const { repoRoot, h, csId } = await g3Fixture();
    await writeFile(
      join(repoRoot, "src/Card.tsx"),
      PADDED.replace("return null", "return 'outside'"),
    );
    const refused = await h.orchestrator.bakeToBranch({
      repoRoot,
      appDir: "",
      changesetId: csId,
    });
    expect(refused.status).toBe(409);
    // Forced past the gate: the UNCOMMITTED overlap is not in HEAD, so the
    // apply targets HEAD cleanly — commit the drift to force the conflict.
    await gitCommitAll(repoRoot, "outside change");
    const forced = await h.orchestrator.bakeToBranch({
      repoRoot,
      appDir: "",
      changesetId: csId,
      force: true,
      skipGate: true,
    });
    expect(forced.error).toBeUndefined();
    await until(
      () =>
        h.events.some(
          (event) =>
            event.type === "bake-status" &&
            event.status === "failed" &&
            typeof event.error === "string" &&
            (event.error as string).includes("Rebase the changeset"),
        ),
      "branch bake conflict failure",
    );
    // No branch was created.
    expect(await sh(repoRoot, ["branch", "--list", "designbook/*"])).toBe("");
  });
});
