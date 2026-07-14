/**
 * G4 history explorer — the PURE graph model (docs/specs/changesets-on-git.md
 * §G4, CONVERSATION-TIMELINE shape): GET /api/sandbox/history-graph wire →
 * ONE unified row/column layout per CONVERSATION that the accordion renders
 * with plain HTML/CSS.
 *
 * Timeline shape (Michael, round 3): a linear conversation reads as ONE line.
 *
 *   - MAINLINE (column 0): the trunk refs of ALL the conversation's
 *     changesets share it — pin work and direct edits interleave on ONE
 *     chronological axis; a dot's changeset is tooltip context, never a rail
 *     of its own. An EMPTY direct-edits changeset (no turns) contributes
 *     NOTHING — no rail, no pill.
 *   - rails SPLIT only at REAL divergence: fork refs, and variant refs that
 *     have their own turns or are the changeset's selection — those get a
 *     column starting at their fork row.
 *   - zero-commit unselected variants stay SELECTABLE but never consume a
 *     full-height rail: they render as short STUBS — pill rows spliced in
 *     right after their fork commit's row, stubs at the same fork sharing
 *     one column (a tip-pill cluster hanging off the mainline).
 *   - one ROW per event: the start row, one per TURN commit across ALL
 *     changesets (global chronology — bare dots, park targets; labels are
 *     TOOLTIPS, never node text), stub pill rows at their fork, then one TIP
 *     row per mainline/branch rail (the labeled pills, selection targets);
 *   - the SELECTED refs' ancestry (one per changeset — selection is
 *     per-changeset checkout) traces in the accent color (`pathThroughRow`);
 *   - a PARKED ("viewing") commit traces its OWN root→parked ancestry in the
 *     viewing accent (`viewingThroughRow` / `onViewingPath`) — distinct from
 *     the selected trace;
 *   - a trunk pill whose title repeats the conversation/group title renders
 *     the short form "main" (`displayTitle`; `title` keeps the full text for
 *     the tooltip).
 *
 * Per-write zoom is deliberately NOT modeled — nodes are turns, keyed by
 * commit, so a finer level can slot in later.
 */

type HistoryGraphRefWire = {
  ref?: string;
  altId?: string;
  kind?: string;
  tip?: string;
  title?: string;
  forkCommit?: string;
  forkOfRef?: string;
  forkConversationId?: string;
  fromTurn?: string;
};

type HistoryGraphTurnWire = {
  turn?: string;
  ref?: string;
  commit?: string;
  from?: string;
  at?: number;
  conversationId?: string;
  /** Round-2 generated turn label (tooltip text). */
  label?: string;
  /** First line of the driving prompt (label fallback). */
  prompt?: string;
};

type HistoryGraphChangesetWire = {
  id?: string;
  title?: string;
  pinId?: string;
  direct?: boolean;
  active?: boolean;
  base?: string;
  selectedRef?: string;
  parked?: { commit?: string; ref?: string; turn?: string };
  refs?: HistoryGraphRefWire[];
  turns?: HistoryGraphTurnWire[];
};

type HistoryGraphWire = {
  conversationId?: string;
  changesets?: HistoryGraphChangesetWire[];
  parent?: { conversationId?: string; atTurn?: string };
};

type GraphRailKind = "trunk" | "variant" | "fork";

type GraphRail = {
  /** The changeset this rail belongs to (park/select calls need it). */
  changesetId: string;
  ref: string;
  altId: string;
  kind: GraphRailKind;
  /** Full title (tooltips). */
  title: string;
  /** What the pill renders — "main" when a trunk repeats the group title. */
  displayTitle: string;
  tip: string;
  column: number;
  /** The row this rail leaves its parent (0 = the start row). */
  startRow: number;
  /** The rail's pill row (its bottom end). Mid-timeline for stubs. */
  tipRow: number;
  /** Zero-commit unselected variant: a short stub (fork row → pill row),
   * not a full-height rail — still a selectable pill (the flip surface). */
  stub?: boolean;
  /** Parent rail's column for the connector curve (absent on trunk). */
  forkOfColumn?: number;
  forkConversationId?: string;
  fromTurn?: string;
  selected: boolean;
  /** Rows ≤ this are on the selected ancestry (absent = not on the path). */
  pathThroughRow?: number;
  /** Rows ≤ this are on the PARKED ("viewing") ancestry — the viewing-accent
   * trace, distinct from the selected one. */
  viewingThroughRow?: number;
};

