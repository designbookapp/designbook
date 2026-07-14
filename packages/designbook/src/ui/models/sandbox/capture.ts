/**
 * Sandbox context capture (docs/specs/sandbox.md, D2).
 *
 * `captureSandboxContext` turns a live app-mode selection into the pin's
 * durable payload: the CODE TARGET (file + export name + instance path — the
 * pin's identity, never a DOM node) plus a JSON-safe snapshot of the runtime
 * context — live fiber props, consumed app contexts (context-scope walk), and
 * the adapter dimension state. Adapters are re-instantiated LIVE on the
 * canvas; app contexts are snapshot-stubbed from these sampled values.
 *
 * `captureValue` is the value-shaped sibling of `sampleValue` (same caps:
 * depth 3, 8 entries, 80-char strings) — it produces JSON-safe VALUES rather
 * than display strings, replacing anything non-serializable with a
 * `{ $unserializable: "<type hint>" }` marker the wrapper generator comments
 * out. Pure core + injected collectors, so tests never touch React internals.
 */

type CaptureOptions = {
  maxDepth?: number;
  maxEntries?: number;
  maxString?: number;
};

const CAPTURE_DEFAULTS: Required<CaptureOptions> = {
  maxDepth: 3,
  maxEntries: 8,
  maxString: 80,
};

/** Marker for values the wrapper generator must stub/comment, never inline. */
type UnserializableMarker = { $unserializable: string };

function marker(hint: string): UnserializableMarker {
  return { $unserializable: hint };
}

function isReactElement(value: object): boolean {
  return "$$typeof" in (value as Record<string, unknown>);
}

function isDomNode(value: object): value is { nodeName: string } {
  return typeof (value as { nodeType?: unknown }).nodeType === "number";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function capture(
  value: unknown,
  depth: number,
  options: Required<CaptureOptions>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return truncate(value, options.maxString);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : marker(`number ${String(value)}`);
  }
  if (typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (typeof value === "function") {
    const name = (value as { name?: string }).name;
    return marker(name ? `function ${name}` : "function");
  }
  if (typeof value === "bigint") return marker(`bigint ${String(value)}`);
  if (typeof value === "symbol") return marker("symbol");

  const obj = value as object;
  if (seen.has(obj)) return marker("circular");
  if (isReactElement(obj)) return marker("ReactElement");
  if (isDomNode(obj)) {
    return marker(`<${String(obj.nodeName).toLowerCase()}> element`);
  }
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Map) return marker(`Map(${obj.size})`);
  if (obj instanceof Set) return marker(`Set(${obj.size})`);

  if (depth >= options.maxDepth) {
    return marker(Array.isArray(obj) ? "array (depth-capped)" : "object (depth-capped)");
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Hard cap, no "…" placeholder — the wrapper renders these literally.
      return obj
        .slice(0, options.maxEntries)
        .map((item) => capture(item, depth + 1, options, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj as Record<string, unknown>).slice(
      0,
      options.maxEntries,
    )) {
      const captured = capture(item, depth + 1, options, seen);
      if (captured !== undefined) out[key] = captured;
    }
    return out;
  } catch {
    return marker("threw during capture");
  } finally {
    seen.delete(obj);
  }
}

/** JSON-safe, capped clone of any runtime value. Never throws. */
function captureValue(value: unknown, options?: CaptureOptions): unknown {
  const resolved = { ...CAPTURE_DEFAULTS, ...options };
  try {
    return capture(value, 0, resolved, new WeakSet());
  } catch {
    return marker("threw during capture");
  }
}

// ---------------------------------------------------------------------------
// Element locator (element pins, docs/specs/sandbox.md v2 E1).
// ---------------------------------------------------------------------------

/** Caps mirrored server-side (`sanitizeElementLocator`). */
const LOCATOR_OUTER_HTML_CAP = 2048;
const LOCATOR_TEXT_CAP = 160;
const LOCATOR_PATH_CAP = 32;

/** What an ELEMENT pin's selection pointed at inside its owner component.
 * The DIRECTOR resolves this to the exact JSX span in the owner source. */
