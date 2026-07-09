/**
 * Built-in selection-context contributors (PREVIEW — docs/specs/
 * selection-context.md): core, props, render context, i18n, context scope.
 *
 * Registered once at mount (before integration/adapter init) so the built-in
 * sections lead the panel/prompt order. Every contributor SNAPSHOTS state at
 * run time — none subscribe to live stores (feedback-loop rule). Fiber access
 * goes only through the previewHost seam. `facts` and `prompt` are different
 * renderings: labeled rows for the panel, terse factual lines for the model.
 */

import {
  collectContextScope,
  collectRenderedText,
  getFiberProps,
} from "@designbook-ui/previewHost";
import type { Fiber } from "@designbook-ui/previewHost";
import {
  registryByName,
  registryByRef,
} from "@designbook-ui/models/catalog/componentRegistry";
import { statusLabel } from "@designbook-ui/models/branch/changesModel";
import { getAdapterRuntime } from "@designbook-ui/adapterRuntime";
import { registerSelectionContributor } from "./registry";
import { sampleValue } from "./sampleValue";
import { baseKey, mergeScans, scanI18nSource } from "./i18nStaticScan";
import type {
  SelectionContextContribution,
  SelectionContextFact,
  SelectionContextInput,
  SelectionContextRunCtx,
} from "./types";

// ---------------------------------------------------------------------------
// core — identity, definition, usage site, git status.
// ---------------------------------------------------------------------------

function coreContributor(
  input: SelectionContextInput,
): SelectionContextContribution {
  const { node, live, changes } = input;
  const facts: SelectionFactList = [];
  const prompt: string[] = [];

  facts.push({ label: "Selected", value: node.label });
  prompt.push(`Selected canvas node: ${node.label}`);

  if (live?.entryId) facts.push({ label: "Entry", value: live.entryId, code: true });
  if (live?.instanceId) {
    facts.push({ label: "Instance", value: live.instanceId, code: true });
  }

  if (node.dom) {
    const domSummary = `<${node.dom.tag}${node.dom.id ? ` id="${node.dom.id}"` : ""}${
      node.dom.classes?.length ? ` class="${node.dom.classes.join(" ")}"` : ""
    }>`;
    facts.push({ label: "DOM element", value: domSummary, code: true });
    prompt.push(`DOM element: ${domSummary}`);
  }

  // Drilled selection: state BOTH the usage site and the definition (this is
  // the drilled-instance prompt fix — see the spec).
  if (node.codeTarget) {
    const target = node.codeTarget;
    facts.push({
      label: "Used in",
      value: `${target.ownerExportName} — ${target.file}`,
      code: true,
    });
    facts.push({
      label: "Element",
      value: target.className
        ? `<${target.name} class="${target.className}">`
        : `<${target.name}>`,
      code: true,
    });
    prompt.push(
      `Instance <${target.name}> used inside ${target.ownerExportName} at ${target.file}`,
    );
  }
  if (node.path) {
    facts.push({ label: "Defined at", value: node.path, code: true });
    prompt.push(
      `Component defined at ${node.path}${node.exportName ? ` (export ${node.exportName})` : ""}`,
    );
  }
  if (node.exportName) {
    facts.push({ label: "Export", value: node.exportName, code: true });
  }

  // Git status of the involved file(s) — from the changes-model snapshot the
  // runner captured (Edited/New badge data; no re-fetch).
  const files = [...new Set([node.path, node.codeTarget?.file].filter(Boolean))];
  for (const file of files) {
    const change = changes?.find(
      (candidate) => candidate.path === file || candidate.origPath === file,
    );
    if (change) {
      facts.push({ label: "Git", value: `${statusLabel(change.status)} — ${file}` });
      prompt.push(`File ${file} has uncommitted changes (${statusLabel(change.status)}).`);
    }
  }

  return { source: "core", title: "Selection", facts, prompt: prompt.join("\n") };
}

type SelectionFactList = SelectionContextFact[];

// ---------------------------------------------------------------------------
// props — live fiber props through the sampled serializer.
// ---------------------------------------------------------------------------

