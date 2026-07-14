/**
 * The sandbox canvas (docs/specs/sandbox.md §5): one pin's exploration
 * surface. A plain SCROLL container (no pan/zoom v1) with absolutely-
 * positioned, pointer-drag variant cards whose x/y persist via
 * `POST /api/sandbox/position` (D4). Cards are self-contained cells
 * (`contain: layout paint`, the variations-strip layout lessons) that
 * AUTO-SIZE to their rendered content by default (fit-content width in a
 * sane band, intrinsic height) and can be USER-RESIZED via a bottom-right
 * handle — an explicit w/h that overrides auto, persisted on the same
 * position endpoint (double-click the handle resets to auto). Cards land
 * progressively as `sandbox-event`s fold in.
 *
 * The left rail renders the pin's comment-style thread plus the prompt input
 * for follow-up variant runs — WORKBENCH mount only (`embedded` false). In the
 * page-mode CanvasPanel (`embedded`) the rail is dropped: the chat drawer's
 * thread already carries the prompt, so the canvas reclaims the full width.
 * Variants render in the selection's CAPTURED state (D2 — say so in the
 * chrome, promise nothing live).
 */

import {
  Component,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowLeftIcon, GripHorizontalIcon, PinIcon } from "lucide-react";
import { Badge } from "@designbook-ui/components/ui/badge";
import { Button } from "@designbook-ui/components/ui/button";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import { Textarea } from "@designbook-ui/components/ui/textarea";
import { cn } from "@designbook-ui/lib/utils";
import { LightDomSlot } from "@designbook-ui/isolationContext";
import { makeSandboxPreview } from "@designbook-ui/models/sandbox/sandboxPreview";
import {
  activeChangesetForPin,
  clampFrameSize,
  readyCounts,
  resolveFrameSize,
  SANDBOX_AUTO_MAX_WIDTH,
  SANDBOX_AUTO_MIN_WIDTH,
  type SandboxFrameSize,
  type SandboxPinState,
  type SandboxVariantState,
} from "@designbook-ui/models/sandbox/sandboxModel";
import {
  useSandboxApi,
  type SandboxApi,
} from "@designbook-ui/models/sandbox/SandboxProvider";
import { ErrorCell } from "../PreviewCell";
import {
  PREVIEW_ROOT_ATTR,
  previewRootKey,
  SandboxPreviewSelectLayer,
  type PreviewElementSelection,
} from "./SandboxPreviewSelect";

/** An element selection inside one variant's preview (canvas-level: carries
 * WHICH variant so exactly one preview shows a selection at a time). */
type SandboxCanvasElementSelection = PreviewElementSelection & {
  variantId: string;
};

/** U5 (page mode): the in-place preview toggle a cell's actions expose when
 * the canvas is mounted in the page drawer (the live page is right there). */
type SandboxPagePreviewControl = {
  activeVariantId?: string;
  onToggle: (variantId: string) => void;
};

const copy = {
  back: "Back",
  capturedNote:
    "Variants render in the selection's captured state — live app behavior isn't promised.",
  failedBadge: "failed",
  generatingBadge: "generating…",
  missingPin: "This pin no longer exists.",
  promptPlaceholder: "Ask for more variants…",
  readyOf: (ready: number, total: number) => `${ready} of ${total} ready`,
  retry: "Retry",
  send: "Send",
  threadEmpty: "No prompts yet.",
  updatingBadge: "updating…",
};

// ---------------------------------------------------------------------------
// Variant card.
// ---------------------------------------------------------------------------

