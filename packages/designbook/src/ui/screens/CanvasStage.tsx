import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { StageElementContext, StageTransformContext } from "./stageContext";

type StageTransform = {
  x: number;
  y: number;
  scale: number;
};

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;

/**
 * Figma-style infinite canvas: trackpad/wheel pans, pinch (ctrl/cmd+wheel)
 * zooms toward the cursor, and dragging the background pans. Content is
 * rendered inside a single transformed layer; overlays (toolbars, headers)
 * belong outside this component so they stay screen-fixed.
 */
function CanvasStage({
  children,
  initial,
  overlay,
  persisted,
  onTransformChange,
}: {
  children: ReactNode;
  initial?: Partial<StageTransform>;
  overlay?: ReactNode;
  /** Restored pan/zoom for this route. Wins over `initial` when set. */
  persisted?: StageTransform;
  /** Write-through of the live transform for reload rehydration. */
  onTransformChange?: (transform: StageTransform) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<StageTransform>(
    persisted ?? {
      x: 48,
      y: 48,
      scale: 1,
      ...initial,
    },
  );

  // Mirror pan/zoom out for persistence; the parent debounces the write. Runs
  // on mount too (idempotent: it writes back the value it was seeded with).
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
  useEffect(() => {
    onTransformChangeRef.current?.(transform);
  }, [transform]);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  }>(undefined);

  const stageCallbackRef = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el;
    setStageEl(el);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Alias for closures below: hoisted function declarations don't see the
    // null-guard narrowing.
    const stageEl: HTMLDivElement = stage;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();

      setTransform((current) => {
        if (event.ctrlKey || event.metaKey) {
          const bounds = stageEl.getBoundingClientRect();
          const cursorX = event.clientX - bounds.left;
          const cursorY = event.clientY - bounds.top;
          const nextScale = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, current.scale * Math.exp(-event.deltaY * 0.01)),
          );
          const ratio = nextScale / current.scale;

          return {
            scale: nextScale,
            x: cursorX - (cursorX - current.x) * ratio,
            y: cursorY - (cursorY - current.y) * ratio,
          };
        }

        return {
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        };
      });
    }

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [stageEl]);

  function isBackgroundTarget(target: EventTarget | null) {
    return target === stageRef.current || target === contentRef.current;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const middleButton = event.button === 1;
    if (
      !middleButton &&
      (event.button !== 0 || !isBackgroundTarget(event.target))
    ) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    setTransform((current) => ({
      ...current,
      x: drag.originX + (event.clientX - drag.startClientX),
      y: drag.originY + (event.clientY - drag.startClientY),
    }));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <StageElementContext.Provider value={stageEl}>
      <StageTransformContext.Provider value={transform}>
        <div
          ref={stageCallbackRef}
          className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            ref={contentRef}
            className="absolute origin-top-left"
            style={{
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            }}
          >
            {children}
          </div>
          {overlay}
        </div>
      </StageTransformContext.Provider>
    </StageElementContext.Provider>
  );
}

export { CanvasStage };
export type { StageTransform };
