/**
 * Design-variations orchestrator tests (docs/specs/design-variations.md).
 *
 * Pure helpers (index round-trip, promote transforms, director parsing) plus
 * the orchestrator state machine against FAKE turns in a temp repo — the
 * sessionRegistry test pattern: no Pi SDK, no auth. Ends with source scans
 * pinning the write-confinement discipline (generation targets come from
 * `variantSourcePath`, deletions are guarded by `isVariationsPath`, api.ts
 * handlers resolve their root via `activeRepoRoot()`, and the endpoints are
 * write-flagged for --read-only).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_DIRECTIONS,
  VARIATIONS_DIR,
  buildVariantPrompt,
  createVariationsOrchestrator,
  detectExportName,
  extractAssistantText,
  extractTurnErrorMessage,
  isValidComponentName,
  isVariationsPath,
  normalizeAppDir,
  parseDirectorReply,
  parseVariationsIndex,
  rebaseRelativeImports,
  renameIdentifier,
  serializeVariationsIndex,
  slugify,
  stripProvenanceHeader,
  truncateDiagnostic,
  variantSourcePath,
  variationsDir,
  variationsIndexFile,
  type RunTurn,
  type VariationRecord,
} from "./variations.ts";
import { READ_ONLY_BLOCKED_ROUTES } from "./readOnlyRoutes.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("slugify / variantSourcePath", () => {
  it("kebab-cases and caps direction text", () => {
    expect(slugify("Type-led, editorial!")).toBe("type-led-editorial");
    expect(slugify("   ")).toBe("variant");
    expect(slugify("x".repeat(60)).length).toBeLessThanOrEqual(24);
  });

  it("builds variant paths inside VARIATIONS_DIR", () => {
    const path = variantSourcePath("", "product.ProductCard", "compact");
    expect(path).toBe(".designbook/variations/product.ProductCard.compact.tsx");
    expect(isVariationsPath(path, "")).toBe(true);
    expect(isVariationsPath("src/App.tsx", "")).toBe(false);
  });
});

describe("index round-trip", () => {
  const records: VariationRecord[] = [
    {
      baseEntryId: "product.ProductCard",
      baseSourcePath: "src/composite/product/variants/Card.tsx",
      slug: "compact",
      intent: 'tighter, "denser" layout',
      sourcePath: ".designbook/variations/product.ProductCard.compact.tsx",
    },
    {
      baseEntryId: "search.ResultsList",
      baseSourcePath: "src/composite/search/variants/ResultsList.tsx",
      slug: "bold",
      intent: "bigger emphasis",
      sourcePath: ".designbook/variations/search.ResultsList.bold.tsx",
    },
  ];

  it("serializes with load thunks and parses back verbatim", () => {
    const source = serializeVariationsIndex(records);
    expect(source).toContain(
      'load: () => import("./product.ProductCard.compact.tsx"),',
    );
    expect(parseVariationsIndex(source)).toEqual(records);
  });

  it("parses nothing from unrelated content", () => {
    expect(parseVariationsIndex("export const x = 1;")).toEqual([]);
  });
});

describe("promote transforms", () => {
  it("rebases relative imports between directories", () => {
    const source = [
      'import { Button } from "../../src/components/ui/button";',
      'import * as atoms from "../../src/composite/product/atoms";',
      'const lazy = () => import("../../src/lib/x");',
      'import { cn } from "@/lib/utils";',
      'import { useState } from "react";',
    ].join("\n");
    const rebased = rebaseRelativeImports(
      source,
      ".designbook/variations",
      "src/composite/product/variants",
    );
    expect(rebased).toContain('from "../../../components/ui/button"');
    expect(rebased).toContain('from "../atoms"');
    expect(rebased).toContain('import("../../../lib/x")');
    // Aliases and bare specifiers untouched.
    expect(rebased).toContain('from "@/lib/utils"');
    expect(rebased).toContain('from "react"');
  });

  it("strips the provenance header only", () => {
    const source =
      '/** designbook:variation of Card.tsx — "compact": denser. */\nimport x from "y";\n';
    expect(stripProvenanceHeader(source)).toBe('import x from "y";\n');
    const plain = "/** unrelated doc */\nconst a = 1;\n";
    expect(stripProvenanceHeader(plain)).toBe(plain);
  });

  it("detects and renames the exported component identifier", () => {
    const source =
      "function helper() {}\nexport function ProductCard() { return helper(); }\nexport { ProductCard as default };\n";
    expect(detectExportName(source)).toBe("ProductCard");
    const renamed = renameIdentifier(source, "ProductCard", "CardCompact");
    expect(renamed).toContain("export function CardCompact()");
    expect(renamed).toContain("CardCompact as default");
    expect(renamed).not.toContain("ProductCard");
  });

  it("detects the split declaration + `export { X }` form (live-verify regression)", () => {
    const source =
      "function ProductCard() { return null; }\nexport { ProductCard };\n";
    expect(detectExportName(source)).toBe("ProductCard");
    const renamed = renameIdentifier(source, "ProductCard", "CardSidePanel");
    expect(renamed).toContain("function CardSidePanel()");
    expect(renamed).toContain("export { CardSidePanel };");
  });

  it("validates promoted component names", () => {
    expect(isValidComponentName("CardCompact")).toBe(true);
    expect(isValidComponentName("cardCompact")).toBe(false);
    expect(isValidComponentName("Card Compact")).toBe(false);
    expect(isValidComponentName("")).toBe(false);
  });
});

