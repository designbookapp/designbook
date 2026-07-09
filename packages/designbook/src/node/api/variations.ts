/**
 * Design-variations orchestrator (docs/specs/design-variations.md, DECIDED
 * 2026-07-09).
 *
 * N parallel EPHEMERAL Pi sessions each write one candidate implementation of
 * a selected component into `.designbook/variations/` — never anywhere else —
 * and the UI mounts each one the moment it lands (progressive `/@fs/` dynamic
 * import; no reload). This module owns:
 *
 *   - the DIRECTOR step: one model turn proposing N distinct direction briefs
 *     (fixed palette fallback when the call fails/parses badly);
 *   - the fan-out: per direction, one injected `runTurn` (api.ts binds it to
 *     an ephemeral restricted-tools session) with a narrow prompt naming
 *     EXACTLY one target file;
 *   - per-session landing verification (the file must exist at turn end) and
 *     the `variations-event` broadcasts the strip renders from;
 *   - the DURABLE RECORD `.designbook/variations/index.ts` (append-per-landing,
 *     serialized through a per-root write queue) — used only to reconstruct a
 *     review after a browser/server restart; live state is memory + events;
 *   - resolve semantics: keep (original ← variant, imports rebased), keepAs
 *     (promote next to the original under a USER-CHOSEN name), discard,
 *     abandon — all plain file ops, Changes-tab visible, never committed.
 *
 * Everything model-shaped is injected (`runTurn`), so the orchestrator state
 * machine tests run against fakes — no Pi SDK, no auth (the sessionRegistry
 * test pattern).
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";

/** Dir name of the variations home. NEVER conflate with
 * `.designbook/worktrees/` (git-excluded); variations are committable content.
 *
 * MONOREPO RULE (spec §A): the APP owns its variations. The home is
 * `<configDir>/.designbook/variations` — `appDir` is the config file's dir,
 * repo-root-relative posix ("" = config at repo root, which keeps single-repo
 * paths byte-identical to before). ONE canonical base for all five sites:
 * the session prompt's target path, the post-turn verifier, the /@fs dynamic
 * import (events carry absPath), the index.ts record, and resolve/promote. */
const VARIATIONS_DIR = ".designbook/variations";

/** Repo-relative variations home for an app dir. */
function variationsDir(appDir: string): string {
  return appDir ? `${appDir}/${VARIATIONS_DIR}` : VARIATIONS_DIR;
}

/** Repo-relative path of the durable index for an app dir. */
function variationsIndexFile(appDir: string): string {
  return `${variationsDir(appDir)}/index.ts`;
}

/** Sanitize a server-computed appDir: posix, repo-contained, "" allowed. */
function normalizeAppDir(raw: string): string | undefined {
  const appDir = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (appDir === "") return "";
  const segments = appDir.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) {
    return undefined;
  }
  return appDir;
}

const DEFAULT_COUNT = 3;
const MAX_COUNT = 5;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** One durable index record (mirrors the emitted index.ts entries). */
type VariationRecord = {
  baseEntryId: string;
  /** Repo-relative path of the ORIGINAL component file (promote target). */
  baseSourcePath: string;
  slug: string;
  intent: string;
  /** Repo-relative path of the variant file, inside VARIATIONS_DIR. */
  sourcePath: string;
};

type VariationItemStatus = "generating" | "landed" | "failed" | "updating";

/** Live per-variant state (memory + events; landed items also in the index). */
type VariationItem = {
  slug: string;
  intent: string;
  status: VariationItemStatus;
  sourcePath: string;
  /** Bumped on every landed/updated write — the UI's ?t= cache-bust key. */
  rev: number;
  error?: string;
};

type VariationSet = {
  baseEntryId: string;
  baseSourcePath: string;
  repoRoot: string;
  /** Config dir, repo-root-relative posix ("" = repo root) — see VARIATIONS_DIR. */
  appDir: string;
  /** True between generate() and the director's directions resolving. */
  planning: boolean;
  items: VariationItem[];
};

type ResolveAction = "keep" | "keepAs" | "discard" | "abandon";

