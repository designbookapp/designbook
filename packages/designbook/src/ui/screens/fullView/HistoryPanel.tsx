/**
 * G4 HISTORY EXPLORER (docs/specs/changesets-on-git.md §G4, conversation-
 * timeline shape) — the accordion panel under the chat title bar: ONE
 * unified vertical git-graph of the conversation's WHOLE history. All
 * trunks (pin work + direct edits) interleave on ONE mainline column;
 * rails split only at REAL divergence (forks, turned/selected variants);
 * zero-commit variants hang off the mainline as short pill stubs.
 *
 *   - labeled PILLS = refs (each changeset's trunk + variants + forks),
 *     titles from the thread/variant records (a trunk repeating the group
 *     title shows "main"); clicking one SELECTS that branch (the existing
 *     switchSelect — the app flips hot-only);
 *   - DOTS = per-TURN commits on vertical rails — BARE dots, no node text
 *     (round-2 refinement); the generated turn label / prompt line rides the
 *     TOOLTIP; clicking a mid-rail dot PARKS there (non-destructive preview
 *     — POST /api/sandbox/park; no ref moves); clicking the parked dot exits;
 *   - the ACCENT trace = each changeset's selected-ref ancestry; the
 *     VIEWING (amber) trace = the parked commit's root→parked ancestry
 *     (round-2 refinement — matches the viewing dot/badge accent).
 *
 * Pure HTML/CSS + one inline SVG — no chart libs. Data:
 * GET /api/sandbox/history-graph, refreshed on the sandbox events that can
 * change the DAG (including `turn-label`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@designbook-ui/designbook";
import {
  subscribeApiEvents,
  subscribeConnectionStatus,
} from "@designbook-ui/models/events/eventBus";
import {
  buildUnifiedHistoryGraph,
  type GraphNode,
  type GraphRail,
  type HistoryGraphLayout,
  type HistoryGraphWire,
} from "@designbook-ui/models/sandbox/historyGraphModel";
import {
  sandboxComponentKey,
  type SandboxChangesetState,
} from "@designbook-ui/models/sandbox/sandboxModel";
import type { SandboxApi } from "@designbook-ui/models/sandbox/SandboxProvider";

const copy = {
  base: "created",
  empty: "No history yet — turns land here as they commit.",
  loading: "Loading history…",
  parkHint: "view the design as of this point (no branch moves)",
  exitHint: "viewing — click to return to the tips",
  parkedHere: "viewing",
  foreignTurn: "other thread",
  renameFailed: "Could not rename the branch.",
  selectTitle: (title: string) =>
    `Select "${title}" — the app flips in place. Double-click to rename.`,
  turn: (index?: number) => (index !== undefined ? `Turn ${index}` : "Turn"),
  unreachable: "The design server is unreachable.",
};

/** Graph geometry (px). */
const COL_W = 14;
const ROW_H = 26;
const PAD_X = 12;

/** Event types that can change the DAG → refetch. */
const REFRESH_EVENTS = new Set([
  "changesets-changed",
  "conversation-turn",
  "forked",
  "parked",
  "reapply-done",
  "rebase-status",
  "rollback",
  "switch-changed",
  "turn-label",
  "unparked",
]);

function x(column: number): number {
  return PAD_X + column * COL_W;
}

function y(row: number): number {
  return row * ROW_H + ROW_H / 2;
}

/** One rail's SVG path: connector curve from the parent + its vertical. */
function railPath(rail: GraphRail, throughRow?: number): string {
  const bottom = y(throughRow ?? rail.tipRow);
  const xc = x(rail.column);
  if (rail.forkOfColumn === undefined || rail.forkOfColumn === rail.column) {
    return `M ${xc} ${y(rail.startRow)} L ${xc} ${bottom}`;
  }
  const xp = x(rail.forkOfColumn);
  const ys = y(rail.startRow);
  const yLand = Math.min(ys + ROW_H * 0.75, bottom);
  return (
    `M ${xp} ${ys} C ${xp} ${ys + ROW_H * 0.6}, ${xc} ${ys + ROW_H * 0.15}, ` +
    `${xc} ${yLand} L ${xc} ${bottom}`
  );
}

/** The rails/curves: grey base pass, accent (selected) pass, then the
 * viewing (amber) pass on top — the parked ancestry must stay readable even
 * where it overlaps the selected trace. */
function GraphSvg({ layout }: { layout: HistoryGraphLayout }) {
  const width = PAD_X * 2 + layout.columnCount * COL_W;
  const height = layout.rowCount * ROW_H;
  return (
    <svg
      className="dbproto-histo-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      {layout.rails.map((rail) => (
        <path
          key={`base-${rail.changesetId}-${rail.ref}`}
          d={railPath(rail)}
          fill="none"
          stroke="var(--border2)"
          strokeWidth={2}
        />
      ))}
      {layout.rails.map((rail) =>
        rail.pathThroughRow !== undefined ? (
          <path
            key={`sel-${rail.changesetId}-${rail.ref}`}
            d={railPath(rail, Math.min(rail.pathThroughRow, rail.tipRow))}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
          />
        ) : null,
      )}
      {layout.rails.map((rail) =>
        rail.viewingThroughRow !== undefined ? (
          <path
            key={`view-${rail.changesetId}-${rail.ref}`}
            d={railPath(rail, Math.min(rail.viewingThroughRow, rail.tipRow))}
            fill="none"
            stroke="var(--amber)"
            strokeWidth={2}
          />
        ) : null,
      )}
    </svg>
  );
}