function CardShell({
  badge,
  cardRef,
  children,
  footer,
  onDragStart,
  onResizeStart,
  onResizeReset,
  position,
  size,
  title,
  intent,
  tone,
  selected,
  selectArmed,
  onSelect,
  onHeaderClick,
  selectLayer,
}: {
  badge?: ReactNode;
  cardRef?: (element: HTMLDivElement | null) => void;
  children: ReactNode;
  footer?: ReactNode;
  onDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Begin a corner-drag resize (sets an explicit w/h, overriding auto). */
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Double-click the handle: reset this frame to auto-size. */
  onResizeReset?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  position: { left: number; top: number };
  /** Explicit user size (px). Absent = AUTO-SIZE to content. */
  size?: SandboxFrameSize;
  title: string;
  intent?: string;
  tone?: "pending" | "failed" | "normal";
  /** R correction: this frame is the Select tool's current pick. */
  selected?: boolean;
  /** R correction: Select tool armed — cover the preview with a click catcher
   * so a click picks the frame instead of reaching the live variant. */
  selectArmed?: boolean;
  onSelect?: () => void;
  /** Frame pick from the card CHROME (header click while Select is armed —
   * element selection owns the preview area on ready cards). */
  onHeaderClick?: () => void;
  /** Element-selection layer over the preview (ready cards, Select armed):
   * REPLACES the frame click-catcher — hover/click select elements INSIDE
   * the rendered variant; padding clicks fall back to the frame pick. */
  selectLayer?: ReactNode;
}) {
  const sized = size !== undefined;
  return (
    <div
      ref={cardRef}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-lg border bg-background shadow-md",
        // AUTO-SIZE: fit-content width clamped to a sane band (min keeps
        // empty/loading cells visible, max stops a full-bleed variant from
        // swallowing the canvas); height grows intrinsically. When USER-SIZED
        // the inline width/height below win and content scrolls within.
        !sized && "w-fit",
        tone === "pending" && "opacity-80",
        tone === "failed" && "border-destructive",
        // Select-tool highlight (mirrors the page select tool's primary box).
        selected && "ring-2 ring-primary",
      )}
      style={{
        left: position.left,
        top: position.top,
        ...(sized
          ? { width: size.w, height: size.h }
          : {
              minWidth: SANDBOX_AUTO_MIN_WIDTH,
              maxWidth: SANDBOX_AUTO_MAX_WIDTH,
            }),
      }}
    >
      {/* Drag handle = the header row (pointer capture, no pan/zoom math).
          `w-0 min-w-full` keeps the header from DRIVING the fit-content width
          (it follows the width the content sets, and truncates). */}
      <div
        className="w-0 min-w-full shrink-0 cursor-grab touch-none border-b px-3 py-2 select-none active:cursor-grabbing"
        onPointerDown={onDragStart}
        onClick={onHeaderClick}
      >
        <div className="flex min-w-0 items-center gap-2">
          <GripHorizontalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 truncate font-mono text-xs font-semibold"
            title={title}
          >
            {title}
          </span>
          {badge}
        </div>
        <div
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={intent}
        >
          {intent || " "}
        </div>
      </div>
      {/* HARD CONTAINMENT (variations FrameShell lesson): `contain: layout
          paint` fences absolute/fixed descendants and clips paint. The content
          DRIVES the fit-content width when auto; when user-sized it scrolls
          (`overflow-auto`) so larger content stays reachable. NOTE: auto mode
          must NOT be a scroll container (overflow collapses the fit-content
          width) — contain:paint does the clipping instead. */}
      <div
        className={cn(
          "relative flex-1 p-3 [contain:layout_paint]",
          sized ? "overflow-auto" : "min-h-40",
        )}
      >
        {children}
        {/* Select tool armed: on READY cards the element-selection layer owns
            the preview area (hover/click select elements INSIDE the variant;
            padding clicks fall back to the frame pick). Other card states
            keep the plain full-bleed catcher: a click is a FRAME PICK (for
            iteration) rather than an interaction with the live variant. The
            header (drag + chrome frame pick) and footer (iterate box) stay
            outside either layer, so they keep working. */}
        {selectLayer ??
          (selectArmed && onSelect ? (
            <button
              type="button"
              aria-label={`Select ${title} to iterate`}
              className="absolute inset-0 z-20 cursor-pointer bg-transparent"
              onClick={onSelect}
            />
          ) : null)}
      </div>
      {footer ? (
        <div className="mt-auto w-0 min-w-full shrink-0 border-t px-3 py-2">
          {footer}
        </div>
      ) : null}
      {/* Resize handle (bottom-right). The handlers stopPropagation so the
          corner-drag never starts a card move. Double-click = auto. */}
      {onResizeStart ? (
        <div
          role="button"
          aria-label="Resize frame (double-click to auto-size)"
          title="Drag to resize · double-click to auto-size"
          className="absolute right-0 bottom-0 z-10 h-4 w-4 cursor-nwse-resize touch-none select-none"
          onPointerDown={onResizeStart}
          onDoubleClick={onResizeReset}
        >
          <div className="absolute right-[3px] bottom-[3px] h-2 w-2 rounded-[1px] border-r-2 border-b-2 border-muted-foreground/60" />
        </div>
      ) : null}
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