/** One injected agent turn. `mode` picks the tool restriction in api.ts.
 * `errorMessage` MUST carry a turn-level failure (provider error, auth,
 * quota, aborted stream) — `session.prompt()` RESOLVES on those, so without
 * it the orchestrator can only report the useless "no file was written". */
type RunTurn = (params: {
  cwd: string;
  prompt: string;
  mode: "director" | "variant";
}) => Promise<{ text: string; errorMessage?: string }>;

type OrchestratorDeps = {
  runTurn: RunTurn;
  broadcast: (eventName: string, payload: unknown) => void;
  log: (message: string) => void;
};

// ---------------------------------------------------------------------------
// Pure helpers: naming, index serialization, promote transforms, prompts.
// ---------------------------------------------------------------------------

/** Direction one-liner → a short, filename-safe slug. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return slug || "variant";
}

/** Variant filename: `<baseEntryId>.<slug>.tsx` inside the variations home. */
function variantSourcePath(
  appDir: string,
  baseEntryId: string,
  slug: string,
): string {
  return `${variationsDir(appDir)}/${baseEntryId}.${slug}.tsx`;
}

/**
 * Emit `.designbook/variations/index.ts` — the DURABLE RECORD. Load thunks
 * (not eager re-exports) so one broken variant can't poison the whole index
 * import: per-cell fault isolation survives reconstruction.
 */
