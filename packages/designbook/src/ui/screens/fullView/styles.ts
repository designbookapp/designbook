/**
 * All CSS for the full-view prototype, scoped under `.dbproto`. Injected once by
 * FullView via a <style> tag so the prototype is fully self-contained and can
 * use hover/transition/animation without depending on the host's Tailwind
 * classes resolving inside whatever mount context it renders in.
 *
 * Real workbench components mounted INSIDE the prototype (AdapterPanel,
 * InfoPanel, CodePanel, DesignChat) are wrapped in a `.dark .dbproto-embed`
 * container so they pick up the workbench's own dark shadcn tokens — the
 * proto css deliberately does not restyle their internals.
 */

export const protoCss = `
.dbproto, .dbproto * { box-sizing: border-box; }
.dbproto {
  --bg: #0b0e14;
  --chrome: #10141c;
  --panel: #141a24;
  --elev: #1b2230;
  --elev2: #222b3b;
  --border: #29323f;
  --border2: #364152;
  --text: #d6dde6;
  --muted: #8a94a3;
  --faint: #5c6675;
  --accent: #4c8dff;
  --accent-dim: #1f6feb;
  --green: #3fb950;
  --amber: #d29922;
  --pink: #db61a2;
  --radius: 8px;
  position: absolute; inset: 0;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px; line-height: 1.45;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
.dbproto button { font: inherit; color: inherit; cursor: pointer; border: none; background: none; }
.dbproto button:disabled { cursor: not-allowed; }
.dbproto ::-webkit-scrollbar { width: 10px; height: 10px; }
.dbproto ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
.dbproto ::-webkit-scrollbar-track { background: transparent; }

/* ---- layout shell ---- */
.dbproto-shell { position: absolute; inset: 0; display: flex; flex-direction: column; }
.dbproto-body { flex: 1; display: flex; min-height: 0; }
.dbproto-mid { flex: 1; display: flex; min-width: 0; position: relative; }

/* ---- center chrome bars (built INTO the rounded container) ---- */
.dbproto-centerbar {
  flex: none; height: 46px; display: flex; align-items: center; gap: 6px;
  padding: 0 10px; background: var(--panel); color: var(--text);
}
.dbproto-centerbar.top { border-bottom: 1px solid var(--border); }
.dbproto-centerbar.bottom { border-top: 1px solid var(--border); justify-content: center; }
.dbproto-centerbar-spacer { flex: 1; }

/* ---- tool picker (center footer) ---- */
.dbproto-toolpick { display: flex; gap: 2px; padding: 3px; background: var(--elev); border: 1px solid var(--border); border-radius: 9px; }
.dbproto-toolpick button { width: 34px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.dbproto-toolpick button:hover:not(:disabled) { color: var(--text); background: var(--elev2); }
.dbproto-toolpick button.active { background: var(--accent-dim); color: #fff; }
.dbproto-toolpick button:disabled { opacity: .38; }

/* ---- dropdown ---- */
.dbproto-dd { position: relative; }
.dbproto-dd-btn {
  display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  border-radius: 7px; background: var(--elev); border: 1px solid var(--border);
  color: var(--text); font-size: 12.5px; white-space: nowrap;
}
.dbproto-dd-btn:hover { background: var(--elev2); border-color: var(--border2); }
.dbproto-dd-btn .lbl-muted { color: var(--muted); }
.dbproto-dd-btn .lbl-mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
.dbproto-dd-menu {
  position: absolute; top: calc(100% + 6px); z-index: 50; min-width: 220px; max-height: 50vh; overflow-y: auto;
  background: var(--elev); border: 1px solid var(--border2); border-radius: 10px;
  padding: 5px; box-shadow: 0 12px 34px rgba(0,0,0,.5);
}
.dbproto-dd-menu.right { right: 0; }
.dbproto-dd-item {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 7px 8px; border-radius: 7px; color: var(--text);
}
.dbproto-dd-item:hover { background: var(--elev2); }
.dbproto-dd-item.active { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.dbproto-dd-item .sub { color: var(--muted); font-size: 11.5px; }
.dbproto-dd-check { margin-left: auto; color: var(--accent); display: flex; }
.dbproto-dd-foot { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px; }
.dbproto-dd-group { padding: 7px 8px 3px; color: var(--muted); font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.dbproto-dd-section:not(:first-child) { border-top: 1px solid var(--border); margin-top: 4px; }

/* ---- viewport segmented ---- */
.dbproto-seg { display: flex; gap: 2px; padding: 3px; background: var(--elev); border: 1px solid var(--border); border-radius: 9px; }
.dbproto-seg button { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 6px; color: var(--muted); font-size: 12px; }
.dbproto-seg button:hover { color: var(--text); }
.dbproto-seg button.active { background: var(--accent-dim); color: #fff; }

/* ---- icon rail ----
 * 64px wide so the absolutely-positioned play button (16px inset, 44px round —
 * the EXACT screen spot the boot pencil occupies) fits inside the rail. */
.dbproto-rail {
  width: 64px; flex: none; background: var(--chrome); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center; padding: 8px 0 76px; gap: 4px;
}
.dbproto-rail-spacer { flex: 1; }
.dbproto-railbtn {
  width: 38px; height: 38px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
  color: var(--muted); position: relative;
}
.dbproto-railbtn:hover { background: var(--elev); color: var(--text); }
.dbproto-railbtn.active { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.dbproto-railbtn.active::before { content: ""; position: absolute; left: -13px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--accent); }

/* ---- play / pencil: the SAME screen position (left 16 / bottom 16), both
 * perfectly round 44px circles. The play button lives in edit mode (exits to
 * the running app); the pencil is the host-mode fallback in the collapsed
 * (full-bleed) state. The boot module's pencil copies these exact metrics. */
.dbproto-playbtn, .dbproto-floatbtn {
  position: absolute; left: 16px; bottom: 16px; z-index: 70;
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--accent-dim); color: #fff;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 22px rgba(31,111,235,.5), 0 0 0 1px rgba(255,255,255,.12);
}
.dbproto-playbtn:hover, .dbproto-floatbtn:hover { background: var(--accent); }
.dbproto-floatbtn { animation: dbproto-pop .2s ease; }
.dbproto-floatbtn:hover { transform: scale(1.06); }
@keyframes dbproto-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }

/* ---- left panel (collapsible: width animates, inner keeps its width) ---- */
.dbproto-leftpanel {
  width: 380px; flex: none; background: var(--panel); border-right: 1px solid var(--border);
  overflow: hidden; transition: width .2s ease, opacity .18s ease;
  animation: dbproto-slide-in .2s ease;
}
.dbproto-leftpanel.closed { width: 0; opacity: 0; border-right: none; }
.dbproto-panel-inner { width: 380px; height: 100%; display: flex; flex-direction: column; min-height: 0; }
.dbproto-rightpanel .dbproto-panel-inner { width: 320px; }
@keyframes dbproto-slide-in { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: none; } }

/* ---- panel resize handles (inner edge of each side panel) ----
 * A slim flex sibling overlapping the panel border; pointer capture keeps the
 * drag alive across the iframe. While dragging, .dbproto-resizing suppresses
 * the panels' width transition and the iframe's pointer events. */
.dbproto-resizer {
  flex: none; width: 7px; margin: 0 -3px; z-index: 30;
  cursor: col-resize; position: relative; touch-action: none;
}
.dbproto-resizer::after {
  content: ""; position: absolute; inset: 0 2px;
  background: transparent; transition: background .12s ease;
}
.dbproto-resizer:hover::after, .dbproto-resizer.active::after {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}
.dbproto-resizing { cursor: col-resize; user-select: none; }
.dbproto-resizing .dbproto-leftpanel, .dbproto-resizing .dbproto-rightpanel { transition: none; }
.dbproto-resizing iframe { pointer-events: none; }

/* ---- small icon button (center-bar panel toggles) ---- */
.dbproto-iconbtn { width: 30px; height: 30px; flex: none; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.dbproto-iconbtn:hover { background: var(--elev); color: var(--text); }
.dbproto-panel-head { flex: none; display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.dbproto-panel-head .dbproto-dd-btn { width: 100%; justify-content: space-between; }
.dbproto-panel-title { font-weight: 600; font-size: 13.5px; }
.dbproto-panel-sub { color: var(--muted); font-size: 11.5px; }
.dbproto-panel-scroll { flex: 1; overflow-y: auto; min-height: 0; }
.dbproto-panel-fill { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbproto-panel-error { padding: 6px 14px; color: #f85149; font-size: 11.5px; }
.dbproto-panel-error button { text-decoration: underline; }

/* ---- embedded REAL workbench panels (AdapterPanel / InfoPanel / CodePanel /
 * DesignChat) — the .dark wrapper flips the shadcn tokens; this class only
 * handles sizing so the embedded panel owns its own scrolling when needed. */
.dbproto-embed { color-scheme: dark; }
.dbproto-embed.fill { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.dbproto-embed.fill > * { flex: 1; min-height: 0; }

/* ---- chat: thread navigation ---- */
.dbproto-subhead { flex: none; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); min-height: 40px; }
.dbproto-subhead-title { flex: 1; min-width: 0; font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbproto-backbtn { width: 26px; height: 26px; flex: none; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.dbproto-backbtn:hover { background: var(--elev); color: var(--text); }

.dbproto-threadlist { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.dbproto-threadrow { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 10px; border-radius: 9px; cursor: pointer; }
.dbproto-threadrow:hover { background: var(--elev); }
.dbproto-threadrow .meta { min-width: 0; flex: 1; }
.dbproto-threadrow .title { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; }
.dbproto-threadrow .title > span:first-child { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbproto-threadrow .sub { color: var(--muted); font-size: 10.5px; display: flex; align-items: center; gap: 4px; }
.dbproto-threadrow .when { flex: none; color: var(--faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.dbproto-statusdot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--faint); }
.dbproto-statusdot.ready { background: var(--accent); }
.dbproto-statusdot.failed { background: #f85149; }
.dbproto-statusdot.busy { background: var(--amber); animation: dbproto-pulse 1s ease-in-out infinite; }
.dbproto-empty { color: var(--faint); font-size: 11.5px; padding: 10px 14px; }

/* ---- chat: thread view ---- */
.dbproto-chat { padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.dbproto-msg { display: flex; flex-direction: column; gap: 6px; }
.dbproto-msg.user { align-items: flex-end; }
.dbproto-bubble { max-width: 86%; padding: 9px 12px; border-radius: 13px; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dbproto-bubble.user { background: var(--accent-dim); color: #fff; border-bottom-right-radius: 4px; }
.dbproto-bubble.asst { background: var(--elev); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.dbproto-collapse-row {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; padding: 6px 8px;
  border-radius: 8px; color: var(--muted); font-size: 12px; border: 1px solid transparent;
}
.dbproto-collapse-row:hover { background: var(--elev); color: var(--text); }
.dbproto-act-body { padding: 4px 10px 4px 26px; display: flex; flex-direction: column; gap: 5px; color: var(--faint); font-size: 11.5px; border-left: 1px solid var(--border2); margin-left: 13px; }
.dbproto-act-body .error { color: #f85149; }
.dbproto-act { display: flex; align-items: center; gap: 7px; padding: 3px 0; color: var(--faint); font-size: 11.5px; min-width: 0; }
.dbproto-act > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* shimmer for live activity summaries */
.dbproto-shimmer { animation: dbproto-pulse 1.4s ease-in-out infinite; }

/* status pills */
.dbproto-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; letter-spacing: .2px; text-transform: uppercase; }
.dbproto-pill.ready { background: color-mix(in srgb, var(--green) 20%, transparent); color: var(--green); }
.dbproto-pill.generating, .dbproto-pill.updating { background: color-mix(in srgb, var(--amber) 20%, transparent); color: var(--amber); }
.dbproto-pill.failed { background: color-mix(in srgb, #f85149 20%, transparent); color: #f85149; }
.dbproto-pill.queued { background: var(--elev2); color: var(--muted); }
.dbproto-pill.warn { background: color-mix(in srgb, var(--amber) 18%, transparent); color: var(--amber); text-transform: none; letter-spacing: 0; font-weight: 500; }
.dbproto-pill.info { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); text-transform: none; letter-spacing: 0; font-weight: 500; }
.dbproto-dot-spin { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: dbproto-pulse 1s ease-in-out infinite; }
@keyframes dbproto-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

/* ---- history explorer (G4): accordion under the chat title bar ---- */
.dbproto-histo-accordion {
  flex: none; overflow: hidden; border-bottom: 1px solid var(--border);
  background: var(--chrome);
  max-height: 0; transition: max-height .22s ease;
}
.dbproto-histo-accordion.open { max-height: 46vh; overflow-y: auto; }
.dbproto-histo { padding: 10px 12px; display: flex; flex-direction: column; gap: 12px; }
.dbproto-histo-cs { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
.dbproto-histo-cshead { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-bottom: 1px solid var(--border); }
.dbproto-histo-cstitle { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbproto-histo-graph { position: relative; overflow-x: auto; }
.dbproto-histo-svg { position: absolute; left: 0; top: 0; pointer-events: none; }
.dbproto-histo-basedot { position: absolute; width: 8px; height: 8px; border-radius: 50%; background: var(--border2); }
.dbproto-histo-dot {
  position: absolute; width: 12px; height: 12px; border-radius: 50%;
  background: var(--faint); border: 2px solid var(--panel); padding: 0;
  transition: transform .12s ease, box-shadow .12s ease;
}
.dbproto-histo-dot:hover { transform: scale(1.35); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
.dbproto-histo-dot.onpath { background: var(--accent); }
/* Round-2: dots on the parked ("viewing") ancestry ride the amber trace. */
.dbproto-histo-dot.onview { background: var(--amber); }
.dbproto-histo-dot.parked { background: var(--amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 35%, transparent); }
.dbproto-histo-tipdot { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: var(--border2); }
.dbproto-histo-tipdot.onpath { background: var(--accent); }
.dbproto-histo-label {
  position: absolute; height: 26px; display: flex; align-items: center;
  font-size: 11px; color: var(--muted); white-space: nowrap;
}
.dbproto-histo-label.faint { color: var(--faint); }
.dbproto-histo-label.parked { color: var(--amber); }
/* inline-block (not flex): text-overflow needs the text inline so long
   titles ELLIPSIZE instead of clipping at the panel edge. */
.dbproto-histo-pill {
  position: absolute; height: 20px; line-height: 18px; padding: 0 9px;
  border-radius: 999px; display: inline-block; box-sizing: border-box;
  max-width: 180px;
  background: var(--elev); border: 1px solid var(--border2); color: var(--text);
  font-size: 10.5px; font-weight: 600; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;
}
.dbproto-histo-pill:hover { background: var(--elev2); }
.dbproto-histo-pill.selected { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.dbproto-histo-pill.fork { border-style: dashed; }
/* In-place rename (double-click a pill): same pill geometry as an input. */
.dbproto-histo-pill.editing {
  outline: none; border-color: var(--accent); background: var(--elev2);
  color: var(--text); font: inherit; font-size: 10.5px; font-weight: 600;
}
/* Turns another conversation landed on a shared rail (reused pin): kept in
   the graph, visually attributed as foreign. */
.dbproto-histo-dot.foreign { opacity: .45; }
.dbproto-histo-label.foreign { opacity: .55; }
/* "Viewing turn N" banner (park preview) in the chat/thread views. */
.dbproto-histo-banner {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-bottom: 1px solid var(--border); font-size: 11.5px;
  color: var(--amber); background: color-mix(in srgb, var(--amber) 10%, transparent);
}
.dbproto-histo-banner .lead { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---- changeset / conflict action bars (thread + changes group headers) ---- */
.dbproto-csbar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 11.5px; color: var(--muted); flex-wrap: wrap; }
.dbproto-csbar .lead { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbproto-minibtn { height: 24px; padding: 0 9px; border-radius: 6px; border: 1px solid var(--border2); background: var(--elev); color: var(--text); font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
.dbproto-minibtn:hover:not(:disabled) { background: var(--elev2); }
.dbproto-minibtn:disabled { opacity: .5; }
.dbproto-minibtn.primary { background: var(--accent-dim); border-color: transparent; color: #fff; }
.dbproto-minibtn.primary:hover:not(:disabled) { background: var(--accent); }
.dbproto-minibtn.danger { color: #f85149; }
.dbproto-minibtn.confirm { border-color: var(--accent); color: var(--accent); }
.dbproto-minibtn.confirm.danger { border-color: #f85149; color: #f85149; }

/* ---- variant cards (REAL variant rows in the proto card treatment) ---- */
.dbproto-vcards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.dbproto-vcard { position: relative; border: 1px solid var(--border); border-radius: 11px; overflow: hidden; background: var(--elev); transition: border-color .15s, box-shadow .15s, opacity .15s; }
.dbproto-vcard.disabled { opacity: .55; }
.dbproto-vcard.active { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent); }
.dbproto-vcard-preview { width: 100%; height: 58px; display: flex; align-items: flex-end; padding: 8px; }
.dbproto-vcard-mini { width: 100%; height: 26px; border-radius: 5px; background: rgba(255,255,255,.14); backdrop-filter: blur(2px); }
.dbproto-vcard-body { padding: 8px 9px; }
.dbproto-vcard-name { font-weight: 600; font-size: 11.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; display: flex; align-items: center; gap: 6px; min-width: 0; }
.dbproto-vcard-name > span:first-child { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbproto-vcard-note { color: var(--muted); font-size: 10.5px; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dbproto-vcard-foot { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-top: 1px solid var(--border); }
.dbproto-vcard-act { flex: 1; height: 24px; border-radius: 6px; background: var(--elev2); color: var(--text); font-size: 11px; display: flex; align-items: center; justify-content: center; gap: 4px; }
.dbproto-vcard-act:hover:not(:disabled) { background: var(--border2); }
.dbproto-vcard-act:disabled { opacity: .5; }
.dbproto-vcard-act.primary { background: var(--accent-dim); color: #fff; }
.dbproto-vcard-act.primary:hover:not(:disabled) { background: var(--accent); }
.dbproto-vcard-act.confirm { background: transparent; border: 1px solid var(--accent); color: var(--accent); }
.dbproto-vcard-ring { position: absolute; top: 7px; right: 7px; z-index: 2; }
.dbproto-vcard-activity { border-top: 1px solid var(--border); padding: 6px 9px; display: flex; flex-direction: column; gap: 3px; }
.dbproto-vcard-iterate { border-top: 1px solid var(--border); padding: 7px 9px; display: grid; gap: 6px; }
.dbproto-vcard-error { padding: 0 9px 8px; color: #f85149; font-size: 10.5px; overflow-wrap: anywhere; }

/* ---- switch ---- */
.dbproto-switch { width: 34px; height: 20px; border-radius: 999px; background: var(--border2); position: relative; flex: none; transition: background .15s; }
.dbproto-switch.on { background: var(--accent-dim); }
.dbproto-switch:disabled { opacity: .45; }
.dbproto-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
.dbproto-switch.on::after { transform: translateX(14px); }

/* ---- selection chip on the threads-list composer (item: chat ↔ selection) */
.dbproto-selchip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  justify-self: start; padding: 3px 9px; border-radius: 999px;
  background: var(--elev2); border: 1px solid var(--border2);
  color: var(--text); font-size: 11px; font-weight: 600;
}
.dbproto-selchip > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---- follow-up prompt (thread + iterate boxes) ---- */
.dbproto-promptbox { flex: none; display: grid; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--border); }
.dbproto-textarea-dark {
  width: 100%; min-height: 54px; resize: vertical; padding: 8px 10px; line-height: 1.4;
  background: var(--elev); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); font: inherit; font-size: 12.5px;
}
.dbproto-textarea-dark:focus { outline: none; border-color: var(--accent); }
.dbproto-textarea-dark::placeholder { color: var(--faint); }
.dbproto-prompt-error { color: #f85149; font-size: 11.5px; overflow-wrap: anywhere; }

/* ---- changes ---- */
.dbproto-changes { padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
.dbproto-cs-group { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.dbproto-cs-grouphead { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--elev); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.dbproto-cs-grouptitle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; color: var(--text); font-size: 12px; font-weight: 600; }
.dbproto-cs-grouptitle > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbproto-cs-label { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; padding: 0 2px; }
.dbproto-filerow { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 8px; width: 100%; text-align: left; }
.dbproto-cs-group .dbproto-filerow { border-radius: 0; }
.dbproto-filerow:hover { background: var(--elev); }
.dbproto-badge { min-width: 18px; height: 18px; padding: 0 4px; flex: none; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.dbproto-badge.M { background: color-mix(in srgb, var(--amber) 22%, transparent); color: var(--amber); }
.dbproto-badge.A { background: color-mix(in srgb, var(--green) 22%, transparent); color: var(--green); }
.dbproto-badge.D { background: color-mix(in srgb, #f85149 22%, transparent); color: #f85149; }
.dbproto-badge.R { background: var(--elev2); color: var(--muted); }
.dbproto-badge.C { background: color-mix(in srgb, #f85149 30%, transparent); color: #f85149; }
.dbproto-filepath { flex: 1; min-width: 0; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.dbproto-filehint { color: var(--faint); font-size: 10.5px; flex: none; }

/* ---- center stage: 16px gutter on all sides, full-height rounded container ---- */
.dbproto-stage { flex: 1; min-width: 0; display: flex; align-items: stretch; justify-content: center; padding: 16px; overflow: hidden; position: relative; }
.dbproto-collapsed .dbproto-stage { padding: 0; }
.dbproto-stage-inner { display: flex; flex-direction: column; min-height: 0; max-width: 100%; transition: width .22s ease, border-radius .22s ease, box-shadow .22s ease; background: var(--panel); border-radius: 10px; overflow: hidden; box-shadow: 0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.05); position: relative; }
.dbproto-stage-inner.fullbleed { width: 100% !important; border-radius: 0; box-shadow: none; }
.dbproto-frame-wrap { flex: 1; min-height: 0; position: relative; background: #fff; overflow: hidden; }
/* Fullscreen sandbox canvas (route-driven): overlays the whole center column
 * with the LIGHT workbench-token canvas; the app frame stays mounted below. */
.dbproto-canvaslayer { position: absolute; inset: 16px; z-index: 30; display: flex; flex-direction: column; background: #fff; color: #1f2328; border-radius: 10px; overflow: hidden; box-shadow: 0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08); }
.dbproto-canvaslayer > * { flex: 1; min-height: 0; }
.dbproto-frame-wrap iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
/* Real overlays (AppFrameOverlay / text tool) mount inside the frame wrap in a
 * light-token context: they draw over the LIGHT running app. */
.dbproto-overlay-host { position: absolute; inset: 0; pointer-events: none; }
.dbproto-overlay-host > * { pointer-events: auto; }

/* ---- right panel (collapsible like the left) ---- */
.dbproto-rightpanel { width: 320px; flex: none; background: var(--panel); border-left: 1px solid var(--border); overflow: hidden; transition: width .2s ease, opacity .18s ease; animation: dbproto-slide-in-r .2s ease; }
.dbproto-rightpanel.closed { width: 0; opacity: 0; border-left: none; }
@keyframes dbproto-slide-in-r { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
.dbproto-tabs { flex: none; display: flex; padding: 8px 8px 0; gap: 4px; border-bottom: 1px solid var(--border); }
.dbproto-tab { padding: 8px 14px; border-radius: 8px 8px 0 0; color: var(--muted); font-size: 12.5px; font-weight: 500; border-bottom: 2px solid transparent; }
.dbproto-tab:hover { color: var(--text); }
.dbproto-tab.active { color: var(--text); border-bottom-color: var(--accent); }

/* props inspector (kept mock by design — item 7) */
.dbproto-props { padding: 12px; display: flex; flex-direction: column; gap: 2px; }
.dbproto-field { padding: 8px 4px; }
.dbproto-field-label { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }
.dbproto-mod-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 0 2px color-mix(in srgb, var(--amber) 30%, transparent); }
.dbproto-input { width: 100%; height: 30px; background: var(--elev); border: 1px solid var(--border); border-radius: 7px; color: var(--text); padding: 0 9px; font-size: 12.5px; }
.dbproto-input:focus { outline: none; border-color: var(--accent); }
.dbproto-textarea { width: 100%; min-height: 52px; resize: vertical; padding: 7px 9px; line-height: 1.4; }
.dbproto-stepper { display: flex; align-items: center; gap: 0; }
.dbproto-stepper input { border-radius: 0; text-align: center; border-left: none; border-right: none; }
.dbproto-step-btn { width: 30px; height: 30px; flex: none; background: var(--elev); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; color: var(--muted); }
.dbproto-step-btn:first-child { border-radius: 7px 0 0 7px; }
.dbproto-step-btn:last-child { border-radius: 0 7px 7px 0; }
.dbproto-step-btn:hover { background: var(--elev2); color: var(--text); }
.dbproto-select { width: 100%; height: 30px; background: var(--elev); border: 1px solid var(--border); border-radius: 7px; color: var(--text); padding: 0 9px; font-size: 12.5px; }
.dbproto-select:focus { outline: none; border-color: var(--accent); }
.dbproto-bool { display: flex; align-items: center; justify-content: space-between; padding: 9px 4px; }
.dbproto-disclose { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; margin: 6px 0; }
.dbproto-disclose-head { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; padding: 9px 10px; background: var(--elev); font-size: 12px; }
.dbproto-disclose-head:hover { background: var(--elev2); }
.dbproto-disclose-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); }

/* ---- real props panel ---- */
.dbproto-prop-type { font-size: 10.5px; color: var(--faint); font-family: ui-monospace, Menlo, monospace; margin-left: auto; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbproto-prop-req { color: var(--amber); font-weight: 700; }
.dbproto-field.unpassed .dbproto-input, .dbproto-field.unpassed .dbproto-select { opacity: .55; }
.dbproto-field.unpassed .dbproto-field-label, .dbproto-bool.unpassed .dbproto-field-label { color: var(--faint); }
.dbproto-prop-default { font-size: 10.5px; color: var(--faint); margin-top: 5px; font-family: ui-monospace, Menlo, monospace; }
.dbproto-prop-ro { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 9px; background: var(--elev); border: 1px dashed var(--border2); border-radius: 7px; color: var(--muted); font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbproto-prop-badge { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--faint); border: 1px solid var(--border2); border-radius: 5px; padding: 1px 5px; }
.dbproto-props-note { margin: 10px 12px; padding: 9px 11px; background: var(--elev); border: 1px solid var(--border); border-radius: 9px; color: var(--muted); font-size: 11.5px; line-height: 1.45; }
.dbproto-props-status { padding: 8px 14px; color: var(--faint); font-size: 11px; }
.dbproto-props-empty { padding: 22px 14px; color: var(--muted); font-size: 12px; text-align: center; }
.dbproto-prop-warn { color: var(--amber); font-size: 10.5px; margin-top: 5px; }
.dbproto-section { border-top: 1px solid var(--border); margin-top: 6px; }
.dbproto-section-head { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; padding: 11px 14px; background: transparent; color: var(--text); font-size: 12px; font-weight: 600; }
.dbproto-section-head:hover { background: var(--elev); }
.dbproto-section-body { padding: 4px 14px 12px; }

/* ---- figma plugin section (src/plugins/figma/ui/FigmaSection.tsx) ---- */
.dbfigma { display: grid; gap: 9px; }
.dbfigma-status { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 11.5px; }
.dbfigma-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--faint); }
.dbfigma-dot.on { background: var(--green); }
.dbfigma-status-label { color: var(--text); font-weight: 500; }
.dbfigma-status-file { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
.dbfigma-hint { color: var(--muted); font-size: 11px; line-height: 1.45; }
.dbfigma-baseline { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); }
.dbfigma-prop-badge { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--faint); border: 1px solid var(--border2); border-radius: 5px; padding: 1px 5px; }
.dbfigma-actions { display: flex; gap: 7px; margin-top: 2px; }
.dbfigma-btn { flex: 1; height: 28px; border-radius: 7px; background: var(--elev); border: 1px solid var(--border); color: var(--text); font-size: 12px; }
.dbfigma-btn:hover:not(:disabled) { background: var(--elev2); border-color: var(--border2); }
.dbfigma-btn:disabled { opacity: .45; }
.dbfigma-msg { font-size: 11px; line-height: 1.45; }
.dbfigma-msg.ok { color: var(--green); }
.dbfigma-msg.warn { color: var(--amber); }
.dbfigma-msg.err { color: var(--pink); }

/* info panel divider under the mock props */

/* ---- toast ---- */
.dbproto-toast {
  position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
  z-index: 80; background: var(--elev2); border: 1px solid var(--border2);
  padding: 10px 16px; border-radius: 10px; font-size: 12.5px;
  box-shadow: 0 10px 30px rgba(0,0,0,.5); display: flex; align-items: center; gap: 8px;
  animation: dbproto-toast-in .18s ease;
}
@keyframes dbproto-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
`;