describe("parseDirectorReply", () => {
  it("extracts a JSON array from a prose-wrapped reply", () => {
    const reply =
      'Here you go:\n[{"slug": "compact", "intent": "denser"}, {"slug": "Bold Look", "intent": "bigger"}]\nDone.';
    expect(parseDirectorReply(reply, 2)).toEqual([
      { slug: "compact", intent: "denser" },
      { slug: "bold-look", intent: "bigger" },
    ]);
  });

  it("returns undefined on bad JSON, duplicates, or a short list", () => {
    expect(parseDirectorReply("no json here", 2)).toBeUndefined();
    expect(
      parseDirectorReply(
        '[{"slug":"a","intent":"x"},{"slug":"a","intent":"y"}]',
        2,
      ),
    ).toBeUndefined();
    expect(parseDirectorReply('[{"slug":"a","intent":"x"}]', 2)).toBeUndefined();
  });
});

describe("extractAssistantText", () => {
  it("reads the last assistant message, string or content-part shaped", () => {
    expect(
      extractAssistantText([
        { role: "assistant", content: "first" },
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "…" },
            { type: "text", text: "[]" },
          ],
        },
      ]),
    ).toBe("[]");
    expect(extractAssistantText([{ role: "user", content: "q" }])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator state machine (fake turns, temp repo).
// ---------------------------------------------------------------------------

type Ev = Record<string, unknown> & { kind?: string };

async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const BASE = "product.ProductCard";
const BASE_SRC = "src/composite/product/variants/Card.tsx";

const ORIGINAL_SOURCE = [
  'import { Button } from "../../../components/ui/button";',
  "export function ProductCard() {",
  "  return <Button>original</Button>;",
  "}",
  "",
].join("\n");

function variantSource(slug: string): string {
  return [
    `/** designbook:variation of ${BASE_SRC} — "${slug}": test variant. */`,
    'import { Button } from "../../src/components/ui/button";',
    "export function ProductCard() {",
    `  return <Button>${slug}</Button>;`,
    "}",
    "",
  ].join("\n");
}

/** Test harness: temp repo + fake runTurn writing (or not) the target file. */
async function makeHarness(options?: {
  failSlugs?: string[];
  directorReply?: string | Error;
  onTurn?: (params: { cwd: string; prompt: string; mode: string }) => void;
  /** Repo-relative base component path (monorepo tests move it under an app dir). */
  baseSrc?: string;
  /** Variant turns report a turn-level failure instead of writing. */
  turnErrorMessage?: string;
  /** Variant turns reply with this text when landing no file. */
  turnText?: string;
}) {
  const repoRoot = await mkdtemp(join(tmpdir(), "db-variations-"));
  const baseSrc = options?.baseSrc ?? BASE_SRC;
  await mkdir(join(repoRoot, dirname(baseSrc)), { recursive: true });
  await writeFile(join(repoRoot, baseSrc), ORIGINAL_SOURCE, "utf8");

  const events: Ev[] = [];
  const runTurn: RunTurn = async (params) => {
    options?.onTurn?.(params);
    if (params.mode === "director") {
      const reply = options?.directorReply;
      if (reply instanceof Error) throw reply;
      return { text: reply ?? "no directions from me" };
    }
    // Variant turn: the prompt names the one target file.
    const target = params.prompt.match(/EXACTLY this file: (\S+)/)?.[1];
    const iterated = params.prompt.match(
      /Revise the design-variation file (\S+)/,
    )?.[1];
    const path = target ?? iterated;
    if (!path) throw new Error("prompt named no target file");
    const slug = path.match(/\.([a-z0-9-]+)\.tsx$/)?.[1] ?? "x";
    if (options?.turnErrorMessage) {
      return { text: "", errorMessage: options.turnErrorMessage };
    }
    if (options?.failSlugs?.includes(slug)) {
      // lands no file → verification fails
      return { text: options?.turnText ?? "did nothing" };
    }
    await mkdir(dirname(join(params.cwd, path)), { recursive: true });
    await writeFile(join(params.cwd, path), variantSource(slug), "utf8");
    return { text: "done" };
  };

  const orchestrator = createVariationsOrchestrator({
    runTurn,
    broadcast: (eventName, payload) => {
      if (eventName === "variations-event") events.push(payload as Ev);
    },
    log: () => {},
  });
  return { repoRoot, events, orchestrator };
}

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

describe("orchestrator: generate", () => {
  it("director directions → parallel landings → index records + events", async () => {
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply:
        '[{"slug":"compact","intent":"denser"},{"slug":"airy","intent":"more whitespace"}]',
    });
    cleanups.push(repoRoot);

    const result = orchestrator.generate({
      repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 2,
    });
    expect(result.error).toBeUndefined();
    await until(
      () => events.some((event) => event.kind === "run-complete"),
      "run-complete",
    );

    const kinds = events.map((event) => event.kind);
    expect(kinds[0]).toBe("planning");
    expect(kinds).toContain("planned");
    expect(events.filter((event) => event.kind === "landed")).toHaveLength(2);

    const landed = events.find((event) => event.kind === "landed")!;
    expect(landed.absPath).toBe(join(repoRoot, landed.path as string));
    expect(landed.rev).toBe(1);

    // Files + durable record.
    expect(
      existsSync(join(repoRoot, variantSourcePath("", BASE, "compact"))),
    ).toBe(true);
    const index = parseVariationsIndex(
      await readFile(join(repoRoot, variationsIndexFile("")), "utf8"),
    );
    expect(index.map((record) => record.slug).sort()).toEqual([
      "airy",
      "compact",
    ]);
    expect(index[0].baseSourcePath).toBe(BASE_SRC);
  });

  it("falls back to the fixed palette when the director fails", async () => {
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply: new Error("model unavailable"),
    });
    cleanups.push(repoRoot);
    orchestrator.generate({
      repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 3,
    });
    await until(
      () => events.some((event) => event.kind === "run-complete"),
      "run-complete",
    );
    const planned = events.find((event) => event.kind === "planned")!;
    expect(
      (planned.items as Array<{ slug: string }>).map((item) => item.slug),
    ).toEqual(FALLBACK_DIRECTIONS.slice(0, 3).map((d) => d.slug));
  });

  it("marks a variant failed when its session lands no file", async () => {
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply:
        '[{"slug":"good","intent":"a"},{"slug":"bad","intent":"b"}]',
      failSlugs: ["bad"],
    });
    cleanups.push(repoRoot);
    orchestrator.generate({
      repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 2,
    });
    await until(
      () => events.some((event) => event.kind === "run-complete"),
      "run-complete",
    );
    const failed = events.find((event) => event.kind === "failed")!;
    expect(failed.slug).toBe("bad");
    const index = parseVariationsIndex(
      await readFile(join(repoRoot, variationsIndexFile("")), "utf8"),
    );
    expect(index.map((record) => record.slug)).toEqual(["good"]);
  });

  it("rejects escapes, variations-dir bases, and concurrent runs", async () => {
    const { repoRoot, orchestrator, events } = await makeHarness({
      directorReply: '[{"slug":"a","intent":"x"}]',
    });
    cleanups.push(repoRoot);
    expect(
      orchestrator.generate({
        repoRoot,
        appDir: "",
        baseEntryId: BASE,
        baseSourcePath: "../outside.tsx",
      }).error,
    ).toBeTruthy();
    expect(
      orchestrator.generate({
        repoRoot,
        appDir: "",
        baseEntryId: BASE,
        baseSourcePath: `${VARIATIONS_DIR}/x.tsx`,
      }).error,
    ).toBeTruthy();
    expect(
      orchestrator.generate({
        repoRoot,
        appDir: "",
        baseEntryId: "evil/../id",
        baseSourcePath: BASE_SRC,
      }).error,
    ).toBeTruthy();

    expect(
      orchestrator.generate({
        repoRoot,
        appDir: "",
        baseEntryId: BASE,
        baseSourcePath: BASE_SRC,
        count: 1,
      }).error,
    ).toBeUndefined();
    // Second run while the first is in flight.
    expect(
      orchestrator.generate({
        repoRoot,
        appDir: "",
        baseEntryId: BASE,
        baseSourcePath: BASE_SRC,
      }).error,
    ).toMatch(/in progress/);
    await until(
      () => events.some((event) => event.kind === "run-complete"),
      "run-complete",
    );
  });
});