function serializeVariationsIndex(records: VariationRecord[]): string {
  const lines = [
    "// .designbook/variations/index.ts — maintained by designbook.",
    "// Durable record of pending design variations; safe to delete (abandons all).",
    "export const variations = [",
  ];
  for (const record of records) {
    const file = posix.basename(record.sourcePath);
    lines.push(
      "  {",
      `    baseEntryId: ${JSON.stringify(record.baseEntryId)},`,
      `    baseSourcePath: ${JSON.stringify(record.baseSourcePath)},`,
      `    slug: ${JSON.stringify(record.slug)},`,
      `    intent: ${JSON.stringify(record.intent)},`,
      `    sourcePath: ${JSON.stringify(record.sourcePath)},`,
      `    load: () => import(${JSON.stringify(`./${file}`)}),`,
      "  },",
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

/** Parse the records back out of the serializer's exact format. */
function parseVariationsIndex(source: string): VariationRecord[] {
  const records: VariationRecord[] = [];
  const block =
    /\{\s*baseEntryId: ("(?:[^"\\]|\\.)*"),\s*baseSourcePath: ("(?:[^"\\]|\\.)*"),\s*slug: ("(?:[^"\\]|\\.)*"),\s*intent: ("(?:[^"\\]|\\.)*"),\s*sourcePath: ("(?:[^"\\]|\\.)*"),/g;
  for (let match = block.exec(source); match; match = block.exec(source)) {
    records.push({
      baseEntryId: JSON.parse(match[1]) as string,
      baseSourcePath: JSON.parse(match[2]) as string,
      slug: JSON.parse(match[3]) as string,
      intent: JSON.parse(match[4]) as string,
      sourcePath: JSON.parse(match[5]) as string,
    });
  }
  return records;
}

/**
 * Rebase relative import/export specifiers when a variant file moves from
 * VARIATIONS_DIR into the component's own directory (keep / keepAs). Only
 * `./`-and-`../`-prefixed specifiers change; aliases and bare imports pass
 * through untouched.
 */
function rebaseRelativeImports(
  source: string,
  fromDir: string,
  toDir: string,
): string {
  return source.replace(
    /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']*)\2/g,
    (_whole, lead: string, quote: string, spec: string) => {
      const target = posix.resolve("/", fromDir, spec);
      let rebased = posix.relative(posix.resolve("/", toDir), target);
      if (!rebased.startsWith(".")) rebased = `./${rebased}`;
      return `${lead}${quote}${rebased}${quote}`;
    },
  );
}

/** Drop the leading designbook:variation provenance block comment, if any. */
function stripProvenanceHeader(source: string): string {
  return source.replace(
    /^\s*\/\*\*[^*]*designbook:variation[\s\S]*?\*\/\s*\n?/,
    "",
  );
}

/**
 * First component-ish export identifier. Covers inline exports
 * (`export function X` / `export const X`) AND the split declaration +
 * `export { X }` form (a real haiku-generated shape from live verification).
 */
function detectExportName(source: string): string | undefined {
  const inline = source.match(
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|const)\s+([A-Za-z][A-Za-z0-9_]*)/,
  )?.[1];
  if (inline) return inline;
  return source.match(/export\s*\{\s*([A-Za-z][A-Za-z0-9_]*)/)?.[1];
}

/** Word-boundary identifier rename (generated files only — not a refactor tool). */
function renameIdentifier(source: string, from: string, to: string): string {
  if (!from || from === to) return source;
  return source.replace(new RegExp(`\\b${from}\\b`, "g"), to);
}

/** Valid promoted-component name: PascalCase identifier. */
function isValidComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

/** Deterministic direction palette — the fallback when the director call fails. */
const FALLBACK_DIRECTIONS: Array<{ slug: string; intent: string }> = [
  { slug: "compact", intent: "denser layout: tighter spacing, smaller footprint" },
  { slug: "bold", intent: "stronger hierarchy: bigger emphasis, weightier type" },
  { slug: "minimal", intent: "stripped back: more whitespace, fewer decorations" },
  { slug: "editorial", intent: "type-led composition, magazine-like structure" },
  { slug: "playful", intent: "rounder, friendlier, more expressive detailing" },
];

function buildDirectorPrompt(params: {
  baseEntryId: string;
  baseSourcePath: string;
  count: number;
  direction?: string;
  context?: string;
}): string {
  const lines = [
    `Propose ${params.count} DISTINCT visual design directions for a variation exploration of the component "${params.baseEntryId}" (source file: ${params.baseSourcePath}).`,
    "Read the source file first so the directions fit what the component actually is.",
  ];
  if (params.direction) {
    lines.push(`Designer's direction hints: ${params.direction}`);
  }
  if (params.context) {
    lines.push("", "Selection context:", params.context);
  }
  lines.push(
    "",
    "Reply with ONLY a JSON array (no prose, no code fence), one object per direction:",
    '[{"slug": "short-kebab-slug", "intent": "one-line design intent"}, …]',
    "Slugs must be unique, lowercase kebab-case, max 24 chars. Directions must differ in LAYOUT/HIERARCHY/DENSITY/EMPHASIS — not just color.",
  );
  return lines.join("\n");
}

/** Parse the director's JSON reply; undefined → caller falls back to palette. */
function parseDirectorReply(
  text: string,
  count: number,
): Array<{ slug: string; intent: string }> | undefined {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const directions: Array<{ slug: string; intent: string }> = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const raw = entry as { slug?: unknown; intent?: unknown };
    if (typeof raw.intent !== "string" || !raw.intent.trim()) continue;
    const slug = slugify(
      typeof raw.slug === "string" && raw.slug.trim()
        ? raw.slug
        : raw.intent,
    );
    if (seen.has(slug)) continue;
    seen.add(slug);
    directions.push({ slug, intent: raw.intent.trim() });
    if (directions.length === count) break;
  }
  return directions.length === count ? directions : undefined;
}

function buildVariantPrompt(params: {
  baseEntryId: string;
  baseSourcePath: string;
  targetPath: string;
  slug: string;
  intent: string;
  direction?: string;
  context?: string;
  iterateNote?: string;
}): string {
  const lines: string[] = [];
  if (params.iterateNote) {
    lines.push(
      `Revise the design-variation file ${params.targetPath} (variation "${params.slug}" of the designbook component "${params.baseEntryId}", original source: ${params.baseSourcePath}).`,
      `Designer's note: ${params.iterateNote}`,
      "Read the variation file (and the original if needed) before editing.",
    );
  } else {
    lines.push(
      `Create ONE design variation of the designbook component "${params.baseEntryId}" using the variations skill.`,
      `Original source file: ${params.baseSourcePath} — read it first.`,
      `Design direction "${params.slug}": ${params.intent}`,
    );
    if (params.direction) {
      lines.push(`Designer's overall hints: ${params.direction}`);
    }
    lines.push(
      "",
      `Write the variation to EXACTLY this file: ${params.targetPath}`,
    );
  }
  if (params.context) {
    lines.push("", "Selection context:", params.context);
  }
  lines.push(
    "",
    "Hard rules:",
    `- Do not create, edit, or delete ANY file other than ${params.targetPath}.`,
    "- Exactly one exported React component, same export name and identical props contract as the original — it must render in the original's place.",
    `- Reuse the app's existing components/atoms, i18n keys, and design tokens. The file lives in ${posix.dirname(params.targetPath)}/, so a repo file <path> is imported as "${posix.relative(posix.dirname(params.targetPath), "") || "."}/<path>" — e.g. the original is "${posix.relative(posix.dirname(params.targetPath), params.baseSourcePath.replace(/\.[a-z]+$/, ""))}". Repo path aliases work as usual.`,
    `- First line: a provenance header comment: /** designbook:variation of ${params.baseSourcePath} — "${params.slug}": <one-line intent> */`,
    "- The component's ROOT must have intrinsic height: never size it solely via absolutely-positioned children (that collapses to an empty render). Overlays go on top of a normally-flowing base element.",
    "- Vary layout/hierarchy/density/emphasis per the direction — not just colors.",
  );
  return lines.join("\n");
}

/**
 * Last assistant message's text from a Pi session transcript (the director's
 * reply). Content is either a plain string or a content-part array.
 */
function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => part as { type?: string; text?: string })
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

/**
 * Turn-level failure from a Pi session transcript: the SDK RESOLVES
 * `session.prompt()` on provider errors (quota/auth/4xx/aborts) and only
 * records them on the assistant message (`stopReason: "error"` +
 * `errorMessage`). The last assistant message decides — a retried turn that
 * eventually succeeded is not a failure.
 */
function extractTurnErrorMessage(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "error") return undefined;
    return message.errorMessage ?? "the model turn errored";
  }
  return undefined;
}

