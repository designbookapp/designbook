/// <reference lib="dom" />

/**
 * Public "text adapter" API. A text adapter teaches the canvas text tool how to
 * attribute a rendered text node back to its source of truth (an i18n catalog,
 * a plain string literal in a `.tsx` file, …) and how to persist edits.
 *
 * Adapters are browser code — the config file that lists them is evaluated in
 * the workbench via a virtual module, so an adapter may touch the DOM, `fetch`
 * the designbook API, and hold in-memory state.
 *
 * The canvas runs the configured adapters as an ordered chain; the first one to
 * claim a text node wins. Designbook ships two adapters:
 *   - `i18nextAdapter` — keyed i18next catalog editing (marker attribution,
 *     rich placeholder/plural editor, live language switching);
 *   - `sourceLiteralAdapter` — a built-in fallback that edits unique plain
 *     string literals directly in their source file.
 *
 * Import the shipped adapters from `@designbookapp/designbook/adapters`; import these types
 * from `@designbookapp/designbook/config`.
 */

import type { ComponentType, ReactNode } from "react";
import type { LanguageOption } from "./index.ts";

/**
 * A rendered text node the tool is asking adapters to claim, plus the fiber
 * attribution the canvas resolved for it.
 */
type TextNodeHit = {
  /** The element under the pointer, inside the canvas stage. */
  element: HTMLElement;
  /** The canvas stage element; adapters may walk ancestors up to (not including) it. */
  boundary: HTMLElement | null;
  /** The primary text node under the pointer, if the element has one. */
  node: Text | null;
  /** Visible text of `element`, adapter markers stripped and trimmed. */
  text: string;
  /** Screen-space bounding rect of `element`. */
  rect: DOMRect;
  /** Owning component's repo-relative source path, when resolvable via the React fiber tree. */
  sourcePath?: string;
  /** Owning component's display label. */
  componentName?: string;
};

/** A plural-suffixed sibling of a keyed entry (e.g. `_one`, `_other`). */
type PluralForm = { key: string; suffix: string; value: string };

/** Placeholder metadata surfaced in the rich keyed editor. */
type PlaceholderMeta = { name: string; example?: string; description?: string };

/**
 * An adapter's claim over a text node: the display value, how to persist edits,
 * and — for keyed claims — the extra capabilities the rich editor uses.
 */
type TextClaim = {
  /** `name` of the adapter that produced the claim. */
  adapter: string;
  /** Display value, markers stripped. */
  value: string;
  kind: "keyed" | "literal";
  /** keyed: the resolved i18n key for this node. */
  key?: string;
  namespace?: string;
  /** File the save writes to (repo/config-relative, adapter-defined). */
  editPath: string;
  /** literal: 1-based line of the matched literal in `editPath`. */
  line?: number;
  /** DOM node the claim anchors to; defaults to the hit's node. */
  node?: Text;
  /** Element used for the highlight/inline edit; defaults to the hit's element. */
  element?: HTMLElement;
  /** Screen-space rect used to anchor the highlight/editor; defaults to the hit's rect. */
  rect?: DOMRect;
  /** Small label shown on hover; defaults to `key`. */
  label?: string;
  /** Persist a single new value. Should reject on failure. */
  save: (next: string) => Promise<void>;
  /** keyed: the raw template (placeholders visible) for a key. */
  getTemplate?: (key: string) => string | undefined;
  /** keyed: plural sibling entries; absent/empty means "not pluralized". */
  pluralForms?: PluralForm[];
  /** keyed: placeholder metadata for the editor's placeholder tray. */
  placeholders?: PlaceholderMeta[];
  /** keyed: persist several entries at once (plurals). Falls back to `save`. */
  saveEntries?: (
    entries: Array<{ key: string; value: string }>,
  ) => Promise<void>;
  /** Optimistically update in-memory state before persistence resolves. */
  updateLocal?: (entries: Array<{ key: string; value: string }>) => void;
};

/** Locale plumbing an adapter that owns language state returns from `setup()`. */
type AdapterLocaleSetup = {
  /** Wrapped around everything on the canvas (e.g. an i18next provider). */
  Provider?: ComponentType<{ children: ReactNode }>;
  /** Switch the active locale. */
  setLocale?: (locale: string) => Promise<void>;
  /** Languages offered in the canvas settings bar. */
  languages?: LanguageOption[];
  /** Locale selected at startup. */
  defaultLocale?: string;
};

/**
 * The active canvas context: a flat map of namespaced dimension id → selected
 * value (e.g. `{ "i18next:locale": "fr-FR", "flags:tenant": "acme" }`). The
 * runtime namespaces each adapter dimension as `"<adapter.name>:<id>"`.
 */
type ContextState = Record<string, string>;

/**
 * A context selector an adapter contributes to the canvas settings bar (e.g.
 * locale, tenant). Choosing a value narrows the source of truth every other
 * capability reads/writes against.
 */
