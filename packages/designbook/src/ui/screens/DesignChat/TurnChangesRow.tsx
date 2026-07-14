/**
 * G2 history UX (docs/specs/changesets-on-git.md §G2): one conversation
 * turn's landed COMMIT RANGE as a thread row.
 *
 *   - Collapsed: a subdued "committed N files" line (the activity-row
 *     treatment) + "Restore" — rollback to BEFORE this turn (the rollback
 *     API's `turn` form), two-step confirm.
 *   - Expanded: the turn's commit-range unified diff (GET
 *     /api/sandbox/turn-diff — server-capped; rendered inline, colored) and
 *     the per-tool-write commit list, each with its own finer "Restore to
 *     here" (rollback by `commit` — the branch tip moves to AFTER that
 *     write).
 *
 * Restores hot-update through the server's SSE rollback event (re-project +
 * redirect refresh) — this row only posts and reports errors.
 */

import { useState } from "react";
import {
  ChevronRightIcon,
  GitCommitVerticalIcon,
  Undo2Icon,
} from "lucide-react";
import { apiUrl } from "@designbook-ui/designbook";
import { cn } from "@designbook-ui/lib/utils";
import type { DesignTurn } from "@designbook-ui/models/chat/types";

const copy = {
  cancel: "Cancel",
  commitRestore: "Restore to here",
  commitsTitle: "Per-write commits",
  diffEmpty: "No diff available.",
  diffLoading: "Loading diff…",
  diffTruncated: "Diff truncated (too large to show whole).",
  restore: "Restore",
  restoreConfirm: "Rewind to before this turn",
  restoreFailed: (error: string) => `Restore failed: ${error}`,
  summary: (item: { label?: string; prompt?: string; files: string[] }) =>
    // Round-2 fallback chain: generated label > prompt line > files.
    item.label ??
    item.prompt ??
    (item.files.length === 0
      ? "Committed design changes"
      : `Committed ${item.files.join(", ")}`),
};

type TurnDiffPayload = {
  diff?: string;
  truncated?: boolean;
  commits?: Array<{ commit?: string; subject?: string; toolCall?: string }>;
  error?: string;
};

/** Colored unified-diff block (wide lines scroll inside the block). */
function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-4">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "whitespace-pre",
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : line.startsWith("@@")
                  ? "text-sky-600 dark:text-sky-400"
                  : line.startsWith("diff --git")
                    ? "mt-1 font-semibold text-foreground"
                    : "text-muted-foreground",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** Two-step inline confirm button (the thread rows' restore affordances). */
function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        disabled={disabled}
        className="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        onClick={() => setConfirming(true)}
      >
        <Undo2Icon className="size-3" />
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded border border-destructive/50 px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        <Undo2Icon className="size-3" />
        {confirmLabel}
      </button>
      <button
        type="button"
        className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={() => setConfirming(false)}
      >
        {copy.cancel}
      </button>
    </span>
  );
}

function TurnChangesRow({ item }: { item: DesignTurn }) {
  const [expanded, setExpanded] = useState(false);
  const [payload, setPayload] = useState<TurnDiffPayload>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && payload === undefined) {
      void fetch(
        apiUrl(
          `/api/sandbox/turn-diff?changesetId=${encodeURIComponent(item.changesetId)}&turn=${encodeURIComponent(item.turn)}`,
        ),
      )
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as TurnDiffPayload;
          setPayload(
            response.ok ? body : { error: body.error ?? "Could not load the diff." },
          );
        })
        .catch(() => setPayload({ error: "The design server is unreachable." }));
    }
  }

  async function restore(target: { turn?: string; commit?: string }) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(apiUrl("/api/sandbox/rollback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changesetId: item.changesetId,
          ...(target.turn ? { turn: target.turn } : {}),
          ...(target.commit ? { commit: target.commit, ref: item.ref } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(copy.restoreFailed(body.error ?? "unknown error"));
      }
    } catch {
      setError(copy.restoreFailed("the design server is unreachable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-1 py-0.5 text-xs" data-testid="turn-changes-row">
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <GitCommitVerticalIcon className="size-3 shrink-0" />
          <span className="truncate" title={item.files.join(", ")}>
            {copy.summary(item)}
          </span>
        </button>
        <ConfirmButton
          label={copy.restore}
          confirmLabel={copy.restoreConfirm}
          disabled={busy}
          onConfirm={() => void restore({ turn: item.turn })}
        />
      </div>
      {error ? (
        <p className="mt-1 ml-[7px] pl-3 text-[11px] text-destructive">{error}</p>
      ) : null}
      {expanded ? (
        <div className="mt-1.5 ml-[7px] flex flex-col gap-1.5 border-l pl-3">
          {payload === undefined ? (
            <span className="text-muted-foreground">{copy.diffLoading}</span>
          ) : payload.error ? (
            <span className="text-destructive">{payload.error}</span>
          ) : (
            <>
              {(payload.commits ?? []).length > 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium tracking-wide text-muted-foreground/80 uppercase">
                    {copy.commitsTitle}
                  </span>
                  {(payload.commits ?? []).map((commit) => (
                    <div
                      key={commit.commit}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                        {(commit.commit ?? "").slice(0, 7)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {commit.subject}
                      </span>
                      <ConfirmButton
                        label={copy.commitRestore}
                        confirmLabel={copy.commitRestore}
                        disabled={busy || !commit.commit}
                        onConfirm={() =>
                          void restore({ commit: commit.commit })
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              {payload.truncated ? (
                <span className="text-[10px] text-muted-foreground/80">
                  {copy.diffTruncated}
                </span>
              ) : null}
              {payload.diff ? (
                <UnifiedDiff diff={payload.diff} />
              ) : (
                <span className="text-muted-foreground">{copy.diffEmpty}</span>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export { TurnChangesRow, UnifiedDiff };