const previewFallbackStyle = {
  minHeight: 96,
  width: "100%",
  borderRadius: 8,
  background:
    "repeating-linear-gradient(-45deg, rgba(120,120,120,.08) 0 10px, rgba(120,120,120,.04) 10px 20px)",
} as const;

/** One render-failure report per (pin, variant, rev) — the client half of
 * the loop's debounce (the server also refuses non-ready variants). */
const reportedRenderFailures = new Set<string>();

/** Below this measured height a landed variant counts as an EMPTY render
 * (the MeasuredPreview threshold from variations, reused). */
const EMPTY_RENDER_HEIGHT_PX = 24;

/**
 * Error boundary that REPORTS what it catches (render throws and rejected
 * variant-module imports alike) — the canvas half of the render-verify loop:
 * "ready" must mean renders, so a caught error posts to
 * /api/sandbox/render-failure and the orchestrator marks + auto-fixes.
 */
class SandboxRenderBoundary extends Component<
  {
    name: string;
    onRenderError: (error: unknown) => void;
    children: ReactNode;
  },
  { error: unknown }
> {
  state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onRenderError(error);
  }

  render() {
    if (this.state.error !== undefined) {
      return (
        <ErrorCell
          name={this.props.name}
          error={this.state.error}
          onRetry={() => {}}
        />
      );
    }
    return this.props.children;
  }
}

function VariantPreview({
  pin,
  variant,
  onRenderFailure,
}: {
  pin: SandboxPinState;
  variant: SandboxVariantState;
  /** Report a crash/empty render of a READY variant (render-verify loop). */
  onRenderFailure: (message: string) => void;
}) {
  const Preview: ComponentType | undefined = makeSandboxPreview(pin, variant);
  const measureRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef(onRenderFailure);
  reportRef.current = onRenderFailure;
  const ready = variant.status === "ready";

  // Empty-render detection (the MeasuredPreview lesson, sandbox-local): once
  // the Suspense content is in (no pending marker), a settled height under
  // the threshold means the variant mounted NOTHING visible — report it.
  // Timers, not rAF (rAF never fires in hidden tabs — live-dogfood finding).
  useEffect(() => {
    if (!ready) return;
    const el = measureRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      timer = undefined;
      if (!el.isConnected) return; // boundary swapped to its error cell
      if (el.querySelector("[data-sandbox-pending]")) return; // still loading
      // A HIDDEN cell measures 0×0 and says nothing about the variant
      // (display:none ancestor, canvas not painted yet — the MeasuredPreview
      // lesson; live-eval false-positive finding): only a VISIBLE cell
      // (real width, painted client rect) can prove an empty render.
      if (el.offsetWidth < 40 || el.getClientRects().length === 0) return;
      const height = el.offsetHeight;
      if (height < EMPTY_RENDER_HEIGHT_PX) {
        reportRef.current(
          `the variant rendered EMPTY (measured height ${height}px — likely a root sized only by absolutely-positioned children)`,
        );
      }
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(evaluate, 400);
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
  }, [ready, variant.rev]);

  if (!Preview) return null;
  return (
    <LightDomSlot>
      {/* Key on rev: an iterate/auto-fix lands as a NEW module URL (?t=rev),
          so the cell remounts with the fresh import — per-cell HMR. */}
      <SandboxRenderBoundary
        key={variant.rev}
        name={variant.id}
        onRenderError={(error) =>
          reportRef.current(
            error instanceof Error
              ? error.message
              : String(error ?? "render error"),
          )
        }
      >
        {/* The measure div doubles as the ELEMENT-SELECTION boundary: the
            select layer scopes its fiber+DOM hit-testing to this subtree via
            the attribute (light DOM — slotted content). */}
        <div
          ref={measureRef}
          {...{ [PREVIEW_ROOT_ATTR]: previewRootKey(pin.id, variant.id) }}
        >
          <Suspense
            fallback={
              <div aria-hidden data-sandbox-pending style={previewFallbackStyle} />
            }
          >
            <Preview />
          </Suspense>
        </div>
      </SandboxRenderBoundary>
    </LightDomSlot>
  );
}

