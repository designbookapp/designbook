/**
 * Conversation-timeline history-graph layout (pure): ONE graph per
 * conversation — every trunk (pin work + direct edits) folds onto ONE
 * mainline column, rails split only at REAL divergence (forks, turned or
 * selected variants), zero-commit variants hang as short pill stubs, empty
 * direct-edits changesets contribute nothing, trunk pills repeating the
 * group title render "main".
 */

import { describe, expect, it } from "vitest";
import {
  buildUnifiedHistoryGraph,
  type HistoryGraphChangesetWire,
  type HistoryGraphWire,
} from "./historyGraphModel";

const PREFIX = "refs/designbook/changesets/cs-1";
const trunk = `${PREFIX}/trunk`;
const va = `${PREFIX}/v/va`;
const vb = `${PREFIX}/v/vb`;
const vc = `${PREFIX}/v/vc`;
const fork = `${PREFIX}/v/fork-x1`;
const D_PREFIX = "refs/designbook/changesets/direct-conv-a";
const dTrunk = `${D_PREFIX}/trunk`;

/** Pin changeset: all turns on the TRUNK (linear work). */
function pinChangeset(): HistoryGraphChangesetWire {
  return {
    id: "cs-1",
    title: "Card exploration",
    pinId: "pin-1",
    direct: false,
    active: true,
    base: "b0",
    refs: [
      {
        ref: trunk,
        altId: "edit",
        kind: "trunk",
        tip: "c2",
        title: "Card exploration",
      },
    ],
    turns: [
      { turn: "s/1", ref: trunk, commit: "c1", from: "b0", at: 100 },
      { turn: "s/2", ref: trunk, commit: "c2", from: "c1", at: 300 },
    ],
  };
}

/** Direct-edits changeset with one turn BETWEEN the pin's turns. */
function directChangeset(): HistoryGraphChangesetWire {
  return {
    id: "direct-conv-a",
    direct: true,
    base: "b0",
    refs: [
      {
        ref: dTrunk,
        altId: "direct",
        kind: "trunk",
        tip: "d1",
        title: "Direct edits",
      },
    ],
    turns: [
      {
        turn: "s/9",
        ref: dTrunk,
        commit: "d1",
        from: "b0",
        at: 150,
        label: "Tighten card spacing",
      },
    ],
  };
}

/** Linear conversation: pin turns + direct-edit turn, no divergence. */
function linearWire(): HistoryGraphWire {
  return {
    conversationId: "conv-a",
    changesets: [pinChangeset(), directChangeset()],
  };
}

/** Pin changeset + a variant that has ITS OWN turn (real divergence). */
function branchedChangeset(): HistoryGraphChangesetWire {
  const changeset = pinChangeset();
  changeset.refs!.push({
    ref: va,
    altId: "va",
    kind: "variant",
    tip: "v1",
    title: "warm palette",
    forkCommit: "c1",
    forkOfRef: trunk,
  });
  changeset.turns!.push({
    turn: "s2/1",
    ref: va,
    commit: "v1",
    from: "c1",
    at: 400,
  });
  return changeset;
}