/** The dot tooltip: generated label > prompt line > "Turn n", plus the
 * park/exit affordance hint. */
function nodeTitle(node: GraphNode): string {
  const what =
    node.label ??
    node.prompt ??
    `${copy.turn(node.turnIndex)} · ${node.commit.slice(0, 7)}`;
  const hint = node.parked ? copy.exitHint : copy.parkHint;
  return `${what}${node.foreign ? ` (${copy.foreignTurn})` : ""} — ${hint}`;
}

/**
 * One tip pill: click = SELECT the ref (existing switchSelect, delayed a
 * beat so a double-click never flips), double-click = RENAME IN PLACE
 * (input swap; Enter/blur commit via POST /api/sandbox/ref-title, Escape
 * cancels). A user rename LOCKS the name — later agent `Title:` lines are
 * ignored server-side.
 */
function RefPill({
  rail,
  gutter,
  onSelect,
  onError,
}: {
  rail: GraphRail;
  gutter: number;
  onSelect: (rail: GraphRail) => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rail.title);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  async function commitRename() {
    setEditing(false);
    const title = text.trim();
    if (!title || title === rail.title) return;
    onError(undefined);
    try {
      const response = await fetch(apiUrl("/api/sandbox/ref-title"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changesetId: rail.changesetId,
          altId: rail.altId,
          title,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        onError(payload.error ?? copy.renameFailed);
      }
      // Success needs no refetch here — the rename emits
      // `changesets-changed`, which refreshes the graph.
    } catch {
      onError(copy.renameFailed);
    }
  }

  if (editing) {
    return (
      <input
        className={`dbproto-histo-pill editing ${rail.kind}`}
        style={{ left: gutter, top: rail.tipRow * ROW_H + 2 }}
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void commitRename()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            void commitRename();
          }
          if (event.key === "Escape") {
            setText(rail.title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      className={`dbproto-histo-pill ${rail.selected ? "selected" : ""} ${
        rail.kind
      }${rail.stub ? " stub" : ""}`}
      style={{ left: gutter, top: rail.tipRow * ROW_H + 2 }}
      title={copy.selectTitle(rail.title)}
      onClick={() => {
        // Delay so a double-click (rename) never also flips selection.
        if (clickTimer.current) clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => void onSelect(rail), 250);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        if (clickTimer.current) clearTimeout(clickTimer.current);
        setText(rail.title);
        setEditing(true);
      }}
    >
      {rail.displayTitle}
    </button>
  );
}

function UnifiedGraph({
  layout,
  title,
  changesets,
  api,
  onError,
}: {
  layout: HistoryGraphLayout;
  title?: string;
  changesets: Map<string, SandboxChangesetState>;
  api: SandboxApi;
  onError: (error: string | undefined) => void;
}) {
  const gutter = PAD_X * 2 + layout.columnCount * COL_W;
  const parkedByChangeset = new Map(
    layout.parked.map((entry) => [entry.changesetId, entry]),
  );

  async function clickNode(node: GraphNode) {
    onError(undefined);
    const result = node.parked
      ? await api.exitPark({ changesetId: node.changesetId })
      : await api.park({
          changesetId: node.changesetId,
          commit: node.commit,
          turn: node.turn,
        });
    onError(result.error);
  }

  async function clickPill(rail: GraphRail) {
    onError(undefined);
    const parked = parkedByChangeset.get(rail.changesetId);
    if (rail.selected && !parked) return;
    if (rail.selected && parked) {
      // Selecting the already-selected pill while parked = exit preview.
      onError((await api.exitPark({ changesetId: rail.changesetId })).error);
      return;
    }
    // The existing switchSelect wire: any overridden module of the layer
    // names the flip (selection is changeset-wide — checkout semantics).
    const changeset = changesets.get(rail.changesetId);
    const override = changeset?.overrides.find((candidate) =>
      candidate.alternatives.includes(rail.altId),
    );
    if (!override) {
      onError("This branch has no landed design to select yet.");
      return;
    }
    const result = await api.setSwitch({
      component: sandboxComponentKey(override.module, override.exportName),
      selection: { changesetId: rail.changesetId, variantId: rail.altId },
    });
    onError(result.error);
  }

  return (
    <div className="dbproto-histo-cs">
      {title || layout.parked.length > 0 ? (
        <div className="dbproto-histo-cshead">
          {title ? (
            <span className="dbproto-histo-cstitle">{title}</span>
          ) : null}
          {layout.parked.length > 0 ? (
            <span className="dbproto-pill warn">{copy.parkedHere}</span>
          ) : null}
        </div>
      ) : null}
      <div
        className="dbproto-histo-graph"
        style={{ height: layout.rowCount * ROW_H }}
      >
        <GraphSvg layout={layout} />
        {/* Start row */}
        <span
          className="dbproto-histo-basedot"
          style={{ left: x(0) - 4, top: y(0) - 4 }}
        />
        <span
          className="dbproto-histo-label faint"
          style={{ left: gutter, top: 0 }}
        >
          {copy.base}
        </span>
        {/* Turn dots — BARE (labels are tooltips; round-2 refinement) */}
        {layout.nodes.map((node) => (
          <button
            key={node.key}
            className={`dbproto-histo-dot ${node.onSelectedPath ? "onpath" : ""} ${
              node.onViewingPath ? "onview" : ""
            } ${node.parked ? "parked" : ""} ${node.foreign ? "foreign" : ""}`}
            style={{ left: x(node.column) - 6, top: y(node.row) - 6 }}
            title={nodeTitle(node)}
            aria-label={nodeTitle(node)}
            onClick={() => void clickNode(node)}
          />
        ))}
        {/* Ref pills at each rail's tip row (the rail's line ends here) */}
        {layout.rails.map((rail) => (
          <span
            key={`tipdot-${rail.changesetId}-${rail.ref}`}
            className={`dbproto-histo-tipdot ${
              // Only the SELECTED rail's tip is on the path — an ancestor's
              // tip sits past its fork point (its accent stops there).
              rail.pathThroughRow !== undefined &&
              rail.pathThroughRow >= rail.tipRow
                ? "onpath"
                : ""
            }`}
            style={{ left: x(rail.column) - 3, top: y(rail.tipRow) - 3 }}
          />
        ))}
        {layout.rails.map((rail) => (
          <RefPill
            key={`pill-${rail.changesetId}-${rail.ref}`}
            rail={rail}
            gutter={gutter}
            onSelect={clickPill}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The accordion body: fetches the conversation's graph and re-renders on
 * DAG-changing sandbox events. `conversationId` scopes the graph; a pin
 * thread without one passes `changesetId` instead. `title` names the ONE
 * unified group (the conversation/thread title).
 */
function HistoryPanel({
  conversationId,
  changesetId,
  title,
  api,
}: {
  conversationId?: string;
  changesetId?: string;
  title?: string;
  api: SandboxApi;
}) {
  const [wire, setWire] = useState<HistoryGraphWire>();
  const [error, setError] = useState<string>();
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const refetch = useCallback(() => {
    const query = conversationId
      ? `conversationId=${encodeURIComponent(conversationId)}`
      : changesetId
        ? `changesetId=${encodeURIComponent(changesetId)}`
        : undefined;
    if (!query) return;
    void fetch(apiUrl(`/api/sandbox/history-graph?${query}`))
      .then(async (response) => {
        const payload = (await response.json()) as HistoryGraphWire & {
          error?: string;
        };
        if (!response.ok || payload.error) {
          setError(payload.error ?? copy.unreachable);
          return;
        }
        setWire(payload);
      })
      .catch(() => setError(copy.unreachable));
  }, [conversationId, changesetId]);

  useEffect(() => {
    setWire(undefined);
    setError(undefined);
    refetch();
    const unsubscribe = subscribeApiEvents("sandbox-event", (messageEvent) => {
      let type: string | undefined;
      try {
        type = (JSON.parse(messageEvent.data as string) as { type?: string })
          .type;
      } catch {
        return;
      }
      if (!type || !REFRESH_EVENTS.has(type)) return;
      // Debounce bursts (a turn end emits several of these back-to-back).
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(refetch, 200);
    });
    // Reconnects refetch too (events missed while the stream was released
    // — the same G4 staleness rule the store sync follows).
    const unsubscribeStatus = subscribeConnectionStatus((status) => {
      if (status === "open") refetch();
    });
    const timer = timerRef;
    return () => {
      unsubscribe();
      unsubscribeStatus();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refetch]);

  // `title` doubles as the group title for trunk-pill dedupe ("main").
  const layout = wire ? buildUnifiedHistoryGraph(wire, title) : undefined;
  const byId = new Map(api.changesets.map((cs) => [cs.id, cs]));
  return (
    <div className="dbproto-histo">
      {error ? <span className="dbproto-prompt-error">{error}</span> : null}
      {!wire && !error ? (
        <div className="dbproto-act">
          <span className="dbproto-dot-spin" />
          <span>{copy.loading}</span>
        </div>
      ) : null}
      {wire && !layout && !error ? (
        <span className="dbproto-empty">{copy.empty}</span>
      ) : null}
      {layout ? (
        <UnifiedGraph
          layout={layout}
          {...(title !== undefined ? { title } : {})}
          changesets={byId}
          api={api}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

export { HistoryPanel };