function SandboxVariantCard({
  api,
  pin,
  variant,
  position,
  size,
  onDrag,
  onDragEnd,
  onResize,
  onResizeEnd,
  onResetSize,
  themeClassName,
  pagePreview,
  selectArmed = false,
  selected = false,
  onSelect,
  onDeselect,
  elementSelection,
  onElementSelect,
}: {
  api: SandboxApi;
  pin: SandboxPinState;
  variant: SandboxVariantState;
  position: { x: number; y: number };
  /** Explicit user size (px), or undefined for auto-size. */
  size?: SandboxFrameSize;
  onDrag: (variantId: string, x: number, y: number) => void;
  onDragEnd: (variantId: string, x: number, y: number) => void;
  onResize: (variantId: string, w: number, h: number) => void;
  onResizeEnd: (variantId: string, w: number, h: number) => void;
  onResetSize: (variantId: string) => void;
  themeClassName?: string;
  /** U5 (page-drawer mount only): the in-place preview toggle. */
  pagePreview?: SandboxPagePreviewControl;
  /** R correction: the Select tool is armed — cover the preview with a click
   * catcher so a click PICKS the frame (for iteration) instead of hitting the
   * live variant inside. */
  selectArmed?: boolean;
  /** This frame is the current select-tool pick (highlight + iterate box). */
  selected?: boolean;
  /** Pick this frame. */
  onSelect?: () => void;
  /** Clear the pick (after the iterate turn is dispatched / cancelled). */
  onDeselect?: () => void;
  /** Element selection inside THIS variant's preview (page-drawer mount). */
  elementSelection?: PreviewElementSelection;
  /** Set/clear the element selection (lifted — Escape ladder in PageTools). */
  onElementSelect?: (selection: PreviewElementSelection | undefined) => void;
}) {
  // The card element — the resize gesture measures its rendered box to seed
  // the base size when the frame is auto (no explicit w/h yet).
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Header clicks double as CHROME frame picks while Select is armed — but
  // only when the pointer didn't actually drag the card between down and up.
  const dragMovedRef = useRef(false);

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    // Do NOT let the corner-drag bubble to a card move.
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rect = cardRef.current?.getBoundingClientRect();
    const base = size ?? {
      w: rect?.width ?? SANDBOX_AUTO_MIN_WIDTH,
      h: rect?.height ?? 240,
    };
    const resize = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseW: base.w,
      baseH: base.h,
    };
    const at = (moveEvent: PointerEvent) =>
      clampFrameSize(
        resize.baseW + moveEvent.clientX - resize.startX,
        resize.baseH + moveEvent.clientY - resize.startY,
      );
    function move(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== resize.pointerId) return;
      const next = at(moveEvent);
      onResize(variant.id, next.w, next.h);
    }
    function up(upEvent: PointerEvent) {
      if (upEvent.pointerId !== resize.pointerId) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      const next = at(upEvent);
      onResizeEnd(variant.id, next.w, next.h);
    }
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function handleResizeReset(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    onResetSize(variant.id);
  }

  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    dragMovedRef.current = false;
    // The whole gesture closes over this one record; pointer capture keeps
    // move/up on the handle even when the pointer leaves the card.
    const drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: position.x,
      baseY: position.y,
    };
    function move(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== drag.pointerId) return;
      if (
        Math.abs(moveEvent.clientX - drag.startX) +
          Math.abs(moveEvent.clientY - drag.startY) >
        3
      ) {
        dragMovedRef.current = true;
      }
      onDrag(
        variant.id,
        Math.max(0, Math.round(drag.baseX + moveEvent.clientX - drag.startX)),
        Math.max(0, Math.round(drag.baseY + moveEvent.clientY - drag.startY)),
      );
    }
    function up(upEvent: PointerEvent) {
      if (upEvent.pointerId !== drag.pointerId) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onDragEnd(
        variant.id,
        Math.max(0, Math.round(drag.baseX + upEvent.clientX - drag.startX)),
        Math.max(0, Math.round(drag.baseY + upEvent.clientY - drag.startY)),
      );
    }
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  // Shell props shared by every card state (position, size, drag + resize,
  // and the R-correction select-tool highlight + click catcher).
  const shell = {
    cardRef: (element: HTMLDivElement | null) => {
      cardRef.current = element;
    },
    position: { left: position.x, top: position.y },
    size,
    onDragStart: handleDragStart,
    onResizeStart: handleResizeStart,
    onResizeReset: handleResizeReset,
    selected,
    selectArmed,
    ...(onSelect ? { onSelect } : {}),
    // Chrome frame pick: a header CLICK (not a drag) selects the frame while
    // the tool is armed — the preview area belongs to element selection.
    ...(selectArmed && onSelect
      ? {
          onHeaderClick: () => {
            if (!dragMovedRef.current) onSelect();
          },
        }
      : {}),
  };

  if (variant.status === "generating") {
    return (
      <CardShell
        {...shell}
        title={variant.id}
        intent={variant.intent}
        tone="pending"
        badge={<Badge variant="secondary">{copy.generatingBadge}</Badge>}
      >
        <PendingSkeleton label={`${variant.id} ${copy.generatingBadge}`} />
      </CardShell>
    );
  }

  if (variant.status === "failed") {
    return (
      <CardShell
        {...shell}
        title={variant.id}
        intent={variant.intent}
        tone="failed"
        badge={<Badge variant="destructive">{copy.failedBadge}</Badge>}
        footer={
          <SandboxVariantRetry api={api} pin={pin} variant={variant} />
        }
      >
        <div className="flex min-w-0 flex-col gap-1">
          <span className="break-all font-mono text-[10px] text-muted-foreground">
            {variant.file}
          </span>
          <span className="break-words text-xs text-destructive">
            {variant.error}
          </span>
        </div>
      </CardShell>
    );
  }

  const updating = variant.status === "updating";
  // Element selection INSIDE the rendered preview (page-drawer mount, Select
  // armed, ready cells only): hover/click select elements; submit runs an
  // ITERATE turn on this variant with the element descriptor attached.
  const selectLayer =
    selectArmed && onElementSelect && variant.status === "ready" ? (
      <SandboxPreviewSelectLayer
        previewKey={previewRootKey(pin.id, variant.id)}
        {...(elementSelection ? { selection: elementSelection } : {})}
        onSelect={onElementSelect}
        {...(onSelect ? { onFramePick: onSelect } : {})}
        busy={pin.busy}
        onSubmit={(prompt, element) =>
          api.iterate({
            pinId: pin.id,
            variantId: variant.id,
            prompt,
            element,
          })
        }
      />
    ) : undefined;
  return (
    <CardShell
      {...shell}
      {...(selectLayer ? { selectLayer } : {})}
      title={variant.id}
      intent={variant.intent}
      tone={updating ? "pending" : "normal"}
      badge={
        updating ? (
          <Badge variant="secondary">
            <Spinner data-icon="inline-start" />
            {copy.updatingBadge}
          </Badge>
        ) : undefined
      }
      footer={
        <SandboxVariantActions
          api={api}
          pin={pin}
          variant={variant}
          selected={selected}
          {...(onDeselect ? { onDeselect } : {})}
          {...(pagePreview ? { pagePreview } : {})}
        />
      }
    >
      <div className={themeClassName}>
        <VariantPreview
          pin={pin}
          variant={variant}
          onRenderFailure={(message) => {
            // Only a READY variant can "fail to render"; one report per rev.
            if (variant.status !== "ready") return;
            const key = `${pin.id}|${variant.id}|${variant.rev}`;
            if (reportedRenderFailures.has(key)) return;
            reportedRenderFailures.add(key);
            void api.renderFailure({
              pinId: pin.id,
              variantId: variant.id,
              error: message,
            });
          }}
        />
      </div>
    </CardShell>
  );
}

