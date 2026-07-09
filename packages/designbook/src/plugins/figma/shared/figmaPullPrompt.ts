/**
 * Formats the declarative "pull from Figma" Pi prompt. SHORT by design: all
 * static boilerplate (annotation legend, reconciliation rules, minimal-diff /
 * preserve-wiring guidance) lives in the designbook-shipped `figma-pull`
 * Agent Skill (skills/figma-pull/SKILL.md, loaded into every embedded Pi
 * session — see src/node/api/piSkills.ts), so each pull sends only the task
 * line, the render context the push stamped into the root marker, and the
 * TARGET html. The current source is NOT inlined — Pi reads the file itself
 * (the skill says to, and read tools are available even in --read-only).
 *
 * Pure and framework-free: used by the browser (confirm → Send to Pi) and
 * server-side (the `figma_pull_component` tool).
 */

import type { PullRenderContext } from "./figmaRender.ts";

type PullPromptContext = {
  componentId: string;
  /** Repo-relative source file of the component (from the registry entry). */
  sourcePath?: string;
  /** Annotated HTML target from `figma_read_html`. */
  html: string;
  /**
   * The render context the push stamped into the root marker (which single
   * rendering the target reflects). Omitted for pre-context pushes — the
   * prompt then simply has no context line.
   */
  render?: PullRenderContext;
};

/** One compact "Target was rendered with: …" line, or undefined when empty. */
function renderContextLine(
  render: PullRenderContext | undefined,
): string | undefined {
  if (!render) return undefined;
  const parts: string[] = [];
  if (render.locale) parts.push(`locale ${render.locale}`);
  if (render.theme) parts.push(`theme ${render.theme}`);
  if (render.mode) parts.push(`mode ${render.mode}`);
  if (render.dimensions) {
    for (const key of Object.keys(render.dimensions)) {
      parts.push(`${key}=${render.dimensions[key]}`);
    }
  }
  if (parts.length === 0) return undefined;
  return `Target was rendered with: ${parts.join(", ")}. Differences explained by this context (sample values, translations, flag-driven presence) are NOT design edits.`;
}

function formatPullPrompt(ctx: PullPromptContext): string {
  const subject = ctx.sourcePath
    ? `${ctx.sourcePath} (component ${ctx.componentId})`
    : `component ${ctx.componentId}`;

  const lines: string[] = [
    `Update ${subject} to match the TARGET below — a declarative Figma pull target. Follow the figma-pull skill for the annotation format and reconciliation rules; read the current source before editing.`,
  ];

  const context = renderContextLine(ctx.render);
  if (context) lines.push("", context);

  lines.push("", "TARGET (annotated HTML from Figma):", ctx.html);
  lines.push(
    "",
    "Keep the edit minimal and idiomatic; if a change is ambiguous or needs restructuring, ask before editing.",
  );

  return lines.join("\n");
}

export { formatPullPrompt };
export type { PullPromptContext };