type GraphNode = {
  key: string;
  changesetId: string;
  commit: string;
  ref: string;
  turn: string;
  turnIndex?: number;
  column: number;
  row: number;
  at: number;
  parked: boolean;
  onSelectedPath: boolean;
  /** On the parked ("viewing") ancestry — amber trace membership. */
  onViewingPath: boolean;
  /** The conversation that landed this turn (sidecar record). */
  conversationId?: string;
  /** Landed by ANOTHER conversation (a reused pin's rail carries turns from
   * every conversation that worked it — foreign dots render dimmed). */
  foreign: boolean;
  /** Round-2 label (tooltip): generated description of the turn. */
  label?: string;
  /** Prompt-line fallback for the tooltip. */
  prompt?: string;
};

type HistoryGraphLayout = {
  columnCount: number;
  rowCount: number;
  nodes: GraphNode[];
  rails: GraphRail[];
  /** Live park pointers (one per parked changeset). */
  parked: Array<{ changesetId: string; commit: string; ref: string; turn?: string }>;
};

/** `<sessionId>/<n>` → n (tooltip fallback "Turn n"). */
function turnIndexOf(turn: string): number | undefined {
  const match = /\/(\d+)$/.exec(turn);
  const index = match ? Number(match[1]) : NaN;
  return Number.isFinite(index) ? index : undefined;
}

type ValidRef = HistoryGraphRefWire & { ref: string; altId: string };
type ValidTurn = HistoryGraphTurnWire & {
  turn: string;
  ref: string;
  commit: string;
};

/**
 * Layout the WHOLE wire payload as ONE unified graph (see module doc).
 * `wire.conversationId` scopes turn ATTRIBUTION: turns another conversation
 * landed on a shared rail are kept (full history) but flagged `foreign`.
 * `groupTitle` (the accordion group's heading) drives trunk-pill title
 * dedupe — a trunk whose title repeats it renders "main" (`displayTitle`).
 * Undefined when nothing is renderable (no changesets with refs, or only
 * empty direct-edits changesets).
 */
