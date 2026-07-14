# Custom agent instructions for designers (draft)

Status: research draft. Investigates how Pi's instruction-file mechanics work
today, what designbook currently does (nothing custom), and proposes a
designbook-native config surface. Grounded in `@earendil-works/pi-coding-agent@0.80.3`
(pinned in `packages/designbook/package.json:64`) and
`packages/designbook/src/node/api.ts`.

## What the underlying SDK supports today

Source: `pi-coding-agent/docs/usage.md` ("Context Files", "System Prompt
Files"), `pi-coding-agent/docs/sdk.md` ("System Prompt", "Context Files"),
`pi-coding-agent/docs/security.md` ("Project Trust"), and
`dist/core/resource-loader.js`.

### Discovery, in the CLI's own terms

| File | Scope | Loaded when | Replaces or appends? |
|---|---|---|---|
| `AGENTS.md` / `CLAUDE.md` | walks up from `cwd` to the repo/filesystem root, plus `~/.pi/agent/AGENTS.md` globally | always, regardless of project trust; disable with `--no-context-files`/`-nc` | appended as context, not a system-prompt replacement |
| `.pi/SYSTEM.md` (project) | project | only if `settingsManager.isProjectTrusted()` (`resource-loader.js:751-753`) | **replaces** the default system prompt |
| `~/.pi/agent/SYSTEM.md` (global) | machine | always | replaces (fallback if no trusted project one) |
| `.pi/APPEND_SYSTEM.md` (project) | project | only if trusted (`resource-loader.js:762-764`) | appends to whichever system prompt won |
| `~/.pi/agent/APPEND_SYSTEM.md` (global) | machine | always | appends |
| CLI `--system-prompt <text>` | per-invocation | always | replaces (context files/skills still appended per `usage.md:237`) |
| CLI `--append-system-prompt <text>` | per-invocation | always | appends |

The SDK-level knobs behind all of this (`pi-coding-agent/docs/sdk.md`,
"System Prompt" / "Context Files" sections) are `DefaultResourceLoaderOptions`:
`systemPromptOverride`, `appendSystemPromptOverride`, `agentsFilesOverride`,
`systemPrompt`/`appendSystemPrompt` (direct string values), and
`noContextFiles`. These are constructor options on `DefaultResourceLoader`,
passed to `createAgentSession({ resourceLoader })` — i.e. they are only
reachable by building your own loader, not by config flags on
`createAgentSession()` itself.

### The trust gate matters here too

`.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md` are the two mechanisms that most
resemble "designbook-specific instructions" out of the box — but they're
gated on `isProjectTrusted()`. See the companion doc
(`docs/drafts/pi-security-hardening.md`, fact #5) for the trace showing that
designbook's `createAgentSession()` call (`api.ts:380-387`) never wires up
project trust resolution, so `SettingsManager.create()` defaults
`projectTrusted: true` (`dist/core/settings-manager.js:152-153`) and it's
**silently always trusted**. Practical upshot: `.pi/SYSTEM.md` *does* work
in designbook today, with zero designbook code changes — but only because of
the same silent-trust behavior that also auto-runs `.pi/extensions/*.ts`.
Relying on it as the "sanctioned" designer-instructions channel means
implicitly relying on a security gap staying open. Once product-backlog item
#4 in the security doc (explicit trust wiring) ships, `.pi/SYSTEM.md` would
stop working unless the project is explicitly trusted — so it's not a
mechanism to build permanent product docs around.

## What designbook does today: nothing custom

`createSession()` (`packages/designbook/src/node/api.ts:380-404`) calls:

```ts
createAgentSession({
  cwd: agentCwd, authStorage, modelRegistry,
  sessionManager: SessionManager.create(agentCwd),
  customTools: figmaTools,
})
```

No `resourceLoader` is passed, so `createAgentSession()` builds a bare
`DefaultResourceLoader({ cwd, agentDir, settingsManager })`
(`dist/core/sdk.js:75`) with no overrides at all. Effective behavior: Pi
picks up whatever `AGENTS.md`/`CLAUDE.md` exist walking up from the project
root — files written for a general engineering agent, not a
design-tool-scoped one — and (per the trust finding above) a project
`.pi/SYSTEM.md` if one happens to exist. designbook has no opinion, no
override, and no docs about any of this today.

### A constraint that shapes the design: `api.ts` never evaluates `designbook.config.tsx`

Every node-side file (`api.ts`, `server.ts`, `sidecar.ts`, `userVite.ts`)
treats `configPath` purely as a filesystem anchor (`dirname(configPath)`,
`relative(projectRoot, configPath)`) — none of them import or evaluate the
config file's contents. The config object (`defineConfig({...})`, with JSX
`sets`, `import.meta.glob`, React `providers`, etc. — see
`packages/designbook/src/config/index.ts`) is only ever evaluated **inside
the browser-side Vite** via the `virtual:designbook-config` module
(`server.ts:95-110`). Nothing today bridges a value from that object back to
the Node process that calls `createAgentSession()`.

This matters for the proposal below: a config field like
`agent: { instructions, inheritRepoInstructions }` living inside
`designbook.config.tsx` is not free — it would need new plumbing (the
browser POSTing it up before/with the first prompt, or a lightweight
non-JSX companion the config file re-exports that Node can statically
parse). A **plain sidecar file** next to the config (parallel to the
existing `designbook.vite.*` sidecar pattern the README already documents)
needs none of that: Node can `readFileSync` it directly, synchronously, the
same way it already resolves `configDir`/`configRelPath`.

## Recommended config surface

### File: `.designbook/agent.md` (or `<config-dir>/agent.md` if the config isn't in `.designbook/`)

Plain markdown with optional YAML frontmatter, matching the convention Pi's
own ecosystem already uses for `SKILL.md` (`pi-coding-agent/docs/skills.md`,
"Frontmatter" — `name`/`description` keys, "unknown frontmatter fields are
ignored"):

```markdown
---
inheritRepoInstructions: false   # default: true
---

# Designbook agent instructions

You're helping a designer iterate on this component library through a
visual canvas, not doing general engineering work. Prefer small, visually
verifiable changes. Never touch build config, CI, or dependencies. Always
leave the dataset/story data alone unless asked.
```

- **Discovery**: sibling to `designbook.config.tsx`, so `resolve(configDir,
  "agent.md")`. No new CLI flag needed for the common case; the file's mere
  presence turns the feature on (matches `designbook.vite.*` and
  `designbook:setup` — presence-based, not flag-based, is the established
  designbook convention per `worktrees.ts` and `userVite.ts`).
- **Precedence / merge semantics** (the `inheritRepoInstructions`
  frontmatter key):
  - `true` (default): designbook's instructions are **appended after** the
    repo's own `AGENTS.md`/`CLAUDE.md` — repo conventions (build/test
    commands, architecture notes) stay in effect, designer-specific
    scoping/tone layers on top. Implementation: `appendSystemPromptOverride`
    (append the file's body to whatever the base loader already computed).
  - `false`: designbook's file **replaces** context entirely for the Pi
    session designbook drives — repo `AGENTS.md`/`CLAUDE.md` are suppressed.
    Implementation: `agentsFilesOverride` returning only
    `{ path, content }` for `agent.md` (or `noContextFiles: true` plus
    `systemPromptOverride` if the intent is closer to "replace the whole
    system prompt," not just "replace the context-file layer" — see open
    question below on which one Michael wants).
  - No `.designbook/agent.md` present: unchanged from today — full repo
    `AGENTS.md`/`CLAUDE.md` inheritance, no designbook opinion injected.
- **Explicitly not `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md`.** Those are
  Pi's own generic, trust-gated mechanism, shared with anyone using bare
  `pi` in the same repo (not designbook-aware) and — per the trust finding
  above — currently only reachable through a security gap. designbook's file
  should live under `.designbook/` (or beside the config), be
  designbook-specific, and be wired via explicit `resourceLoader` overrides
  in `api.ts` rather than inherited accidentally.

### Implementation sketch (in `api.ts`)

```ts
// createSession(), before createAgentSession():
const agentInstructions = await loadDesignbookAgentInstructions(configDir);
// -> { content: string, inheritRepoInstructions: boolean } | undefined

const resourceLoader = agentInstructions
  ? new DefaultResourceLoader({
      cwd: agentCwd,
      agentDir: getAgentDir(),
      ...(agentInstructions.inheritRepoInstructions
        ? { appendSystemPromptOverride: (base) => [...base, agentInstructions.content] }
        : { agentsFilesOverride: () => ({ agentsFiles: [{ path: agentMdPath, content: agentInstructions.content }] }) }),
    })
  : undefined;
if (resourceLoader) await resourceLoader.reload();

const { session, modelFallbackMessage } = await createAgentSession({
  cwd: agentCwd, authStorage, modelRegistry,
  sessionManager: SessionManager.create(agentCwd),
  customTools: figmaTools,
  ...(resourceLoader ? { resourceLoader } : {}),
});
```

`getAgentDir()` is already exported by the SDK (`sdk.md` "Exports" list) so
global (`~/.pi/agent/AGENTS.md`) behavior is preserved either way.

### Why not the `agent: {...}` field inside `designbook.config.tsx`

Worth stating in the final doc even though it's what Michael originally
suggested: it's a fine *shape* (`agent: { instructions, inheritRepoInstructions
}`), but placing it inside the JSX config object means it only exists
browser-side today. If a code-level (not markdown-file) config surface is
wanted later — e.g. for programmatic instructions, or per-dataset variants —
the pragmatic path is: keep `.designbook/agent.md` as the primitive Node
reads directly, and optionally let `defineConfig({ agent: { instructions:
"..." } })` in the browser act as a convenience that, on first prompt, POSTs
its value to a new small endpoint (e.g. `PUT /api/agent-instructions`) that
`createSession()` consults instead of/alongside the file. That's strictly
more plumbing for the same outcome, so start with the file.

## What other embedded-agent / editor products do (for precedent)

- **Cursor**: precedence is tool-specific-first — `.cursor/rules/*.mdc`
  (project rules, conditional/glob-scoped) > legacy single-file
  `.cursorrules` (deprecated but still read) > `AGENTS.md` read as a
  cross-IDE fallback. The general pattern: an editor-specific, more
  structured instruction mechanism *overrides* the generic cross-tool
  `AGENTS.md`, rather than the other way around — supports designbook's file
  taking precedence over repo `AGENTS.md` when `inheritRepoInstructions:
  false`. ([comparison writeup](https://serenitiesai.com/articles/cursorrules-vs-agents-md-vs-claude-md-comparison))
- **Claude Code**: layers `CLAUDE.md` at enterprise / user (`~/.claude/CLAUDE.md`)
  / project / project-local scopes, all *merged* (appended) rather than
  one replacing another — supports the `inheritRepoInstructions: true`
  (append) default being the least-surprising choice for a tool whose users
  already expect layered instructions to add up, not silently replace each
  other.
- **Replit Agent**: doesn't expose an instruction-file override so much as
  ship its own opinionated scaffolding/auth defaults; less directly
  applicable to the instructions question, but its "defense in depth"
  framing (multiple independent layers, no single layer assumed sufficient)
  is a good model for pairing this feature with the security doc's
  trust-wiring backlog item rather than treating them as unrelated.

General cross-tool convention as of 2026: most agent products read
`AGENTS.md` as a baseline/fallback and layer a tool-specific file on top
when they want scoped behavior — designbook's `.designbook/agent.md`
following that same shape (specific-overrides-generic, opt-in replace) is
consistent with the ecosystem, not a novel pattern.

## Open questions

- inheritRepoInstructions:false — suppress just AGENTS.md/CLAUDE.md, or full system-prompt replace (SYSTEM.md-equivalent)? spec above assumes context-file-only.
- agent.md discovery: hardcode `.designbook/agent.md` next to config, or configurable path?
- ship default `.designbook/agent.md` template via `designbook init`, or docs-only (opt-in, no scaffold)?
- does `inheritRepoInstructions:false` also need to suppress global `~/.pi/agent/AGENTS.md`, or only project-level?