type ContextDimension = {
  /** Unique within the adapter; the runtime namespaces it as `<adapter>:<id>`. */
  id: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue: string;
  /** How the selector renders. Defaults to a dropdown. */
  control?: "select" | "segmented" | "toggle";
};

/**
 * A single editable value surfaced in an adapter tab. READ (`value`) + WRITE
 * (`save`) over a source of truth, scoped by the active context.
 */
type EditableField = {
  id: string;
  label: string;
  control: "toggle" | "select" | "text" | "color" | "number";
  options?: { value: string; label: string }[];
  /** Current resolved value (optimistically updated by the panel on edit). */
  value: string | boolean;
  /** Persist a new value. Should reject on failure so the panel can roll back. */
  save: (next: string | boolean) => Promise<void>;
};

/**
 * A button an adapter contributes to the bottom of its tab (e.g. "Sync to
 * Figma"). Generic: the panel renders it, optionally polling `isEnabled` to
 * gate the button, and shows the string `run` resolves to (or its rejection).
 */
type AdapterTabAction = {
  id: string;
  label: string;
  /** Optional hint shown under the action row. */
  description?: string;
  /** Polled (~every few seconds) to gate the button; absent = always enabled. */
  isEnabled?: () => boolean | Promise<boolean>;
  /** Runs the action; the resolved string is shown inline as the result. */
  run: () => Promise<string>;
};

/**
 * An editable-field tab an adapter contributes to the side rail. `fields`
 * resolves the tab's fields for the active context (may be async). `actions`
 * are optional buttons rendered beneath the fields.
 */
type AdapterTab = {
  id: string;
  label: string;
  /** Icon name mapped to a lucide icon by the side rail (e.g. "flag"). */
  icon?: string;
  fields: (ctx: ContextState) => EditableField[] | Promise<EditableField[]>;
  /** Optional action buttons (e.g. Sync to/from Figma). */
  actions?: AdapterTabAction[];
};

/**
 * What an adapter's `setup()` contributes to the generalized runtime: a
 * context provider, context dimensions, editable-field tabs, and change hooks.
 * The legacy locale fields remain for back-compat, but new adapters should use
 * a `locale` dimension instead.
 */
type AdapterSetup = {
  /**
   * Wrapped around the canvas preview, receiving the live context and the
   * per-adapter resolved values (namespaced by adapter name).
   */
  Provider?: ComponentType<{
    context: ContextState;
    values: Record<string, unknown>;
    children: ReactNode;
  }>;
  dimensions?: ContextDimension[];
  tabs?: AdapterTab[];
  /** The adapter's current resolved values for the active context (fed to `Provider`). */
  getValues?: (ctx: ContextState) => unknown;
  /** Called when one of this adapter's dimensions changes (id is un-namespaced). */
  onContextChange?: (
    id: string,
    value: string,
    ctx: ContextState,
  ) => void | Promise<void>;
  // Back-compat locale fields (prefer a `locale` dimension):
  languages?: LanguageOption[];
  setLocale?: (locale: string) => Promise<void>;
  defaultLocale?: string;
};

/**
 * The generalized adapter: a named capability that may contribute context
 * (via `setup`) and/or claim rendered text (`resolveText`). A `TextAdapter` is
 * a valid `Adapter`.
 */
type Adapter = {
  name: string;
  /** Called once at canvas boot; contributes providers, dimensions, tabs. */
  setup?: () => Promise<AdapterSetup | void>;
  /** Claim a rendered text node, or return `null`/omit for context-only adapters. */
  resolveText?: TextAdapter["resolveText"];
  /** Synchronous, side-effect-free variant used for the hover highlight. */
  previewText?: TextAdapter["previewText"];
};

type TextAdapter = {
  name: string;
  /** Called once at canvas boot; may contribute providers/dimensions/tabs. */
  setup?: () => Promise<AdapterSetup | void>;
  /** Claim a rendered text node, or return `null` to pass it to the next adapter. */
  resolveText: (
    hit: TextNodeHit,
  ) => TextClaim | Promise<TextClaim | null> | null;
  /**
   * Optional synchronous, side-effect-free variant used only for the hover
   * highlight (which fires on every pointer move). Adapters whose `resolveText`
   * is async (e.g. fetches source) implement this to light up on hover without
   * doing I/O; omit it to simply not participate in hover highlighting.
   */
  previewText?: (hit: TextNodeHit) => TextClaim | null;
};

export type {
  Adapter,
  AdapterLocaleSetup,
  AdapterSetup,
  AdapterTab,
  AdapterTabAction,
  ContextDimension,
  ContextState,
  EditableField,
  PlaceholderMeta,
  PluralForm,
  TextAdapter,
  TextClaim,
  TextNodeHit,
};
