/**
 * Typed prop-schema extraction for the props panel
 * (docs/specs/props-panel.md). `GET /api/props-schema?file=&export=` resolves
 * a component's declared props into editable-control descriptors via
 * `react-docgen-typescript`, keyed off the APP's own TypeScript.
 *
 * TS RESOLUTION (mirrors the bake gate's app-local tsc rule): the typescript
 * instance is resolved from `react-docgen-typescript`'s own module location —
 * i.e. its peer dependency, which in an installed app is the app's hoisted
 * typescript — so the program react-docgen walks and the program we build for
 * it are the SAME instance (cross-version AST-enum drift would otherwise break
 * the walk). The app's `tsconfig.json` compiler options (jsx, path aliases)
 * seed the program. When typescript / react-docgen / a tsconfig can't be
 * resolved, the endpoint returns `{ unavailable: <reason> }` and the panel
 * degrades to values-only — never a hard failure.
 *
 * CACHE: one entry per absolute file, invalidated on the file's mtime. The
 * first call on a big repo pays the cold `createProgram` cost (seconds, per
 * spec); repeats are a map hit. The endpoint is async and independent, so a
 * cold extraction never blocks other routes.
 *
 * The heavy modules (react-docgen-typescript, the resolved typescript) load
 * LAZILY on first use so importing this module is free.
 */

import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** A control-shaping kind derived from the prop's TS type. */
type PropKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "node"
  | "function"
  | "object";

/** One declared prop, panel-ready. */
type PropDescriptor = {
  name: string;
  /** Human-readable type text (react-docgen's `type.name`/`raw`). */
  typeText: string;
  kind: PropKind;
  /** Literal choices for an `enum` kind (unquoted). */
  options?: string[];
  required: boolean;
  /** The declared default (`defaultProps` / destructure default), when known. */
  defaultValue?: string;
  description?: string;
};

type PropsSchemaResult =
  | { props: PropDescriptor[] }
  | { unavailable: string };

// ---------------------------------------------------------------------------
// react-docgen-typescript shapes (typed structurally — no value import at the
// top level so this module stays cheap to import).
// ---------------------------------------------------------------------------

type DocgenPropType = {
  name: string;
  raw?: string;
  value?: Array<{ value?: unknown }> | unknown;
};

type DocgenProp = {
  name: string;
  required: boolean;
  type?: DocgenPropType;
  description?: string;
  defaultValue?: { value?: unknown } | null;
  parent?: { fileName?: string; name?: string };
};

type DocgenComponent = {
  displayName?: string;
  props?: Record<string, DocgenProp>;
};

type DocgenParser = {
  parseWithProgramProvider: (
    filePathOrPaths: string | string[],
    programProvider?: () => unknown,
  ) => DocgenComponent[];
};

type DocgenModule = {
  withCompilerOptions: (
    compilerOptions: unknown,
    parserOptions: Record<string, unknown>,
  ) => DocgenParser;
};

type Tooling = {
  docgen: DocgenModule;
  ts: {
    findConfigFile: (
      searchPath: string,
      fileExists: (path: string) => boolean,
      configName?: string,
    ) => string | undefined;
    readConfigFile: (
      path: string,
      readFile: (path: string) => string | undefined,
    ) => { config?: unknown; error?: unknown };
    parseJsonConfigFileContent: (
      json: unknown,
      host: unknown,
      basePath: string,
    ) => { options: unknown };
    createProgram: (rootNames: string[], options: unknown) => unknown;
    sys: {
      fileExists: (path: string) => boolean;
      readFile: (path: string) => string | undefined;
    };
  };
};

/** Strip surrounding single/double quotes from a react-docgen literal. */
function unquote(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const NODE_TYPE_NAMES = new Set([
  "ReactNode",
  "React.ReactNode",
  "ReactElement",
  "React.ReactElement",
  "ReactChild",
  "Element",
  "JSX.Element",
  "ReactNode[]",
]);

/** Enum literal string values (unquoted), or undefined when the value list is
 * not a plain literal list. */
function enumOptions(type: DocgenPropType): string[] | undefined {
  if (!Array.isArray(type.value)) return undefined;
  const values = type.value
    .map((entry) =>
      entry && typeof entry === "object" && "value" in entry
        ? String((entry as { value?: unknown }).value ?? "")
        : "",
    )
    .filter((value) => value !== "");
  return values.length > 0 ? values : undefined;
}

/** A literal-union token: a quoted string, a number, or true/false. */
function isLiteralToken(token: string): boolean {
  return (
    /^"[^"]*"$/.test(token) ||
    /^'[^']*'$/.test(token) ||
    /^-?\d+(\.\d+)?$/.test(token) ||
    token === "true" ||
    token === "false"
  );
}

