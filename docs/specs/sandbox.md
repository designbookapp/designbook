# Sandbox — iterate on live-app selections (exploration)

Status: DECIDED (Michael 2026-07-10) — exploration track; variations feature stays untouched, compare later.

## Concept

Today iteration lives in a separate components area — you leave the place you saw the thing. Sandbox inverts it: in **app mode (collapsed/toolbar view)**, the AI prompt works like the select tool. Select any component instance in the live running app → a small prompt box appears anchored to it (Figma-comment style). Prompt for a direct edit (straight Pi turn) or for variants. Variants are generated into a sandbox with the selection's **captured runtime context** re-created as a wrapper, and land on a free-form absolute-position canvas (Figma-like: drag things around).

No pre-configured component needed — any instance, any configuration, as it runs live.

## Decisions (locked)

- **D1 non-destructive**: existing variations strip/flow untouched. Sandbox is parallel. If it works out, variations gets folded in/removed later.
- **D2 context capture v1**: designbook adapters (theme/i18n/flags/viewport) re-instantiated LIVE in the wrapper; everything else (app providers: query clients, routers, auth…) = **snapshot consumed values** via the context-scope walk + sampleValue caps, generated as literal stub providers. Variants look right in captured state; live behavior not promised. State this in UI copy ("captured state").
- **D3 replace = history**: after Replace, the sandbox entry is kept, marked `resolved: true`, hidden from canvas. Future (only if this works out): "show resolved", Remove/Delete.
- **D4 pins persist**: pins + threads + canvas positions stored in the sandbox index, survive reload.
- **D5 namespace**: `.designbook/sandbox/` under configDir (same base rule as variations — configDir, rebased per worktree). New `sandbox-event` SSE. No rename of variations anything.
- **D6 sessions**: each pin gets its OWN ephemeral Pi session (parallel pins = parallel sessions), inheriting the chat-selected model (setModel, like variations). Direct-edit prompts run on the pin's session too — NOT the main chat session.

## Architecture

### 1. Capture (`src/ui/models/sandbox/capture.ts`)
`captureSandboxContext(selection)` from the selection-context registry + fiber walk:
- `codeTarget` (file, exportName, owner, instance path) — the pin's durable identity
- props snapshot (sampleValue caps: depth 3, 8 entries, 80-char strings)
- consumed contexts w/ sampled values (context-scope contributor)
- active adapter state: theme, locale, flags, viewport
- non-serializable props/contexts recorded as `{ unserializable: "<type hint>" }` — the generator stubs these and the wrapper comments them.

### 2. Server (`src/node/api/sandbox.ts`, wired in api.ts)
- `POST /api/sandbox/pin` — create pin {target, contextSnapshot} → id; append to index
- `POST /api/sandbox/prompt` — {pinId, prompt, mode: "edit" | "variants", n?} 
  - `edit`: one turn on the pin's session against the REAL source file (branch-scoped via activeRepoRoot)
  - `variants`: director turn (reuse/generalize the variations director) → wrapper module + N variant files in `.designbook/sandbox/<pinId>/`, parallel sessions, per-variant landing
- `POST /api/sandbox/iterate` — {pinId, variantId, prompt} → turn on that variant file
- `POST /api/sandbox/replace` — {pinId, variantId} → Pi turn: rewrite original source using variant, PRESERVE original prop interface + real imports; gate: tsc on touched files; then mark entry resolved
- `POST /api/sandbox/position` — {pinId, variantId, x, y} persist drag
- SSE `sandbox-event`: {pinId, type: pin-created | director-started | variant-ready | variant-failed | turn-start | turn-end | replaced, …} — branch-tagged like variations-event
- Index: `.designbook/sandbox/index.ts` durable record + load thunks (same pattern as variations index): entries {id, createdAt, target, contextSnapshot, thread: [{role, text, at}], variants: [{id, file, x, y, status}], resolved}
- Turn-error diagnostics via extractTurnErrorMessage (reuse).

