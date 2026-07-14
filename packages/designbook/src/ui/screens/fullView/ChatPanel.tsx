/**
 * Full-view chat panel — the thread system (row assembly in
 * models/chat/threadRows) filling the full view's dark left panel.
 *
 * Views mirror the drawer exactly: the ALL-THREADS list (pin threads + the
 * general chat + prior chat sessions, via drawerThreads' buildThreadRows), one
 * PIN THREAD (real messages + director activity + variant sub-agents + a real
 * follow-up prompt through /api/sandbox/ask), the LIVE CHAT (the real
 * DesignChat, embedded whole in a dark wrapper), and the READ-ONLY history
 * transcript (chatModel's messagesToThreadItems fold).
 *
 * SELECTION-SCOPED PROMPTS (conversation-routed asks — changesets-on-git.md
 * §Conversation-routed asks): while the select tool holds a promptable frame
 * selection, the panel's composers route the prompt to the PERSISTENT
 * CONVERSATION SESSION as a normal turn — reuse-or-create the selection's
 * pin (promptTarget.ts, FRESH capture at send), then POST /api/prompt with
 * the selection attached. The server binds the conversation's workspace to
 * the pin's changeset for that turn, the message renders in the conversation
 * thread with a PIN CHIP, and a variants ask fans out on the pin (unchanged
 * pipeline) with its cards anchored IN the conversation. The pin thread view
 * below remains the drill-in surface for a pin's cards/bake actions.
 *
 * Variants render as the proto's selectable CARDS over the REAL variant rows:
 * the card switch + active ring are the O1 per-component switch (api.setSwitch
 * — server-persisted, SSE-synced), Iterate submits a real element-less
 * /api/sandbox/iterate turn, Bake runs the real O2 bake (drifted ⇒ force
 * consent on the confirm click). Each card's chevron expands the sub-agent's
 * brief + live activity rows (U4).
 */

import { useEffect, useRef, useState } from "react";
import {
  BrainIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  FrameIcon,
  GitBranchIcon,
  HistoryIcon,
  MessageSquareIcon,
  PencilLineIcon,
  PinIcon,
  PlusIcon,
  RepeatIcon,
  SparklesIcon,
} from "lucide-react";
import { apiUrl } from "@designbook-ui/designbook";
import { DesignChat } from "@designbook-ui/screens/DesignChat";
import { messagesToThreadItems } from "@designbook-ui/models/chat/chatModel";
import { parseSelectionMessage } from "@designbook-ui/models/chat/messageTransforms";
import { canPromptFrameSandbox } from "@designbook-ui/models/frame/appFrameHit";
import type { CanvasHitResult } from "@designbook-ui/screens/CanvasOverlay";
import {
  captureSelectionSnapshot,
  createSelectionPin,
  findReusablePin,
  frameHitToSandboxSelection,
} from "@designbook-ui/screens/sandbox/promptTarget";
import type {
  CanvasNodeSelection,
} from "@designbook-ui/types";
import type {
  DesignVariantsRow,
  RawAgentMessage,
  ThreadItem,
} from "@designbook-ui/models/chat/types";
import {
  activeChangesetForPin,
  bakeStateForPin,
  conflictedPinIds,
  pinThreadTitle,
  readyCounts,
  sandboxComponentKey,
  type SandboxActivityEntry,
  type SandboxBakeState,
  type SandboxChangesetState,
  type SandboxPinState,
  type SandboxVariantState,
} from "@designbook-ui/models/sandbox/sandboxModel";
import {
  useSandboxApi,
  type SandboxApi,
} from "@designbook-ui/models/sandbox/SandboxProvider";
import { useLiveChatMeta } from "@designbook-ui/models/chat/liveChatMeta";
import {
  buildThreadRows,
  formatLastActivity,
  type ChatHistoryThread,
  type ThreadRow,
  type ThreadRowStatus,
} from "@designbook-ui/models/chat/threadRows";
import { variantSwatches } from "./mockData";
import { HistoryPanel } from "./HistoryPanel";
import { ReapplyStrip } from "./panels";
import { Switch } from "./ui";

/** The chat panel's view stack (all-threads list / general chat / one pin
 * thread / read-only history transcript). */
type ChatView =
  | { kind: "list" }
  | { kind: "chat" }
  | { kind: "thread"; pinId: string }
  | { kind: "history"; path: string; title: string };

const copy = {
  back: "All threads",
  bake: "Bake",
  bakeConfirm: "Write into source",
  bakeConfirmDrifted: "Bake against changed source",
  bakeDone: "Baked into real source.",
  bakeFailed: (error: string) => `Bake failed: ${error}`,
  bakeGated: "Typechecking the rewrite…",
  bakeQueued: "Bake queued…",
  bakeRunning: "Baking — writing the design into real source…",
  cancel: "Cancel",
  changesetActive: "Sandbox changes active",
  directEdits: "Direct edits",
  directorPlanning: "Planning variant directions…",
  directorSummary: "Planned the variant directions",
  discard: "Discard",
  discardConfirm: "Discard changes",
  editing: "Working on it…",
  followUpPlaceholder: "Reply — describe a change or ask for variations…",
  generating: (n: number) => `Generating ${n} variants…`,
  generatingProgress: (ready: number, total: number) => `${ready}/${total} ready`,
  forkPill: "fork",
  historyEmpty: "No earlier conversations.",
  historyExit: "Exit",
  historyMessages: (count: number) => `${count} messages`,
  historyToggle: "History — this conversation's branches and turns",
  historyViewing: (turn?: number) =>
    turn !== undefined
      ? `Viewing turn ${turn} — new prompts fork from here.`
      : "Viewing an earlier point — new prompts fork from here.",
  iterate: "Iterate",
  iteratePlaceholder: (id: string) => `Iterate on ${id}…`,
  loadingThread: "Loading thread…",
  openCanvas: "Open canvas",
  pinCreateFailed: "Could not create the pin.",
  readOnlyTranscript: "Read-only transcript of an earlier conversation.",
  routing: "Thinking…",
  selectionPromptPlaceholder: "Describe a change or ask for variations…",
  send: "Send",
  threads: "Threads",
  dataAdds: (count: number) =>
    `adds ${count} ${count === 1 ? "string" : "strings"}`,
  directFiles: (count: number) =>
    `${count} ${count === 1 ? "file" : "files"} changed`,
  discardChangesetConfirm: "Discard changes",
};