describe("orchestrator: iterate + retry", () => {
  it("iterate bumps rev and emits updated", async () => {
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply: '[{"slug":"compact","intent":"denser"}]',
    });
    cleanups.push(repoRoot);
    orchestrator.generate({
      repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 1,
    });
    await until(
      () => events.some((event) => event.kind === "run-complete"),
      "generate",
    );

    expect(
      orchestrator.iterate({
        repoRoot,
        base: BASE,
        slug: "compact",
        note: "make the button secondary",
      }).error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.kind === "updated"),
      "updated",
    );
    const updated = events.find((event) => event.kind === "updated")!;
    expect(updated.rev).toBe(2);
    expect(events.some((event) => event.kind === "updating")).toBe(true);

    // Guards.
    expect(
      orchestrator.iterate({ repoRoot, base: BASE, slug: "nope", note: "x" })
        .error,
    ).toBeTruthy();
    expect(
      orchestrator.iterate({ repoRoot, base: BASE, slug: "compact", note: " " })
        .error,
    ).toBeTruthy();
  });

  it("retry re-runs a failed variant with a fresh turn", async () => {
    const failSlugs = ["compact"];
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply: '[{"slug":"compact","intent":"denser"}]',
      failSlugs,
    });
    cleanups.push(repoRoot);
    orchestrator.generate({
      repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 1,
    });
    await until(
      () => events.some((event) => event.kind === "failed"),
      "failed",
    );

    failSlugs.length = 0; // next attempt succeeds
    expect(orchestrator.retry({ base: BASE, slug: "compact" }).error)
      .toBeUndefined();
    await until(
      () => events.some((event) => event.kind === "landed"),
      "landed after retry",
    );
  });
});

