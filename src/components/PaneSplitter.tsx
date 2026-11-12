import { useEffect, useRef, useState } from "react";
import { clampPaneWidth, effectivePaneLimits, stepPaneDrag, type PaneDragStep, type PaneLimits } from "../utils/paneResize";
import "./PaneSplitter.css";

// The splitter on a side pane's inner edge — the only resize and collapse
// control the sidebar and the queue have (there are no arrow buttons).
//
// Preview, then release: while dragging, the open width follows the pointer
// through a CSS variable on the grid (`--sidebar-drag-width` /
// `--queue-drag-width`), so App doesn't re-render per move; a collapse or an
// open is only *previewed* — the pane dims with its rail outlined, or a ghost
// shows the width it will open at — and nothing is committed or persisted
// until the pointer is released. Escape or a cancelled pointer drops the drag.
// A pill by the pointer says what letting go will do; in the collapse zone it
// fills a meter toward a dashed line where the pane folds.
// Double-click or Enter toggles; arrow keys resize. Rules in `utils/paneResize.ts`.

interface Props {
  /** "start": the pane is on the window's left (the sidebar); "end": right (the queue). */
  side: "start" | "end";
  label: string;
  limits: PaneLimits;
  width: number;
  collapsed: boolean;
  /** The other side pane's current column width — the main column keeps
   *  `MAIN_MIN_WIDTH` between the two. */
  otherWidth: number;
  onResize: (width: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}

interface Gesture {
  startX: number;
  moved: boolean;
  startCollapsed: boolean;
  limits: PaneLimits;
  step: PaneDragStep;
}

interface DragView extends PaneDragStep {
  startCollapsed: boolean;
  /** Pointer height inside the splitter, for the pill. */
  y: number;
}

const KEY_STEP = 16;

export default function PaneSplitter({ side, label, limits, width, collapsed, otherWidth, onResize, onCollapsedChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [view, setView] = useState<DragView | null>(null);

  const dragVar = side === "start" ? "--sidebar-drag-width" : "--queue-drag-width";
  const shown = collapsed ? limits.rail : clampPaneWidth(width, limits);
  const grow = side === "start" ? "ArrowRight" : "ArrowLeft";
  const shrink = side === "start" ? "ArrowLeft" : "ArrowRight";

  const grid = () => ref.current?.parentElement ?? null;
  const liveLimits = () => effectivePaneLimits(limits, grid()?.clientWidth ?? Infinity, otherWidth);

  function pointerWidth(clientX: number): number {
    // Measured from the window edge the pane is docked to: the grid's own box.
    const box = grid()?.getBoundingClientRect();
    if (!box) return shown;
    return side === "start" ? clientX - box.left : box.right - clientX;
  }

  function setDragWidth(w: number | null) {
    const el = grid();
    if (!el) return;
    if (w === null) el.style.removeProperty(dragVar);
    else el.style.setProperty(dragVar, `${w}px`);
  }

  function finish(commit: boolean) {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.moved) {
      document.body.classList.remove("pane-resizing");
      window.removeEventListener("keydown", onEscape, true);
      setView(null);
      if (commit) {
        const { step } = g;
        if (step.collapsed !== g.startCollapsed) onCollapsedChange(step.collapsed);
        // A pane this drag collapsed reopens at the width it had before it.
        if (!step.collapsed && step.width !== clampPaneWidth(width, limits)) onResize(step.width);
      }
      // Same task as the state update above, so no frame shows the old width.
      setDragWidth(null);
    }
  }

  // Escape drops the drag. One listener identity for the component's life, so
  // add and remove pair up; it dispatches to the latest closure.
  const escapeRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const [onEscape] = useState(() => (e: KeyboardEvent) => escapeRef.current(e));
  useEffect(() => {
    escapeRef.current = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !gesture.current) return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
  });

