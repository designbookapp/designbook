/**
 * Non-chat left-panel sections, wired to REAL state:
 *
 *  - Changes (round-2 shape): EVERY changeset of the viewed branch — every
 *    conversation's changesets + direct-edits + ungrouped, active or not —
 *    grouped under CONVERSATION headers, one row-group per changeset with an
 *    ACTIVE toggle (the existing activate/deactivate machinery), real
 *    per-changeset Bake/Discard (O2), conflict badges as before, and the
 *    remaining working-tree changes listed separately. Rows open the file's
 *    diff in the right panel's Code tab.
 *  - Tokens / Flags: the EXISTING workbench AdapterPanel (theme + flags
 *    adapter tabs) mounted whole in a dark wrapper — deliberately NOT rebuilt
 *    in the proto UI style (item 4).
 */

import { useEffect, useState } from "react";
import {
  CircleAlertIcon,
  GitBranchIcon,
  GitCommitVerticalIcon,
  LayersIcon,
  MessageSquareIcon,
  PencilLineIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
  Undo2Icon,
} from "lucide-react";
import { apiUrl } from "@designbook-ui/designbook";
import { useLiveChatMeta } from "@designbook-ui/models/chat/liveChatMeta";
import { AdapterPanel } from "@designbook-ui/screens/AdapterPanel";
import { getAdapterRuntime } from "@designbook-ui/adapterRuntime";
import type {
  ChangeStatus,
  FileChange,
} from "@designbook-ui/models/branch/changesModel";
import {
  conflictedChangesetIds,
  pinThreadTitle,
  sandboxComponentKey,
  type SandboxChangesetState,
  type SandboxDataConflict,
  type SandboxFileConflict,
} from "@designbook-ui/models/sandbox/sandboxModel";
import {
  useSandboxApi,
  type SandboxApi,
} from "@designbook-ui/models/sandbox/SandboxProvider";

const copy = {
  bake: "Bake",
  bakeConfirm: "Write into source",
  bakeConfirmDrifted: "Bake against changed source",
  bakeToBranch: "Branch",
  bakeToBranchConfirm: "Create branch",
  bakeToBranchTitle:
    "Bake this changeset onto a REAL git branch (a reviewable snapshot; nothing is pushed). The changeset stays active here.",
  bakedToBranch: (branch: string) => `→ ${branch}`,
  bakedToBranchTitle: (branch: string) =>
    `Baked to branch ${branch} — re-run Branch to stack a new commit on it.`,
  rebase: "Rebase",
  rebaseTitle:
    "Rebase onto current source: replay this changeset's work over the outside edits (a merge agent resolves conflicts; nothing is lost on failure).",
  rebaseRunning: "Rebasing onto current source…",
  rebaseConflict: "Conflict — a merge turn is resolving it…",
  rebaseFailed: (error: string) => `Rebase failed: ${error}`,
  cancel: "Cancel",
  conflict: "conflict",
  conflictFile: (count: number, file: string) =>
    `${count} changesets modify ${file}`,
  conflictKey: (key: string, file: string) =>
    `"${key}" changed twice in ${file}`,
  conflictKeep: (title: string) => `Keep ${title}`,
  compose: "Compose",
  composeTitle:
    "Merge the conflicting changesets: one merge-agent turn composes them into a NEW changeset (based on both) that activates on top.",
  conflictTitle:
    "Two active changesets modify the same file. Keep one (the others deactivate) or compose them — re-activate any of them later from its thread.",
  dataAdds: (count: number) =>
    `adds ${count} ${count === 1 ? "string" : "strings"}`,
  directEdits: "Direct edits",
  conversationFallback: "Conversation",
  currentConversation: "Current conversation",
  ungroupedChangesets: "Other changesets",
  activeToggleOn: "Active — serving in the app. Click to deactivate.",
  activeToggleOff: "Inactive — not serving. Click to activate.",
  discard: "Discard",
  discardConfirm: "Discard changeset",
  empty: "Edits made in this worktree will show up here.",
  loading: "Checking for changes…",
  noGit: "Not a git repo — change tracking is off.",
  noTab: (kind: string) => `No ${kind} adapter is configured for this app.`,
  pendingLanding: "not on disk yet",
  workingTree: "Working tree",
  reapplyOffer: (count: number, fromAlt: string, toAlt: string) =>
    `${count} ${count === 1 ? "change" : "changes"} on ${fromAlt} — reapply onto ${toAlt}?`,
  reapplyAccept: "Reapply",
  reapplyDismiss: "Dismiss",
  reapplyRunning: (toAlt: string) => `Reapplying onto ${toAlt}…`,
  reapplyConflict: "Conflict — a merge turn is resolving it…",
  reapplyFailed: (error: string) => `Reapply failed: ${error}`,
  reapplyKept: (fromAlt: string) =>
    `Your edits stay on ${fromAlt} — select it again to see them.`,
};