function buildUnifiedHistoryGraph(
  wire: HistoryGraphWire,
  groupTitle?: string,
): HistoryGraphLayout | undefined {
  const graphConversationId = wire.conversationId;
  const changesets = (wire.changesets ?? []).filter(
    (changeset): changeset is HistoryGraphChangesetWire & { id: string } =>
      typeof changeset.id === "string" && (changeset.refs ?? []).length > 0,
  );

  type Block = {
    changeset: HistoryGraphChangesetWire & { id: string };
    /** Mainline members — every trunk shares column 0. */
    trunks: ValidRef[];
    /** REAL divergence (own column): forks, turned variants, the selection. */
    branches: ValidRef[];
    /** Zero-commit unselected variants — short stubs, no full rail. */
    stubs: ValidRef[];
  };
  const blocks: Block[] = [];
  /** ALL valid turns, global chronology (the shared time axis). */
  const allTurns: Array<ValidTurn & { changesetId: string }> = [];

  for (const changeset of changesets) {
    const rawRails = (changeset.refs ?? []).filter(
      (rail): rail is ValidRef =>
        typeof rail.ref === "string" && typeof rail.altId === "string",
    );
    if (rawRails.length === 0) continue;
    const railRefs = new Set(rawRails.map((rail) => rail.ref));
    const turns = (changeset.turns ?? []).filter(
      (record): record is ValidTurn =>
        typeof record.turn === "string" &&
        typeof record.ref === "string" &&
        typeof record.commit === "string" &&
        railRefs.has(record.ref),
    );
    // An EMPTY "Direct edits" changeset contributes NOTHING — no rail, no
    // pill (timeline rule 1).
    if (changeset.direct && turns.length === 0) continue;
    const turnedRefs = new Set(turns.map((record) => record.ref));
    const trunks: ValidRef[] = [];
    const branches: ValidRef[] = [];
    const stubs: ValidRef[] = [];
    for (const rail of rawRails) {
      if (rail.kind === "trunk") trunks.push(rail);
      else if (
        rail.kind === "fork" ||
        turnedRefs.has(rail.ref) ||
        changeset.selectedRef === rail.ref
      )
        branches.push(rail);
      else stubs.push(rail);
    }
    blocks.push({ changeset, trunks, branches, stubs });
    for (const record of turns) {
      allTurns.push({ ...record, changesetId: changeset.id });
    }
  }
  if (blocks.length === 0) return undefined;
  allTurns.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  const railKey = (changesetId: string, ref: string) =>
    `${changesetId} ${ref}`;

  // Stub anchors: a stub's pill rows splice in right after its fork
  // commit's node row (else right after the start row). Stubs sharing an
  // anchor cluster in one column.
  const commitsOf = new Map<string, Set<string>>();
  for (const record of allTurns) {
    const set = commitsOf.get(record.changesetId) ?? new Set<string>();
    set.add(record.commit);
    commitsOf.set(record.changesetId, set);
  }
  const startAnchor = (changesetId: string) => `${changesetId}@`;
  const stubsByAnchor = new Map<
    string,
    Array<{ changesetId: string; ref: string }>
  >();
  for (const block of blocks) {
    const base = block.changeset.base ?? "";
    const commits = commitsOf.get(block.changeset.id);
    const sortedStubs = [...block.stubs].sort((a, b) =>
      a.altId < b.altId ? -1 : 1,
    );
    for (const rail of sortedStubs) {
      const anchor =
        rail.forkCommit &&
        rail.forkCommit !== base &&
        commits?.has(rail.forkCommit)
          ? `${block.changeset.id}@${rail.forkCommit}`
          : startAnchor(block.changeset.id);
      const list = stubsByAnchor.get(anchor) ?? [];
      list.push({ changesetId: block.changeset.id, ref: rail.ref });
      stubsByAnchor.set(anchor, list);
    }
  }

  // Row pass: start row = 0, then one row per turn across ALL changesets
  // (deduped by changeset+ref+commit — an SSE upsert may repeat a record),
  // stub pill rows spliced in right after their anchor row.
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  const rowOfCommit = new Map<string, number>(); // `${changesetId}@${commit}`
  const stubPlacement = new Map<
    string,
    { startRow: number; tipRow: number }
  >();
  let row = 0;
  const emitStubs = (anchor: string, anchorRow: number) => {
    for (const stub of stubsByAnchor.get(anchor) ?? []) {
      row += 1;
      stubPlacement.set(railKey(stub.changesetId, stub.ref), {
        startRow: anchorRow,
        tipRow: row,
      });
    }
    stubsByAnchor.delete(anchor);
  };
  for (const block of blocks) emitStubs(startAnchor(block.changeset.id), 0);
  for (const record of allTurns) {
    const key = `${record.changesetId}@${record.ref}@${record.commit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    row += 1;
    nodes.push({
      key,
      changesetId: record.changesetId,
      commit: record.commit,
      ref: record.ref,
      turn: record.turn,
      ...(turnIndexOf(record.turn) !== undefined
        ? { turnIndex: turnIndexOf(record.turn) }
        : {}),
      column: 0, // Rewritten below once columns are assigned.
      row,
      at: record.at ?? 0,
      parked: false,
      onSelectedPath: false,
      onViewingPath: false,
      ...(record.conversationId
        ? { conversationId: record.conversationId }
        : {}),
      foreign:
        graphConversationId !== undefined &&
        record.conversationId !== undefined &&
        record.conversationId !== graphConversationId,
      ...(record.label ? { label: record.label } : {}),
      ...(record.prompt ? { prompt: record.prompt } : {}),
    });
    const commitKey = `${record.changesetId}@${record.commit}`;
    if (!rowOfCommit.has(commitKey)) {
      rowOfCommit.set(commitKey, row);
      emitStubs(commitKey, row);
    }
  }

  // Fork rows: the row of the node carrying the fork commit (within the
  // same changeset), else the start row.
  const startRowOf = (changesetId: string, base: string, rail: ValidRef) =>
    !rail.forkCommit || rail.forkCommit === base
      ? 0
      : (rowOfCommit.get(`${changesetId}@${rail.forkCommit}`) ?? 0);

  // Columns: mainline (every trunk) = 0; branch rails and stub clusters get
  // 1..n ordered by fork row, then first activity, then altId.
  const firstActivity = new Map<string, number>();
  for (const record of allTurns) {
    const key = railKey(record.changesetId, record.ref);
    if (!firstActivity.has(key)) firstActivity.set(key, record.at ?? 0);
  }
  type ColumnUnit = {
    startRow: number;
    activity: number;
    altId: string;
    keys: string[];
  };
  const units: ColumnUnit[] = [];
  const clusters = new Map<string, ColumnUnit>();
  for (const block of blocks) {
    const base = block.changeset.base ?? "";
    for (const rail of block.branches) {
      const key = railKey(block.changeset.id, rail.ref);
      units.push({
        startRow: startRowOf(block.changeset.id, base, rail),
        activity: firstActivity.get(key) ?? Number.MAX_SAFE_INTEGER,
        altId: rail.altId,
        keys: [key],
      });
    }
    for (const rail of block.stubs) {
      const key = railKey(block.changeset.id, rail.ref);
      const placement = stubPlacement.get(key)!;
      const clusterKey = `${block.changeset.id}@${placement.startRow}`;
      let unit = clusters.get(clusterKey);
      if (!unit) {
        unit = {
          startRow: placement.startRow,
          activity: Number.MAX_SAFE_INTEGER,
          altId: rail.altId,
          keys: [],
        };
        clusters.set(clusterKey, unit);
        units.push(unit);
      }
      unit.keys.push(key);
    }
  }
  units.sort(
    (a, b) =>
      a.startRow - b.startRow ||
      a.activity - b.activity ||
      (a.altId < b.altId ? -1 : 1),
  );
  const columnOf = new Map<string, number>();
  for (const block of blocks) {
    for (const rail of block.trunks) {
      columnOf.set(railKey(block.changeset.id, rail.ref), 0);
    }
  }
  units.forEach((unit, index) => {
    for (const key of unit.keys) columnOf.set(key, index + 1);
  });
  for (const node of nodes) {
    node.column = columnOf.get(railKey(node.changesetId, node.ref)) ?? 0;
  }

  const normalizedGroupTitle = groupTitle?.trim().toLowerCase();
  const buildRail = (
    block: Block,
    rail: ValidRef,
    startRow: number,
    tipRow: number,
    stub: boolean,
  ): GraphRail => {
    const changeset = block.changeset;
    const parentColumn =
      rail.forkOfRef !== undefined
        ? columnOf.get(railKey(changeset.id, rail.forkOfRef))
        : undefined;
    const kind = (
      rail.kind === "trunk" || rail.kind === "fork" ? rail.kind : "variant"
    ) as GraphRailKind;
    const title = rail.title ?? rail.altId;
    return {
      changesetId: changeset.id,
      ref: rail.ref,
      altId: rail.altId,
      kind,
      title,
      // Trunk-pill dedupe: "main" when the title repeats the group title
      // (the full title stays in `title` for the tooltip).
      displayTitle:
        kind === "trunk" &&
        normalizedGroupTitle !== undefined &&
        title.trim().toLowerCase() === normalizedGroupTitle
          ? "main"
          : title,
      tip: rail.tip ?? "",
      column: columnOf.get(railKey(changeset.id, rail.ref)) ?? 0,
      startRow,
      tipRow,
      ...(stub ? { stub: true } : {}),
      ...(parentColumn !== undefined ? { forkOfColumn: parentColumn } : {}),
      ...(rail.forkConversationId
        ? { forkConversationId: rail.forkConversationId }
        : {}),
      ...(rail.fromTurn ? { fromTurn: rail.fromTurn } : {}),
      // No explicit selection = trunk serves (checkout semantics) — the
      // trunk pill reads selected so a click there honestly means
      // "already here" instead of a silent no-op.
      selected:
        changeset.selectedRef === rail.ref ||
        (!changeset.selectedRef && kind === "trunk"),
      // pathThroughRow / viewingThroughRow filled below.
    };
  };

  // Bottom tip rows: mainline pills first (wire order), then branch pills
  // left→right. Stub pills already sit at their spliced mid-timeline rows.
  const rails: GraphRail[] = [];
  const bottom: Array<{ block: Block; rail: ValidRef }> = [];
  for (const block of blocks) {
    for (const rail of block.trunks) bottom.push({ block, rail });
  }
  const branchBottom = blocks.flatMap((block) =>
    block.branches.map((rail) => ({ block, rail })),
  );
  branchBottom.sort(
    (a, b) =>
      (columnOf.get(railKey(a.block.changeset.id, a.rail.ref)) ?? 0) -
      (columnOf.get(railKey(b.block.changeset.id, b.rail.ref)) ?? 0),
  );
  bottom.push(...branchBottom);
  for (const entry of bottom) {
    row += 1;
    const base = entry.block.changeset.base ?? "";
    const startRow =
      entry.rail.kind === "trunk"
        ? 0
        : startRowOf(entry.block.changeset.id, base, entry.rail);
    rails.push(buildRail(entry.block, entry.rail, startRow, row, false));
  }
  for (const block of blocks) {
    for (const rail of block.stubs) {
      const placement = stubPlacement.get(
        railKey(block.changeset.id, rail.ref),
      )!;
      rails.push(
        buildRail(block, rail, placement.startRow, placement.tipRow, true),
      );
    }
  }

  // Ancestry traces, PER CHANGESET (selection + park are per changeset):
  //   - selected: the selected rail whole, then each parent up through the
  //     row its child forked at (recursively) — the accent trace;
  //   - viewing: the parked rail up through the PARKED ROW, then parents the
  //     same way — the viewing-accent trace (round-2 refinement).
  const parkedOut: HistoryGraphLayout["parked"] = [];
  for (const block of blocks) {
    const changeset = block.changeset;
    const blockRails = rails.filter(
      (rail) => rail.changesetId === changeset.id,
    );
    const byRef = new Map(blockRails.map((rail) => [rail.ref, rail]));
    const forkOfRef = new Map(
      [...block.trunks, ...block.branches, ...block.stubs].map((rail) => [
        rail.ref,
        rail.forkOfRef,
      ]),
    );
    const trace = (
      startRef: string | undefined,
      startThrough: number | undefined,
      mark: (rail: GraphRail, through: number) => void,
    ) => {
      let cursor = startRef !== undefined ? byRef.get(startRef) : undefined;
      let through = startThrough;
      const guard = new Set<string>();
      while (cursor && through !== undefined && !guard.has(cursor.ref)) {
        guard.add(cursor.ref);
        mark(cursor, through);
        const parentRef = forkOfRef.get(cursor.ref);
        through = cursor.startRow;
        cursor = parentRef !== undefined ? byRef.get(parentRef) : undefined;
      }
    };

    const selectedRail =
      blockRails.find((rail) => rail.selected) ?? undefined;
    trace(selectedRail?.ref, selectedRail?.tipRow, (rail, through) => {
      rail.pathThroughRow = through;
    });

    const parked = changeset.parked;
    if (parked?.commit && parked.ref) {
      parkedOut.push({
        changesetId: changeset.id,
        commit: parked.commit,
        ref: parked.ref,
        ...(parked.turn ? { turn: parked.turn } : {}),
      });
      const parkedRow = rowOfCommit.get(`${changeset.id}@${parked.commit}`);
      trace(parked.ref, parkedRow, (rail, through) => {
        rail.viewingThroughRow = through;
      });
    }
  }
  const parkedByChangeset = new Map(
    parkedOut.map((entry) => [entry.changesetId, entry]),
  );
  const railByKey = new Map(
    rails.map((rail) => [railKey(rail.changesetId, rail.ref), rail]),
  );
  for (const node of nodes) {
    const rail = railByKey.get(railKey(node.changesetId, node.ref));
    node.onSelectedPath =
      rail?.pathThroughRow !== undefined && node.row <= rail.pathThroughRow;
    node.onViewingPath =
      rail?.viewingThroughRow !== undefined &&
      node.row <= rail.viewingThroughRow;
    const parked = parkedByChangeset.get(node.changesetId);
    node.parked =
      parked !== undefined &&
      parked.commit === node.commit &&
      parked.ref === node.ref;
  }

  return {
    columnCount: units.length + 1,
    rowCount: row + 1,
    nodes,
    rails,
    parked: parkedOut,
  };
}

export { buildUnifiedHistoryGraph, turnIndexOf };
export type {
  GraphNode,
  GraphRail,
  HistoryGraphChangesetWire,
  HistoryGraphLayout,
  HistoryGraphWire,
};