describe("buildUnifiedHistoryGraph", () => {
  it("folds a linear conversation onto ONE mainline column", () => {
    const layout = buildUnifiedHistoryGraph(linearWire())!;
    // ONE column: pin trunk + direct trunk share the mainline; the direct
    // turn interleaves chronologically — c1(100), d1(150), c2(300).
    expect(layout.columnCount).toBe(1);
    expect(
      layout.nodes.map((node) => [node.commit, node.row, node.column]),
    ).toEqual([
      ["c1", 1, 0],
      ["d1", 2, 0],
      ["c2", 3, 0],
    ]);
    expect(layout.rails.every((rail) => rail.column === 0)).toBe(true);
    // Both trunk pills render (each changeset stays selectable/parkable).
    expect(
      layout.rails.map((rail) => [rail.changesetId, rail.tipRow]),
    ).toEqual([
      ["cs-1", 4],
      ["direct-conv-a", 5],
    ]);
    expect(layout.rowCount).toBe(6);
    // Labels still ride the nodes (tooltips, never node text).
    expect(
      layout.nodes.find((node) => node.commit === "d1")?.label,
    ).toBe("Tighten card spacing");
  });

  it("drops EMPTY direct-edits changesets entirely (no rail, no pill)", () => {
    const emptyDirect: HistoryGraphChangesetWire = {
      ...directChangeset(),
      turns: [],
    };
    const layout = buildUnifiedHistoryGraph({
      conversationId: "conv-a",
      changesets: [pinChangeset(), emptyDirect],
    })!;
    expect(layout.rails.map((rail) => rail.changesetId)).toEqual(["cs-1"]);
    expect(layout.columnCount).toBe(1);
    expect(layout.nodes).toHaveLength(2);
    // A conversation with ONLY an empty direct changeset has nothing to show.
    expect(
      buildUnifiedHistoryGraph({ changesets: [emptyDirect] }),
    ).toBeUndefined();
  });

  it("gives a variant WITH its own turns a column starting at its fork row", () => {
    const layout = buildUnifiedHistoryGraph({
      conversationId: "conv-a",
      changesets: [branchedChangeset()],
    })!;
    expect(layout.columnCount).toBe(2);
    const vaRail = layout.rails.find((rail) => rail.altId === "va")!;
    expect(vaRail.column).toBe(1);
    expect(vaRail.startRow).toBe(1); // c1's row.
    expect(vaRail.forkOfColumn).toBe(0);
    expect(vaRail.stub).toBeUndefined();
    expect(
      layout.nodes.map((node) => [node.commit, node.row, node.column]),
    ).toEqual([
      ["c1", 1, 0],
      ["c2", 2, 0],
      ["v1", 3, 1],
    ]);
    // Bottom pills: mainline trunk first, then the branch.
    const trunkRail = layout.rails.find((rail) => rail.altId === "edit")!;
    expect(trunkRail.tipRow).toBe(4);
    expect(vaRail.tipRow).toBe(5);
  });

  it("always splits a rail for fork refs, even without turns", () => {
    const changeset = branchedChangeset();
    changeset.refs!.push({
      ref: fork,
      altId: "fork-x1",
      kind: "fork",
      tip: "c1",
      title: "Fork · x1",
      forkCommit: "c1",
      forkOfRef: trunk,
      fromTurn: "s/1",
      forkConversationId: "conv-f",
    });
    const layout = buildUnifiedHistoryGraph({
      conversationId: "conv-a",
      changesets: [changeset],
    })!;
    const forkRail = layout.rails.find((rail) => rail.altId === "fork-x1")!;
    expect(forkRail.kind).toBe("fork");
    expect(forkRail.stub).toBeUndefined();
    // Own column after va (va has activity, the fork none).
    expect(forkRail.column).toBe(2);
    expect(layout.columnCount).toBe(3);
    expect(forkRail.startRow).toBe(1);
    expect(forkRail.forkOfColumn).toBe(0);
    expect(forkRail.forkConversationId).toBe("conv-f");
    // Bottom pill row (after trunk + va tips).
    expect(forkRail.tipRow).toBe(6);
  });

  it("renders zero-commit unselected variants as short stubs at their fork row", () => {
    const changeset = pinChangeset();
    changeset.turns = [
      { turn: "s/1", ref: trunk, commit: "c1", from: "b0", at: 100 },
      { turn: "s/2", ref: trunk, commit: "c2", from: "c1", at: 200 },
    ];
    changeset.refs!.push(
      {
        ref: vb,
        altId: "vb",
        kind: "variant",
        tip: "c1",
        title: "cool palette",
        forkCommit: "c1",
        forkOfRef: trunk,
      },
      {
        ref: vc,
        altId: "vc",
        kind: "variant",
        tip: "c1",
        title: "warm palette",
        forkCommit: "c1",
        forkOfRef: trunk,
      },
    );
    const layout = buildUnifiedHistoryGraph({
      conversationId: "conv-a",
      changesets: [changeset],
    })!;
    // The cluster shares ONE column; pill rows splice in right after c1's
    // row — a short stub, not a full-height parallel rail.
    const vbRail = layout.rails.find((rail) => rail.altId === "vb")!;
    const vcRail = layout.rails.find((rail) => rail.altId === "vc")!;
    expect(vbRail.stub).toBe(true);
    expect(vcRail.stub).toBe(true);
    expect([vbRail.column, vcRail.column]).toEqual([1, 1]);
    expect([vbRail.startRow, vcRail.startRow]).toEqual([1, 1]);
    expect([vbRail.tipRow, vcRail.tipRow]).toEqual([2, 3]);
    expect(vbRail.forkOfColumn).toBe(0);
    // The pills stay (they're the flip surface) — selectable titles intact.
    expect(vbRail.title).toBe("cool palette");
    // c2 lands after the stub cluster; the trunk pill closes the graph.
    expect(
      layout.nodes.map((node) => [node.commit, node.row]),
    ).toEqual([
      ["c1", 1],
      ["c2", 4],
    ]);
    expect(
      layout.rails.find((rail) => rail.altId === "edit")!.tipRow,
    ).toBe(5);
    expect(layout.columnCount).toBe(2);
    expect(layout.rowCount).toBe(6);

    // A zero-commit variant that IS the selection gets a real rail instead.
    changeset.selectedRef = vb;
    const selectedLayout = buildUnifiedHistoryGraph({
      conversationId: "conv-a",
      changesets: [changeset],
    })!;
    const vbSelected = selectedLayout.rails.find(
      (rail) => rail.altId === "vb",
    )!;
    expect(vbSelected.stub).toBeUndefined();
    expect(vbSelected.selected).toBe(true);
    // Full rail: bottom pill row, own column; vc stays a stub cluster.
    expect(vbSelected.tipRow).toBe(5);
    expect(
      selectedLayout.rails.find((rail) => rail.altId === "vc")!.stub,
    ).toBe(true);
    expect(selectedLayout.columnCount).toBe(3);
  });

  it("traces a selected variant's ancestry through the mainline", () => {
    const changeset = branchedChangeset();
    changeset.selectedRef = va;
    const layout = buildUnifiedHistoryGraph({
      conversationId: "conv-a",
      changesets: [changeset],
    })!;
    const path = Object.fromEntries(
      layout.rails.map((rail) => [rail.altId, rail.pathThroughRow]),
    );
    // va whole (through its tip), the mainline up THROUGH the fork row.
    expect(path.va).toBe(5);
    expect(path.edit).toBe(1);
    expect(
      Object.fromEntries(
        layout.nodes.map((node) => [node.commit, node.onSelectedPath]),
      ),
    ).toEqual({ c1: true, c2: false, v1: true });
  });

  it("traces the parked ('viewing') ancestry in its own channel", () => {
    const parkedWire = linearWire();
    parkedWire.changesets![0] = {
      ...pinChangeset(),
      parked: { commit: "c1", ref: trunk, turn: "s/1" },
    };
    const layout = buildUnifiedHistoryGraph(parkedWire)!;
    expect(layout.parked).toEqual([
      { changesetId: "cs-1", commit: "c1", ref: trunk, turn: "s/1" },
    ]);
    const viewing = Object.fromEntries(
      layout.rails.map((rail) => [rail.altId, rail.viewingThroughRow]),
    );
    // The pin trunk up through the parked row; the direct trunk untouched
    // (park is per changeset even though both share the mainline column).
    expect(viewing.edit).toBe(1);
    expect(viewing.direct).toBeUndefined();
    expect(
      Object.fromEntries(
        layout.nodes.map((node) => [node.commit, node.onViewingPath]),
      ),
    ).toEqual({ c1: true, c2: false, d1: false });
    expect(
      layout.nodes.find((node) => node.commit === "c1")?.parked,
    ).toBe(true);
    expect(
      layout.nodes.find((node) => node.commit === "c2")?.parked,
    ).toBe(false);
  });

  it("shows 'main' for trunk pills repeating the group title (full title kept)", () => {
    const layout = buildUnifiedHistoryGraph(
      linearWire(),
      "  card EXPLORATION ", // Case/whitespace-insensitive match.
    )!;
    const pinRail = layout.rails.find((rail) => rail.altId === "edit")!;
    expect(pinRail.displayTitle).toBe("main");
    expect(pinRail.title).toBe("Card exploration"); // Tooltip keeps it.
    // The direct pill keeps its label.
    expect(
      layout.rails.find((rail) => rail.altId === "direct")!.displayTitle,
    ).toBe("Direct edits");
    // Without a group title nothing dedupes.
    const plain = buildUnifiedHistoryGraph(linearWire())!;
    expect(
      plain.rails.find((rail) => rail.altId === "edit")!.displayTitle,
    ).toBe("Card exploration");
  });

  it("dedupes repeated turn records and drops unknown-rail nodes", () => {
    const noisy = linearWire();
    noisy.changesets![0].turns = [
      ...pinChangeset().turns!,
      { turn: "s/1", ref: trunk, commit: "c1", from: "b0", at: 100 }, // Repeat.
      { turn: "s/9", ref: `${PREFIX}/v/gone`, commit: "z9", at: 400 },
    ];
    const layout = buildUnifiedHistoryGraph(noisy)!;
    expect(layout.nodes.map((node) => node.commit)).toEqual([
      "c1",
      "d1",
      "c2",
    ]);
  });

  it("attributes foreign-conversation turns (reused pin rails keep full history)", () => {
    const shared = linearWire();
    shared.changesets![0].turns = [
      { turn: "s/1", ref: trunk, commit: "c1", from: "b0", at: 100, conversationId: "conv-a" },
      { turn: "s/2", ref: trunk, commit: "c2", from: "c1", at: 300, conversationId: "conv-b" },
    ];
    const layout = buildUnifiedHistoryGraph(shared)!;
    const foreign = Object.fromEntries(
      layout.nodes.map((node) => [node.commit, node.foreign]),
    );
    // Own conversation + tag-less records stay first-class; the OTHER
    // conversation's turn renders as foreign.
    expect(foreign).toEqual({ c1: false, c2: true, d1: false });
    // A changeset-scoped graph (no conversation) never flags anything.
    const unscoped = { ...shared };
    delete unscoped.conversationId;
    const layout2 = buildUnifiedHistoryGraph(unscoped)!;
    expect(layout2.nodes.every((node) => !node.foreign)).toBe(true);
  });

  it("reads trunk as selected when nothing explicit is selected", () => {
    const layout = buildUnifiedHistoryGraph({
      changesets: [directChangeset()],
    })!;
    expect(layout.rails[0].selected).toBe(true);
    // An explicit selection still wins over the fallback.
    const changeset = branchedChangeset();
    changeset.selectedRef = va;
    const explicit = buildUnifiedHistoryGraph({ changesets: [changeset] })!;
    expect(
      Object.fromEntries(
        explicit.rails.map((rail) => [rail.altId, rail.selected]),
      ),
    ).toEqual({ edit: false, va: true });
  });

  it("survives malformed wire entries", () => {
    expect(buildUnifiedHistoryGraph({})).toBeUndefined();
    expect(
      buildUnifiedHistoryGraph({
        changesets: [{}, pinChangeset(), { id: "empty", refs: [] }],
      })!.rails.map((rail) => rail.changesetId),
    ).toEqual(["cs-1"]);
  });
});