/** Designer-facing letter badge per status (proto badge look). */
function badgeFor(status: ChangeStatus): { letter: string; cls: string } {
  switch (status) {
    case "added":
    case "untracked":
      return { letter: "A", cls: "A" };
    case "deleted":
      return { letter: "D", cls: "D" };
    case "renamed":
      return { letter: "R", cls: "R" };
    case "conflicted":
      return { letter: "C", cls: "C" };
    default:
      return { letter: "M", cls: "M" };
  }
}

function FileRow({
  path,
  status,
  hint,
  onOpen,
}: {
  path: string;
  status?: ChangeStatus;
  hint?: string;
  onOpen?: () => void;
}) {
  const badge = status ? badgeFor(status) : { letter: "M", cls: "M" };
  return (
    <button className="dbproto-filerow" onClick={onOpen} title={path}>
      <span className={`dbproto-badge ${badge.cls}`}>{badge.letter}</span>
      <span className="dbproto-filepath">{path}</span>
      {hint ? <span className="dbproto-filehint">{hint}</span> : null}
    </button>
  );
}

/** A changeset's display title: its own wire title (direct-edits layers
 * carry "Direct edits"), else the owning pin thread's title, else the id. */
function changesetTitle(
  api: SandboxApi,
  changeset: SandboxChangesetState,
): string {
  if (changeset.title) return changeset.title;
  const pin = api.pins[changeset.threadPinId];
  if (pin) return pinThreadTitle(pin);
  return changeset.direct ? copy.directEdits : changeset.id;
}

/** One ACTIVE changeset's group: header (thread title + real O2 Bake/Discard
 * with inline confirm) + its override files, matched against the real git
 * changes for status badges. Conflicted groups (server file/data conflicts)
 * carry the amber badge — the Choose strip above owns the resolution. */