/**
 * Parse a raw union TYPE TEXT (`"a" | "b" | null`) into its literal members —
 * the buttonVariants case, where react-docgen hands back the union string as
 * the type name rather than an `enum` value list (VariantProps' `… | null`
 * breaks its enum detection). Returns undefined unless EVERY non-null/undefined
 * member is a literal.
 */
function parseLiteralUnion(text: string): string[] | undefined {
  if (!text.includes("|")) return undefined;
  const tokens = text
    .split("|")
    .map((token) => token.trim())
    .filter((token) => token && token !== "null" && token !== "undefined");
  if (tokens.length === 0 || !tokens.every(isLiteralToken)) return undefined;
  return tokens;
}

/** Map a react-docgen prop type onto a control kind (+ enum options). */
function classifyKind(type: DocgenPropType | undefined): {
  kind: PropKind;
  options?: string[];
} {
  if (!type) return { kind: "object" };
  const name = type.name ?? "";
  if (name === "boolean") return { kind: "boolean" };
  if (name === "string") return { kind: "string" };
  if (name === "number") return { kind: "number" };
  if (NODE_TYPE_NAMES.has(name) || /\bReactNode\b|\bReactElement\b/.test(name)) {
    return { kind: "node" };
  }
  if (name === "enum") {
    const options = enumOptions(type);
    if (options) {
      const literals = options.map(unquote);
      // `true | false` (or a boolean-widened union) reads as a switch.
      if (
        literals.every((value) => value === "true" || value === "false") &&
        literals.length > 0
      ) {
        return { kind: "boolean" };
      }
      // A single-member union with `undefined`/`{}` noise degrades to its
      // representable literals.
      const clean = literals.filter(
        (value) => value !== "undefined" && value !== "{}" && value !== "null",
      );
      if (clean.length > 0) return { kind: "enum", options: clean };
    }
    return { kind: "object" };
  }
  // Function signatures: `(...) => ...`, `Function`, named handler types.
  if (/=>|\bFunction\b|^\(.*\)/.test(name) || /^\(.*\) =>/.test(type.raw ?? "")) {
    return { kind: "function" };
  }
  // A raw string/number literal union (buttonVariants-style: react-docgen
  // returns the union text as the name, not an `enum` value list).
  const union = parseLiteralUnion(name) ?? parseLiteralUnion(type.raw ?? "");
  if (union) {
    const literals = union.map(unquote);
    if (literals.every((value) => value === "true" || value === "false")) {
      return { kind: "boolean" };
    }
    return { kind: "enum", options: literals };
  }
  return { kind: "object" };
}

function toDescriptor(prop: DocgenProp): PropDescriptor {
  const { kind, options } = classifyKind(prop.type);
  const typeText = prop.type?.raw?.trim() || prop.type?.name || "unknown";
  const defaultRaw = prop.defaultValue?.value;
  return {
    name: prop.name,
    typeText,
    kind,
    ...(options ? { options } : {}),
    required: Boolean(prop.required),
    ...(defaultRaw !== undefined && defaultRaw !== null
      ? { defaultValue: String(defaultRaw) }
      : {}),
    ...(prop.description ? { description: prop.description.trim() } : {}),
  };
}

/**
 * Build the props panel's schema extractor. `getSchema` is async, cached per
 * file+mtime, and never throws — resolution failures come back as
 * `{ unavailable }`.
 */