describe("orchestrator: resolve", () => {
  async function landedHarness() {
    const harness = await makeHarness({
      directorReply:
        '[{"slug":"compact","intent":"denser"},{"slug":"airy","intent":"space"}]',
    });
    cleanups.push(harness.repoRoot);
    harness.orchestrator.generate({
      repoRoot: harness.repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 2,
    });
    await until(
      () => harness.events.some((event) => event.kind === "run-complete"),
      "generate",
    );
    return harness;
  }

  it("keep: original ← variant (header stripped, imports rebased); set cleaned", async () => {
    const { repoRoot, orchestrator, events } = await landedHarness();
    const result = await orchestrator.resolve({
      repoRoot,
      appDir: "",
      base: BASE,
      action: "keep",
      slug: "compact",
    });
    expect(result.error).toBeUndefined();

    const original = await readFile(join(repoRoot, BASE_SRC), "utf8");
    expect(original).toContain("compact"); // variant content
    expect(original).not.toContain("designbook:variation"); // header stripped
    // ../../src/components/ui/button rebased for src/composite/product/variants/.
    expect(original).toContain('from "../../../components/ui/button"');

    expect(existsSync(join(repoRoot, variantSourcePath("", BASE, "compact"))))
      .toBe(false);
    expect(existsSync(join(repoRoot, variantSourcePath("", BASE, "airy"))))
      .toBe(false);
    expect(existsSync(join(repoRoot, variationsIndexFile("")))).toBe(false);
    expect((await orchestrator.status(repoRoot, "")).sets).toHaveLength(0);
    expect(
      events.some(
        (event) => event.kind === "resolved" && event.action === "keep",
      ),
    ).toBe(true);
  });

  it("keepAs: promotes under the user-chosen name; the rest stays pending", async () => {
    const { repoRoot, orchestrator } = await landedHarness();
    const bad = await orchestrator.resolve({
      repoRoot,
      appDir: "",
      base: BASE,
      action: "keepAs",
      slug: "compact",
      newName: "not pascal",
    });
    expect(bad.error).toMatch(/PascalCase/);

    const result = await orchestrator.resolve({
      repoRoot,
      appDir: "",
      base: BASE,
      action: "keepAs",
      slug: "compact",
      newName: "CardCompact",
    });
    expect(result.error).toBeUndefined();

    const promoted = await readFile(
      join(repoRoot, "src/composite/product/variants/CardCompact.tsx"),
      "utf8",
    );
    expect(promoted).toContain("export function CardCompact()");
    expect(promoted).toContain('from "../../../components/ui/button"');
    // Original untouched; the other variant still pending in the index.
    expect(await readFile(join(repoRoot, BASE_SRC), "utf8")).toBe(
      ORIGINAL_SOURCE,
    );
    const index = parseVariationsIndex(
      await readFile(join(repoRoot, variationsIndexFile("")), "utf8"),
    );
    expect(index.map((record) => record.slug)).toEqual(["airy"]);

    // Promoting onto an existing file is refused.
    const clash = await orchestrator.resolve({
      repoRoot,
      appDir: "",
      base: BASE,
      action: "keepAs",
      slug: "airy",
      newName: "CardCompact",
    });
    expect(clash.status).toBe(409);
  });

  it("discard removes one; abandon removes the set", async () => {
    const { repoRoot, orchestrator } = await landedHarness();
    await orchestrator.resolve({
      repoRoot,
      appDir: "",
      base: BASE,
      action: "discard",
      slug: "compact",
    });
    expect(existsSync(join(repoRoot, variantSourcePath("", BASE, "compact"))))
      .toBe(false);
    expect(existsSync(join(repoRoot, variantSourcePath("", BASE, "airy"))))
      .toBe(true);

    await orchestrator.resolve({ repoRoot, appDir: "", base: BASE, action: "abandon" });
    expect(existsSync(join(repoRoot, variantSourcePath("", BASE, "airy"))))
      .toBe(false);
    expect(existsSync(join(repoRoot, variationsIndexFile("")))).toBe(false);
  });

  it("404s on unknown sets/slugs", async () => {
    const { repoRoot, orchestrator } = await makeHarness();
    cleanups.push(repoRoot);
    const unknown = await orchestrator.resolve({
      repoRoot,
      appDir: "",
      base: "nope.Missing",
      action: "abandon",
    });
    expect(unknown.status).toBe(404);
  });
});