function ChangesetGroup({
  api,
  changeset,
  changesByPath,
  conflicted,
  onOpenDiff,
  onError,
}: {
  api: SandboxApi;
  changeset: SandboxChangesetState;
  changesByPath: Map<string, FileChange>;
  /** This changeset participates in a server-reported conflict. */
  conflicted: boolean;
  onOpenDiff: (path: string) => void;
  onError: (error: string | undefined) => void;
}) {
  // Round-2: every changeset row carries an ACTIVE toggle (the existing
  // activate/deactivate + switch machinery — flips are hot, layer-wins).
  const [toggling, setToggling] = useState(false);
  async function toggleActive() {
    setToggling(true);
    onError(undefined);
    const result = await api.activate({
      changesetId: changeset.id,
      active: !changeset.active,
    });
    onError(result.error);
    setToggling(false);
  }
  const [confirming, setConfirming] = useState<"bake" | "discard" | "branch">();
  const [branchName, setBranchName] = useState<string>();
  const pin = api.pins[changeset.threadPinId];
  const title = changesetTitle(api, changeset);
  const files = [
    ...new Set(changeset.overrides.flatMap((override) => override.variantFiles)),
  ];
  const bake = api.bakes[changeset.id];
  const rebase = api.rebases[changeset.id];
  const rebasing =
    rebase !== undefined &&
    (rebase.status === "running" || rebase.status === "conflict");
  const busy =
    (pin?.busy ?? false) ||
    rebasing ||
    (bake !== undefined &&
      (bake.status === "queued" || bake.status === "running" || bake.status === "gated"));
  /** Default branch-bake name: the last target, else designbook/<slug>. */
  const defaultBranchName =
    changeset.bakedTo?.branch ??
    `designbook/${
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || changeset.id
    }`;

  function run(action: "bake" | "discard" | "branch") {
    setConfirming(undefined);
    onError(undefined);
    const request =
      action === "bake"
        ? api.bake({
            changesetId: changeset.id,
            ...(changeset.drifted ? { force: true } : {}),
          })
        : action === "branch"
          ? api.bakeToBranch({
              changesetId: changeset.id,
              name: (branchName ?? defaultBranchName).trim(),
              ...(changeset.drifted ? { force: true } : {}),
            })
          : api.discard({ changesetId: changeset.id });
    void request.then((result) => onError(result.error));
  }

  return (
    <div
      className="dbproto-cs-group"
      style={changeset.active ? undefined : { opacity: 0.55 }}
    >
      <div className="dbproto-cs-grouphead">
        <button
          className="dbproto-minibtn"
          style={{ border: "none", background: "transparent", padding: 0 }}
          disabled={toggling || busy}
          title={
            changeset.active ? copy.activeToggleOn : copy.activeToggleOff
          }
          onClick={() => void toggleActive()}
        >
          {changeset.active ? (
            <ToggleRightIcon size={17} style={{ color: "var(--accent)" }} />
          ) : (
            <ToggleLeftIcon size={17} style={{ color: "var(--faint)" }} />
          )}
        </button>
        <span className="dbproto-cs-grouptitle">
          {changeset.direct ? (
            <PencilLineIcon size={13} style={{ flex: "none" }} />
          ) : (
            <LayersIcon size={13} style={{ flex: "none" }} />
          )}
          <span title={title}>{title}</span>
        </span>
        {conflicted ? (
          <span className="dbproto-pill warn" title={copy.conflictTitle}>
            {copy.conflict}
          </span>
        ) : null}
        {changeset.drifted && !rebasing ? (
          <span className="dbproto-pill warn">drifted</span>
        ) : null}
        {changeset.bakedTo ? (
          <span
            className="dbproto-pill info"
            title={copy.bakedToBranchTitle(changeset.bakedTo.branch)}
          >
            {copy.bakedToBranch(changeset.bakedTo.branch)}
          </span>
        ) : null}
        {changeset.dataAdditionCount > 0 ? (
          // Data-only layers (fileCount 0): this badge is the PRIMARY signal.
          <span className="dbproto-pill info">
            {copy.dataAdds(changeset.dataAdditionCount)}
          </span>
        ) : null}
        {rebasing ? (
          <>
            <span className="dbproto-dot-spin" />
            <span className="lead dbproto-shimmer">
              {rebase.status === "conflict"
                ? copy.rebaseConflict
                : copy.rebaseRunning}
            </span>
          </>
        ) : confirming === undefined ? (
          <>
            {changeset.drifted ? (
              // G3: the explicit "Rebase onto current source" action —
              // replay the changeset's branches over the outside edits.
              <button
                className="dbproto-minibtn primary"
                disabled={busy}
                title={copy.rebaseTitle}
                onClick={() => {
                  onError(undefined);
                  void api
                    .rebase({ changesetId: changeset.id })
                    .then((result) => onError(result.error));
                }}
              >
                <Undo2Icon size={12} /> {copy.rebase}
              </button>
            ) : null}
            <button
              className="dbproto-minibtn primary"
              disabled={busy}
              onClick={() => setConfirming("bake")}
            >
              <GitCommitVerticalIcon size={12} /> {copy.bake}
            </button>
            <button
              className="dbproto-minibtn"
              disabled={busy}
              title={copy.bakeToBranchTitle}
              onClick={() => {
                setBranchName(defaultBranchName);
                setConfirming("branch");
              }}
            >
              <GitBranchIcon size={12} /> {copy.bakeToBranch}
            </button>
            <button
              className="dbproto-minibtn danger"
              disabled={busy}
              onClick={() => setConfirming("discard")}
            >
              {copy.discard}
            </button>
          </>
        ) : confirming === "branch" ? (
          <>
            <input
              className="dbproto-input"
              style={{ width: 180, fontSize: 11 }}
              value={branchName ?? defaultBranchName}
              onChange={(event) => setBranchName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") run("branch");
                if (event.key === "Escape") setConfirming(undefined);
              }}
              autoFocus
            />
            <button
              className="dbproto-minibtn confirm"
              disabled={busy || !(branchName ?? defaultBranchName).trim()}
              onClick={() => run("branch")}
            >
              {copy.bakeToBranchConfirm}
            </button>
            <button className="dbproto-minibtn" onClick={() => setConfirming(undefined)}>
              {copy.cancel}
            </button>
          </>
        ) : (
          <>
            <button
              className={`dbproto-minibtn confirm ${confirming === "discard" ? "danger" : ""}`}
              disabled={busy}
              onClick={() => run(confirming)}
            >
              {confirming === "bake"
                ? changeset.drifted
                  ? copy.bakeConfirmDrifted
                  : copy.bakeConfirm
                : copy.discardConfirm}
            </button>
            <button className="dbproto-minibtn" onClick={() => setConfirming(undefined)}>
              {copy.cancel}
            </button>
          </>
        )}
      </div>
      {rebase?.status === "failed" && rebase.error ? (
        <span className="dbproto-prompt-error">
          {copy.rebaseFailed(rebase.error)}
        </span>
      ) : null}
      {files.map((file) => {
        const change = changesByPath.get(file);
        return (
          <FileRow
            key={file}
            path={file}
            status={change?.status}
            hint={change ? undefined : copy.pendingLanding}
            onOpen={() => onOpenDiff(file)}
          />
        );
      })}
    </div>
  );
}

