# Pi setup + security hardening (draft)

Status: research draft for OSS launch docs. Not yet reviewed. All claims below
are grounded in the code as of this worktree (`pi-coding-agent@0.80.3`,
`packages/designbook/src/node/{api,server,sidecar}.ts`).

## The trust model, in one paragraph

designbook embeds a Pi coding agent with **full bash + file read/write/edit
tools**, **no permission gate**, **no request auth**, and (as of this
investigation) a **silently auto-trusted project**. Anyone who can make an
HTTP request to the sidecar — a browser tab you have open, a script on your
LAN, or (in `--host 0.0.0.0` mode) any device on your network — can drive Pi
to run shell commands and rewrite files in your repo, or write files directly
through the non-agent data endpoints. There is currently no confirmation
step between "a prompt arrived at `/api/prompt`" and "code changed on disk."

## Concrete facts (grounded in code)

### 1. Pi has bash + write access by default, in your real repo

`createSession()` in `packages/designbook/src/node/api.ts:380-404` calls:

```ts
createAgentSession({ cwd: agentCwd, authStorage, modelRegistry,
  sessionManager: SessionManager.create(agentCwd), customTools: figmaTools })
```

No `tools` allowlist and no `noTools` is passed. Per the SDK
(`pi-coding-agent/docs/sdk.md`, "Tools" section), the default built-ins are
`read, bash, edit, write` — i.e. Pi can run arbitrary shell commands and
write arbitrary files, with the permissions of whatever user account started
`designbook`/`designbook dev`. `agentCwd` is `projectRoot` — the git root
above your config file (`api.ts:76`), so this is your real working tree, not
a sandbox.

### 2. No auth on `/api/prompt` or any data-write endpoint

`packages/designbook/src/node/api.ts` routes (`handle()`, line ~1333) never
check for a token, cookie, or any credential. Every route — `/api/prompt`,
`/api/file` (POST, arbitrary source file write for `.tsx/.ts/.jsx/.js/.css/
.json/.md`), `/api/json`, `/api/style`, `/api/i18n`, `/api/po` — accepts the
request as-is. `server.ts`'s `applyApiCors()` (line 65) only decides whether
to **echo CORS response headers**; it never rejects a request based on
origin, and it doesn't run at all for non-browser clients (curl, another
process) since CORS is a browser-enforced concept.

### 3. This is exploitable even in the localhost-only default — not just `--host`

`handlePrompt`'s body reader (`readJsonBody`, `api.ts:449-469`) never checks
`Content-Type`; it just buffers the body and `JSON.parse`s it. Combined with
fact #2, this means a "simple" cross-origin request — e.g. from **any web
page you have open in the same browser** while `designbook` is running —
can reach `/api/prompt` without a CORS preflight at all:

```js
fetch("http://localhost:8787/api/prompt", {
  method: "POST",
  mode: "no-cors",                              // no preflight required
  headers: { "Content-Type": "text/plain" },    // CORS-safelisted content type
  body: JSON.stringify({ message: "<attacker prompt>" }),
});
```