type SandboxElementLocator = {
  tag: string;
  /** outerHTML snippet at capture time (capped ~2KB). */
  outerHtml: string;
  /** Element-child index path from the owner's rendered root (a hint). */
  childIndexPath: number[];
  /** Hash of the normalized text content (revive-time identity check). */
  textHash: string;
  /** Normalized text content, capped (director readability). */
  text?: string;
  className?: string;
};

/** djb2 over the normalized text — cheap, stable, hex-rendered. */
function hashLocatorText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

/** Whitespace-normalized text (the DOM serializes runs of whitespace). */
function normalizeLocatorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Build a capped, JSON-safe element locator from raw DOM readings (the DOM
 * touch itself lives in captureLive — this stays pure/testable).
 */
function buildElementLocator(input: {
  tag: string;
  outerHtml: string;
  textContent?: string;
  className?: string;
  childIndexPath?: number[];
}): SandboxElementLocator {
  const text = normalizeLocatorText(input.textContent ?? "");
  return {
    tag: input.tag.toLowerCase(),
    outerHtml: input.outerHtml.slice(0, LOCATOR_OUTER_HTML_CAP),
    childIndexPath: (input.childIndexPath ?? []).slice(0, LOCATOR_PATH_CAP),
    textHash: hashLocatorText(text),
    ...(text ? { text: truncate(text, LOCATOR_TEXT_CAP) } : {}),
    ...(input.className ? { className: input.className.slice(0, 256) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Snapshot assembly.
// ---------------------------------------------------------------------------

type SandboxCapturedContext = {
  name: string;
  value: unknown;
  ownerName?: string;
  ownerFile?: string;
  /**
   * The component that RENDERED the provider (the fiber's `_debugOwner`),
   * when identifiable — e.g. `ProductProvider`. The deterministic wrapper
   * generator re-emits an import of this real provider with
   * `providerProps` when the component is resolvable in the app source.
   */
  providerName?: string;
  /** Repo-relative source of `providerName`, when attributable client-side. */
  providerFile?: string;
  /** The provider component's own props at capture (children excluded). */
  providerProps?: Record<string, unknown>;
};

/** App i18n shape (from the designbook config) the wrapper generator uses to
 * re-create an i18next instance with the app's own locale resources. */
type SandboxI18nInfo = {
  /** Repo-relative locale file pattern with `{locale}`/`{namespace}` slots. */
  localePathPattern?: string;
  defaultNamespace?: string;
  defaultLocale?: string;
};

type SandboxContextSnapshot = {
  props: Record<string, unknown>;
  contexts: SandboxCapturedContext[];
  /** Adapter dimension state at capture (theme/locale/flags/viewport…). */
  adapters: Record<string, string>;
  /** The app route (location.pathname) at pin time — the deterministic
   * wrapper seeds `<MemoryRouter initialEntries={[capturedPath]}>` with it so
   * a react-router selection renders at its real route. Defaults to "/". */
  capturedPath?: string;
  /** App i18n config, when the app has one (wrapper i18next re-creation). */
  i18n?: SandboxI18nInfo;
  /** ELEMENT pins: the selected element subtree's resolved values (fiber
   * props + text; sampleValue caps) — the controller's inlined-locals raw
   * material (docs/specs/sandbox.md v2). */
  element?: { tag: string; text?: string; props?: Record<string, unknown> };
};

type SandboxTargetInput = {
  file: string;
  exportName: string;
  name: string;
  entryId?: string;
  instancePath?: string;
};

/** Raw inputs the collectors provide (live bindings live in the screens). */
type SandboxCaptureInput = {
  target: SandboxTargetInput;
  /** Live fiber props (children excluded by the caller or here). */
  props?: Record<string, unknown>;
  /** Context-scope entries, nearest first (consumed flags pre-computed). */
  contextScope?: Array<{
    contextName: string;
    value: unknown;
    consumed: boolean;
    shadowed: boolean;
    ownerName?: string;
    ownerFile?: string;
    providerName?: string;
    providerFile?: string;
    /** RAW provider-component props (children excluded by the caller). */
    providerProps?: Record<string, unknown>;
  }>;
  /** Namespaced adapter dimension id → current value. */
  adapterState?: Record<string, string>;
  /** App i18n config info (from the designbook config, when present). */
  i18n?: SandboxI18nInfo;
  /** ELEMENT pins: raw element subtree readings (tag + text + host-fiber
   * props) — capped/JSON-safed here like everything else. */
  element?: { tag: string; text?: string; props?: Record<string, unknown> };
  /** App route (location.pathname) at capture; seeds the wrapper's router. */
  capturedPath?: string;
};

/** Clean a captured location.pathname into a router `initialEntries` value:
 * keep the path only (query/hash dropped — the wrapper needs a bare route),
 * ensure a leading slash, default "/". */
function normalizeCapturedPath(raw: string | undefined): string {
  if (typeof raw !== "string" || !raw.trim()) return "/";
  let path = raw.trim().split(/[?#]/)[0];
  if (!path.startsWith("/")) path = `/${path}`;
  return path || "/";
}

/**
 * Build the pin payload: target + capped JSON-safe snapshot. Only contexts
 * the selection actually CONSUMES (and that aren't shadowed) are captured —
 * they're what the wrapper must re-create for the variant to look right.
 */
function captureSandboxContext(input: SandboxCaptureInput): {
  target: SandboxTargetInput;
  contextSnapshot: SandboxContextSnapshot;
} {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.props ?? {})) {
    if (key === "children") {
      // Children are render-time structure, not data — always stubbed.
      if (value !== undefined && value !== null) {
        props[key] = marker("children (ReactNode)");
      }
      continue;
    }
    const captured = captureValue(value);
    if (captured !== undefined) props[key] = captured;
  }

  const contexts: SandboxCapturedContext[] = (input.contextScope ?? [])
    .filter((entry) => entry.consumed && !entry.shadowed)
    .map((entry) => {
      let providerProps: Record<string, unknown> | undefined;
      if (entry.providerProps) {
        providerProps = {};
        for (const [key, value] of Object.entries(entry.providerProps)) {
          if (key === "children") continue;
          const captured = captureValue(value);
          if (captured !== undefined) providerProps[key] = captured;
        }
      }
      return {
        name: entry.contextName,
        value: captureValue(entry.value),
        ...(entry.ownerName ? { ownerName: entry.ownerName } : {}),
        ...(entry.ownerFile ? { ownerFile: entry.ownerFile } : {}),
        ...(entry.providerName ? { providerName: entry.providerName } : {}),
        ...(entry.providerFile ? { providerFile: entry.providerFile } : {}),
        ...(providerProps ? { providerProps } : {}),
      };
    });

  let element: SandboxContextSnapshot["element"];
  if (input.element) {
    const elementProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.element.props ?? {})) {
      if (key === "children") continue; // structure, not data
      const captured = captureValue(value);
      if (captured !== undefined) elementProps[key] = captured;
    }
    const text = normalizeLocatorText(input.element.text ?? "");
    element = {
      tag: input.element.tag.toLowerCase(),
      ...(text ? { text: truncate(text, LOCATOR_TEXT_CAP) } : {}),
      ...(Object.keys(elementProps).length > 0 ? { props: elementProps } : {}),
    };
  }

  return {
    target: input.target,
    contextSnapshot: {
      props,
      contexts,
      adapters: { ...(input.adapterState ?? {}) },
      ...(input.i18n ? { i18n: { ...input.i18n } } : {}),
      ...(element ? { element } : {}),
      capturedPath: normalizeCapturedPath(input.capturedPath),
    },
  };
}

export {
  buildElementLocator,
  captureSandboxContext,
  captureValue,
  hashLocatorText,
  normalizeLocatorText,
};
export type {
  SandboxCaptureInput,
  SandboxCapturedContext,
  SandboxContextSnapshot,
  SandboxElementLocator,
  SandboxI18nInfo,
  SandboxTargetInput,
  UnserializableMarker,
};