  // A splitter that unmounts mid-drag (mini mode, fullscreen) leaves nothing behind.
  useEffect(() => () => {
    if (gesture.current?.moved) {
      document.body.classList.remove("pane-resizing");
      window.removeEventListener("keydown", onEscape, true);
      setDragWidth(null);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- unmount-only cleanup

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const l = liveLimits();
    const w = clampPaneWidth(width, l);
    gesture.current = {
      startX: e.clientX, moved: false, startCollapsed: collapsed, limits: l,
      step: { collapsed, width: w, phase: collapsed ? "rest" : "resize", progress: 0 },
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.abs(e.clientX - g.startX) < 3) return;
      g.moved = true;
      document.body.classList.add("pane-resizing");
      window.addEventListener("keydown", onEscape, true);
    }
    const step = stepPaneDrag(pointerWidth(e.clientX), g.step.collapsed, g.step.width, g.limits, g.startCollapsed);
    g.step = step;
    // Only an open pane follows the pointer; a collapse or open is previewed.
    if (!g.startCollapsed) setDragWidth(step.width);
    const rect = e.currentTarget.getBoundingClientRect();
    setView({ ...step, startCollapsed: g.startCollapsed, y: e.clientY - rect.top });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onCollapsedChange(!collapsed);
    } else if (e.key === grow || e.key === shrink) {
      e.preventDefault();
      if (collapsed) {
        if (e.key === grow) onCollapsedChange(false);
        return;
      }
      const l = liveLimits();
      if (e.key === shrink && width <= l.min) {
        onCollapsedChange(true);
        return;
      }
      onResize(clampPaneWidth(width + (e.key === grow ? KEY_STEP : -KEY_STEP), l));
    }
  }

  // ---- what the drag looks like ----
  const phase = view?.phase;
  const armedCollapse = !!view && !view.startCollapsed && view.collapsed;
  const armedOpen = !!view && view.startCollapsed && !view.collapsed;
  const inZone = !armedOpen && (phase === "zone-collapse" || phase === "zone-expand");
  // Where the pane's edge is drawn right now (this splitter sits on it).
  const edgeWidth = view ? (view.startCollapsed ? limits.rail : view.width) : shown;
  const foldLine = view?.startCollapsed ? limits.expandAt : limits.collapseAt;
  const toward = (w: number) => (side === "start" ? w - edgeWidth : edgeWidth - w);
  const showFoldLine = inZone || armedCollapse;
  // Expand preview: a ghost of the pane at the width it would open at.
  const ghostWidth = view?.startCollapsed
    ? (armedOpen ? view.width : clampPaneWidth(Math.max(view.width, limits.rail), limits))
    : 0;
  const showGhost = !!view && view.startCollapsed && phase !== "rest";

  let pill = "";
  if (view) {
    if (armedCollapse) pill = "Release to collapse";
    else if (armedOpen) pill = `Release to open · ${Math.round(view.width)} px`;
    else if (phase === "zone-collapse") pill = "Keep dragging to collapse";
    else if (phase === "zone-expand") pill = "Keep dragging to open";
    else if (phase === "rest") pill = "Collapsed";
    else pill = `${Math.round(view.width)} px`;
  }

  return (
    <div
      ref={ref}
      className={`pane-splitter pane-splitter--${side}${collapsed ? " is-collapsed" : ""}${view ? " active" : ""}${inZone ? " zone" : ""}${armedCollapse || armedOpen ? " armed" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={limits.rail}
      aria-valuemax={limits.max}
      aria-valuenow={shown}
      aria-valuetext={collapsed ? "Collapsed" : `${shown} pixels`}
      tabIndex={0}
      title={collapsed
        ? "Drag to open · double-click to open"
        : "Drag to resize · drag past the edge or double-click to collapse"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => onCollapsedChange(!collapsed)}
      onKeyDown={onKeyDown}
    >
      {/* Everything is positioned from the pane's edge, which the CSS places
          inside the hit area (it leans off the scrolling side). */}
      <span className="pane-splitter-edge" aria-hidden="true">
        {armedCollapse && (
          <span className="pane-splitter-preview" style={{ width: `${edgeWidth}px` }}>
            <span className="pane-splitter-rail" style={{ width: `${limits.rail - 8}px` }} />
          </span>
        )}
        {showGhost && (
          <span className={`pane-splitter-ghost${armedOpen ? " armed" : ""}`} style={{ width: `${Math.max(0, ghostWidth - limits.rail)}px` }}>
            <span>{armedOpen ? `Opens at ${Math.round(view.width)} px` : "Keep dragging"}</span>
          </span>
        )}
        {showFoldLine && (
          <span className="pane-splitter-line" style={{ transform: `translateX(${toward(foldLine)}px)` }} />
        )}
        {view && (
          <span
            className={`pane-splitter-pill${inZone ? " zone" : ""}${armedCollapse ? " armed" : ""}`}
            style={{ top: `${Math.max(8, view.y - 14)}px` }}
          >
            {pill}
            {inZone && <span className="pane-splitter-meter"><i style={{ transform: `scaleX(${view.progress})` }} /></span>}
          </span>
        )}
      </span>
    </div>
  );
}