/** Footer of a FAILED card: re-run the variant (same direction + request). */
function SandboxVariantRetry({
  api,
  pin,
  variant,
}: {
  api: SandboxApi;
  pin: SandboxPinState;
  variant: SandboxVariantState;
}) {
  const [error, setError] = useState<string>();
  const busy = pin.busy;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void api
            .retry({ pinId: pin.id, variantId: variant.id })
            .then((result) => setError(result.error))
        }
      >
        {busy ? <Spinner /> : null}
        {copy.retry}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

/**
 * Per-variant actions (P2): select → inline iterate note, or Replace with
 * this (confirm → /replace → pin resolved → canvas hides the entry, D3).
 */
function SandboxVariantActions({
  api,
  pin,
  variant,
  pagePreview,
  selected,
  onDeselect,
}: {
  api: SandboxApi;
  pin: SandboxPinState;
  variant: SandboxVariantState;
  /** U5 (page mode only): toggle the temporary in-place preview. */
  pagePreview?: SandboxPagePreviewControl;
  /** R correction: the Select tool picked this frame — open the iterate form
   * (the prompt-first pattern converges on the SAME inline affordance). */
  selected?: boolean;
  /** Clear the Select-tool pick once its iterate turn is sent / cancelled. */
  onDeselect?: () => void;
}) {
  const actionsCopy = {
    cancel: "Cancel",
    iterate: "Iterate",
    iteratePlaceholder: "What should change in this one?",
    preview: "Preview in place",
    previewOn: "In place — restore original",
    replace: "Replace with this",
    replaceConfirm: (file: string) => `Rewrite ${file} from this variant?`,
    replaceGo: "Replace",
    send: "Send",
  };
  const [form, setForm] = useState<"iterate" | "replace" | undefined>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const busy = pin.busy || variant.status === "updating";
  const baseFile = pin.target.file.split("/").pop() ?? pin.target.file;
  const iterateInputRef = useRef<HTMLInputElement>(null);

  // R correction: a Select-tool pick opens THIS card's iterate form (the same
  // inline affordance the Iterate button opens — no competing box) and focuses
  // it, so selecting a frame is prompt-first like a page selection.
  useEffect(() => {
    if (selected) {
      setForm("iterate");
      setNote("");
    }
  }, [selected]);
  useEffect(() => {
    if (selected && form === "iterate") iterateInputRef.current?.focus();
  }, [selected, form]);

  async function act(action: () => Promise<{ error?: string }>) {
    setError(undefined);
    const result = await action();
    if (result.error) setError(result.error);
    else {
      setForm(undefined);
      setNote("");
      // The picked frame's iterate turn is dispatched — drop the selection so
      // the highlight clears (the "updating" badge now carries the activity).
      onDeselect?.();
    }
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setNote("");
            setForm(form === "iterate" ? undefined : "iterate");
          }}
        >
          {busy ? <Spinner /> : null}
          {actionsCopy.iterate}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setForm(form === "replace" ? undefined : "replace")}
        >
          {actionsCopy.replace}
        </Button>
        {pagePreview &&
        variant.status === "ready" &&
        activeChangesetForPin(api.changesets, pin.id) ? (
          <Button
            type="button"
            size="sm"
            variant={
              pagePreview.activeVariantId === variant.id ? "default" : "outline"
            }
            onClick={() => pagePreview.onToggle(variant.id)}
          >
            {pagePreview.activeVariantId === variant.id
              ? actionsCopy.previewOn
              : actionsCopy.preview}
          </Button>
        ) : null}
      </div>
      {form === "iterate" ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() =>
              api.iterate({
                pinId: pin.id,
                variantId: variant.id,
                prompt: note.trim(),
              }),
            );
          }}
        >
          <input
            ref={iterateInputRef}
            value={note}
            className="h-7 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={actionsCopy.iteratePlaceholder}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!note.trim() || busy}>
            {actionsCopy.send}
          </Button>
        </form>
      ) : null}
      {form === "replace" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span>{actionsCopy.replaceConfirm(baseFile)}</span>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.replace({ pinId: pin.id, variantId: variant.id }),
              )
            }
          >
            {actionsCopy.replaceGo}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setForm(undefined)}
          >
            {actionsCopy.cancel}
          </Button>
        </div>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread rail.
