/**
 * The "Info" tab (right-hand panel, PREVIEW — docs/specs/selection-context.md):
 * renders the selection-context registry's contributions for the current
 * canvas selection as a stack of bordered section cards (core first). Sync
 * sections appear immediately; async ones patch in when they resolve (the run
 * store notifies via useSyncExternalStore). The refresh button re-runs every
 * contributor for the current selection.
 *
 * This component is DISPLAY-ONLY: it reshapes each contributor's public `facts`
 * per section (render-context → chips, i18n → keyed rows + provenance suffix,
 * context-scope → summary + providers with sampled values behind a disclosure)
 * via the React-free presenters in models/selectionContext/infoPresenters. It
 * never changes the contribution data or the model prompt. Fiber access stays
 * behind the previewHost seam (contributors only).
 */

import { useState, useSyncExternalStore } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Button } from "@designbook-ui/components/ui/button";
import { cn } from "@designbook-ui/lib/utils";
import {
  getSelectionContextSnapshot,
  refreshSelectionContext,
  subscribeSelectionContext,
} from "@designbook-ui/models/selectionContext/store";
import {
  contextScopeSummary,
  toContextEntry,
  toI18nRow,
  toRenderChip,
} from "@designbook-ui/models/selectionContext/infoPresenters";
import type {
  SelectionContextContribution,
  SelectionContextFact,
} from "@designbook-ui/models/selectionContext/types";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import { PanelSection } from "./panels";

const copy = {
  deriving: "Deriving context…",
  emptyHint: "Select an element on the canvas to inspect it.",
  emptySection: "Nothing derived for this selection.",
  hideSampled: "Hide sampled values",
  refresh: "Refresh selection context",
  showSampled: "Show sampled values",
  title: "Info",
};

/**
 * Per-section collapse state, kept in a module-level map so it persists across
 * panel re-mounts for the session but resets on reload (spec: session only).
 */
const collapsedSections = new Map<string, boolean>();

const rowClass = "flex min-w-0 items-baseline justify-between gap-3 py-1";
const labelClass = "min-w-0 shrink-0 text-[11px] text-muted-foreground";
const provClass =
  "text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60";