### 3. Wrapper generation (director skill)
Generated `<pinId>/wrapper.tsx`: re-creates adapter providers from captured state + literal stub providers for snapshot contexts + renders variant with captured props. Variants import ONLY the wrapper; skill rules: self-contained, intrinsic height (variations lessons carry over).

### 4. Pin UI (`src/ui/screens/sandbox/`)
- App-mode toolbar: selecting with the AI/select tool shows a compact **prompt box** anchored to the selection rect (overlay technique from AppFrameOverlay). Existing cards popover stays available (D1) — prompt box is additive, small "Go to component" link kept.
- Pin bubble states: idle → generating (spinner, "2/3 ready") → ready. Click → opens sandbox canvas focused on that pin's entry.
- Anchor by codeTarget re-resolution each render; element unmounted/off-route → pin lives in the **bottom-bar tray** (tray = overflow, always lists active pins + statuses).
- Pin thread renders like a comment thread (reuse chat activity rows for tool/thinking).

### 5. Canvas (`src/ui/screens/sandbox/SandboxCanvas.tsx`)
- Absolute-position canvas; variant cards draggable (pointer events, persist x/y via /position). Initial layout: simple non-overlapping grid seeding of x/y.
- v1 features ONLY: select a variant → inline prompt to tweak (iterate turn); select → **Replace with this** (confirm → /replace → entry resolved → canvas hides it). No pan/zoom v1 (scroll container).
- Resolved entries hidden (D3).

## Phases
- **P1**: capture + pin + prompt box + variants generation + canvas (view, drag, per-variant landing). 
- **P2**: iterate-on-variant + Replace w/ typecheck gate + resolved flow.
- **P3** (later, if kept): show-resolved, delete, pan/zoom, tray polish, fold variations in.

## Non-goals (v1)
Live data in variants (D2), multi-select, cross-component sandboxes, Vue targets, pan/zoom.

## Element-level variations (v2 — DECIDED 2026-07-11)

Variations of ANY single element/subtree (e.g. a div inside a component), not
just registered components. MVP: single element within one owner component.

### Decisions
- **E1 LLM extraction**: the director extracts the selected JSX span into a temp
  component (AST-based extraction deferred; revisit if this wins).