// ---------------------------------------------------------------------------

function ThreadRail({
  api,
  pin,
}: {
  api: SandboxApi;
  pin: SandboxPinState;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();

  async function send() {
    const prompt = text.trim();
    if (!prompt || pin.busy) return;
    setError(undefined);
    const result = await api.prompt({ pinId: pin.id, prompt, mode: "variants" });
    if (result.error) setError(result.error);
    else setText("");
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {pin.thread.length === 0 ? (
          <p className="text-xs text-muted-foreground">{copy.threadEmpty}</p>
        ) : (
          <div className="grid gap-2">
            {pin.thread.map((message, index) => (
              <div
                key={`${message.at}-${index}`}
                className={cn(
                  "max-w-full rounded-lg px-2.5 py-1.5 text-xs break-words whitespace-pre-wrap",
                  message.role === "user"
                    ? "justify-self-end bg-primary text-primary-foreground"
                    : "justify-self-start bg-muted",
                )}
              >
                {message.text}
              </div>
            ))}
            {pin.busy ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                {pin.planning ? "Proposing directions…" : "Working…"}
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div className="grid gap-1.5 border-t p-2">
        {pin.lastError ? (
          <span className="text-xs break-words text-destructive">
            {pin.lastError}
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
        <Textarea
          value={text}
          rows={2}
          placeholder={copy.promptPlaceholder}
          className="min-h-0 text-xs"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={pin.busy || !text.trim()}
          onClick={() => void send()}
        >
          {pin.busy ? <Spinner /> : null}
          {copy.send}
        </Button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The canvas screen.
// ---------------------------------------------------------------------------

const CANVAS_PADDING = 480;

function SandboxCanvas({
  pinId,
  themeClassName,
  onBack,
  embedded = false,
  pagePreview,
  selectArmed = false,
  selectedVariantId,
  onSelectVariant,
  elementSelection,
  onElementSelect,
}: {
  pinId: string;
  themeClassName?: string;
  onBack: () => void;
  /** U6: mounted inside the page-mode CanvasPanel — the panel header owns
   * navigation, so the canvas's own back button hides AND the thread rail is
   * dropped (the chat drawer owns the thread + prompt). Everything else
   * (drag, resize, iterate, replace) is identical to the workbench mount. */
  embedded?: boolean;
  /** U5 (page-drawer mount only): the in-place preview toggle per cell. */
  pagePreview?: SandboxPagePreviewControl;
  /** R correction (page-drawer mount only): the page Select tool is armed, so
   * clicking a variant FRAME picks it for iteration (highlight + inline iterate
   * box) instead of interacting with the live preview inside the cell. */
  selectArmed?: boolean;
  /** The select-tool-picked variant (highlighted frame). */
  selectedVariantId?: string;
  /** Set/clear the picked variant — a pure selection, no navigation. */
  onSelectVariant?: (variantId: string | undefined) => void;
  /** Element selection inside one variant's preview (page-drawer mount) —
   * lifted to PageTools so the Escape ladder clears it first. */
  elementSelection?: SandboxCanvasElementSelection;
  /** Set/clear the element selection. */
  onElementSelect?: (
    selection: SandboxCanvasElementSelection | undefined,
  ) => void;
}) {
  const api = useSandboxApi();
  // Drag overrides win over server positions until the next status reload
  // (position POSTs aren't echoed back — the dragging client owns the truth).
  const [dragPositions, setDragPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  // Resize echoes, same discipline: a live {w,h} override, or `null` for an
  // explicit reset-to-auto that must beat a still-persisted server w/h until
  // the next reload. Absent = fall through to the variant's persisted size.
  const [dragSizes, setDragSizes] = useState<
    Record<string, SandboxFrameSize | null>
  >({});
  const pin = api?.pins[pinId];

  // An element selection is only meaningful on a READY cell — drop it when
  // its variant starts updating/fails/vanishes (the cell remounts on rev).
  const selectedElementVariant = elementSelection
    ? pin?.variants.find(
        (candidate) => candidate.id === elementSelection.variantId,
      )
    : undefined;
  const selectedElementStale =
    elementSelection !== undefined &&
    (!selectedElementVariant || selectedElementVariant.status !== "ready");
  useEffect(() => {
    if (selectedElementStale) onElementSelect?.(undefined);
  }, [selectedElementStale, onElementSelect]);

  const header = (
    <div className="flex items-center gap-2 border-b bg-background px-3 py-2">
      {embedded ? null : (
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          {copy.back}
        </Button>
      )}
      <PinIcon className="size-3.5 text-muted-foreground" />
      {pin ? (
        <>
          <span className="text-xs font-semibold">{pin.target.name}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {pin.target.file}
          </span>
          {pin.variants.length > 0 ? (
            <Badge variant="secondary">
              {copy.readyOf(
                readyCounts(pin).ready,
                readyCounts(pin).total,
              )}
            </Badge>
          ) : null}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {copy.capturedNote}
          </span>
        </>
      ) : null}
    </div>
  );

  if (!api || !pin) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <p className="p-4 text-sm text-muted-foreground">{copy.missingPin}</p>
      </div>
    );
  }

  // Resolved entries are hidden from the canvas (D3) — history, not workspace.
  const variants = pin.resolved ? [] : pin.variants;
  const positionOf = (variant: SandboxVariantState) =>
    dragPositions[variant.id] ?? { x: variant.x, y: variant.y };
  const sizeOf = (variant: SandboxVariantState) =>
    resolveFrameSize(dragSizes[variant.id], variant);
  // Canvas extent leaves room past each frame's right/bottom edge; an explicit
  // size widens/heightens the slack so a resized frame never clips the scroll.
  const extentX = Math.max(
    1200,
    ...variants.map(
      (variant) =>
        positionOf(variant).x +
        Math.max(CANVAS_PADDING, (sizeOf(variant)?.w ?? 0) + 160),
    ),
  );
  const extentY = Math.max(
    900,
    ...variants.map(
      (variant) =>
        positionOf(variant).y +
        Math.max(CANVAS_PADDING, (sizeOf(variant)?.h ?? 0) + 160),
    ),
  );

  return (
    <div className="flex h-full flex-col bg-muted">
      {header}
      <div className="flex min-h-0 flex-1">
        {/* WORKBENCH mount keeps the thread rail; the page-mode CanvasPanel
            (embedded) drops it — its chat drawer thread carries the prompt. */}
        {embedded ? null : <ThreadRail api={api} pin={pin} />}
        <div className="relative min-w-0 flex-1 overflow-auto">
          <div
            className="relative"
            style={{ width: extentX, height: extentY }}
            // While the Select tool is armed, a click on the bare canvas
            // backdrop (not a frame) deselects — the page select tool's
            // click-empty-to-clear semantics, scoped to the canvas. Clears
            // BOTH pick kinds (frame and in-preview element).
            onClick={
              selectArmed && (onSelectVariant || onElementSelect)
                ? (event) => {
                    if (event.target === event.currentTarget) {
                      onSelectVariant?.(undefined);
                      onElementSelect?.(undefined);
                    }
                  }
                : undefined
            }
          >
            {pin.resolved ? (
              <div className="m-6 max-w-md rounded-lg border bg-background p-4 text-sm text-muted-foreground">
                Replaced into {pin.target.file}. This pin is resolved — its
                variants are kept as history.
              </div>
            ) : null}
            {variants.map((variant) => (
              <SandboxVariantCard
                key={variant.id}
                api={api}
                pin={pin}
                variant={variant}
                position={positionOf(variant)}
                size={sizeOf(variant)}
                themeClassName={themeClassName}
                selectArmed={selectArmed}
                selected={selectedVariantId === variant.id}
                {...(onSelectVariant
                  ? {
                      onSelect: () => onSelectVariant(variant.id),
                      onDeselect: () => onSelectVariant(undefined),
                    }
                  : {})}
                {...(elementSelection?.variantId === variant.id
                  ? { elementSelection }
                  : {})}
                {...(onElementSelect
                  ? {
                      onElementSelect: (
                        selection: PreviewElementSelection | undefined,
                      ) =>
                        onElementSelect(
                          selection
                            ? { ...selection, variantId: variant.id }
                            : undefined,
                        ),
                    }
                  : {})}
                {...(pagePreview ? { pagePreview } : {})}
                onDrag={(variantId, x, y) =>
                  setDragPositions((current) => ({
                    ...current,
                    [variantId]: { x, y },
                  }))
                }
                onDragEnd={(variantId, x, y) => {
                  setDragPositions((current) => ({
                    ...current,
                    [variantId]: { x, y },
                  }));
                  void api.position({ pinId: pin.id, variantId, x, y });
                }}
                onResize={(variantId, w, h) =>
                  setDragSizes((current) => ({
                    ...current,
                    [variantId]: { w, h },
                  }))
                }
                onResizeEnd={(variantId, w, h) => {
                  setDragSizes((current) => ({
                    ...current,
                    [variantId]: { w, h },
                  }));
                  // Persist size with the move's current x/y (the endpoint
                  // wants finite x/y); w/h override auto server-side too.
                  const { x, y } = positionOf(variant);
                  void api.position({ pinId: pin.id, variantId, x, y, w, h });
                }}
                onResetSize={(variantId) => {
                  // Echo the reset (null beats a still-persisted w/h) and clear
                  // the persisted size (w/h: null → auto).
                  setDragSizes((current) => ({
                    ...current,
                    [variantId]: null,
                  }));
                  const { x, y } = positionOf(variant);
                  void api.position({
                    pinId: pin.id,
                    variantId,
                    x,
                    y,
                    w: null,
                    h: null,
                  });
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export { SandboxCanvas };
export type { SandboxCanvasElementSelection, SandboxPagePreviewControl };