// ---------------------------------------------------------------------------
// Shared bits.
// ---------------------------------------------------------------------------

// Live chat metadata (first message / last activity / conversation id) comes
// from the drawer's exported useLiveChatMeta hook (L3) — seed-fetch +
// `state` SSE subscription, shared verbatim.

function activityEntryRows(
  entries: SandboxActivityEntry[],
): Array<{ key: string; text: string; error?: boolean }> {
  return entries.map((entry, index) =>
    entry.type === "tool"
      ? {
          key: `tool-${entry.id}-${index}`,
          text: `${entry.status === "running" ? "Running" : "Ran"} ${entry.name}${
            entry.detail ? ` · ${entry.detail}` : ""
          }`,
          error: entry.status === "error",
        }
      : {
          key: `thinking-${index}`,
          text: entry.text.trim().split("\n").find(Boolean) ?? "…",
        },
  );
}

function activitySummary(
  entries: SandboxActivityEntry[],
  fallback: string,
): string {
  const last = entries[entries.length - 1];
  if (!last) return fallback;
  if (last.type === "tool") {
    return `${last.status === "running" ? "Running" : "Ran"} ${last.name}${
      last.detail ? ` · ${last.detail}` : ""
    }`;
  }
  return last.text.trim().split("\n").filter(Boolean).pop() ?? fallback;
}

/** Collapsed, expandable activity row (proto's collapse-row treatment over the
 * drawer's ThreadActivityRow). */
