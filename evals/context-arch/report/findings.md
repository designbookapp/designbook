# Findings — replay (before) vs curated (after)

Before = `2026-07-11T05-52-44-387Z` (full-replay baseline). After = `2026-07-11T07-40-50-035Z-curated` (keep-log + last-3-turns + state doc + `state_update`/`recall` tools). Same 8 tasks, same pinned `claude-opus-4-8`, thinking medium.

- **Quality parity held: 97/97 scripted checks on BOTH architectures.** Every forgetting probe passed under curated — the teal-700 amendment applied from memory at turns 5/6/15, the atoms.tsx ban held and was named, original copy quoted, recaps correct — with turns 1–15 literally absent from context. The state doc + keep-log carried it. One judge regression: task 05 `unrequested_edits` (curated anticipated turn 2's locale keys in turn 1 — scope creep by rubric; replay had none).
- **Curated LOSES on cost at ≤18 turns: $3.105 vs $1.504 (2.1×).** Cost/turn: short $0.0479 vs $0.0247 (+94%), long $0.0532 vs $0.0247 (+115%). Three drivers: (1) the mutable state doc sits after the last cache breakpoint → ~460 uncached input tok/call at full price (replay: 2); (2) window slides rewrite the recent window every turn → cacheWrite 196K vs 60K (3.2×); (3) `state_update` adds ~27 extra LLM calls and +40% output tokens (32.4K vs 23.1K). Replay's cache economics (0.1× reads, breakpoint always at the tail) are brutally good at this length.
- **Curated wins the thing it was built for: context size stops growing.** Task 07 last-call prompt: replay climbs 4.5K → 16.1K linearly (~680 tok/turn); curated plateaus at ~12–14K from turn 8 (turns 9–18 add ~50 tok/turn). Final-turn context: 07 16.1K → 13.0K (−20%), 08 13.0K → 10.4K (−20%). Short tasks go the other way (01: 5.3K → 6.8K) — the keep-log + state-doc floor costs more than a 4-turn history.
- **Per-call p50 latency dropped 1.73s → 1.46s** (smaller prompts answer faster), but wall/turn went UP (short +15%, long +49%) — extra state_update round-trips dominate. Total wall 8.5 → 11.3 min.
- **Keep-log prefix caching works as designed (sanity check): zero calls (beyond each task's first) with cacheRead=0**; on window-slide first-calls the cache still serves ≥4.7K tok (system + tools + keep-log survive the slide). Cached share of prompt tokens: **82.5% curated vs 94.7% replay** — the 12pp gap is the state doc + slide rewrites.
- `recall` was almost never used (1 call across 61 turns); the model leaned on state doc + keep-log. `state_update` usage varied 0–15 calls/task — tasks where it skipped updates (03, 05) still passed because the keep-log carries user prompts verbatim.

# Verdict

- **At ≤18 turns curated is a net loss**: 2.1× cost, +32% wall, one scope-creep flag, in exchange for −20% final context on long tasks. Full-replay stays the right default in this regime.
- **The crossover is real but further out.** Curated's context is ~flat once the window fills (~50 tok/turn vs replay's ~680), so replay's linear growth catches up: prompts cross near ~30 turns, replay's cache-read base keeps compounding after that, and replay eventually hits the context-window ceiling / compaction cliffs, which curated never does. The 40+-turn / large-file regime (real sandbox sessions) is where curated should win; this suite doesn't reach it.
- **Cheap wins available before re-testing**: (1) move the 4th cache breakpoint ONTO the state doc (drop the newest-message one) — the doc only changes when the model edits it, so most calls would cache-hit it instead of paying full input price (~$0.6 of the gap); (2) batch state maintenance into one `state_update` per turn (fewer calls, less output); (3) stop duplicating recent-window prompts in the keep-log (append on age-out instead).

# Next steps

- Extend the task set past the crossover: 30–40-turn sessions and/or the mono-app fixture with large file reads, where replay's extrapolated 30–60K-token prompts and curated's flat ~13K should separate decisively on cost AND latency.
- Re-run curated with the three cheap wins above before the long-regime head-to-head.
- Watch scope creep under curated: the state doc's plan section may encourage the model to "get ahead" of scripted turns (the 05 flag). Consider a system-prompt line: do only what the current turn asks.