`text/plain` is a CORS-safelisted content type, so this is a "simple
request": the browser sends it with **no preflight**, and — because
designbook never validates `Content-Type` — the server happily
`JSON.parse`s the body and runs the prompt. The attacker page can't read the
response (`no-cors` blocks that), but the write already happened. This is
the same trust-boundary bug behind CVE-2025-49596 (Anthropic MCP Inspector
RCE via unauthenticated localhost + no origin check) — see
[Oligo Security's writeup](https://www.oligo.security/blog/critical-rce-vulnerability-in-anthropic-mcp-inspector-cve-2025-49596)
and [Rafter's "localhost is not a trust boundary"](https://rafter.so/blog/incidents/clawjacked-localhost-trust-boundary).
**"It only binds to localhost" is not the mitigation it sounds like.**

### 4. `--host 0.0.0.0` (LAN mode) removes even the localhost requirement — and we ship it as a documented pattern

`packages/designbook/src/cli/dev.ts` and the host-mode CLI both accept
`--host`, and `examples/demo/package.json` ships:

```json
"start:lan": "designbook designbook.config.tsx --host 0.0.0.0 --no-open"
```

With this, everything in #2/#3 above is reachable by **any device on the
LAN**, no browser or CORS trick needed — a plain `curl` from another laptop
on the coffee-shop wifi works.

### 5. The project is auto-trusted — repo-supplied extension code runs with zero prompt

**Status: FIXED (launch-minimal), see backlog item #4 below for what shipped
and what's still open.** The rest of this section describes the bug as found;
it is no longer designbook's default behavior.

This is the least obvious and most important finding. Pi's own CLI has a
"project trust" gate (`pi-coding-agent/docs/security.md`): before running
project-local `.pi/settings.json`, `.pi/extensions/*.ts`, `.pi/SYSTEM.md`,
etc., interactive Pi asks the user to confirm. Non-interactive Pi
(`-p`/`--mode json`/`--mode rpc`) defaults to `defaultProjectTrust: "ask"`,
which **skips** those resources absent a saved decision.

designbook uses neither path — it calls the raw SDK `createAgentSession()`
directly. Tracing that call in `pi-coding-agent@0.80.3`:

- `createAgentSession()` (`dist/core/sdk.js:74`) builds
  `settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir)`
  — designbook passes no `settingsManager`, so this runs.
- `SettingsManager.create()` → `fromStorage()` (`dist/core/settings-manager.js:152-153`):
  `const projectTrusted = options.projectTrusted ?? true;` — **defaults to
  `true`** when no options are passed.
- `createAgentSession()` then builds
  `resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager })`
  and calls `await resourceLoader.reload()` **with no arguments**
  (`dist/core/sdk.js:75-76`). `DefaultResourceLoader.reload()`
  (`dist/core/resource-loader.js:219-230`) only re-resolves trust when
  called with a `resolveProjectTrust` callback; without one it "preserves"
  whatever `settingsManager.projectTrusted` already is — which is `true`.

Net effect: **every designbook session trusts the project by default**,
silently, with no prompt anywhere in the UI. Any repo opened with designbook
— including one a user just cloned — will have its `.pi/extensions/*.ts`
auto-loaded and executed (arbitrary TypeScript, same process, same
permissions as the user), its `.pi/settings.json` applied, and its
`.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md` used to shape the system prompt — all
without the confirmation step Pi's own CLI would show. This is a real
supply-chain vector: a malicious/compromised repo can ship a `.pi/extensions/`
payload that runs the moment someone opens it in designbook.

(Context files — `AGENTS.md`/`CLAUDE.md` — are loaded regardless of trust in
Pi's model too, so that part is unchanged; the delta introduced by
designbook's embedding is specifically `.pi/extensions`, `.pi/settings.json`,
and `.pi/SYSTEM.md`/`APPEND_SYSTEM.md` going from "gated" to "always on.")

### 6. No git hygiene guard; branch-instance ("worktrees") feature exists but isn't wired to agent isolation

Grepping `packages/designbook/src` finds no dirty-tree check, no
confirm-before-write, nothing that stops the agent from writing into an
already-dirty working tree. designbook does ship a git-worktree-backed
**branch instances** feature (`packages/designbook/src/node/worktrees.ts`,
docs at `docs-site/src/content/docs/branch-instances.md`) — but it exists to
let you preview another branch's components alongside your current one, not
to isolate agent sessions. It's real infrastructure that a "run Pi in a
scratch worktree" recommendation could reuse, but today it isn't framed that
way anywhere.

### 7. API keys: not stored in the repo, but shared machine-wide

`api.ts:92` calls `AuthStorage.create()` with no path override, which
defaults to `~/.pi/agent/auth.json` (global, shared with any other Pi/`pi`
CLI usage on the machine) per `pi-coding-agent/docs/sdk.md` ("API Keys and
OAuth"). `packages/designbook/src/cli/init.ts:509` tells users the chat tab
"needs `ANTHROPIC_API_KEY` in the shell that runs `... design`" — i.e. the
documented path today is an environment variable, resolved by the SDK's
standard priority (runtime override → `auth.json` → env var → custom
resolver). Good: no key ever needs to live in the project repo or config
file. Worth stating explicitly in docs so users don't invent their own
`.env`-in-repo pattern.

## Recommended user-facing docs (write these now)

1. **State the trust model up front, not buried in a FAQ.** Something like:
   "Anyone who can reach the designbook sidecar — including any browser tab
   open on your machine while it's running — can make Pi edit or run
   commands in this repo. Treat the sidecar port like a root shell into the
   project, because functionally it is one." Lead with fact #3 (localhost
   isn't a full mitigation), not just fact #4 (LAN mode).

2. **Default to localhost; make `--host`/LAN mode a scary, explicit opt-in.**
   Current README (`packages/designbook/README.md:24`) lists `--host
   localhost` as just another flag next to `--port`/`--no-open`/`--debug` —
   no warning. Recommend: a dedicated "LAN / demo mode" doc section that (a)
   explicitly says this exposes an unauthenticated code-editing agent to
   everyone on the network, (b) recommends it only for short-lived, trusted
   demos, disconnected from other agent-holding repos, (c) tells people to
   turn it off when done. Also flag `examples/demo/package.json`'s
   `start:lan` script/`docs/`s "demo:lan" precedent as the pattern to be
   careful copying into user projects.

3. **Recommend a dedicated branch or worktree per agent session.** Point at
   the existing branch-instances feature and suggest: run designbook (and
   therefore Pi) against a scratch branch/worktree, commit or stash before
   prompting, and review the diff before merging. This is a mitigation for
   fact #6 (no dirty-tree guard) that ships today with zero code changes —
   purely a docs/workflow recommendation.

4. **API key handling section**: document the env var path
   (`ANTHROPIC_API_KEY` etc.) as primary, mention `~/.pi/agent/auth.json` as
   the SDK's persistent alternative (e.g. after `pi login` if the user has
   pi installed separately), and explicitly say **do not** put API keys in
   `designbook.config.tsx` or any file that gets committed — there is
   currently no config-driven key path in designbook itself, so this is
   mostly "don't invent one."

5. **A short hardening checklist** distilled from the above:
   - Keep `--host` at its `localhost` default unless you have a specific,
     time-boxed reason not to (demoing to people physically present, on a
     network you trust).
   - Don't leave `designbook`/`designbook dev` running in the background on
     a machine while browsing untrusted sites (fact #3 CSRF vector) — treat
     it like any other credentialed localhost dev server.
   - Projects are untrusted by default (fact #5, fixed): `.pi/extensions`,
     `.pi/settings.json`, `.pi/SYSTEM.md` don't load unless you pass
     `--trust-project`. Only pass it for repos you'd vet like a
     `postinstall` script — it's a static, session-wide opt-in, not a
     per-extension prompt.
   - Run agent sessions from a clean working tree, ideally a scratch branch
     or worktree, so a bad edit is a `git diff`/`git reset` away from
     undone, not mixed into your uncommitted work.
   - Never commit `~/.pi/agent/auth.json`; never put API keys in
     `designbook.config.tsx` or repo-tracked files.

## Product backlog (build later — do not imply these exist in docs)

Ordered roughly by leverage-per-effort:

1. **Bind-address guard for `--host`.** Refuse (or require a second
   confirmation flag, e.g. `--host 0.0.0.0 --i-know-what-im-doing`) non-loopback
   binds unless explicitly acknowledged. Cheapest change with the highest
   payoff against fact #4.

2. **Origin/Host header validation on `/api/*`.** Reject requests whose
   `Origin` (when present) isn't in the localhost allowlist already computed
   by `applyApiCors` (`server.ts:53-92`), and reject requests whose `Host`
   header doesn't match the bound host/port (closes the DNS-rebinding
   variant of fact #3). This is a request-time check, distinct from the
   CORS response headers that exist today — currently nothing rejects the
   request itself.

3. **A same-origin/session token for `/api/*`.** E.g. mint a random token at
   startup, print it once, require it as a header or query param the
   workbench UI already has (it's same-origin/same-process, so it can read
   it from the served HTML). This is the direct fix for facts #2/#3 — closes
   the same class of bug as CVE-2025-49596's fix (session-token-gated
   localhost proxy).

4. **Explicit project-trust wiring — IMPLEMENTED (launch-minimal).**
   `createSession()` (`packages/designbook/src/node/api/api.ts`) now passes an
   explicit `settingsManager: SettingsManager.create(agentCwd, undefined,
   { projectTrusted: trustProject })` into `createAgentSession()`, alongside
   the existing `sessionManager`. `trustProject` defaults to `false`, so
   `.pi/settings.json` and `.pi/extensions/*.ts` no longer auto-load for a
   repo you just opened/cloned — `.pi/SYSTEM.md`/`APPEND_SYSTEM.md` are
   likewise gated (`resource-loader.js` checks
   `settingsManager.isProjectTrusted()` before reading them). Opt in with the
   `--trust-project` CLI flag (mirrors `--read-only`; wired through both host
   mode, `src/cli/index.ts`, and `designbook dev`, `src/cli/dev.ts`). When a
   project is untrusted and has a `.pi/` directory, designbook broadcasts a
   one-time `server-notice` explaining why extensions/settings didn't load
   and how to opt in.
   Verified at the SDK level (`SettingsManager.create(cwd, agentDir,
   {projectTrusted:false}).getProjectSettings()` returns `{}`; `true` loads
   the file) and live (a `.pi/extensions/evil.ts` with a module-load side
   effect only runs when `--trust-project`/`trustProject:true` is set).
   NOT done (still backlog): the in-workbench "trust this project?" prompt UI
   and a `resolveProjectTrust` callback for interactive re-prompting —
   `--trust-project` is a static, launch-time opt-in only. AGENTS.md/CLAUDE.md
   behavior is unchanged (trust-independent, matching Pi's own model).

5. **Confirm-before-write / diff-review mode.** A setting that holds file
   writes from `edit`/`write` tool calls (and the `/api/file`, `/api/json`,
   `/api/style`, `/api/i18n`, `/api/po` data endpoints) behind an in-UI
   approve step, showing a diff before it lands on disk. Bigger lift; likely
   the highest-value feature for a "trust but verify" posture once the
   auth-gap items above are closed.

6. **Read-only / restricted-tools mode.** Expose the SDK's existing
   `tools`/`noTools` options (`sdk.md` "Tools") as a designbook config or CLI
   flag — e.g. `--read-only` maps to `tools: ["read","grep","find","ls"]` — for
   users who want Pi to propose changes without bash/write access at all.
   This is nearly free since the SDK already supports it; designbook just
   never threads a value through in `api.ts:380-387`.

7. **Git dirty-tree warning.** Before the first prompt in a session, check
   `git status --porcelain` in `projectRoot` and surface a workbench warning
   ("working tree has uncommitted changes — Pi's edits will mix with them")
   if dirty. Cheap, complements recommendation #3 above without requiring
   users to remember it themselves.