function createPropsSchema(deps: { log?: (message: string) => void } = {}) {
  const log = deps.log ?? (() => {});
  /** absFile → { mtimeMs, result }. */
  const cache = new Map<string, { mtimeMs: number; result: PropsSchemaResult }>();
  /** Lazily-resolved tooling (undefined until the first successful load; the
   * `false` sentinel records a hard-unavailable so we don't re-probe). */
  let tooling: Tooling | false | undefined;
  let toolingReason = "";

  /** Resolve react-docgen-typescript + a typescript instance that MATCHES the
   * one react-docgen imports (its peer — app-local in an installed app). */
  function loadTooling(fromDir: string): Tooling | undefined {
    if (tooling !== undefined) return tooling === false ? undefined : tooling;
    try {
      const base = createRequire(resolve(fromDir, "package.json"));
      const docgenEntry = base.resolve("react-docgen-typescript");
      const docgen = base(docgenEntry) as DocgenModule;
      // Same-instance TS: resolve typescript relative to react-docgen's own
      // module so the program we createProgram and the checker docgen walks it
      // with are one instance.
      const docgenRequire = createRequire(docgenEntry);
      const tsPath = docgenRequire.resolve("typescript");
      const ts = docgenRequire(tsPath) as Tooling["ts"];
      tooling = { docgen, ts };
      return tooling;
    } catch (error) {
      toolingReason =
        error instanceof Error ? error.message : String(error);
      tooling = false;
      log(`props schema tooling unavailable: ${toolingReason}`);
      return undefined;
    }
  }

  /** The app tsconfig's compiler options, or a permissive default. */
  function compilerOptionsFor(tools: Tooling, gateCwd: string): unknown {
    try {
      const configPath = tools.ts.findConfigFile(
        gateCwd,
        tools.ts.sys.fileExists,
        "tsconfig.json",
      );
      if (configPath) {
        const { config } = tools.ts.readConfigFile(
          configPath,
          tools.ts.sys.readFile,
        );
        const parsed = tools.ts.parseJsonConfigFileContent(
          config ?? {},
          tools.ts.sys,
          dirname(configPath),
        );
        return parsed.options;
      }
    } catch (error) {
      log(`props schema tsconfig read failed: ${String(error)}`);
    }
    // No tsconfig — a JSX-aware default keeps extraction working.
    return { jsx: 2 /* react */, esModuleInterop: true, allowJs: true };
  }

  const PARSER_OPTIONS = {
    savePropValueAsString: true,
    shouldExtractLiteralValuesFromEnum: true,
    shouldRemoveUndefinedFromOptional: true,
    // The component's OWN props only — DOM/HTMLAttributes inherited from
    // node_modules are dropped (they aren't the authored surface).
    propFilter: (prop: DocgenProp) =>
      prop.parent ? !/node_modules/.test(prop.parent.fileName ?? "") : true,
  };

  function extract(
    tools: Tooling,
    gateCwd: string,
    absFile: string,
    exportName: string | undefined,
  ): PropsSchemaResult {
    const options = compilerOptionsFor(tools, gateCwd);
    let components: DocgenComponent[];
    try {
      const parser = tools.docgen.withCompilerOptions(options, PARSER_OPTIONS);
      const program = tools.ts.createProgram([absFile], options);
      components = parser.parseWithProgramProvider(absFile, () => program);
    } catch (error) {
      return {
        unavailable: `docgen extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (components.length === 0) {
      return { unavailable: "no documentable component found in the file." };
    }
    const chosen =
      (exportName &&
        components.find((component) => component.displayName === exportName)) ||
      components[0];
    const props = Object.values(chosen.props ?? {}).map(toDescriptor);
    // Stable order: required first, then alphabetical — the panel renders in
    // this order.
    props.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { props };
  }

  /**
   * Schema for `exportName` in `absFile` (absolute). `gateCwd` is the app dir
   * (tsconfig + tooling resolution root). Cached by mtime.
   */
  async function getSchema(params: {
    absFile: string;
    gateCwd: string;
    exportName?: string;
  }): Promise<PropsSchemaResult> {
    const { absFile, gateCwd, exportName } = params;
    if (!isAbsolute(absFile)) {
      return { unavailable: "internal: non-absolute file path." };
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(absFile).mtimeMs;
    } catch {
      return { unavailable: `file not found: ${absFile}` };
    }
    // The export selection is part of the cache identity (one file can export
    // several components).
    const cacheKey = `${absFile}::${exportName ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs) return cached.result;

    const tools = loadTooling(gateCwd);
    if (!tools) {
      return {
        unavailable: `typescript/react-docgen unavailable (${toolingReason}).`,
      };
    }
    const result = extract(tools, gateCwd, absFile, exportName);
    cache.set(cacheKey, { mtimeMs, result });
    return result;
  }

  /** Drop a file's cached schema (used by tests; the mtime check covers the
   * live path). */
  function invalidate(absFile: string): void {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${absFile}::`)) cache.delete(key);
    }
  }

  return { getSchema, invalidate };
}

export { createPropsSchema, classifyKind };
export type { PropDescriptor, PropKind, PropsSchemaResult };