/** Default key/value row: muted label left, mono value right, truncated. */
function FactRow({ fact }: { fact: SelectionContextFact }) {
  const value = fact.href ? (
    <a
      href={fact.href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:no-underline"
    >
      {fact.value}
    </a>
  ) : (
    fact.value
  );
  return (
    <div className={rowClass}>
      <span className={labelClass}>{fact.label}</span>
      <span
        title={fact.value}
        className={cn(
          "min-w-0 flex-1 truncate text-right text-[11px]",
          fact.code ? "font-mono text-foreground/80" : "text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Render context: each dimension value as a rounded-full pill. */
function RenderContextBody({ facts }: { facts: SelectionContextFact[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 py-0.5">
      {facts.map((fact, index) => {
        const { text, follows } = toRenderChip(fact);
        return (
          <span
            key={`${fact.label}-${index}`}
            title={fact.label}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] text-foreground/80"
          >
            {text}
            {follows ? (
              <span className="text-[9px] text-muted-foreground/70">follows</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** i18n: keyed rows with a provenance suffix + a warning hardcoded summary. */
function I18nBody({ facts }: { facts: SelectionContextFact[] }) {
  return (
    <>
      {facts.map((fact, index) => {
        const row = toI18nRow(fact);
        if (row.kind === "hardcoded") {
          return (
            <div
              key={`hc-${index}`}
              data-testid="info-i18n-hardcoded"
              className="mt-1 flex items-center gap-1.5 rounded-md border border-tool-hardcoded/40 bg-tool-hardcoded/5 px-2 py-1 text-[11px] text-tool-hardcoded-label"
            >
              <TriangleAlertIcon className="size-3 shrink-0" />
              <span className="min-w-0">{row.text}</span>
            </div>
          );
        }
        return (
          <div key={`${row.key}-${index}`} className={rowClass}>
            <span
              title={row.key}
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            >
              {row.key}
            </span>
            <span className="flex shrink-0 items-baseline gap-1.5 text-right">
              <span className="font-mono text-[11px] text-foreground/80">
                {row.value}
              </span>
              {row.provenance ? (
                <span className={provClass}>{row.provenance}</span>
              ) : null}
            </span>
          </div>
        );
      })}
    </>
  );
}

/** Context scope: summary row, provider rows, sampled values behind disclosure. */
function ContextScopeBody({ facts }: { facts: SelectionContextFact[] }) {
  const [showValues, setShowValues] = useState(false);
  const { total, reads } = contextScopeSummary(facts);
  const entries = facts.map(toContextEntry);
  return (
    <>
      <div className="flex min-w-0 items-baseline justify-between gap-3 py-1 text-[11px] font-medium text-foreground/80">
        <span className="shrink-0">Providers in scope</span>
        <span className="text-right font-mono text-muted-foreground">
          {total} in scope · reads {reads}
        </span>
      </div>
      {entries.map((entry, index) => (
        <div key={`${entry.name}-${index}`} className={rowClass}>
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-mono text-[11px] text-foreground/80">
              {entry.name}
            </span>
            {entry.flags.map((flag) => (
              <span key={flag} className={provClass}>
                {flag}
              </span>
            ))}
          </span>
          {entry.origin ? (
            <span
              title={entry.origin}
              className="min-w-0 shrink truncate text-right text-[11px] text-muted-foreground"
            >
              {entry.origin}
            </span>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        aria-expanded={showValues}
        className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={() => setShowValues((current) => !current)}
      >
        {showValues ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
        {showValues ? copy.hideSampled : copy.showSampled}
      </button>
      {showValues ? (
        <div className="mt-1 flex flex-col gap-1 rounded-md bg-muted/40 p-2">
          {entries.map((entry, index) => (
            <div
              key={`v-${entry.name}-${index}`}
              className="flex min-w-0 items-baseline justify-between gap-3"
            >
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {entry.name}
              </span>
              <span
                title={entry.sampled}
                className="min-w-0 truncate text-right font-mono text-[10px] text-foreground/80"
              >
                {entry.sampled}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Dispatch a contribution's body by source; unknown sources render kv rows. */
function ContributionBody({
  contribution,
}: {
  contribution: SelectionContextContribution;
}) {
  if (contribution.facts.length === 0) {
    return (
      <p className="py-1 text-[11px] text-muted-foreground">
        {copy.emptySection}
      </p>
    );
  }
  switch (contribution.source) {
    case "render-context":
      return <RenderContextBody facts={contribution.facts} />;
    case "i18n":
      return <I18nBody facts={contribution.facts} />;
    case "context-scope":
      return <ContextScopeBody facts={contribution.facts} />;
    default:
      return (
        <>
          {contribution.facts.map((fact, index) => (
            <FactRow key={`${fact.label}-${index}`} fact={fact} />
          ))}
        </>
      );
  }
}

/** One contributor's collapsible bordered section card (open by default). */
function ContributionSection({
  contribution,
}: {
  contribution: SelectionContextContribution;
}) {
  const [, force] = useState(0);
  const open = !(collapsedSections.get(contribution.source) ?? false);
  const toggle = () => {
    collapsedSections.set(contribution.source, open);
    force((current) => current + 1);
  };
  return (
    <section
      className="overflow-hidden rounded-lg border"
      data-testid={`info-section-${contribution.source}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {contribution.title}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">
          {contribution.source}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col border-t px-3 py-2">
          <ContributionBody contribution={contribution} />
        </div>
      ) : null}
    </section>
  );
}

function InfoPanel({ selectedNode }: { selectedNode?: CanvasNodeSelection }) {
  const snapshot = useSyncExternalStore(
    subscribeSelectionContext,
    getSelectionContextSnapshot,
    getSelectionContextSnapshot,
  );

  if (!selectedNode) {
    return (
      <PanelSection title={copy.title}>
        <p className="text-xs text-muted-foreground">{copy.emptyHint}</p>
      </PanelSection>
    );
  }

  return (
    <div className="grid content-start gap-2 p-4">
      <div className="flex items-center gap-2">
        <div className="grid min-w-0 gap-1">
          <h2 className="text-sm font-semibold">{copy.title}</h2>
          {selectedNode.description ? (
            <p className="truncate text-xs text-muted-foreground">
              {selectedNode.description}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0"
          aria-label={copy.refresh}
          title={copy.refresh}
          onClick={() => refreshSelectionContext()}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {snapshot.contributions.map((contribution) => (
        <ContributionSection
          key={contribution.source}
          contribution={contribution}
        />
      ))}
      {snapshot.pending > 0 ? (
        <p className="text-xs text-muted-foreground">{copy.deriving}</p>
      ) : null}
    </div>
  );
}

export { InfoPanel };
