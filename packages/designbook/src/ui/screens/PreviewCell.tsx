/**
 * Per-cell rendering with fault isolation (C4.1).
 *
 * Every previewed component — grid cell and detail-page preview alike — renders
 * through `PreviewCell`. Lazy entries (a raw or `fromGlob`-branded glob thunk)
 * materialize through `React.lazy`, so the owning bundler compiles the dynamic
 * import per cell: a broken component is ONE red cell, never a dead workbench.
 *
 * Boundaries:
 *   - `CellErrorBoundary` catches an import rejection OR a render throw and shows
 *     a red cell (component name + first error line + retry). Retry bumps a key
 *     that both remounts the boundary and rebuilds the React.lazy (React.lazy
 *     caches rejections, so a fresh wrapper is required for an HMR fix to
 *     recover).
 *   - `Suspense` covers the load gap with a subtle, fixed-min-height fallback so
 *     there is no layout jump and — under shadow isolation, where this renders
 *     into the LIGHT DOM via `LightDomSlot` — no flash of unstyled content
 *     (the fallback/error UI use inline styles, not chrome tailwind classes).
 *
 * The `[data-db-entry]` element (the Figma serializer root and selection-restore
 * anchor) exists ONLY on success — an errored/loading cell has no
 * `[data-db-entry]` content, which is exactly what selection restore drops silently.
 */

import {
  Component,
  createElement,
  Suspense,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { LightDomSlot } from "@designbook-ui/isolationContext";
import {
  getSetWrapper,
  makeLazyComponent,
  type RegistryEntry,
} from "@designbook-ui/models/catalog/componentRegistry";

const copy = {
  errorHeading: "Failed to render",
  retry: "Retry",
};

/** First non-empty line of an error message, for the compact red cell. */
function firstErrorLine(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  const line = message.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "Unknown error").trim();
}

const fallbackStyle: CSSProperties = {
  minHeight: 96,
  width: "100%",
  borderRadius: 8,
  background:
    "repeating-linear-gradient(-45deg, rgba(120,120,120,.08) 0 10px, rgba(120,120,120,.04) 10px 20px)",
};

function CellFallback() {
  return <div aria-hidden style={fallbackStyle} />;
}

const errorCellStyle: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  minHeight: 96,
  padding: "14px 16px",
  borderRadius: 8,
  border: "1px solid #ef4444",
  background: "#fef2f2",
  color: "#7f1d1d",
  font: "13px system-ui, -apple-system, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  alignItems: "flex-start",
};

function ErrorCell({
  name,
  error,
  onRetry,
}: {
  name: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div role="alert" style={errorCellStyle}>
      <div style={{ fontWeight: 600 }}>
        {copy.errorHeading}: {name}
      </div>
      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.9 }}>
        {firstErrorLine(error)}
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          font: "inherit",
          fontWeight: 600,
          padding: "4px 12px",
          borderRadius: 6,
          border: "1px solid #ef4444",
          background: "#fff",
          color: "#b91c1c",
          cursor: "pointer",
        }}
      >
        {copy.retry}
      </button>
    </div>
  );
}

class CellErrorBoundary extends Component<
  { name: string; onRetry: () => void; children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (this.state.error !== undefined) {
      return (
        <ErrorCell
          name={this.props.name}
          error={this.state.error}
          onRetry={this.props.onRetry}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Render one registry entry with fault isolation. Static entries render inline;
 * lazy entries load through React.lazy. The `data-db-entry` wrapper is the
 * serializer/selection root and is present only when the component renders.
 */
function PreviewCell({ entry }: { entry: RegistryEntry }) {
  const [attempt, setAttempt] = useState(0);
  const Wrapper = getSetWrapper(entry.setId);

  const Rendered = useMemo<ComponentType | undefined>(() => {
    if (entry.load) return makeLazyComponent(entry);
    return isRenderable(entry.component) ? (entry.component as ComponentType) : undefined;
    // Rebuild the lazy wrapper on retry so a cached rejection is discarded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, attempt]);

  if (!Rendered) return null;

  const node = createElement(Rendered);
  const content = (
    <div data-db-entry={entry.id}>
      {Wrapper ? createElement(Wrapper, null, node) : node}
    </div>
  );

  return (
    <LightDomSlot>
      <CellErrorBoundary
        key={attempt}
        name={entry.name}
        onRetry={() => setAttempt((a) => a + 1)}
      >
        <Suspense fallback={<CellFallback />}>{content}</Suspense>
      </CellErrorBoundary>
    </LightDomSlot>
  );
}

function isRenderable(value: unknown): boolean {
  if (typeof value === "function") return true;
  return Boolean(value) && typeof value === "object" && "$$typeof" in (value as object);
}

export { CellErrorBoundary, ErrorCell, PreviewCell, firstErrorLine };