- **E2 controller wrapper (Michael's design)**: three layers —
  `SandboxProviders` (codegen, deterministic, unchanged) > `Controller`
  (LLM-authored at pin time: reads provider-derived values via the app's real
  hooks — t()/useProduct()/useLanguage()/… — INSIDE the provider tree; inlines
  purely-local values as literals; renders `<Variant {...props}/>`) > variants
  (presentational over the flat props contract; atoms allowed — providers exist
  above). Controller source doubles as the prop→original-expression mapping
  (`// from:` trailing comment per prop). SHIPPED NOTE: a span with NO free
  variables (e.g. ProductCard's badges-container div) legitimately yields an
  EMPTY props object — the artifact gate accepts a mapping-less controller
  only in that shape. Convention: original/variants export `Original`,
  controller exports `Controller({ V })`.
- **E3 hybrid contract everywhere**: component pins keep working as today;
  element pins add the contract. Unification of component pins onto the
  controller pattern = later, if this wins.
- **E4 Replace safety (elements)**: Replace re-inlines the winning variant into
  the owner file span using the controller mapping (t() re-wired, not frozen
  strings). Gate = tsc (existing) + NON-blocking runtime crash report: injected
  client reports window errors within ~20s post-replace into the pin thread as
  a warning; resolve is not blocked (HMR + Changes-tab revert cover recovery).
  Blocking render probe only if this proves risky. SHIPPED NOTE: the replace
  itself triggers a vite FULL RELOAD (source + index write), which would
  destroy an in-memory watch — the armed deadline persists in sessionStorage
  and re-arms on SandboxProvider mount, so the watch survives the reload the
  new code first renders under (live-probe finding).
- **E5 MVP scope**: one element, one owner component, no cross-component spans.

### Flow
select any DOM element (drill already reaches DOM levels) → prompt box offers
variants on element pins too → director: locate span in owner source (owner
file + element outerHTML as locator), extract temp component + author
controller → variants generated against the props contract → iterate as today
→ Replace re-inlines via mapping. Render-failure auto-fix loop covers
controller and variant crashes alike.

> **2026-07-14 — CONVERSATION-ROUTED ASKS** (docs/specs/changesets-on-git.md
> §Conversation-routed asks): in the FULL VIEW, selection-scoped prompts no
> longer spawn a separate pin thread — they run as normal turns of the
> persistent CONVERSATION session (pin chip on the message, per-turn
> workspace binding to the pin's changeset, variants anchored in the
> conversation). The SelectionPromptBar + composer intercept feed the
> conversation now. Pin threads remain the drill-in surface for a pin's
> cards/bake actions and full back-compat history; U1-U5 below describe the
> pin-thread pipeline that still powers the on-canvas page-mode flow and the
> variants machinery itself.

## UX v3 — prompt-first flow, threads, in-place canvas (DECIDED 2026-07-12)

Focus: COLLAPSED TOOLBAR (page mode) only. Host-mode/expanded-workbench UIs stay
in code, untouched, not the target experience.

### U1 Selection = just a prompt
Selecting an element shows ONLY: a small "what's selected" label + a prompt
box. NO Edit/Variants mode buttons, NO variant-count control, NO SelectionChip
action bar (Prompt Pi / Go to component buttons hidden in page mode; code
kept). The user describes what they want in plain words.

### U2 Submit → chat drawer, new THREAD
Return in the prompt box opens the existing docked chat drawer with the prompt
sent as the first message of a NEW THREAD anchored to the selection (= a pin
thread). Threads concept in the drawer:
- Header: current thread title (auto-generated) + back control to the ALL-
  THREADS list (each row: title, anchor label, status, last activity).
- Threads = pin threads (selection-anchored, like comments on parts of the
  app) + general chats (unanchored) INCLUDING FULL CHAT HISTORY: prior Pi
  sessions for this cwd (SessionManager transcripts) listed as threads,
  openable (rendered from transcript) and resumable where the SDK allows.
- Titles: LLM-generated after the first response lands (session model, one
  cheap turn); fallback = truncated first prompt.

### U3 Intent routing — no modes (REVISED per Michael 2026-07-12)
The agent decides freely what the turn is: it may just ANSWER a question,
perform an in-place edit, or — ONLY when the user clearly asks for
variations/options — trigger the variants pipeline. Mechanism: classify
"variants requested? {no | yes(n)}"; if no, run a NORMAL agent turn on the pin
session (it has selection context + edit tools and chooses whether to answer
or edit). N: 3 unless the user names a number, cap 5.

### U4 Generation transparency in the thread
The thread shows the director's thinking/tool activity live (reuse the chat
activity rows), then ONE expandable row PER variant sub-agent ("simulated
thinking"): collapsed = variant name + status (generating/ready/failed);
expanded = the brief it was given + its activity/errors. Same SSE plumbing
(sandbox-event), rendered in-thread.

### U5 Variant results — act from the thread
Per ready variant, in-thread actions:
- PREVIEW IN PLACE (temporary replace): toggle that renders the variant AT the
  live element's position (overlay root: SandboxProviders>controller>variant in
  captured state; original hidden while active). Toggling another variant swaps;
  toggling off restores the original. NO source edit. Clearly badged "preview".
- Open Canvas → U6. Real Replace stays available (canvas + thread action) with
  the existing gates/guardrails.

### U6 Canvas in place
"Open canvas" swaps the drawer content for the sandbox canvas of that pin,
anchored bottom-right like the drawer but larger: ~50% viewport width, near-
full height, with a full-screen toggle. NOT the expanded workbench route —
same canvas surface mounted in the drawer shell. Same capabilities as today
(drag, resize frames, iterate, replace). Back control returns to the thread.

### Phasing
- V3-P1: U1 + U2 + U3 (prompt-only selection, threads UI, intent routing,
  in-place edits).
- V3-P2: U4 + U6 (transparency rows, in-place canvas w/ fullscreen).
- V3-P3: U5 temporary in-place preview.
