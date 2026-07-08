/**
 * The `text` model's shared claim-resolution + save pipeline.
 *
 * Three surfaces edit i18n/literal text — the canvas text tool
 * (`TextToolOverlay`), the live-page text tool (`PageTextTool`), and the
 * App-page frame text tool (`AppFrameTextOverlay`). Each used to re-implement
 * the SAME four steps: build a `TextNodeHit` from a DOM element, resolve it to
 * a `TextClaim` through the adapter chain, decide whether an inline edit of a
 * keyed claim must escalate to the popover (plurals), and route saves. This
 * module is the ONE home for that pipeline; the surfaces keep only their
 * genuinely surface-specific geometry/overlay/DOM-capture code (the "layout").
 *
 * `createTextModel` is a pure factory (no React, no ambient globals) so it is
 * unit-testable in this package's node vitest env and cell-renderable without a
 * real app:
 *   - LIVE use: pass a `runtime` (the adapter runtime) — resolution goes through
 *     the adapter chain, and each resolved claim's persistence is wrapped by the
 *     surface-supplied `decorateSave` (canvas: none; page: push into the live
 *     i18n instance; frame: flush-then-reload).
 *   - FIXTURE use: pass `data` (canonical claims from `fixtures.ts`) — resolution
 *     matches against that hardcoded set, no adapters, no DOM I/O.
 *
 * The React `TextProvider` (TextProvider.tsx) wraps this in context so surfaces
 * and atoms consume it declaratively; tests call `createTextModel` directly.
 */

import { hitTest, stripMarkers } from "@designbook-ui/previewHost";
import {
  registryByName,
  registryByRef,
} from "@designbook-ui/models/catalog/componentRegistry";
import type { TextClaim, TextNodeHit } from "@designbookapp/designbook/config";

/** A single new/updated entry the popover or an atom persists. */
type TextEntry = { key: string; value: string };

/**
 * Wraps a resolved claim's persistence with a surface side effect (the ONLY
 * legitimately per-surface part of the save path): canvas uses none, the live
 * page pushes the saved value into the app's running i18n instance, the frame
 * flushes the target dev-server's module cache then reloads the frame. Surfaces
 * supply this; the model applies it to every claim it resolves so downstream
 * (popover, inline edit) just call `claim.save`/`claim.saveEntries`.
 */
type SaveDecorator = (claim: TextClaim) => TextClaim;

/** No-op decorator (canvas — saves straight through the adapter). */
const identitySave: SaveDecorator = (claim) => claim;

/**
 * The live resolution surface the model needs from the adapter runtime —
 * narrowed to just the two claim methods so the model neither imports nor is
 * coupled to the full `AdapterRuntime`.
 */
type TextRuntime = {
  resolveClaim: (hit: TextNodeHit) => Promise<TextClaim | null>;
  previewClaim: (hit: TextNodeHit) => TextClaim | null;
};

/** Canonical fixture data fed via the Provider's `data` prop (tests + cells). */
type TextData = {
  /** The hardcoded claims this model resolves against. */
  claims: TextClaim[];
  /**
   * Optional custom hit→claim resolver; defaults to `matchClaim` (element, then
   * node, then stripped-text identity against `claims`).
   */
  resolve?: (hit: TextNodeHit, claims: TextClaim[]) => TextClaim | null;
};

/**
 * The shared inline-commit decision (canvas + frame): a keyed claim with plural
 * forms can't be fully represented by its single on-screen (singular) node, so
 * an inline edit of it escalates to the popover pre-filled with the typed value
 * instead of saving directly. Everything else commits straight to the adapter.
 * The surface still owns WHERE the popover anchors (its own geometry) — this is
 * only the escalate/save decision + the pre-fill.
 */
type InlineCommitPlan =
  | { escalate: false }
  | { escalate: true; initialValues?: Record<string, string> };

/** The text model surface exposed on context and returned by the factory. */
type TextModel = {
  /**
   * Known claims — the fixture set in `data` mode (decorated), empty in live
   * pointer-driven use (where claims are resolved on demand from hits).
   */
  claims: TextClaim[];
  /**
   * Build a `TextNodeHit` from the element under the pointer. `boundary` is the
   * canvas stage element (adapters walk ancestors up to it); page/frame pass
   * `null`. DOM-touching — not exercised by the node unit tests.
   */
  buildHit: (target: HTMLElement, boundary?: HTMLElement | null) => TextNodeHit;
  /** Sync, side-effect-free resolve for the hover highlight. */
  previewHit: (hit: TextNodeHit) => TextClaim | null;
  /**
   * Async resolve for a click. The returned claim's `save`/`saveEntries` are
   * already wrapped by the surface's `decorateSave`, so callers persist without
   * re-wrapping.
   */
  resolveHit: (hit: TextNodeHit) => Promise<TextClaim | null>;
  /** Persist a single value through the claim's (decorated) save. */
  save: (claim: TextClaim, value: string) => Promise<void>;
  /**
   * Persist several entries (plurals) through the claim's (decorated)
   * `saveEntries`, falling back to `save` when the adapter offers only one.
   */
  saveEntries: (claim: TextClaim, entries: TextEntry[]) => Promise<void>;
  /** The shared inline-commit escalate/save decision (see `InlineCommitPlan`). */
  planInlineCommit: (claim: TextClaim, value: string) => InlineCommitPlan;
};