describe("orchestrator: reconstruction from the durable index", () => {
  it("status() revives sets written by a previous process", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "db-variations-"));
    cleanups.push(repoRoot);
    const record: VariationRecord = {
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      slug: "compact",
      intent: "denser",
      sourcePath: variantSourcePath("", BASE, "compact"),
    };
    await mkdir(join(repoRoot, VARIATIONS_DIR), { recursive: true });
    await writeFile(
      join(repoRoot, variationsIndexFile("")),
      serializeVariationsIndex([record]),
      "utf8",
    );

    const orchestrator = createVariationsOrchestrator({
      runTurn: async () => ({ text: "" }),
      broadcast: () => {},
      log: () => {},
    });
    const { sets } = await orchestrator.status(repoRoot, "");
    expect(sets).toHaveLength(1);
    expect(sets[0].base).toBe(BASE);
    expect(sets[0].items[0]).toMatchObject({
      slug: "compact",
      status: "landed",
      rev: 1,
    });
    expect(sets[0].items[0].absPath).toBe(
      join(repoRoot, record.sourcePath),
    );
  });
});

describe("path base: monorepo (configDir under the git root)", () => {
  const APP_DIR = "examples/demo";
  const MONO_BASE_SRC = `${APP_DIR}/src/composite/product/variants/Card.tsx`;

  it("pure helpers put the home under the app dir; single-repo unchanged", () => {
    expect(variationsDir("")).toBe(".designbook/variations");
    expect(variationsDir(APP_DIR)).toBe("examples/demo/.designbook/variations");
    expect(variationsIndexFile(APP_DIR)).toBe(
      "examples/demo/.designbook/variations/index.ts",
    );
    expect(variantSourcePath(APP_DIR, BASE, "compact")).toBe(
      "examples/demo/.designbook/variations/product.ProductCard.compact.tsx",
    );
    // Containment respects the base: a git-root path is NOT in the app home.
    expect(
      isVariationsPath(".designbook/variations/x.tsx", APP_DIR),
    ).toBe(false);
    expect(
      isVariationsPath(
        "examples/demo/.designbook/variations/x.tsx",
        APP_DIR,
      ),
    ).toBe(true);
    // appDir sanitation.
    expect(normalizeAppDir("")).toBe("");
    expect(normalizeAppDir("examples/demo")).toBe("examples/demo");
    expect(normalizeAppDir("examples\\demo")).toBe("examples/demo");
    expect(normalizeAppDir("a/../b")).toBeUndefined();
    expect(normalizeAppDir("..")).toBeUndefined();
  });

  it("prompt target, verifier, files, and index all share the app-dir base", async () => {
    const prompts: string[] = [];
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply: '[{"slug":"compact","intent":"denser"}]',
      baseSrc: MONO_BASE_SRC,
      onTurn: (params) => prompts.push(params.prompt),
    });
    cleanups.push(repoRoot);
    expect(
      orchestrator.generate({
        repoRoot,
        appDir: APP_DIR,
        baseEntryId: BASE,
        baseSourcePath: MONO_BASE_SRC,
        count: 1,
      }).error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.kind === "run-complete"),
      "run-complete",
    );

    // SEAM PIN: the harness writes ONLY at the path the prompt names — a
    // landed event proves the verifier looked exactly where the prompt
    // pointed, in the monorepo shape.
    const landed = events.find((event) => event.kind === "landed")!;
    const target = variantSourcePath(APP_DIR, BASE, "compact");
    expect(landed.path).toBe(target);
    expect(landed.absPath).toBe(join(repoRoot, target));
    expect(existsSync(join(repoRoot, target))).toBe(true);
    expect(
      existsSync(join(repoRoot, variationsIndexFile(APP_DIR))),
    ).toBe(true);
    // NOTHING lands at the git root — the exact monorepo stray-dir failure.
    expect(existsSync(join(repoRoot, ".designbook"))).toBe(false);

    const variantPrompt = prompts.find((prompt) =>
      prompt.includes("EXACTLY this file"),
    )!;
    expect(variantPrompt).toContain(`EXACTLY this file: ${target}`);
    // Import hints are computed from the REAL depth, not a hardcoded ../..
    expect(variantPrompt).toContain(
      '"../../src/composite/product/variants/Card"',
    );
    expect(variantPrompt).toContain('"../../../../<path>"');
  });

  it("keep promotes across the app-dir base (imports rebased, home cleaned)", async () => {
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply: '[{"slug":"compact","intent":"denser"}]',
      baseSrc: MONO_BASE_SRC,
    });
    cleanups.push(repoRoot);
    orchestrator.generate({
      repoRoot,
      appDir: APP_DIR,
      baseEntryId: BASE,
      baseSourcePath: MONO_BASE_SRC,
      count: 1,
    });
    await until(
      () => events.some((event) => event.kind === "run-complete"),
      "generate",
    );
    const result = await orchestrator.resolve({
      repoRoot,
      appDir: APP_DIR,
      base: BASE,
      action: "keep",
      slug: "compact",
    });
    expect(result.error).toBeUndefined();
    const original = await readFile(join(repoRoot, MONO_BASE_SRC), "utf8");
    expect(original).toContain("compact");
    // ../../src/components/ui/button (from the app-dir home) rebased for
    // examples/demo/src/composite/product/variants/.
    expect(original).toContain('from "../../../components/ui/button"');
    expect(
      existsSync(join(repoRoot, variationsIndexFile(APP_DIR))),
    ).toBe(false);
  });

  it("buildVariantPrompt computes the import prefix for the single-repo base too", () => {
    const prompt = buildVariantPrompt({
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      targetPath: variantSourcePath("", BASE, "compact"),
      slug: "compact",
      intent: "denser",
    });
    expect(prompt).toContain('"../../<path>"');
    expect(prompt).toContain(
      '"../../src/composite/product/variants/Card"',
    );
  });
});