/** Compact conflict strip (Michael's decision, changeset-layers follow-ups):
 * the SERVER's file-level layer conflicts + data-key conflicts render in the
 * CHANGES panel — one amber row per conflict, with a Keep action per
 * participating changeset (keep one = POST /api/sandbox/activate deactivates
 * the others; the layer engine then resolves the file to the kept layer) and,
 * for file conflicts with a resolvable component, a Compose action (POST
 * /api/sandbox/compose — one merge-agent turn lands a NEW changeset based on
 * both, which activates on top and shows up as its own group). */
function ConflictStrip({
  api,
  conflict,
  label,
  composeComponent,
  onError,
}: {
  api: SandboxApi;
  conflict: SandboxFileConflict | SandboxDataConflict;
  label: string;
  /** Compose target (`module#export`) — set only for file-level conflicts
   * whose component resolves from a participating changeset's override. */
  composeComponent?: string;
  onError: (error: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const participants = conflict.changesetIds.flatMap((id) => {
    const changeset = api.changesets.find((candidate) => candidate.id === id);
    return changeset ? [changeset] : [];
  });

  async function keep(keepId: string) {
    setBusy(true);
    onError(undefined);
    for (const other of conflict.changesetIds) {
      if (other === keepId) continue;
      const result = await api.activate({ changesetId: other, active: false });
      if (result.error) {
        onError(result.error);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
  }

  async function compose() {
    if (!composeComponent) return;
    setBusy(true);
    onError(undefined);
    const result = await api.compose({
      component: composeComponent,
      changesetIds: conflict.changesetIds,
    });
    if (result.error) onError(result.error);
    setBusy(false);
  }

  return (
    <div
      className="dbproto-csbar"
      title={copy.conflictTitle}
      style={{
        background: "color-mix(in srgb, var(--amber) 8%, transparent)",
        flexWrap: "wrap",
      }}
    >
      <CircleAlertIcon size={13} style={{ color: "var(--amber)", flex: "none" }} />
      <span className="lead" style={{ color: "var(--amber)" }} title={label}>
        {label}
      </span>
      {participants.map((changeset) => (
        <button
          key={changeset.id}
          className="dbproto-minibtn"
          disabled={busy}
          onClick={() => void keep(changeset.id)}
          title={copy.conflictKeep(changesetTitle(api, changeset))}
        >
          {copy.conflictKeep(changesetTitle(api, changeset))}
        </button>
      ))}
      {composeComponent ? (
        <button
          className="dbproto-minibtn primary"
          disabled={busy}
          onClick={() => void compose()}
          title={copy.composeTitle}
        >
          {copy.compose}
        </button>
      ) : null}
    </div>
  );
}

/**
 * G2 reapply strip (spec §Selection): after a variant switch left
 * post-selection edits behind, a NON-BLOCKING offer — "N changes on <old> —
 * reapply onto <new>?" Accept cherry-picks (conflicts get ONE merge turn);
 * decline dismisses and the edits simply stay on the old branch. Rendered in
 * the Changes panel and the owning pin thread (ChatPanel).
 */
function ReapplyStrip({ api }: { api: SandboxApi }) {
  const state = api.reapplyState;
  if (!state) return null;
  const accent = state.status === "failed" ? "var(--amber)" : "var(--accent)";
  return (
    <div
      className="dbproto-csbar"
      style={{
        background: `color-mix(in srgb, ${accent} 8%, transparent)`,
        flexWrap: "wrap",
      }}
    >
      <Undo2Icon size={13} style={{ color: accent, flex: "none" }} />
      {state.status === "offered" ? (
        <>
          <span className="lead">
            {copy.reapplyOffer(state.count, state.fromAlt, state.toAlt)}
          </span>
          <button
            className="dbproto-minibtn primary"
            onClick={() =>
              void api.reapply({
                changesetId: state.changesetId,
                fromRef: state.fromRef,
                toRef: state.toRef,
              })
            }
          >
            {copy.reapplyAccept}
          </button>
          <button className="dbproto-minibtn" onClick={api.dismissReapply}>
            {copy.reapplyDismiss}
          </button>
        </>
      ) : null}
      {state.status === "running" || state.status === "conflict" ? (
        <>
          <span className="dbproto-dot-spin" />
          <span className="lead dbproto-shimmer">
            {state.status === "conflict"
              ? copy.reapplyConflict
              : copy.reapplyRunning(state.toAlt)}
          </span>
        </>
      ) : null}
      {state.status === "failed" ? (
        <>
          <span className="lead" style={{ color: "var(--amber)" }}>
            {copy.reapplyFailed(state.error ?? "unknown error")}{" "}
            {copy.reapplyKept(state.fromAlt)}
          </span>
          <button className="dbproto-minibtn" onClick={api.dismissReapply}>
            {copy.reapplyDismiss}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** The compose target for a FILE conflict: the first participating
 * changeset's override of the conflicted file names the export — compose
 * parses the module back off the `module#export` key server-side. */
function composeComponentForConflict(
  changesets: readonly SandboxChangesetState[],
  conflict: SandboxFileConflict,
): string | undefined {
  for (const id of conflict.changesetIds) {
    const changeset = changesets.find((candidate) => candidate.id === id);
    const override = changeset?.overrides.find(
      (candidate) => candidate.module === conflict.file,
    );
    if (override) {
      return sandboxComponentKey(override.module, override.exportName);
    }
  }
  return undefined;
}

function ChangesSection({
  changes,
  loaded,
  git,
  onOpenDiff,
}: {
  changes: FileChange[];
  loaded: boolean;
  git: boolean;
  onOpenDiff: (path: string) => void;
}) {
  const api = useSandboxApi();
  const chat = useLiveChatMeta();
  const [error, setError] = useState<string>();
  // Round-2: EVERY changeset of the viewed branch shows (active or not) —
  // grouped under conversation headers below.
  const all = api?.changesets ?? [];
  const active = all.filter((changeset) => changeset.active);
  // Conversation titles for the group headers (thread history rows carry
  // conversationId + title; the live conversation falls back to its first
  // message).
  const [threadTitles, setThreadTitles] = useState<Map<string, string>>(
    () => new Map(),
  );
  useEffect(() => {
    let disposed = false;
    void fetch(apiUrl("/api/sandbox/threads"))
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as {
          threads?: Array<{ conversationId?: string; title?: string }>;
        };
        if (disposed || !Array.isArray(payload.threads)) return;
        const titles = new Map<string, string>();
        for (const thread of payload.threads) {
          if (thread.conversationId && thread.title) {
            titles.set(thread.conversationId, thread.title);
          }
        }
        setThreadTitles(titles);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [all.length]);
  /** The conversation a changeset belongs to (meta, else its pin's). */
  const conversationOf = (changeset: SandboxChangesetState): string | undefined =>
    changeset.conversationId ??
    (api ? api.pins[changeset.threadPinId]?.conversationId : undefined);
  const conversationTitle = (conversationId: string): string => {
    const fromHistory = threadTitles.get(conversationId);
    if (fromHistory) return fromHistory;
    if (conversationId === chat.conversationId) {
      return (
        chat.firstMessage?.split("\n").find(Boolean) ??
        copy.currentConversation
      );
    }
    return copy.conversationFallback;
  };
  /** Conversation groups, live conversation first, then by title; the
   * conversation-less remainder last. */
  const groups = (() => {
    const byConversation = new Map<string, SandboxChangesetState[]>();
    const rest: SandboxChangesetState[] = [];
    for (const changeset of all) {
      const conversationId = conversationOf(changeset);
      if (!conversationId) {
        rest.push(changeset);
        continue;
      }
      const list = byConversation.get(conversationId) ?? [];
      list.push(changeset);
      byConversation.set(conversationId, list);
    }
    const entries = [...byConversation].map(([conversationId, changesets]) => ({
      conversationId,
      title: conversationTitle(conversationId),
      changesets,
    }));
    entries.sort((a, b) => {
      const liveA = a.conversationId === chat.conversationId ? 0 : 1;
      const liveB = b.conversationId === chat.conversationId ? 0 : 1;
      if (liveA !== liveB) return liveA - liveB;
      return a.title < b.title ? -1 : 1;
    });
    return { entries, rest };
  })();
  const changesByPath = new Map(changes.map((change) => [change.path, change]));
  const grouped = new Set(
    active.flatMap((changeset) =>
      changeset.overrides.flatMap((override) => override.variantFiles),
    ),
  );
  // A pin's context wrapper etc. also lands under .designbook/sandbox — keep
  // attribution simple: exactly the override variant files group; the rest is
  // the working tree.
  const ungrouped = changes.filter((change) => !grouped.has(change.path));
  // Server-reported conflicts (file-level layer conflicts + data keys) —
  // amber badge on the affected groups + the Choose strips below.
  const conflicts = api?.conflicts ?? [];
  const dataConflicts = api?.dataConflicts ?? [];
  const conflictedIds = conflictedChangesetIds(conflicts, dataConflicts);
  const fileName = (path: string) => path.split("/").pop() ?? path;

  return (
    <div className="dbproto-panel-scroll">
      <div className="dbproto-changes">
        {error ? <span className="dbproto-prompt-error">{error}</span> : null}
        {api ? <ReapplyStrip api={api} /> : null}
        {api
          ? conflicts.map((conflict) => (
              <ConflictStrip
                key={`conflict:${conflict.file}`}
                api={api}
                conflict={conflict}
                label={copy.conflictFile(
                  conflict.changesetIds.length,
                  fileName(conflict.file),
                )}
                composeComponent={composeComponentForConflict(
                  api.changesets,
                  conflict,
                )}
                onError={setError}
              />
            ))
          : null}
        {api
          ? dataConflicts.map((conflict) => (
              <ConflictStrip
                key={`data-conflict:${conflict.file}:${conflict.key}`}
                api={api}
                conflict={conflict}
                label={copy.conflictKey(conflict.key, fileName(conflict.file))}
                onError={setError}
              />
            ))
          : null}
        {api
          ? groups.entries.map((group) => (
              <div key={`conv:${group.conversationId}`}>
                <div
                  className="dbproto-cs-label"
                  style={{ marginBottom: 6 }}
                  title={group.conversationId}
                >
                  <MessageSquareIcon size={13} />
                  {group.title}
                </div>
                {group.changesets.map((changeset) => (
                  <ChangesetGroup
                    key={changeset.id}
                    api={api}
                    changeset={changeset}
                    changesByPath={changesByPath}
                    conflicted={conflictedIds.has(changeset.id)}
                    onOpenDiff={onOpenDiff}
                    onError={setError}
                  />
                ))}
              </div>
            ))
          : null}
        {api && groups.rest.length > 0 ? (
          <div>
            <div className="dbproto-cs-label" style={{ marginBottom: 6 }}>
              <LayersIcon size={13} />
              {copy.ungroupedChangesets}
            </div>
            {groups.rest.map((changeset) => (
              <ChangesetGroup
                key={changeset.id}
                api={api}
                changeset={changeset}
                changesByPath={changesByPath}
                conflicted={conflictedIds.has(changeset.id)}
                onOpenDiff={onOpenDiff}
                onError={setError}
              />
            ))}
          </div>
        ) : null}
        <div>
          <div className="dbproto-cs-label" style={{ marginBottom: 6 }}>
            <GitCommitVerticalIcon size={13} />
            {copy.workingTree} · {loaded ? ungrouped.length : "…"}
          </div>
          {!loaded ? (
            <div className="dbproto-empty">{copy.loading}</div>
          ) : ungrouped.length === 0 ? (
            <div className="dbproto-empty">
              {copy.empty}
              {!git ? ` ${copy.noGit}` : ""}
            </div>
          ) : (
            ungrouped.map((change) => (
              <FileRow
                key={change.path}
                path={change.path}
                status={change.status}
                onOpen={() => onOpenDiff(change.path)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Mount an adapter-contributed tab (the REAL workbench panel) whole. */
function AdapterTabSection({ suffix, kind }: { suffix: string; kind: string }) {
  const runtime = getAdapterRuntime();
  const tab = runtime.tabs.find((candidate) => candidate.id.endsWith(`:${suffix}`));
  if (!tab) {
    return <div className="dbproto-empty">{copy.noTab(kind)}</div>;
  }
  return (
    <div className="dbproto-panel-scroll">
      <div className="dark dbproto-embed">
        <AdapterPanel tab={tab} />
      </div>
    </div>
  );
}

function TokensSection() {
  return <AdapterTabSection suffix="theme" kind="theme-token" />;
}

function FlagsSection() {
  return <AdapterTabSection suffix="flags" kind="feature-flag" />;
}

export { ChangesSection, FlagsSection, ReapplyStrip, TokensSection };
