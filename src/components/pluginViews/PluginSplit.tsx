import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { clampSplitSize, SPLIT_DEFAULT_SIZE } from "../../utils/pluginSplit";
import "./PluginSplit.css";

export interface PluginSplitProps {
  first: ReactNode;
  second: ReactNode;
  initialSize?: number;
  minSize?: number;
  maxSize?: number;
  /** The user's stored width for this split, if any (wins over `initialSize`). */
  storedSize?: number;
  /** Called once per drag, on release, with the final width. */
  onSizeCommit?: (size: number) => void;
  /** The user asked for the default back: forget the stored width. */
  onSizeReset?: () => void;
}

const KEY_STEP = 16;

/**
 * The plugin `split` view node: two panes side by side, a draggable divider,
 * each pane scrolling on its own. The width lives in local state while
 * dragging and is handed to the host (`onSizeCommit`) only on release, so the
 * store isn't rewritten on every pointer move. The divider is a focusable
 * `separator`: ←/→ resize by 16px (Shift: 64px) and are the only keys it
 * takes — it `preventDefault`s just those, so Space and ↑/↓ still reach the
 * window's transport shortcuts (`widgetHandledKey`). Double-click resets to the
 * plugin's `initialSize` by forgetting the stored width, so a later default
 * from the plugin applies again.
 */
export function PluginSplit({ first, second, initialSize, minSize, maxSize, storedSize, onSizeCommit, onSizeReset }: PluginSplitProps) {
  const bounds = { minSize, maxSize };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  const [dragSize, setDragSize] = useState<number | null>(null);
  // The width this split last committed, ahead of the store echoing it back.
  // `"default"` = reset: ignore a stored width until the store drops it.
  const [localSize, setLocalSize] = useState<number | "default" | null>(null);
  // Tears down an in-progress drag. Kept so an unmount mid-drag (a plugin
  // re-rendering a different layout) detaches the listeners instead of
  // leaving them on a detached element to set state and commit a width later.
  const endDragRef = useRef<(() => void) | null>(null);

  // Re-clamp against the container as the window resizes.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth || undefined);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => { endDragRef.current?.(); }, []);

  const fallback = initialSize ?? SPLIT_DEFAULT_SIZE;
  const base = dragSize ?? (localSize === "default" ? fallback : localSize ?? storedSize ?? fallback);
  const size = clampSplitSize(base, bounds, containerWidth);

  const commit = (next: number) => {
    const clamped = clampSplitSize(next, bounds, containerWidth);
    setLocalSize(clamped);
    onSizeCommit?.(clamped);
  };

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    endDragRef.current?.();
    const startX = e.clientX;
    const startSize = size;
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    let latest = startSize;
    const onMove = (ev: PointerEvent) => {
      latest = clampSplitSize(startSize + (ev.clientX - startX), bounds, containerWidth);
      setDragSize(latest);
    };
    const detach = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      endDragRef.current = null;
    };
    const onUp = () => {
      detach();
      setDragSize(null);
      if (latest !== startSize) commit(latest);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
    endDragRef.current = detach;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    commit(size + (e.key === "ArrowLeft" ? -step : step));
  }

  function handleReset() {
    setLocalSize("default");
    onSizeReset?.();
  }

  return (
    <div ref={containerRef} className={`psplit${dragSize !== null ? " psplit--dragging" : ""}`}>
      <div className="psplit-pane psplit-pane--first" style={{ width: size }}>
        {first}
      </div>
      <div
        className="psplit-divider"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={size}
        aria-label="Resize panes"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        onDoubleClick={handleReset}
      />
      <div className="psplit-pane psplit-pane--second">{second}</div>
    </div>
  );
}
