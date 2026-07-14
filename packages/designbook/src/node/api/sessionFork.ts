/**
 * G4 — chat forking (docs/specs/changesets-on-git.md §G4): the transcript
 * boundary a park-fork slices the parent Pi session at. The actual slice is
 * `SessionManager.createBranchedSession(leafId)` (a NEW session file with
 * the root→leaf path; header.parentSession links the parent) — this module
 * only RESOLVES the leaf:
 *
 *   1. the parked turn record's recorded `leaf` (stamped at turn end, G4);
 *   2. else the entry just BEFORE the (n+1)-th USER message — turn labels
 *      are `<sessionId>/<n>` and turn n's content precedes prompt n+1;
 *   3. else the session's current leaf (fork = full copy — still safe).
 *
 * Structural typing keeps it testable without the Pi SDK; api.ts passes the
 * real SessionManager. NOTE for Resume: this + createBranchedSession is the
 * whole "open any history row as a live session" mechanism.
 */

/** The SessionManager slice this module reads (structural). */
type SliceableSession = {
  getEntry(id: string): unknown;
  getBranch(): Array<{
    id: string;
    type: string;
    message?: { role?: string };
  }>;
  getLeafId(): string | null;
};

/**
 * The entry id to slice a park-fork's chat at (see module doc). Undefined
 * only when the transcript is empty.
 */
function forkSliceLeaf(
  manager: SliceableSession,
  turnLabel: string | undefined,
  turnRecords: readonly { turn: string; leaf?: string }[],
): string | undefined {
  if (turnLabel) {
    const record = [...turnRecords]
      .reverse()
      .find((candidate) => candidate.turn === turnLabel);
    if (record?.leaf && manager.getEntry(record.leaf)) return record.leaf;
    const parsed = /\/(\d+)$/.exec(turnLabel);
    const turnIndex = parsed ? Number(parsed[1]) : NaN;
    if (Number.isFinite(turnIndex) && turnIndex >= 1) {
      let userCount = 0;
      let previousId: string | undefined;
      for (const entry of manager.getBranch()) {
        if (entry.type === "message" && entry.message?.role === "user") {
          userCount += 1;
          if (userCount === turnIndex + 1) return previousId;
        }
        previousId = entry.id;
      }
    }
  }
  return manager.getLeafId() ?? undefined;
}

export { forkSliceLeaf };
export type { SliceableSession };