type CreateTextModelOptions = {
  /**
   * Live adapter resolution. Required unless `data` is given. May be a thunk so
   * the runtime is looked up LAZILY (on the first hover/click), not at model
   * construction — the page-tools layer mounts its `TextProvider` before the
   * adapter runtime singleton finishes initializing, so an eager lookup there
   * would throw. A live surface passes `getAdapterRuntime` itself.
   */
  runtime?: TextRuntime | (() => TextRuntime);
  /** Fixture claims — when present, resolution ignores `runtime`. */
  data?: TextData;
  /** Per-surface save side effect. Defaults to none (canvas). */
  decorateSave?: SaveDecorator;
};

function firstTextNode(el: Element): Text | null {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      return child as Text;
    }
  }
  return null;
}

/**
 * DOM element → `TextNodeHit`, identical across all three surfaces bar the
 * `boundary` (canvas stage vs. none). Shared here so the surfaces don't each
 * carry their own copy.
 */
function buildHit(
  target: HTMLElement,
  boundary: HTMLElement | null = null,
): TextNodeHit {
  const fiberHit = hitTest(target, registryByRef, registryByName);
  return {
    element: target,
    boundary,
    node: firstTextNode(target),
    text: stripMarkers(target.textContent ?? "").trim(),
    rect: target.getBoundingClientRect(),
    sourcePath: fiberHit?.entry.sourcePath,
    componentName: fiberHit?.entry.label,
  };
}

/**
 * Default fixture resolver: match a hit to a claim by element identity, then by
 * text node, then by stripped visible text. Enough for cells (a rendered node)
 * and tests (a synthetic hit whose `text` equals a claim's `value`).
 */
function matchClaim(claims: TextClaim[], hit: TextNodeHit): TextClaim | null {
  return (
    claims.find((claim) => claim.element && claim.element === hit.element) ??
    claims.find((claim) => claim.node && claim.node === hit.node) ??
    claims.find((claim) => claim.value === hit.text) ??
    null
  );
}

/** The shared plural-escalation decision — see `InlineCommitPlan`. */
function planInlineCommit(claim: TextClaim, value: string): InlineCommitPlan {
  if ((claim.pluralForms?.length ?? 0) > 0 && claim.element) {
    return {
      escalate: true,
      initialValues: claim.key ? { [claim.key]: value } : undefined,
    };
  }
  return { escalate: false };
}

function saveClaim(claim: TextClaim, value: string): Promise<void> {
  return claim.save(value);
}

function saveClaimEntries(
  claim: TextClaim,
  entries: TextEntry[],
): Promise<void> {
  if (claim.saveEntries) return claim.saveEntries(entries);
  return claim.save(entries[0]?.value ?? "");
}

/**
 * Build a text model. Pure — no React, no globals. See the module doc for the
 * live vs. fixture split.
 */
function createTextModel(options: CreateTextModelOptions): TextModel {
  const decorate = options.decorateSave ?? identitySave;
  const shared = {
    buildHit,
    save: saveClaim,
    saveEntries: saveClaimEntries,
    planInlineCommit,
  };

  if (options.data) {
    const claims = options.data.claims.map(decorate);
    const resolve = options.data.resolve
      ? (hit: TextNodeHit) => options.data!.resolve!(hit, claims)
      : (hit: TextNodeHit) => matchClaim(claims, hit);
    return {
      ...shared,
      claims,
      previewHit: resolve,
      resolveHit: async (hit) => resolve(hit),
    };
  }

  const runtimeOption = options.runtime;
  if (!runtimeOption) {
    throw new Error("createTextModel requires a `runtime` or `data`.");
  }
  // Resolve the runtime lazily so a thunk is not invoked until the first
  // hover/click (see `runtime` doc above).
  const getRuntime =
    typeof runtimeOption === "function" ? runtimeOption : () => runtimeOption;
  return {
    ...shared,
    claims: [],
    // Preview is hover-only and never persisted, so it is left undecorated
    // (matches every surface's pre-refactor behavior).
    previewHit: (hit) => getRuntime().previewClaim(hit),
    resolveHit: async (hit) => {
      const claim = await getRuntime().resolveClaim(hit);
      return claim ? decorate(claim) : null;
    },
  };
}

export {
  buildHit,
  createTextModel,
  identitySave,
  matchClaim,
  planInlineCommit,
};
export type {
  CreateTextModelOptions,
  InlineCommitPlan,
  SaveDecorator,
  TextData,
  TextEntry,
  TextModel,
  TextRuntime,
};
