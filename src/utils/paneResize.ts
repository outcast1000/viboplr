// Drag-to-collapse rules shared by the sidebar and the queue splitters
// (`components/PaneSplitter.tsx`). There are no collapse arrows: a pane is
// resized between `min` and `max`, holds at `min` while the pointer goes on
// into the collapse zone, and snaps to its rail once the pointer crosses
// `collapseAt` (live snap — the layout follows during the drag). From the rail,
// dragging outward past `expandAt` opens it again. `expandAt` sits further out
// than `collapseAt`, so hovering at the line can't flip the pane back and forth.
// Pinned by `__tests__/paneResize.test.ts`.

export interface PaneLimits {
  /** Narrowest open width. */
  min: number;
  /** Widest open width. */
  max: number;
  /** Width of the collapsed rail (the grid column). */
  rail: number;
  /** An open pane collapses once the pointer's width drops below this. */
  collapseAt: number;
  /** A collapsed pane opens once the pointer's width rises above this. */
  expandAt: number;
}

export const SIDEBAR_LIMITS: PaneLimits = { min: 160, max: 320, rail: 56, collapseAt: 110, expandAt: 130 };
export const QUEUE_LIMITS: PaneLimits = { min: 200, max: 600, rail: 40, collapseAt: 140, expandAt: 165 };

export const SIDEBAR_WIDTH_DEFAULT = 220;
export const QUEUE_WIDTH_DEFAULT = 300;

/** How the drag reads right now, for the splitter's feedback. */
export type PaneDragPhase =
  /** Plain resize between min and max. */
  | "resize"
  /** Open, past min, short of the collapse line — the pane holds at min. */
  | "zone-collapse"
  /** Collapsed, dragged outward, short of the open line. */
  | "zone-expand"
  /** Collapsed during this drag; releasing keeps it collapsed. */
  | "collapsed"
  /** Collapsed, pointer at the rail — nothing happening. */
  | "rest";

export interface PaneDragStep {
  collapsed: boolean;
  /** Open width to show/persist; unchanged while collapsed. */
  width: number;
  phase: PaneDragPhase;
  /** 0..1 toward the line being approached (zone phases only). */
  progress: number;
}

export const clampPaneWidth = (w: number, l: PaneLimits) => Math.max(l.min, Math.min(l.max, w));

/** The main column keeps at least this much between the side panes (mirrors
 *  `--main-min-width` in App.css). */
export const MAIN_MIN_WIDTH = 360;

/** The pane's limits in a window this wide beside the other pane: its max
 *  shrinks so the main column keeps `MAIN_MIN_WIDTH`, but never below its min. */
export function effectivePaneLimits(l: PaneLimits, gridWidth: number, otherWidth: number): PaneLimits {
  const room = gridWidth - otherWidth - MAIN_MIN_WIDTH;
  return { ...l, max: Math.max(l.min, Math.min(l.max, room)) };
}

/** One pointer move. `pointerWidth` is the distance from the pane's outer
 *  window edge to the pointer; `wasCollapsed` is the state the previous move
 *  left (the hysteresis lives in which line is tested); `startCollapsed` is
 *  the state the gesture began in — a pane this drag collapsed reads "release
 *  to collapse" for the rest of the drag, one that began collapsed reads as
 *  the rail being pulled open. */
export function stepPaneDrag(pointerWidth: number, wasCollapsed: boolean, width: number, l: PaneLimits, startCollapsed = wasCollapsed): PaneDragStep {
  const collapsed = wasCollapsed ? pointerWidth <= l.expandAt : pointerWidth < l.collapseAt;
  if (collapsed) {
    if (!startCollapsed) return { collapsed, width, phase: "collapsed", progress: 1 };
    const out = pointerWidth - l.rail;
    if (out <= 6) return { collapsed, width, phase: "rest", progress: 0 };
    return { collapsed, width, phase: "zone-expand", progress: Math.min(1, out / (l.expandAt - l.rail)) };
  }
  const next = clampPaneWidth(pointerWidth, l);
  if (pointerWidth < l.min) {
    return { collapsed, width: next, phase: "zone-collapse", progress: Math.min(1, (l.min - pointerWidth) / (l.min - l.collapseAt)) };
  }
  return { collapsed, width: next, phase: "resize", progress: 0 };
}

/** Restore for a persisted open width: in range, or the default stands. */
export function restorePaneWidth(l: PaneLimits): (raw: unknown) => number | undefined {
  return (raw) => (typeof raw === "number" && raw >= l.min && raw <= l.max ? raw : undefined);
}