function ActivityRow({
  summary,
  running,
  entries,
}: {
  summary: string;
  running?: boolean;
  entries?: Array<{ key: string; text: string; error?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="dbproto-collapse-row" onClick={() => setOpen((o) => !o)}>
        {running ? (
          <span className="dbproto-dot-spin" />
        ) : (
          <ChevronRightIcon
            size={13}
            style={{ transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}
          />
        )}
        <BrainIcon size={13} />
        <span
          className={running ? "dbproto-shimmer" : undefined}
          style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {summary}
        </span>
      </button>
      {open && entries && entries.length > 0 ? (
        <div className="dbproto-act-body">
          {entries.map((entry) => (
            <div key={entry.key} className={entry.error ? "error" : undefined}>
              {entry.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MessageBubble({ role, text }: { role: "user" | "assistant"; text: string }) {
  return (
    <div className={`dbproto-msg ${role === "user" ? "user" : ""}`}>
      <div className={`dbproto-bubble ${role === "user" ? "user" : "asst"}`}>{text}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant cards — the proto card treatment on REAL variant rows.
// ---------------------------------------------------------------------------

function variantStatusLabel(variant: SandboxVariantState): string {
  if (variant.status === "generating" && variant.attempt !== undefined) {
    return `retry ${variant.attempt}`;
  }
  return variant.status;
}

function VariantCard({
  api,
  pin,
  variant,
  index,
  changeset,
  switchedOn,
  onError,
}: {
  api: SandboxApi;
  pin: SandboxPinState;
  variant: SandboxVariantState;
  index: number;
  changeset: SandboxChangesetState | undefined;
  /** The O1 switch currently renders THIS variant in place. */
  switchedOn: boolean;
  onError: (error: string | undefined) => void;
}) {
  const [activityOpen, setActivityOpen] = useState(false);
  const [iterateOpen, setIterateOpen] = useState(false);
  const [iteratePrompt, setIteratePrompt] = useState("");
  const [bakeConfirm, setBakeConfirm] = useState(false);
  const swatch = variantSwatches[index % variantSwatches.length];
  const busy = variant.status === "generating" || variant.status === "updating";
  const canFlip = variant.status === "ready" && changeset !== undefined;

  useEffect(() => setBakeConfirm(false), [changeset?.id, pin.busy]);

  function flipSwitch() {
    if (!changeset) return;
    const component = sandboxComponentKey(pin.target.file, pin.target.exportName);
    onError(undefined);
    void api
      .setSwitch({
        component,
        selection: switchedOn
          ? null
          : { changesetId: changeset.id, variantId: variant.id },
      })
      .then((result) => onError(result.error));
  }

  async function submitIterate() {
    const prompt = iteratePrompt.trim();
    if (!prompt || pin.busy) return;
    onError(undefined);
    const result = await api.iterate({ pinId: pin.id, variantId: variant.id, prompt });
    if (result.error) {
      onError(result.error);
      return;
    }
    setIteratePrompt("");
    setIterateOpen(false);
  }

  function bake() {
    if (!changeset) return;
    onError(undefined);
    // A drifted changeset's confirm IS the force consent (O2).
    void api
      .bake({ changesetId: changeset.id, ...(changeset.drifted ? { force: true } : {}) })
      .then((result) => onError(result.error));
    setBakeConfirm(false);
  }

  return (
    <div
      className={`dbproto-vcard ${switchedOn ? "active" : ""} ${
        variant.status === "failed" ? "disabled" : ""
      }`}
    >
      {switchedOn ? (
        <span className="dbproto-vcard-ring">
          <CircleCheckIcon size={16} style={{ color: "var(--accent)" }} />
        </span>
      ) : null}
      <button
        className="dbproto-vcard-preview"
        style={{ background: `linear-gradient(135deg, ${swatch[0]}, ${swatch[1]})` }}
        onClick={() => canFlip && flipSwitch()}
        title={
          canFlip
            ? switchedOn
              ? "Switched in place — restore original"
              : "Switch in place (render at every live instance)"
            : variantStatusLabel(variant)
        }
      >
        <div className="dbproto-vcard-mini" />
      </button>
      <div className="dbproto-vcard-body">
        <div className="dbproto-vcard-name">
          <span title={variant.id}>{variant.id}</span>
          <span className={`dbproto-pill ${variant.status}`} style={{ marginLeft: "auto" }}>
            {busy ? <span className="dbproto-dot-spin" /> : null}
            {variantStatusLabel(variant)}
          </span>
          <button
            className="dbproto-backbtn"
            style={{ width: 20, height: 20 }}
            onClick={() => setActivityOpen((o) => !o)}
            title="Sub-agent activity"
          >
            <ChevronRightIcon
              size={13}
              style={{ transition: "transform .15s", transform: activityOpen ? "rotate(90deg)" : "none" }}
            />
          </button>
        </div>
        {variant.intent ? (
          <div className="dbproto-vcard-note" title={variant.intent}>
            {variant.intent}
          </div>
        ) : null}
      </div>
      {variant.error ? (
        <div className="dbproto-vcard-error">{variant.error}</div>
      ) : null}
      {activityOpen ? (
        <div className="dbproto-vcard-activity">
          {variant.activity.length === 0 ? (
            <span style={{ color: "var(--faint)", fontSize: 10.5 }}>No activity yet.</span>
          ) : (
            activityEntryRows(variant.activity).map((entry) => (
              <div
                key={entry.key}
                style={{
                  color: entry.error ? "#f85149" : "var(--faint)",
                  fontSize: 10.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {entry.text}
              </div>
            ))
          )}
        </div>
      ) : null}
      <div className="dbproto-vcard-foot">
        <Switch
          on={switchedOn}
          onToggle={flipSwitch}
          disabled={!canFlip}
          title={
            canFlip
              ? "Switch this variant in place (O1)"
              : "Needs a ready variant + active changeset"
          }
        />
        <button
          className="dbproto-vcard-act"
          disabled={pin.busy || busy}
          onClick={() => setIterateOpen((o) => !o)}
        >
          <RepeatIcon size={12} /> {copy.iterate}
        </button>
        <button
          className={`dbproto-vcard-act primary ${bakeConfirm ? "confirm" : ""}`}
          disabled={!changeset || pin.busy}
          title={changeset?.drifted ? copy.bakeConfirmDrifted : undefined}
          onClick={() => (bakeConfirm ? bake() : setBakeConfirm(true))}
        >
          <SparklesIcon size={12} /> {bakeConfirm ? copy.bakeConfirm : copy.bake}
        </button>
      </div>
      {iterateOpen ? (
        <div className="dbproto-vcard-iterate">
          <textarea
            className="dbproto-textarea-dark"
            style={{ minHeight: 40 }}
            value={iteratePrompt}
            placeholder={copy.iteratePlaceholder(variant.id)}
            onChange={(event) => setIteratePrompt(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitIterate();
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pin thread view.
// ---------------------------------------------------------------------------

function pinActivityLabel(pin: SandboxPinState): string | undefined {
  if (!pin.busy && !pin.planning) return undefined;
  if (pin.routedIntent?.intent === "variants") {
    const counts = readyCounts(pin);
    const n = pin.routedIntent.n ?? counts.total;
    return counts.total > 0
      ? `${copy.generating(n)} ${copy.generatingProgress(counts.ready, counts.total)}`
      : copy.generating(n);
  }
  if (pin.routedIntent?.intent === "turn") return copy.editing;
  return copy.routing;
}

function ChangesetBar({
  changeset,
  busy,
  onBake,
  onDiscard,
}: {
  changeset: SandboxChangesetState;
  busy: boolean;
  onBake: () => void;
  onDiscard: () => void;
}) {
  const [confirming, setConfirming] = useState<"bake" | "discard">();
  useEffect(() => setConfirming(undefined), [changeset.id, busy]);
  return (
    <div className="dbproto-csbar">
      <span className="lead">{copy.changesetActive}</span>
      {changeset.drifted ? <span className="dbproto-pill warn">drifted</span> : null}
      {changeset.basedOnInactive ? (
        <span className="dbproto-pill warn">base inactive</span>
      ) : null}
      {changeset.dataAdditionCount > 0 ? (
        <span className="dbproto-pill info">
          adds {changeset.dataAdditionCount}{" "}
          {changeset.dataAdditionCount === 1 ? "string" : "strings"}
        </span>
      ) : null}
      {confirming === undefined ? (
        <>
          <button className="dbproto-minibtn" disabled={busy} onClick={() => setConfirming("bake")}>
            {copy.bake}
          </button>
          <button
            className="dbproto-minibtn danger"
            disabled={busy}
            onClick={() => setConfirming("discard")}
          >
            {copy.discard}
          </button>
        </>
      ) : (
        <>
          <button
            className={`dbproto-minibtn confirm ${confirming === "discard" ? "danger" : ""}`}
            disabled={busy}
            onClick={() => {
              setConfirming(undefined);
              if (confirming === "bake") onBake();
              else onDiscard();
            }}
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
  );
}

// NOTE: the file-level conflict strip is deliberately NOT in the proto
// thread view — conflict surfacing lives in the proto CHANGES panel
// (amber badge on the affected changeset groups + the Choose strip;
// panels.tsx). The plain drawer keeps its own strip.

function BakeProgress({ bake }: { bake: SandboxBakeState }) {
  if (bake.status === "failed") {
    return (
      <div className="dbproto-act" style={{ color: "#f85149" }}>
        <CircleAlertIcon size={13} />
        <span>{copy.bakeFailed(bake.error ?? "unknown error")}</span>
      </div>
    );
  }
  if (bake.status === "done") {
    return (
      <div className="dbproto-act" style={{ color: "var(--green)" }}>
        <CircleCheckIcon size={13} />
        <span>{copy.bakeDone}</span>
      </div>
    );
  }
  const label =
    bake.status === "queued"
      ? copy.bakeQueued
      : bake.status === "gated"
        ? copy.bakeGated
        : copy.bakeRunning;
  return (
    <div className="dbproto-act">
      <span className="dbproto-dot-spin" />
      <span className="dbproto-shimmer">{label}</span>
    </div>
  );
}

function ThreadView({ pin, api }: { pin: SandboxPinState; api: SandboxApi }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activity = pinActivityLabel(pin);
  const counts = readyCounts(pin);
  const changeset = activeChangesetForPin(api.changesets, pin.id);
  const bake = bakeStateForPin(api.bakes, pin.id);
  const bakeInFlight =
    bake !== undefined &&
    (bake.status === "queued" || bake.status === "running" || bake.status === "gated");
  const component = sandboxComponentKey(pin.target.file, pin.target.exportName);
  const currentSwitch = api.switches[component];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pin.thread.length, activity, pin.variants.length, counts.ready, bake?.status]);

  async function runChangesetAction(action: "bake" | "discard") {
    if (!changeset) return;
    setError(undefined);
    const result =
      action === "bake"
        ? await api.bake({
            changesetId: changeset.id,
            ...(changeset.drifted ? { force: true } : {}),
          })
        : await api.discard({ changesetId: changeset.id });
    if (result.error) setError(result.error);
  }

  async function submit() {
    const prompt = text.trim();
    if (!prompt || pin.busy) return;
    setError(undefined);
    const result = await api.ask({ pinId: pin.id, prompt });
    if (result.error) {
      setError(result.error);
      return;
    }
    setText("");
  }

  return (
    <div className="dbproto-panel-fill">
      {changeset ? (
        <ChangesetBar
          changeset={changeset}
          busy={pin.busy || bakeInFlight}
          onBake={() => void runChangesetAction("bake")}
          onDiscard={() => void runChangesetAction("discard")}
        />
      ) : null}
      {changeset && api.reapplyState?.changesetId === changeset.id ? (
        // G2: the non-blocking reapply offer surfaces in the owning thread
        // too (same strip as the Changes panel).
        <ReapplyStrip api={api} />
      ) : null}
      <div ref={scrollRef} className="dbproto-panel-scroll">
        <div className="dbproto-chat">
          {pin.thread.map((message, index) => (
            <MessageBubble key={`${message.at}-${index}`} role={message.role} text={message.text} />
          ))}
          {pin.planning || pin.directorActivity.length > 0 ? (
            <ActivityRow
              summary={
                pin.planning
                  ? activitySummary(pin.directorActivity, copy.directorPlanning)
                  : copy.directorSummary
              }
              running={pin.planning}
              entries={activityEntryRows(pin.directorActivity)}
            />
          ) : null}
          {pin.variants.length > 0 ? (
            <div className="dbproto-vcards">
              {pin.variants.map((variant, index) => (
                <VariantCard
                  key={variant.id}
                  api={api}
                  pin={pin}
                  variant={variant}
                  index={index}
                  changeset={changeset}
                  switchedOn={
                    changeset !== undefined &&
                    currentSwitch?.changesetId === changeset.id &&
                    currentSwitch.variantId === variant.id
                  }
                  onError={setError}
                />
              ))}
            </div>
          ) : null}
          {activity ? <ActivityRow summary={activity} running /> : null}
          {bake ? <BakeProgress bake={bake} /> : null}
          {pin.lastError ? (
            <div className="dbproto-act" style={{ color: "#f85149" }}>
              <CircleAlertIcon size={13} />
              <span style={{ whiteSpace: "normal" }}>{pin.lastError}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="dbproto-promptbox">
        <textarea
          className="dbproto-textarea-dark"
          value={text}
          placeholder={copy.followUpPlaceholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {error ? <span className="dbproto-prompt-error">{error}</span> : null}
      </div>
    </div>
  );
}

/**
 * Conversation-anchored VARIANT CARDS (conversation-routed asks): the
 * variants row a fan-out left in the conversation transcript, rendered with
 * the LIVE pin state — the same VariantCard grid (flip/iterate/bake) the pin
 * thread uses, anchored at the asking message.
 */
function ConversationVariantsRow({
  item,
  api,
}: {
  item: DesignVariantsRow;
  api: SandboxApi;
}) {
  const [error, setError] = useState<string | undefined>();
  const pin = api.pins[item.pinId];
  if (!pin) {
    // Pin gone (discarded/foreign branch) — the transcript note stands in.
    return (
      <div className="dbproto-act" style={{ whiteSpace: "normal" }}>
        {item.text}
      </div>
    );
  }
  const changeset = activeChangesetForPin(api.changesets, pin.id);
  const component = sandboxComponentKey(
    pin.target.file,
    pin.target.exportName,
  );
  const currentSwitch = api.switches[component];
  // This ROW's run when known (completion note); a still-generating ask
  // shows every live variant of the pin (they stream in as cards).
  const runIds = item.variants?.map((entry) => entry.id);
  const variants = runIds
    ? pin.variants.filter((variant) => runIds.includes(variant.id))
    : pin.variants;
  return (
    <div className="dark dbproto-embed" style={{ padding: "6px 0" }}>
      {item.error ? (
        <div className="dbproto-act" style={{ color: "#f85149" }}>
          <CircleAlertIcon size={13} />
          <span style={{ whiteSpace: "normal" }}>{item.error}</span>
        </div>
      ) : null}
      {variants.length > 0 ? (
        <div className="dbproto-vcards">
          {variants.map((variant, index) => (
            <VariantCard
              key={variant.id}
              api={api}
              pin={pin}
              variant={variant}
              index={index}
              changeset={changeset}
              switchedOn={
                changeset !== undefined &&
                currentSwitch?.changesetId === changeset.id &&
                currentSwitch.variantId === variant.id
              }
              onError={setError}
            />
          ))}
        </div>
      ) : (
        <div className="dbproto-act" style={{ whiteSpace: "normal" }}>
          {item.text}
        </div>
      )}
      {error ? <span className="dbproto-prompt-error">{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History transcript (read-only).
// ---------------------------------------------------------------------------

function TranscriptRow({ item }: { item: ThreadItem }) {
  if (item.kind === "message") {
    return <MessageBubble role={item.role} text={item.text} />;
  }
  if (item.kind === "marker") {
    return (
      <div className="dbproto-act">
        <CircleAlertIcon size={13} />
        <span style={{ whiteSpace: "normal" }}>{item.text}</span>
      </div>
    );
  }
  if (item.kind === "turn") {
    // Turn rows are a LIVE-thread affordance (restore targets a live
    // changeset) — the read-only transcript fold never produces them.
    return null;
  }
  if (item.kind === "variants") {
    // Read-only transcript: the fan-out's note, no live cards.
    return (
      <div className="dbproto-act">
        <span style={{ whiteSpace: "normal" }}>{item.text}</span>
      </div>
    );
  }
  const last = item.entries[item.entries.length - 1];
  const summary =
    last?.type === "tool"
      ? `Ran ${last.name}${last.detail ? ` · ${last.detail}` : ""}`
      : (last?.text.trim().split("\n")[0] ?? "Done");
  return (
    <ActivityRow
      summary={summary}
      entries={item.entries.map((entry, index) => ({
        key: entry.type === "tool" ? `${entry.id}-${index}` : `thinking-${index}`,
        text:
          entry.type === "tool"
            ? `${entry.name}${entry.detail ? ` · ${entry.detail}` : ""}`
            : entry.text.trim(),
        error: entry.type === "tool" && entry.status === "error",
      }))}
    />
  );
}

function HistoryView({ path }: { path: string }) {
  const [items, setItems] = useState<ThreadItem[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setItems(undefined);
    setError(undefined);
    void fetch(apiUrl(`/api/sandbox/thread?path=${encodeURIComponent(path)}`))
      .then(async (response) => {
        const payload = (await response.json()) as {
          messages?: RawAgentMessage[];
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok || payload.error) {
          setError(payload.error ?? "Could not load the transcript.");
          return;
        }
        setItems(messagesToThreadItems(payload.messages ?? []));
      })
      .catch(() => {
        if (!cancelled) setError("The design server is unreachable.");
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="dbproto-panel-fill">
      <div className="dbproto-csbar">
        <HistoryIcon size={13} style={{ flex: "none" }} />
        <span className="lead">{copy.readOnlyTranscript}</span>
      </div>
      <div className="dbproto-panel-scroll">
        <div className="dbproto-chat">
          {items === undefined && !error ? (
            <div className="dbproto-act">
              <span className="dbproto-dot-spin" />
              <span>{copy.loadingThread}</span>
            </div>
          ) : null}
          {error ? <span className="dbproto-prompt-error">{error}</span> : null}
          {(items ?? []).map((item) => (
            <TranscriptRow key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Threads list.
// ---------------------------------------------------------------------------

function statusDotClass(status: ThreadRowStatus): string {
  if (status === "generating" || status === "working") return "busy";
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "";
}

/** A conversation's DIRECT-EDITS changeset row (L3, proto skin): pin-less
 * layer carrying manual edits + captured main-chat work. Inline Bake/Discard
 * with the same two-step confirm the variant cards use. */
function DirectChangesetRow({
  api,
  row,
}: {
  api: SandboxApi;
  row: Extract<ThreadRow, { kind: "changeset" }>;
}) {
  const [confirming, setConfirming] = useState<"bake" | "discard">();
  const [error, setError] = useState<string>();
  useEffect(() => setConfirming(undefined), [row.changesetId]);

  async function run(action: "bake" | "discard") {
    setError(undefined);
    const result =
      action === "bake"
        ? await api.bake({ changesetId: row.changesetId })
        : await api.discard({ changesetId: row.changesetId });
    if (result.error) setError(result.error);
  }

  return (
    <div
      className="dbproto-threadrow"
      style={row.indent ? { marginLeft: 16, cursor: "default" } : { cursor: "default" }}
    >
      <PencilLineIcon size={14} style={{ color: "var(--muted)", flex: "none" }} />
      <span className="meta">
        <span className="title">
          <span>{row.title}</span>
          {row.dataAdditionCount > 0 ? (
            <span className="dbproto-pill info">
              {copy.dataAdds(row.dataAdditionCount)}
            </span>
          ) : null}
        </span>
        <span className="sub">
          {error ?? copy.directFiles(row.fileCount)}
        </span>
      </span>
      {confirming === undefined ? (
        <>
          <button
            className="dbproto-minibtn"
            onClick={(event) => {
              event.stopPropagation();
              setConfirming("bake");
            }}
          >
            {copy.bake}
          </button>
          <button
            className="dbproto-minibtn danger"
            onClick={(event) => {
              event.stopPropagation();
              setConfirming("discard");
            }}
          >
            {copy.discard}
          </button>
        </>
      ) : (
        <>
          <button
            className={`dbproto-minibtn confirm ${confirming === "discard" ? "danger" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              const action = confirming;
              setConfirming(undefined);
              void run(action);
            }}
          >
            {confirming === "bake" ? copy.bakeConfirm : copy.discardChangesetConfirm}
          </button>
          <button
            className="dbproto-minibtn"
            onClick={(event) => {
              event.stopPropagation();
              setConfirming(undefined);
            }}
          >
            {copy.cancel}
          </button>
        </>
      )}
    </div>
  );
}

function ThreadsList({
  api,
  onOpen,
  onOpenCanvas,
}: {
  api: SandboxApi | undefined;
  onOpen: (view: ChatView) => void;
  /** Open the fullscreen sandbox canvas for a pin thread's row. */
  onOpenCanvas?: (pinId: string) => void;
}) {
  const [history, setHistory] = useState<ChatHistoryThread[]>([]);
  const chat = useLiveChatMeta();

  useEffect(() => {
    let cancelled = false;
    void fetch(apiUrl("/api/sandbox/threads"))
      .then((response) => response.json())
      .then((payload: { threads?: ChatHistoryThread[] }) => {
        if (!cancelled) setHistory(payload.threads ?? []);
      })
      .catch(() => {
        // No server / legacy server — pin threads + the chat still list.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const now = Date.now();
  // L3 grouping: conversation rows with nested changesets/pins (drawer parity).
  const rows = buildThreadRows({
    pins: Object.values(api?.pins ?? {}),
    history,
    chatFirstMessage: chat.firstMessage,
    ...(chat.lastActivityAt ? { chatLastActivityAt: chat.lastActivityAt } : {}),
    ...(chat.conversationId ? { liveConversationId: chat.conversationId } : {}),
    changesets: api?.changesets ?? [],
  });
  const driftedPinIds = new Set(
    (api?.changesets ?? [])
      .filter((changeset) => changeset.active && changeset.drifted)
      .map((changeset) => changeset.threadPinId),
  );
  const conflictPinIds = conflictedPinIds(api?.changesets ?? []);

  /** L3: "New conversation" is a REAL session reset — the retired session
   * becomes a history row. A still-fresh chat just opens. */
  function startNewConversation() {
    if (!chat.firstMessage) {
      onOpen({ kind: "chat" });
      return;
    }
    void fetch(apiUrl("/api/new-session"), { method: "POST" })
      .catch(() => {})
      .finally(() => onOpen({ kind: "chat" }));
  }

  function rowIcon(row: ThreadRow) {
    if (row.kind === "new") {
      return <PlusIcon size={14} style={{ color: "var(--muted)", flex: "none" }} />;
    }
    if (row.kind === "chat") {
      return <MessageSquareIcon size={14} style={{ color: "var(--muted)", flex: "none" }} />;
    }
    if (row.kind === "pin") {
      return <span className={`dbproto-statusdot ${statusDotClass(row.status)}`} />;
    }
    return <HistoryIcon size={14} style={{ color: "var(--muted)", flex: "none" }} />;
  }

  return (
    <div className="dbproto-threadlist">
      {rows.map((row) => {
        if (row.kind === "label") {
          return (
            <span key={row.key} className="dbproto-cs-label" style={{ padding: "8px 8px 2px" }}>
              {row.title}
            </span>
          );
        }
        if (row.kind === "changeset") {
          return api ? (
            <DirectChangesetRow key={row.key} api={api} row={row} />
          ) : null;
        }
        const openRow = () => {
          if (row.kind === "new") startNewConversation();
          else if (row.kind === "chat") onOpen({ kind: "chat" });
          else if (row.kind === "pin") onOpen({ kind: "thread", pinId: row.pinId });
          else onOpen({ kind: "history", path: row.path, title: row.title });
        };
        return (
          // A div-with-button-semantics so the pin rows can nest a REAL
          // "Open canvas" button (button-in-button is invalid HTML).
          <div
            key={row.key}
            className="dbproto-threadrow"
            role="button"
            tabIndex={0}
            style={"indent" in row && row.indent ? { marginLeft: 16 } : undefined}
            onClick={openRow}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openRow();
              }
            }}
          >
            {rowIcon(row)}
            <span className="meta">
              <span className="title">
                <span>{row.title}</span>
                {row.kind === "pin" && driftedPinIds.has(row.pinId) ? (
                  <span className="dbproto-pill warn">drifted</span>
                ) : null}
                {row.kind === "pin" && conflictPinIds.has(row.pinId) ? (
                  <span className="dbproto-pill warn">conflict</span>
                ) : null}
                {row.kind === "history" && row.forkOf ? (
                  // G4: a park-fork's sliced conversation (nested/linked).
                  <span className="dbproto-pill info">{copy.forkPill}</span>
                ) : null}
              </span>
              {row.kind === "pin" ? (
                <span className="sub">
                  <PinIcon size={10} />
                  {row.anchorLabel}
                </span>
              ) : row.kind === "history" ? (
                <span className="sub">{copy.historyMessages(row.messageCount)}</span>
              ) : null}
            </span>
            {row.kind === "pin" && onOpenCanvas ? (
              <button
                className="dbproto-backbtn"
                title={copy.openCanvas}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenCanvas(row.pinId);
                }}
              >
                <FrameIcon size={13} />
              </button>
            ) : null}
            {"at" in row && row.at !== undefined ? (
              <span className="when">{formatLastActivity(now, row.at)}</span>
            ) : null}
          </div>
        );
      })}
      {rows.length === 1 && history.length === 0 ? (
        <span className="dbproto-empty">{copy.historyEmpty}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel shell: back nav + view routing (drawer parity, proto skin).
// ---------------------------------------------------------------------------

/** Selection-scoped composer (the on-canvas prompt box's full-view peer):
 * shown on the ALL-THREADS list while a promptable selection exists, so a
 * selection prompt is one keystroke away without entering the general chat. */
function SelectionPromptBar({
  label,
  onSubmit,
}: {
  label: string;
  onSubmit: (prompt: string) => Promise<{ error?: string }>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await onSubmit(prompt);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setText("");
  }

  return (
    <div className="dbproto-promptbox">
      <div className="dbproto-selchip">
        <PinIcon size={11} />
        <span title={label}>{label}</span>
        {busy ? <span className="dbproto-dot-spin" /> : null}
      </div>
      <textarea
        className="dbproto-textarea-dark"
        value={text}
        placeholder={copy.selectionPromptPlaceholder}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {error ? <span className="dbproto-prompt-error">{error}</span> : null}
    </div>
  );
}


/** The live conversation's title: a selection-scoped first message titles
 * by its bare REQUEST (the chip carries the scope), never the raw frame. */
function conversationTitle(firstMessage: string | undefined): string | undefined {
  if (!firstMessage) return undefined;
  const selection = parseSelectionMessage(firstMessage);
  return (selection?.request ?? firstMessage)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function ChatPanel({
  view,
  onViewChange,
  draft,
  onDraftChange,
  selection,
  selectedHit,
  onOpenCanvas,
}: {
  view: ChatView;
  onViewChange: (view: ChatView) => void;
  /** The live chat's controlled prompt draft (survives view switches). */
  draft: string;
  onDraftChange: (draft: string) => void;
  /** Current frame selection — the chat's send-time context block. */
  selection?: CanvasNodeSelection;
  /** The LIVE frame hit behind `selection` (fiber/anchor intact): a prompt
   * while one exists routes through the sandbox pin machinery — the same
   * pin → intent classification → variants/turn flow as the on-canvas prompt
   * box (promptTarget.ts). Absent = the panel stays a general chat. */
  selectedHit?: CanvasHitResult;
  /** Open the fullscreen sandbox canvas on a pin (thread rows + thread view). */
  onOpenCanvas?: (pinId: string) => void;
}) {
  const api = useSandboxApi();
  const chat = useLiveChatMeta();
  const pin = view.kind === "thread" ? api?.pins[view.pinId] : undefined;
  // G4 history explorer: the accordion under the title bar (clock toggle).
  const [historyOpen, setHistoryOpen] = useState(false);
  const viewKey = `${view.kind}:${view.kind === "thread" ? view.pinId : ""}`;
  useEffect(() => setHistoryOpen(false), [viewKey]);

  /** The graph scope of the current view: the live conversation (chat) or
   * the pin thread's conversation/changeset. Undefined = no clock. */
  const historyTarget = (() => {
    if (view.kind === "chat") {
      const conversationId = chat.conversationId;
      if (!conversationId || !api) return undefined;
      // Conversation-routed asks: a conversation's turns can land on
      // changesets whose META names another conversation (reused pins,
      // resolution-following turns) — the graph unions turn membership
      // server-side, so any changeset activity is enough to show the clock
      // (an unbound conversation just renders the empty state).
      return api.changesets.length > 0 ? { conversationId } : undefined;
    }
    if (view.kind === "thread" && pin) {
      if (pin.conversationId) return { conversationId: pin.conversationId };
      const changeset = activeChangesetForPin(api?.changesets ?? [], pin.id);
      return changeset ? { changesetId: changeset.id } : undefined;
    }
    return undefined;
  })();

  /** The view's PARKED changeset (drives the "viewing turn N" banner). */
  const parkedChangeset = api?.changesets.find((candidate) => {
    if (!candidate.parked) return false;
    if (historyTarget && "conversationId" in historyTarget && historyTarget.conversationId) {
      return (
        candidate.conversationId === historyTarget.conversationId ||
        candidate.forkConversationIds?.includes(historyTarget.conversationId) ===
          true ||
        (view.kind === "thread" &&
          pin !== undefined &&
          candidate.threadPinId === pin.id)
      );
    }
    if (historyTarget && "changesetId" in historyTarget) {
      return candidate.id === historyTarget.changesetId;
    }
    return false;
  });
  const parkedTurnIndex = (() => {
    const match = parkedChangeset?.parked?.turn
      ? /\/(\d+)$/.exec(parkedChangeset.parked.turn)
      : null;
    return match ? Number(match[1]) : undefined;
  })();

  // The selection-scoped prompt target — exactly the on-canvas box's gate
  // (canPromptFrameSandbox) over the same hit→selection mapping.
  const promptTarget =
    api && selectedHit && canPromptFrameSandbox(selectedHit)
      ? frameHitToSandboxSelection(selectedHit)
      : undefined;

  /** CONVERSATION-ROUTED ask: reuse-or-create the selection's pin (FRESH
   * capture at send — a reused pin re-captures), then send the prompt to
   * the PERSISTENT conversation session with the selection attached. The
   * turn lands in the conversation thread (pin chip); the server binds the
   * conversation's workspace to the pin's changeset for the turn. */
  async function submitToSelection(
    prompt: string,
  ): Promise<{ error?: string }> {
    if (!api || !promptTarget) return { error: copy.pinCreateFailed };
    let pinId = findReusablePin(api.pins, promptTarget)?.id;
    let contextSnapshot: unknown;
    if (!pinId) {
      // createSelectionPin captures at THIS moment — already fresh.
      const created = await createSelectionPin(api, promptTarget);
      if (created.error || !created.id) {
        return { error: created.error ?? copy.pinCreateFailed };
      }
      pinId = created.id;
    } else {
      // Reused pin: re-capture at send (fresh context per message).
      contextSnapshot = await captureSelectionSnapshot(promptTarget);
    }
    try {
      const response = await fetch(apiUrl("/api/prompt"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          selection: {
            pinId,
            label: promptTarget.label,
            ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
          },
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        return { error: payload.error ?? copy.pinCreateFailed };
      }
    } catch {
      return { error: "The design server is unreachable." };
    }
    // The conversation IS the surface — stay/land on the live chat.
    if (view.kind !== "chat") onViewChange({ kind: "chat" });
    return {};
  }

  const title =
    view.kind === "list"
      ? copy.threads
      : view.kind === "chat"
        ? (conversationTitle(chat.firstMessage) ?? "New conversation")
        : view.kind === "thread"
          ? pin
            ? pinThreadTitle(pin)
            : copy.loadingThread
          : view.title;

  return (
    <div className="dbproto-panel-fill">
      <div className="dbproto-subhead">
        {view.kind === "list" ? null : (
          <button
            className="dbproto-backbtn"
            title={copy.back}
            onClick={() => onViewChange({ kind: "list" })}
          >
            <ChevronLeftIcon size={15} />
          </button>
        )}
        <span className="dbproto-subhead-title">{title}</span>
        {historyTarget && api ? (
          // G4: the clock — opens the history accordion under the title.
          <button
            className="dbproto-backbtn"
            style={{
              marginLeft: "auto",
              ...(historyOpen ? { color: "var(--accent)" } : {}),
            }}
            title={copy.historyToggle}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <ClockIcon size={14} />
          </button>
        ) : null}
        {view.kind === "thread" && onOpenCanvas ? (
          <button
            className="dbproto-backbtn"
            style={historyTarget ? undefined : { marginLeft: "auto" }}
            title={copy.openCanvas}
            onClick={() => onOpenCanvas(view.pinId)}
          >
            <FrameIcon size={14} />
          </button>
        ) : null}
      </div>
      <div
        className={`dbproto-histo-accordion ${historyOpen ? "open" : ""}`}
      >
        {historyOpen && historyTarget && api ? (
          // Round-2: ONE unified graph, titled by the conversation/thread.
          <HistoryPanel {...historyTarget} title={title} api={api} />
        ) : null}
      </div>
      {parkedChangeset?.parked && api ? (
        <div className="dbproto-histo-banner">
          <GitBranchIcon size={13} style={{ flex: "none" }} />
          <span className="lead">{copy.historyViewing(parkedTurnIndex)}</span>
          <button
            className="dbproto-minibtn"
            onClick={() =>
              void api.exitPark({ changesetId: parkedChangeset.id })
            }
          >
            {copy.historyExit}
          </button>
        </div>
      ) : null}
      {view.kind === "list" ? (
        <>
          <ThreadsList api={api} onOpen={onViewChange} onOpenCanvas={onOpenCanvas} />
          {promptTarget ? (
            <SelectionPromptBar
              label={promptTarget.label}
              onSubmit={submitToSelection}
            />
          ) : null}
        </>
      ) : null}
      {view.kind === "chat" ? (
        <div className="dark dbproto-embed fill" style={{ flex: 1, minHeight: 0 }}>
          <DesignChat
            embedded
            draft={draft}
            onDraftChange={onDraftChange}
            selectedNode={selection}
            // While a promptable selection exists the ONE chat composer
            // routes the prompt to the CONVERSATION with the selection
            // attached (fresh capture + pin chip — conversation-routed
            // asks); without a selection it stays the general chat.
            onPromptIntercept={promptTarget ? submitToSelection : undefined}
            // CHAT TIME-TRAVEL: parked on a past turn → the thread
            // truncates at that turn's row (display only; exit restores).
            viewingTurn={
              parkedChangeset?.parked?.turn
                ? {
                    turn: parkedChangeset.parked.turn,
                    changesetId: parkedChangeset.id,
                  }
                : undefined
            }
            // Conversation-anchored variant cards (live pin state).
            renderVariantsRow={
              api
                ? (item) => <ConversationVariantsRow item={item} api={api} />
                : undefined
            }
          />
        </div>
      ) : null}
      {view.kind === "thread" ? (
        pin && api ? (
          <ThreadView pin={pin} api={api} />
        ) : (
          <div className="dbproto-act" style={{ padding: 14 }}>
            <span className="dbproto-dot-spin" />
            <span>{copy.loadingThread}</span>
          </div>
        )
      ) : null}
      {view.kind === "history" ? <HistoryView path={view.path} /> : null}
    </div>
  );
}

export { ChatPanel };
export type { ChatView };