function propsContributor(
  input: SelectionContextInput,
): SelectionContextContribution | undefined {
  const { node, live } = input;

  if (node.dom) {
    const facts: SelectionFactList = [
      { label: "tag", value: node.dom.tag, code: true },
    ];
    if (node.dom.id) facts.push({ label: "id", value: node.dom.id, code: true });
    if (node.dom.classes?.length) {
      facts.push({ label: "class", value: node.dom.classes.join(" "), code: true });
    }
    return {
      source: "props",
      title: "Props",
      facts,
      prompt: `DOM node — tag=${node.dom.tag}${node.dom.id ? ` id=${node.dom.id}` : ""}${
        node.dom.classes?.length ? ` class="${node.dom.classes.join(" ")}"` : ""
      }`,
    };
  }

  if (!live?.fiber) {
    return {
      source: "props",
      title: "Props",
      facts: [
        { label: "Props", value: "Live props are unavailable for this selection." },
      ],
    };
  }

  const props = getFiberProps(live.fiber as Fiber);
  const rows = Object.entries(props).filter(([name]) => name !== "children");
  if (rows.length === 0) {
    return {
      source: "props",
      title: "Props",
      facts: [{ label: "Props", value: "This instance received no props." }],
      prompt: "Instance received no props.",
    };
  }

  return {
    source: "props",
    title: "Props",
    facts: rows.map(([name, value]) => ({
      label: name,
      value: sampleValue(value),
      code: true,
    })),
    prompt: [
      "Current live props:",
      ...rows.map(([name, value]) => `${name}: ${sampleValue(value)}`),
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// render context — the adapter runtime's dimension snapshot.
// ---------------------------------------------------------------------------

function renderContextContributor(): SelectionContextContribution | undefined {
  // Snapshot at run time; throws before runtime init → contributor skipped.
  const runtime = getAdapterRuntime();
  const { context, follow } = runtime.getSnapshot();
  if (runtime.dimensions.length === 0) return undefined;

  const facts: SelectionFactList = runtime.dimensions.map((dimension) => {
    const value = context[dimension.id] ?? dimension.defaultValue;
    const following = follow[dimension.id]?.following;
    return {
      label: dimension.label,
      value: following ? `${value} (follows app)` : String(value),
      code: true,
    };
  });

  const promptLine = runtime.dimensions
    .map(
      (dimension) =>
        `${dimension.id}=${context[dimension.id] ?? dimension.defaultValue}`,
    )
    .join("; ");

  return {
    source: "render-context",
    title: "Render context",
    facts,
    prompt: `Preview render context: ${promptLine}`,
  };
}

// ---------------------------------------------------------------------------
// i18n — runtime marker walk + static source scan, merged with provenance.
// ---------------------------------------------------------------------------

async function fetchSource(
  ctx: SelectionContextRunCtx,
  path: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(
      ctx.apiUrl(`/api/file?path=${encodeURIComponent(path)}`),
    );
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { content?: string };
    return typeof payload.content === "string" ? payload.content : undefined;
  } catch {
    return undefined;
  }
}

async function i18nContributor(
  input: SelectionContextInput,
  ctx: SelectionContextRunCtx,
): Promise<SelectionContextContribution | undefined> {
  const { node, live } = input;

  // RUNTIME: markers rendered right now, with current-locale values.
  const rendered = collectRenderedText({
    fiber: live?.fiber,
    element: live?.anchor,
  });

  // STATIC: declared keys in the definition (and the usage file when drilled).
  const files = [...new Set([node.path, node.codeTarget?.file].filter(Boolean))];
  const sources = await Promise.all(
    files.map((file) => fetchSource(ctx, file as string)),
  );
  const scan = mergeScans(
    sources.filter((s): s is string => s !== undefined).map(scanI18nSource),
  );

  const renderedBaseKeys = new Set(
    rendered.marked.flatMap((entry) => [entry.key, entry.resolvedKey]),
  );
  const declaredOnly = scan.keys.filter(
    (key) => !renderedBaseKeys.has(baseKey(key)),
  );

  if (
    rendered.marked.length === 0 &&
    rendered.hardcodedCount === 0 &&
    scan.keys.length === 0 &&
    scan.dynamic.length === 0
  ) {
    return undefined;
  }

  const facts: SelectionFactList = [];
  const prompt: string[] = [];

  for (const entry of rendered.marked) {
    facts.push({
      label: `${entry.namespace}:${entry.resolvedKey}`,
      value: `"${entry.value}" · rendered`,
      code: true,
    });
  }
  if (rendered.marked.length > 0) {
    prompt.push(
      "i18n keys rendered now: " +
        rendered.marked
          .map((entry) => `${entry.namespace}:${entry.resolvedKey}="${entry.value}"`)
          .join(", "),
    );
  }
  for (const key of declaredOnly) {
    facts.push({ label: key, value: "declared in source, not rendered", code: true });
  }
  if (declaredOnly.length > 0) {
    prompt.push(`i18n keys declared but not rendered: ${declaredOnly.join(", ")}`);
  }
  for (const snippet of scan.dynamic) {
    facts.push({ label: snippet, value: "dynamic key — not enumerable", code: true });
  }
  if (scan.dynamic.length > 0) {
    prompt.push(`Dynamic i18n keys present: ${scan.dynamic.join(", ")}`);
  }
  if (rendered.hardcodedCount > 0) {
    facts.push({
      label: "Hardcoded",
      value: `${rendered.hardcodedCount} rendered string(s) without i18n markers`,
    });
    prompt.push(
      `${rendered.hardcodedCount} rendered string(s) are hardcoded (no i18n marker).`,
    );
  }

  return { source: "i18n", title: "i18n", facts, prompt: prompt.join("\n") };
}

// ---------------------------------------------------------------------------
// context scope — ancestor providers, consumption, shadowing.
// ---------------------------------------------------------------------------

function contextScopeContributor(
  input: SelectionContextInput,
): SelectionContextContribution | undefined {
  const fiber = input.live?.fiber;
  if (!fiber) return undefined;

  const entries = collectContextScope(fiber, registryByRef, registryByName);
  if (entries.length === 0) return undefined;

  const facts: SelectionFactList = entries.map((entry) => {
    const flags = [
      entry.consumed ? "consumed" : undefined,
      entry.shadowed ? "shadowed" : undefined,
    ].filter(Boolean);
    const origin = entry.ownerName
      ? ` — from ${entry.ownerName}${entry.ownerFile ? ` (${entry.ownerFile})` : ""}`
      : "";
    return {
      label: flags.length ? `${entry.contextName} (${flags.join(", ")})` : entry.contextName,
      value: `${sampleValue(entry.value)}${origin}`,
      code: true,
    };
  });

  const prompt = [
    "React context providers in scope (nearest first):",
    ...entries.map((entry) => {
      const flags = [
        entry.consumed ? "CONSUMED by selection" : undefined,
        entry.shadowed ? "shadowed" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      const origin = entry.ownerName ? ` via ${entry.ownerName}` : "";
      return `${entry.contextName}${origin}: ${sampleValue(entry.value)}${flags ? ` [${flags}]` : ""}`;
    }),
  ].join("\n");

  return { source: "context-scope", title: "Context scope", facts, prompt };
}

// ---------------------------------------------------------------------------
// Registration (mount calls this once, before integration/adapter init).
// ---------------------------------------------------------------------------

function registerBuiltinSelectionContributors(): void {
  registerSelectionContributor("core", (input) => coreContributor(input));
  registerSelectionContributor("props", (input) => propsContributor(input));
  registerSelectionContributor("render-context", () =>
    renderContextContributor(),
  );
  registerSelectionContributor("i18n", (input, ctx) => i18nContributor(input, ctx));
  registerSelectionContributor("context-scope", (input) =>
    contextScopeContributor(input),
  );
}

export {
  contextScopeContributor,
  coreContributor,
  i18nContributor,
  propsContributor,
  registerBuiltinSelectionContributors,
  renderContextContributor,
};
