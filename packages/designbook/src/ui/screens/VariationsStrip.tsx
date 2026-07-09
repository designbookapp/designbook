/**
 * Design-variations review chrome (docs/specs/design-variations.md, DECIDED
 * 2026-07-09): the Generate affordance, the progressive COMPARE strip, and
 * the in-place focus CYCLER. All of it is workbench chrome around standard
 * `PreviewCell`s — nothing is injected into the app's component tree.
 *
 *   - Generate (D1): the button POSTs `/api/variations/generate` DIRECTLY —
 *     no chat draft; typing a direction + seeing the cost note + clicking is
 *     the consent gate. The selection-context prompt block rides along when
 *     the registry has resolved one for the current selection.
 *   - Strip: original + one frame per variant; skeletons pulse while sessions
 *     run, cells pop in per `landed` event ("n of m landed"), failures show
 *     the error + Retry. Keep / Keep as… (name prompt, D4) / Iterate (inline
 *     note, D3) / Discard per frame; "Keep original" abandons the set.
 *   - Cycler: in Single layout a landed variant renders in the ORIGINAL's
 *     exact spot; ◀ ▶ walk Original → variants (Michael's minimize mode).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns3Icon,
  RefreshCwIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { Badge } from "@designbook-ui/components/ui/badge";
import { Button } from "@designbook-ui/components/ui/button";
import { Input } from "@designbook-ui/components/ui/input";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import { Textarea } from "@designbook-ui/components/ui/textarea";
import { cn } from "@designbook-ui/lib/utils";
import { apiUrl } from "@designbook-ui/designbook";
import { PreviewCell } from "./PreviewCell";
import { buildSelectionContextBlock } from "@designbook-ui/models/selectionContext/store";
import {
  useVariationsApi,
  type VariationsApi,
} from "@designbook-ui/models/variations/VariationsProvider";
import {
  classifyRenderedSize,
  landedCounts,
  synthesizeVariantEntry,
  type VariationItem,
  type VariationSet,
} from "@designbook-ui/models/variations/variationsModel";
import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";

const copy = {
  abandonAll: "Keep original",
  backToCompare: "Compare",
  cancel: "Cancel",
  costNote: (count: number, model?: string) =>
    `≈ ${count} parallel agent turn${count === 1 ? "" : "s"}${model ? ` on ${model}` : ""}, plus one small director call.`,
  countLabel: "Variations",
  directionPlaceholder: "Optional direction hints (e.g. denser, more editorial…)",
  discard: "Discard",
  emptyRender:
    "Rendered empty — likely needs explicit sizing (an absolutely-positioned root has no intrinsic height). Iterate or discard.",
  emptyBadge: "empty",
  failedBadge: "failed",
  generate: "Generate",
  generateTitle: "Generate design variations",
  iterate: "Iterate",
  iteratePlaceholder: "What should change in this one?",
  keep: "Keep",
  keepAs: "Keep as…",
  keepAsPlaceholder: "NewComponentName",
  keepConfirm: (file: string) => `Replace ${file} with this variation?`,
  landedOf: (landed: number, total: number) => `${landed} of ${total} landed`,
  noSourcePath:
    "This entry has no source-path attribution, so variations can't target it.",
  original: "Original",
  originalReference: "reference",
  planning: "Proposing directions…",
  replace: "Replace",
  retry: "Retry",
  save: "Save",
  send: "Send",
  stripTitle: (name: string) => `Variations of ${name}`,
  variationsButton: "Variations",
  waiting: "generating…",
};

/** PascalCase a slug for the default promoted-component name. */
function pascalSlug(slug: string): string {
  return slug
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// Generate affordance (header button + inline panel).
// ---------------------------------------------------------------------------

function VariationsGenerateButton({ entry }: { entry: RegistryEntry }) {
  const api = useVariationsApi();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState("");
  const [count, setCount] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  // The chat's selected model — ephemeral sessions inherit it, so the popover
  // shows what will actually run. Fetched when the panel opens.
  const [modelName, setModelName] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch(apiUrl("/api/state"))
      .then((response) => response.json() as Promise<{ model?: { name?: string; id?: string } | null }>)
      .then((payload) => {
        if (!cancelled) {
          setModelName(payload.model?.name ?? payload.model?.id ?? undefined);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);
  if (!api) return null;

  const set = api.sets[entry.id];
  const busy =
    submitting ||
    Boolean(
      set &&
        (set.planning ||
          set.items.some(
            (item) =>
              item.status === "generating" || item.status === "updating",
          )),
    );

  async function generate() {
    setSubmitting(true);
    setError(undefined);
    const result = await api!.generate({
      baseEntryId: entry.id,
      baseSourcePath: entry.sourcePath,
      count,
      direction: direction.trim() || undefined,
      // Selection-context prompt fragments enrich the director brief.
      context: buildSelectionContextBlock(),
    });
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setDirection("");
  }

  return (
    <div className="grid justify-items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        data-testid="variations-generate-button"
      >
        {busy ? <Spinner /> : <WandSparklesIcon />}
        {copy.variationsButton}
      </Button>
      {open ? (
        <div className="grid w-80 gap-2 rounded-lg border bg-background p-3 shadow-md">
          <span className="text-xs font-medium">{copy.generateTitle}</span>
          {entry.sourcePath ? (
            <>
              <Textarea
                value={direction}
                rows={2}
                placeholder={copy.directionPlaceholder}
                onChange={(event) => setDirection(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {copy.countLabel}
                </span>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Button
                    key={n}
                    type="button"
                    size="sm"
                    variant={count === n ? "default" : "outline"}
                    className="h-6 w-6 p-0 text-xs"
                    onClick={() => setCount(n)}
                  >
                    {n}
                  </Button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {copy.costNote(count, modelName)}
              </span>
              {error ? (
                <span className="text-xs text-destructive">{error}</span>
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void generate()}
                >
                  {copy.generate}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                >
                  {copy.cancel}
                </Button>
              </div>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {copy.noSourcePath}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-variant frame.
// ---------------------------------------------------------------------------

/**
 * One self-contained strip column (the FIX-1 layout): the slug/status line
 * and the direction one-liner live INSIDE the card header (truncating with a
 * title tooltip — labels can never collide with a neighbor), the preview body
 * has a sane min-height and its own overflow (wide/tall variant content
 * scrolls WITHIN the cell), and the action row is pinned to the card's bottom
 * edge. The strip row is `items-stretch`, so cells equalize to the tallest
 * and every action row sits on the same baseline.
 */
function FrameShell({
  children,
  footer,
  title,
  intent,
  badge,
  tone,
}: {
  children: ReactNode;
  footer?: ReactNode;
  title: string;
  intent?: string;
  badge?: ReactNode;
  tone?: "pending" | "failed" | "normal";
}) {
  return (
    <div
      className={cn(
        "flex w-80 shrink-0 flex-col self-stretch overflow-hidden rounded-lg border bg-background shadow-md",
        tone === "pending" && "opacity-80",
        tone === "failed" && "border-destructive",
      )}
    >
      <div className="min-w-0 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate font-mono text-xs font-semibold"
            title={title}
          >
            {title}
          </span>
          {badge}
        </div>
        {/* Always one line (nbsp filler) so headers align across cells. */}
        <div
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={intent}
        >
          {intent || "\u00a0"}
        </div>
      </div>
      {/* HARD CONTAINMENT: `contain: layout paint` makes this box the
          containing block for absolute AND fixed descendants and clips all
          paint. The cell GROWS with tall content (no max-height — the row's
          items-stretch keeps siblings level); only oversized WIDTH scrolls.
          Absolute/fixed roots, negative margins, 1200px fixed widths still
          cannot escape the cell. */}
      <div className="relative min-h-40 flex-1 overflow-x-auto p-3 [contain:layout_paint]">
        {children}
      </div>
      <div className="mt-auto border-t px-3 py-2">
        {footer ?? (
          <span className="text-xs text-muted-foreground">
            {copy.originalReference}
          </span>
        )}
      </div>
    </div>
  );
}

function PendingSkeleton({ label }: { label: string }) {
  return (
    <div className="grid animate-pulse gap-2" aria-label={label}>
      <div className="h-20 rounded-md bg-muted" />
      <div className="h-3 w-2/3 rounded bg-muted" />
      <div className="h-3 w-1/3 rounded bg-muted" />
    </div>
  );
}

/**
 * Measures the mounted variant preview ROOT (`[data-db-entry]`, the element
 * PreviewCell renders on success) so the frame can flag a collapsed render
 * (FIX 2). Layout sizes (`offsetWidth`/`offsetHeight`), not fiber rects and
 * not `getBoundingClientRect` — the canvas scale transform must not skew the
 * threshold. Re-observes on child mutations so the Suspense→content swap and
 * iterate remounts re-measure; no root found → `undefined` (unknown, never a
 * false positive — also the shadow-isolation teleport case).
 */
function MeasuredPreview({
  children,
  onMeasure,
}: {
  children: ReactNode;
  onMeasure: (size: { width: number; height: number } | undefined) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Coalesce via setTimeout, NOT requestAnimationFrame: rAF never fires in
    // a hidden tab, which froze measurements at a stale pre-CSS zero-height
    // state (live-dogfood finding). Timers are clamped when hidden but run.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      timer = undefined;
      const root = el.querySelector("[data-db-entry]") as HTMLElement | null;
      // A root React has display:none'd (hide-during-suspense) measures 0×0
      // but says nothing about the variant — stay "unknown", never flag it.
      const hidden = root && getComputedStyle(root).display === "none";
      onMeasureRef.current(
        root && !hidden
          ? { width: root.offsetWidth, height: root.offsetHeight }
          : undefined,
      );
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(evaluate, 0);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(el);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(el, { childList: true, subtree: true });
    schedule();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return <div ref={ref}>{children}</div>;
}

type FrameForm = "keep" | "keepAs" | "iterate" | undefined;

function VariantFrame({
  api,
  base,
  item,
  onFocus,
}: {
  api: VariationsApi;
  base: RegistryEntry;
  item: VariationItem;
  onFocus?: () => void;
}) {
  const [form, setForm] = useState<FrameForm>(undefined);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  // FIX 2: measured size of the mounted preview root (per rev).
  const [renderedSize, setRenderedSize] = useState<
    { width: number; height: number } | undefined
  >(undefined);
  const entry = synthesizeVariantEntry(base, item);
  const emptyRender =
    item.status === "landed" && classifyRenderedSize(renderedSize) === "empty";

  async function act(action: () => Promise<{ error?: string }>) {
    setError(undefined);
    const result = await action();
    if (result.error) setError(result.error);
    else {
      setForm(undefined);
      setText("");
    }
  }

  if (item.status === "generating") {
    return (
      <FrameShell
        title={item.slug}
        intent={item.intent}
        tone="pending"
        badge={<Badge variant="secondary">{copy.waiting}</Badge>}
      >
        <PendingSkeleton label={`${item.slug} ${copy.waiting}`} />
      </FrameShell>
    );
  }

  if (item.status === "failed") {
    return (
      <FrameShell
        title={item.slug}
        intent={item.intent}
        tone="failed"
        badge={<Badge variant="destructive">{copy.failedBadge}</Badge>}
        footer={
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void act(() => api.retry({ base: base.id, slug: item.slug }))
              }
            >
              <RefreshCwIcon />
              {copy.retry}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`${copy.discard} ${item.slug}`}
              onClick={() =>
                void act(() =>
                  api.resolve({
                    base: base.id,
                    action: "discard",
                    slug: item.slug,
                  }),
                )
              }
            >
              <XIcon />
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-1">
          {item.path ? (
            <span className="break-all font-mono text-[10px] text-muted-foreground">
              {item.path}
            </span>
          ) : null}
          <span className="break-words text-xs text-destructive">
            {item.error}
          </span>
        </div>
      </FrameShell>
    );
  }

  const updating = item.status === "updating";
  const baseFile = base.sourcePath.split("/").pop() ?? base.sourcePath;

  const footer = (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={updating}
          onClick={() => setForm(form === "keep" ? undefined : "keep")}
        >
          <CheckIcon />
          {copy.keep}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={updating}
          onClick={() => {
            setText(`${base.key}${pascalSlug(item.slug)}`);
            setForm(form === "keepAs" ? undefined : "keepAs");
          }}
        >
          {copy.keepAs}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={updating}
          onClick={() => {
            setText("");
            setForm(form === "iterate" ? undefined : "iterate");
          }}
        >
          {updating ? <Spinner /> : null}
          {copy.iterate}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={updating}
          aria-label={`${copy.discard} ${item.slug}`}
          onClick={() =>
            void act(() =>
              api.resolve({ base: base.id, action: "discard", slug: item.slug }),
            )
          }
        >
          <XIcon />
        </Button>
      </div>
      {form === "keep" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span>{copy.keepConfirm(baseFile)}</span>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              void act(() =>
                api.resolve({ base: base.id, action: "keep", slug: item.slug }),
              )
            }
          >
            {copy.replace}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setForm(undefined)}
          >
            {copy.cancel}
          </Button>
        </div>
      ) : null}
      {form === "keepAs" ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() =>
              api.resolve({
                base: base.id,
                action: "keepAs",
                slug: item.slug,
                newName: text.trim(),
              }),
            );
          }}
        >
          <Input
            value={text}
            className="h-7 flex-1 font-mono text-xs"
            placeholder={copy.keepAsPlaceholder}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!text.trim()}>
            {copy.save}
          </Button>
        </form>
      ) : null}
      {form === "iterate" ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() =>
              api.iterate({
                base: base.id,
                slug: item.slug,
                note: text.trim(),
              }),
            );
          }}
        >
          <Input
            value={text}
            className="h-7 flex-1 text-xs"
            placeholder={copy.iteratePlaceholder}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!text.trim()}>
            {copy.send}
          </Button>
        </form>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );

  return (
    <FrameShell
      title={item.slug}
      intent={item.intent}
      tone={updating ? "pending" : emptyRender ? "failed" : "normal"}
      badge={
        updating ? (
          <Badge variant="secondary">
            <Spinner data-icon="inline-start" />
            {copy.iterate}
          </Badge>
        ) : emptyRender ? (
          <Badge variant="destructive">{copy.emptyBadge}</Badge>
        ) : undefined
      }
      footer={footer}
    >
      {emptyRender ? (
        <div
          role="alert"
          className="mb-2 rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive"
        >
          {copy.emptyRender}
        </div>
      ) : null}
      <div
        role={onFocus ? "button" : undefined}
        tabIndex={onFocus ? 0 : undefined}
        onDoubleClick={onFocus}
        onKeyDown={(event) => {
          if (onFocus && event.key === "Enter") onFocus();
        }}
      >
        {/* Key on rev: an iterate lands as a NEW module URL (?t=rev), so the
            cell remounts with the fresh import AND re-measures — per-cell
            HMR, no reload. */}
        {entry ? (
          <MeasuredPreview key={item.rev} onMeasure={setRenderedSize}>
            <PreviewCell entry={entry} />
          </MeasuredPreview>
        ) : null}
      </div>
    </FrameShell>
  );
}

// ---------------------------------------------------------------------------
// The compare strip (third detail layout).
// ---------------------------------------------------------------------------

function VariationsStrip({
  entry,
  set,
  themeClassName,
  onFocusVariant,
}: {
  entry: RegistryEntry;
  set: VariationSet;
  themeClassName?: string;
  onFocusVariant?: (slug: string) => void;
}) {
  const api = useVariationsApi();
  if (!api) return null;
  const counts = landedCounts(set);

  return (
    <div className="grid content-start gap-2">
      <div className="flex items-baseline gap-3">
        <span className="text-xs font-semibold">
          {copy.stripTitle(entry.name)}
        </span>
        <span className="text-xs text-muted-foreground">
          {set.planning
            ? copy.planning
            : copy.landedOf(counts.landed, counts.total)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-4"
          onClick={() =>
            void api.resolve({ base: entry.id, action: "abandon" })
          }
        >
          {copy.abandonAll}
        </Button>
      </div>
      {/* Fixed-width columns, items-stretch (equal heights → aligned action
          rows), horizontally scrolling past ~3 cells. Cells own their
          overflow; nothing can collide. */}
      <div
        className={cn(
          "flex max-w-[1080px] items-stretch gap-3 overflow-x-auto pb-2",
          themeClassName,
        )}
      >
        <FrameShell title={copy.original} intent={entry.sourcePath}>
          <PreviewCell entry={entry} />
        </FrameShell>
        {set.items.map((item) => (
          <VariantFrame
            key={item.slug}
            api={api}
            base={entry}
            item={item}
            onFocus={
              item.status === "landed"
                ? () => onFocusVariant?.(item.slug)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Focus cycler (single layout, in the original's spot).
// ---------------------------------------------------------------------------

function VariationsCycler({
  entry,
  set,
  onBackToCompare,
}: {
  entry: RegistryEntry;
  set: VariationSet;
  onBackToCompare: () => void;
}) {
  const api = useVariationsApi();
  if (!api) return null;
  const landed = set.items.filter((item) => item.status === "landed");
  // Position 0 = the original; 1..n = landed variants.
  const slugs = [undefined, ...landed.map((item) => item.slug)];
  const focused =
    api.focus?.base === entry.id ? api.focus.slug : undefined;
  const position = Math.max(0, slugs.indexOf(focused));
  const item = focused
    ? landed.find((candidate) => candidate.slug === focused)
    : undefined;

  function step(delta: number) {
    const next = (position + delta + slugs.length) % slugs.length;
    const slug = slugs[next];
    api!.setFocus(slug ? { base: entry.id, slug } : undefined);
  }

  return (
    <div className="flex items-center gap-1.5 rounded-lg border bg-background p-1 shadow-md">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Previous variation"
        onClick={() => step(-1)}
      >
        <ChevronLeftIcon />
      </Button>
      <span className="min-w-32 text-center font-mono text-xs">
        {focused ?? copy.original} ({position + 1}/{slugs.length})
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Next variation"
        onClick={() => step(1)}
      >
        <ChevronRightIcon />
      </Button>
      {item ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            void api
              .resolve({ base: entry.id, action: "keep", slug: item.slug })
              .then(() => api.setFocus(undefined))
          }
        >
          <CheckIcon />
          {copy.keep}
        </Button>
      ) : null}
      <Button type="button" size="sm" variant="ghost" onClick={onBackToCompare}>
        <Columns3Icon />
        {copy.backToCompare}
      </Button>
    </div>
  );
}

/** The focused variant's synthesized entry for the single-layout preview. */
function focusedVariantEntry(
  api: VariationsApi | undefined,
  entry: RegistryEntry | undefined,
  set: VariationSet | undefined,
): RegistryEntry | undefined {
  if (!api || !entry || !set) return undefined;
  if (api.focus?.base !== entry.id) return undefined;
  const item = set.items.find(
    (candidate) => candidate.slug === api.focus?.slug,
  );
  if (!item) return undefined;
  return synthesizeVariantEntry(entry, item);
}

export {
  VariationsCycler,
  VariationsGenerateButton,
  VariationsStrip,
  focusedVariantEntry,
};