describe("failure diagnostics (why is never invisible)", () => {
  it("surfaces the turn-level errorMessage (provider quota/auth) verbatim", async () => {
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply: '[{"slug":"compact","intent":"denser"}]',
      turnErrorMessage:
        '400 {"type":"error","error":{"message":"You\'re out of extra usage."}}',
    });
    cleanups.push(repoRoot);
    orchestrator.generate({
      repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 1,
    });
    await until(
      () => events.some((event) => event.kind === "failed"),
      "failed",
    );
    const failed = events.find((event) => event.kind === "failed")!;
    expect(failed.error).toContain("out of extra usage");
    expect(failed.error).toContain("the agent turn failed");
    expect(failed.error).not.toContain("without writing");
    // The expected target rides along for the failed cell.
    expect(failed.path).toBe(variantSourcePath("", BASE, "compact"));
  });

  it("names the expected target and quotes the assistant when no file lands", async () => {
    const { repoRoot, events, orchestrator } = await makeHarness({
      directorReply: '[{"slug":"compact","intent":"denser"}]',
      failSlugs: ["compact"],
      turnText: "I looked around but could not find the original file.",
    });
    cleanups.push(repoRoot);
    orchestrator.generate({
      repoRoot,
      appDir: "",
      baseEntryId: BASE,
      baseSourcePath: BASE_SRC,
      count: 1,
    });
    await until(
      () => events.some((event) => event.kind === "failed"),
      "failed",
    );
    const failed = events.find((event) => event.kind === "failed")!;
    expect(failed.error).toContain(
      `without writing ${variantSourcePath("", BASE, "compact")}`,
    );
    expect(failed.error).toContain(
      'the agent said: "I looked around but could not find',
    );
    expect(failed.path).toBe(variantSourcePath("", BASE, "compact"));
  });

  it("extractTurnErrorMessage reads only the LAST assistant message", () => {
    expect(
      extractTurnErrorMessage([
        { role: "user", content: "go" },
        { role: "assistant", stopReason: "error", errorMessage: "429 quota" },
      ]),
    ).toBe("429 quota");
    expect(
      extractTurnErrorMessage([
        { role: "assistant", stopReason: "error", errorMessage: "flaky" },
        { role: "assistant", stopReason: "stop", content: "recovered" },
      ]),
    ).toBeUndefined();
    expect(
      extractTurnErrorMessage([
        { role: "assistant", stopReason: "error" },
      ]),
    ).toBe("the model turn errored");
    expect(extractTurnErrorMessage([{ role: "user", content: "q" }]))
      .toBeUndefined();
  });

  it("truncateDiagnostic flattens whitespace and bounds length", () => {
    expect(truncateDiagnostic("a\n  b\t c")).toBe("a b c");
    const long = truncateDiagnostic("x".repeat(1000));
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Seam guards (source scans).
// ---------------------------------------------------------------------------

describe("write-confinement + endpoint seams", () => {
  const variationsSource = readFileSync(join(here, "variations.ts"), "utf8");
  const apiSource = readFileSync(join(here, "api.ts"), "utf8");

  it("generation targets come only from variantSourcePath (inside VARIATIONS_DIR)", () => {
    // The only sourcePath assignment for generated items is the helper call.
    expect(variationsSource).toContain(
      "sourcePath: variantSourcePath(appDir, baseEntryId, slug)",
    );
    expect(variationsSource).toContain(
      'return `${variationsDir(appDir)}/${baseEntryId}.${slug}.tsx`;',
    );
  });

  it("deletions are guarded by isVariationsPath", () => {
    const deleteChunk = variationsSource.slice(
      variationsSource.indexOf("async function deleteItems"),
      variationsSource.indexOf("async function resolveSet"),
    );
    expect(deleteChunk).toContain("if (!isVariationsPath(item.sourcePath, set.appDir)) continue;");
  });

  it("api.ts variations handlers resolve their root via activeRepoRoot()", () => {
    for (const handler of [
      "handleVariationsStatus",
      "handleVariationsGenerate",
      "handleVariationsIterate",
      "handleVariationsResolve",
    ]) {
      const start = apiSource.indexOf(`async function ${handler}`);
      expect(start, `${handler} present`).toBeGreaterThan(-1);
      const chunk = apiSource.slice(start, start + 1600);
      expect(chunk, `${handler} uses activeRepoRoot()`).toContain(
        "activeRepoRoot()",
      );
    }
  });

  it("ephemeral variation sessions are restricted and never broadcast pi-events", () => {
    const start = apiSource.indexOf("async function runVariationTurn");
    const chunk = apiSource.slice(start, apiSource.indexOf("const variations ="));
    expect(chunk).toContain("READ_ONLY_TOOL_NAMES : VARIANT_TOOL_NAMES");
    expect(chunk).toContain("session.subscribe(logPiEvent)");
    expect(chunk).not.toContain("broadcast(");
    expect(chunk).toContain("session.dispose()");
    // Turn-level failures MUST be surfaced (quota/auth errors resolve prompt()).
    expect(chunk).toContain("extractTurnErrorMessage(");
    expect(apiSource).toContain(
      'const VARIANT_TOOL_NAMES = [...READ_ONLY_TOOL_NAMES, "write", "edit"];',
    );
  });

  it("all variations write endpoints are blocked in --read-only mode", () => {
    for (const route of [
      "POST /api/variations/generate",
      "POST /api/variations/iterate",
      "POST /api/variations/retry",
      "POST /api/variations/resolve",
    ]) {
      expect(READ_ONLY_BLOCKED_ROUTES.has(route), route).toBe(true);
    }
  });
});