/** Single-line, bounded text for failed-cell diagnostics ("why" must never
 * be invisible — but also never a wall of JSON). */
const DIAGNOSTIC_TEXT_LIMIT = 280;

function truncateDiagnostic(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DIAGNOSTIC_TEXT_LIMIT
    ? `${flat.slice(0, DIAGNOSTIC_TEXT_LIMIT - 1)}…`
    : flat;
}

// ---------------------------------------------------------------------------
// Path guards.
// ---------------------------------------------------------------------------

/** Containment: repo-relative, no escapes/absolutes; returns the abs path. */
function containedPath(repoRoot: string, relPath: string): string | undefined {
  if (!relPath || relPath.includes("\0") || relPath.startsWith("/")) {
    return undefined;
  }
  const absPath = resolve(repoRoot, relPath);
  const inside = relative(repoRoot, absPath);
  if (!inside || inside.startsWith("..") || inside.startsWith("/")) {
    return undefined;
  }
  return absPath;
}

function isVariationsPath(relPath: string, appDir: string): boolean {
  return relPath.startsWith(`${variationsDir(appDir)}/`);
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

function createVariationsOrchestrator(deps: OrchestratorDeps) {
  const { runTurn, broadcast, log } = deps;
  /** Live sets, keyed by baseEntryId. */
  const sets = new Map<string, VariationSet>();
  /** Per-index-file write queue (parallel landings serialize here). */
  const indexQueues = new Map<string, Promise<void>>();

  function emit(payload: Record<string, unknown>): void {
    broadcast("variations-event", payload);
  }

  function absItemPath(set: VariationSet, item: { sourcePath: string }) {
    return join(set.repoRoot, item.sourcePath);
  }

  /** Queue an index mutation for one index file (read-modify-write, serialized). */
  function withIndex(
    home: { repoRoot: string; appDir: string },
    mutate: (records: VariationRecord[]) => VariationRecord[],
  ): Promise<void> {
    const indexAbs = join(home.repoRoot, variationsIndexFile(home.appDir));
    const queued = (indexQueues.get(indexAbs) ?? Promise.resolve()).then(
      async () => {
        let records: VariationRecord[] = [];
        try {
          records = parseVariationsIndex(await readFile(indexAbs, "utf8"));
        } catch {
          // No index yet.
        }
        const next = mutate(records);
        if (next.length === 0) {
          await rm(indexAbs, { force: true });
          return;
        }
        await mkdir(dirname(indexAbs), { recursive: true });
        await writeFile(indexAbs, serializeVariationsIndex(next), "utf8");
      },
    );
    indexQueues.set(
      indexAbs,
      queued.catch((error: unknown) => {
        log(`variations index write failed: ${String(error)}`);
      }),
    );
    return queued;
  }

  async function fileExists(absPath: string): Promise<boolean> {
    try {
      return (await stat(absPath)).isFile();
    } catch {
      return false;
    }
  }

  /** One variant generation run (fan-out arm). */
  async function runGeneration(
    set: VariationSet,
    item: VariationItem,
    params: { direction?: string; context?: string },
  ): Promise<void> {
    const record: VariationRecord = {
      baseEntryId: set.baseEntryId,
      baseSourcePath: set.baseSourcePath,
      slug: item.slug,
      intent: item.intent,
      sourcePath: item.sourcePath,
    };
    try {
      const turn = await runTurn({
        cwd: set.repoRoot,
        mode: "variant",
        prompt: buildVariantPrompt({
          baseEntryId: set.baseEntryId,
          baseSourcePath: set.baseSourcePath,
          targetPath: item.sourcePath,
          slug: item.slug,
          intent: item.intent,
          direction: params.direction,
          context: params.context,
        }),
      });
      if (turn.errorMessage) {
        throw new Error(
          `the agent turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
        );
      }
      if (!(await fileExists(absItemPath(set, item)))) {
        const said = truncateDiagnostic(turn.text);
        throw new Error(
          `the session ended without writing ${item.sourcePath}` +
            (said ? ` — the agent said: "${said}"` : ""),
        );
      }
      await withIndex(set, (records) => [
        ...records.filter(
          (existing) =>
            !(
              existing.baseEntryId === record.baseEntryId &&
              existing.slug === record.slug
            ),
        ),
        record,
      ]);
      item.status = "landed";
      item.rev += 1;
      emit({
        kind: "landed",
        base: set.baseEntryId,
        slug: item.slug,
        intent: item.intent,
        path: item.sourcePath,
        absPath: absItemPath(set, item),
        rev: item.rev,
      });
      log(`variation landed: ${item.sourcePath}`);
    } catch (error) {
      item.status = "failed";
      item.error = error instanceof Error ? error.message : String(error);
      emit({
        kind: "failed",
        base: set.baseEntryId,
        slug: item.slug,
        // The expected target: a failed cell must show WHERE the file was
        // supposed to land, not just that it didn't.
        path: item.sourcePath,
        error: item.error,
      });
      log(`variation failed (${item.slug}): ${item.error}`);
    }
  }

  /** Director step → N distinct directions (palette fallback). */
  async function planDirections(
    set: VariationSet,
    count: number,
    params: { direction?: string; context?: string },
  ): Promise<Array<{ slug: string; intent: string }>> {
    try {
      const turn = await runTurn({
        cwd: set.repoRoot,
        mode: "director",
        prompt: buildDirectorPrompt({
          baseEntryId: set.baseEntryId,
          baseSourcePath: set.baseSourcePath,
          count,
          direction: params.direction,
          context: params.context,
        }),
      });
      if (turn.errorMessage) {
        log(
          `variations director turn failed (${truncateDiagnostic(turn.errorMessage)}); using palette fallback`,
        );
        return FALLBACK_DIRECTIONS.slice(0, count);
      }
      const directions = parseDirectorReply(turn.text, count);
      if (directions) return directions;
      log("variations director reply unparseable; using palette fallback");
    } catch (error) {
      log(`variations director call failed (${String(error)}); using palette fallback`);
    }
    return FALLBACK_DIRECTIONS.slice(0, count);
  }

  /**
   * Start a generation. Returns synchronously-known errors; the work itself
   * runs detached and reports through `variations-event`s.
   */
  function generate(params: {
    repoRoot: string;
    /** Config dir, repo-root-relative ("" = repo root) — the variations home. */
    appDir: string;
    baseEntryId: string;
    baseSourcePath: string;
    count?: number;
    direction?: string;
    context?: string;
  }): { error?: string } {
    const { repoRoot, baseEntryId, baseSourcePath } = params;
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) {
      return { error: "Invalid app dir." };
    }
    if (!baseEntryId || /[\s/\\]/.test(baseEntryId)) {
      return { error: "A valid baseEntryId is required." };
    }
    const baseAbs = containedPath(repoRoot, baseSourcePath);
    if (!baseAbs || isVariationsPath(baseSourcePath, appDir)) {
      return { error: "baseSourcePath must be a repo-relative component file." };
    }
    const existing = sets.get(baseEntryId);
    if (
      existing &&
      (existing.planning ||
        existing.items.some(
          (item) => item.status === "generating" || item.status === "updating",
        ))
    ) {
      return { error: "A variation run for this component is already in progress." };
    }
    const count = Math.max(
      1,
      Math.min(MAX_COUNT, params.count ?? DEFAULT_COUNT),
    );
    const set: VariationSet = {
      baseEntryId,
      baseSourcePath,
      repoRoot,
      appDir,
      planning: true,
      // Keep already-landed items (a second run ADDS to a reviewed set).
      items: existing ? existing.items.filter((i) => i.status === "landed") : [],
    };
    sets.set(baseEntryId, set);
    emit({ kind: "planning", base: baseEntryId, count });

    void (async () => {
      const directions = await planDirections(set, count, params);
      const taken = new Set(set.items.map((item) => item.slug));
      const items: VariationItem[] = [];
      for (const direction of directions) {
        let slug = direction.slug;
        let n = 2;
        while (taken.has(slug)) slug = `${direction.slug}-${n++}`;
        taken.add(slug);
        items.push({
          slug,
          intent: direction.intent,
          status: "generating",
          sourcePath: variantSourcePath(appDir, baseEntryId, slug),
          rev: 0,
        });
      }
      set.items.push(...items);
      set.planning = false;
      emit({
        kind: "planned",
        base: baseEntryId,
        items: items.map((item) => ({ slug: item.slug, intent: item.intent })),
      });
      await Promise.all(
        items.map((item) => runGeneration(set, item, params)),
      );
      emit({ kind: "run-complete", base: baseEntryId });
    })();
    return {};
  }

  /** Iterate on ONE landed variant (inline note → ephemeral session). */
  function iterate(params: {
    repoRoot: string;
    base: string;
    slug: string;
    note: string;
  }): { error?: string } {
    const set = sets.get(params.base);
    const item = set?.items.find((candidate) => candidate.slug === params.slug);
    if (!set || !item) return { error: "Unknown variation." };
    if (item.status !== "landed") {
      return { error: "Only a landed variation can be iterated on." };
    }
    if (!params.note.trim()) return { error: "A note is required." };
    item.status = "updating";
    emit({ kind: "updating", base: set.baseEntryId, slug: item.slug });
    void (async () => {
      try {
        const turn = await runTurn({
          cwd: set.repoRoot,
          mode: "variant",
          prompt: buildVariantPrompt({
            baseEntryId: set.baseEntryId,
            baseSourcePath: set.baseSourcePath,
            targetPath: item.sourcePath,
            slug: item.slug,
            intent: item.intent,
            iterateNote: params.note,
          }),
        });
        if (turn.errorMessage) {
          throw new Error(
            `the agent turn failed: ${truncateDiagnostic(turn.errorMessage)}`,
          );
        }
        if (!(await fileExists(absItemPath(set, item)))) {
          throw new Error(
            `the variation file ${item.sourcePath} disappeared during the edit`,
          );
        }
        item.status = "landed";
        item.rev += 1;
        emit({
          kind: "updated",
          base: set.baseEntryId,
          slug: item.slug,
          absPath: absItemPath(set, item),
          rev: item.rev,
        });
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : String(error);
        emit({
          kind: "failed",
          base: set.baseEntryId,
          slug: item.slug,
          path: item.sourcePath,
          error: item.error,
        });
      }
    })();
    return {};
  }

  /** Retry ONE failed variant (fresh session, same direction). */
  function retry(params: {
    base: string;
    slug: string;
  }): { error?: string } {
    const set = sets.get(params.base);
    const item = set?.items.find((candidate) => candidate.slug === params.slug);
    if (!set || !item) return { error: "Unknown variation." };
    if (item.status !== "failed") {
      return { error: "Only a failed variation can be retried." };
    }
    item.status = "generating";
    item.error = undefined;
    emit({
      kind: "planned",
      base: set.baseEntryId,
      items: [{ slug: item.slug, intent: item.intent }],
    });
    void runGeneration(set, item, {});
    return {};
  }

  /** Reconstruct a set from the durable index (server restarted mid-review). */
  async function reviveSet(
    repoRoot: string,
    appDir: string,
    baseEntryId: string,
  ): Promise<VariationSet | undefined> {
    const inMemory = sets.get(baseEntryId);
    if (inMemory) return inMemory;
    try {
      const records = parseVariationsIndex(
        await readFile(join(repoRoot, variationsIndexFile(appDir)), "utf8"),
      ).filter((record) => record.baseEntryId === baseEntryId);
      if (records.length === 0) return undefined;
      const set: VariationSet = {
        baseEntryId,
        baseSourcePath: records[0].baseSourcePath,
        repoRoot,
        appDir,
        planning: false,
        items: records.map((record) => ({
          slug: record.slug,
          intent: record.intent,
          status: "landed",
          sourcePath: record.sourcePath,
          rev: 1,
        })),
      };
      sets.set(baseEntryId, set);
      return set;
    } catch {
      return undefined;
    }
  }

  /** Read + transform a variant file for promotion. */
  async function promotedSource(
    set: VariationSet,
    item: VariationItem,
    targetRelPath: string,
    renameTo?: string,
  ): Promise<string> {
    const raw = await readFile(absItemPath(set, item), "utf8");
    let source = stripProvenanceHeader(raw);
    source = rebaseRelativeImports(
      source,
      posix.dirname(item.sourcePath),
      posix.dirname(targetRelPath),
    );
    if (renameTo) {
      const exportName = detectExportName(source);
      if (exportName) source = renameIdentifier(source, exportName, renameTo);
    }
    return source;
  }

  async function deleteItems(
    set: VariationSet,
    items: VariationItem[],
  ): Promise<void> {
    for (const item of items) {
      // Guard: only ever delete inside the variations home.
      if (!isVariationsPath(item.sourcePath, set.appDir)) continue;
      await rm(absItemPath(set, item), { force: true });
    }
    const gone = new Set(items.map((item) => item.slug));
    await withIndex(set, (records) =>
      records.filter(
        (record) =>
          record.baseEntryId !== set.baseEntryId || !gone.has(record.slug),
      ),
    );
    set.items = set.items.filter((item) => !gone.has(item.slug));
    if (set.items.length === 0) sets.delete(set.baseEntryId);
  }

  /** Resolve a review: keep / keepAs / discard / abandon. All file ops. */
  async function resolveSet(params: {
    repoRoot: string;
    appDir: string;
    base: string;
    action: ResolveAction;
    slug?: string;
    newName?: string;
  }): Promise<{ error?: string; status?: number }> {
    const appDir = normalizeAppDir(params.appDir);
    if (appDir === undefined) return { error: "Invalid app dir." };
    const set = await reviveSet(params.repoRoot, appDir, params.base);
    if (!set) return { error: "Unknown variation set.", status: 404 };
    const busy = set.planning ||
      set.items.some((item) => item.status === "generating" || item.status === "updating");

    if (params.action === "abandon") {
      await deleteItems(set, [...set.items]);
      emit({ kind: "resolved", base: params.base, action: "abandon" });
      return {};
    }

    const item = set.items.find((candidate) => candidate.slug === params.slug);
    if (!item) return { error: "Unknown variation.", status: 404 };

    if (params.action === "discard") {
      await deleteItems(set, [item]);
      emit({ kind: "resolved", base: params.base, action: "discard", slug: item.slug });
      return {};
    }

    if (item.status !== "landed") {
      return { error: "Only a landed variation can be kept." };
    }
    if (busy) {
      return { error: "Wait for in-flight variations before keeping one." };
    }

    if (params.action === "keep") {
      const targetAbs = containedPath(set.repoRoot, set.baseSourcePath);
      if (!targetAbs || isVariationsPath(set.baseSourcePath, set.appDir)) {
        return { error: "The original source path is invalid." };
      }
      const source = await promotedSource(set, item, set.baseSourcePath);
      await writeFile(targetAbs, source, "utf8");
      await deleteItems(set, [...set.items]);
      emit({ kind: "resolved", base: params.base, action: "keep", slug: item.slug });
      log(`variation kept: ${item.slug} -> ${set.baseSourcePath}`);
      return {};
    }

    // keepAs — promote under a USER-CHOSEN name next to the original (D4).
    const newName = params.newName ?? "";
    if (!isValidComponentName(newName)) {
      return { error: "A PascalCase component name is required." };
    }
    const targetRel = posix.join(
      posix.dirname(set.baseSourcePath),
      `${newName}.tsx`,
    );
    const targetAbs = containedPath(set.repoRoot, targetRel);
    if (!targetAbs) return { error: "The promoted path is invalid." };
    if (await fileExists(targetAbs)) {
      return { error: `${targetRel} already exists.`, status: 409 };
    }
    const source = await promotedSource(set, item, targetRel, newName);
    await writeFile(targetAbs, source, "utf8");
    await deleteItems(set, [item]);
    emit({
      kind: "resolved",
      base: params.base,
      action: "keepAs",
      slug: item.slug,
      path: targetRel,
    });
    log(`variation promoted: ${item.slug} -> ${targetRel}`);
    return {};
  }

  /** Live sets + index-only sets (reconstruction), for GET /api/variations. */
  async function status(repoRoot: string, rawAppDir: string): Promise<{
    sets: Array<{
      base: string;
      baseSourcePath: string;
      planning: boolean;
      items: Array<VariationItem & { absPath: string }>;
    }>;
  }> {
    // Revive anything present only in the index (reload/restart path).
    const appDir = normalizeAppDir(rawAppDir) ?? "";
    try {
      const records = parseVariationsIndex(
        await readFile(join(repoRoot, variationsIndexFile(appDir)), "utf8"),
      );
      for (const record of records) {
        if (!sets.has(record.baseEntryId)) {
          await reviveSet(repoRoot, appDir, record.baseEntryId);
        }
      }
    } catch {
      // No index — memory only.
    }
    return {
      sets: [...sets.values()]
        .filter((set) => set.repoRoot === repoRoot)
        .map((set) => ({
          base: set.baseEntryId,
          baseSourcePath: set.baseSourcePath,
          planning: set.planning,
          items: set.items.map((item) => ({
            ...item,
            absPath: absItemPath(set, item),
          })),
        })),
    };
  }

  return { generate, iterate, retry, resolve: resolveSet, status };
}

export {
  DEFAULT_COUNT,
  extractAssistantText,
  extractTurnErrorMessage,
  FALLBACK_DIRECTIONS,
  MAX_COUNT,
  VARIATIONS_DIR,
  buildDirectorPrompt,
  buildVariantPrompt,
  containedPath,
  createVariationsOrchestrator,
  detectExportName,
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
};
export type {
  ResolveAction,
  RunTurn,
  VariationItem,
  VariationRecord,
  VariationSet,
};
