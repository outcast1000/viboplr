import { useState, useCallback, useRef, useEffect } from "react";
import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { subscribe } from "../utils/tauriEvents";
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store";
import { applyWebviewZoom } from "../utils/zoom";

const MINI_NORMAL_HEIGHT = 52;
const MINI_COMPACT_HEIGHT = 24;
const MINI_EXTRA_ROW_HEIGHT = 54;
const MINI_EXPANDED_HEIGHT = MINI_NORMAL_HEIGHT + MINI_EXTRA_ROW_HEIGHT;
const MINI_MIN_WIDTH = 280;
const FULL_MIN_WIDTH = 300;
const FULL_MIN_HEIGHT = 400;
const MINI_HOVER_EXPAND_DELAY = 500;
const MINI_HOVER_COLLAPSE_DELAY = 300;
const MINI_SEARCH_PANEL_HEIGHT = 260;

export type MiniWidthSize = "small" | "medium" | "large";

const MINI_WIDTHS: Record<MiniWidthSize, number> = {
  small: 280,
  medium: 400,
  large: 550,
};

type MonitorRect = { x: number; y: number; w: number; h: number };

export function isPositionOnScreen(x: number, y: number, monitors: MonitorRect[]): boolean {
  if (monitors.length === 0) return true;
  return monitors.some(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
}

export function clampToNearestMonitor(
  x: number, y: number, winW: number, winH: number, monitors: MonitorRect[],
): { x: number; y: number } {
  if (monitors.length === 0) return { x, y };
  let best = monitors[0];
  let bestDist = Infinity;
  for (const m of monitors) {
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return {
    x: Math.max(best.x, Math.min(x, best.x + best.w - winW)),
    y: Math.max(best.y, Math.min(y, best.y + best.h - winH)),
  };
}

export interface SearchPanelGeometryInput {
  logicalY: number;       // current window top, logical px
  restingHeight: number;  // 52 (normal) or 24 (compact)
  monitor: MonitorRect | null;
}

export interface SearchPanelGeometry {
  height: number;
  direction: "down" | "up";
  newY: number;           // window top after resize
}

// Decide the search-panel window geometry: prefer growing down; if the panel
// would overflow the bottom of the monitor, grow up and shift the top edge.
// `panelHeight` defaults to the unscaled constant; callers pass a zoom-scaled
// height when the mini player runs at a non-1 zoom factor.
export function searchPanelGeometry(
  input: SearchPanelGeometryInput,
  panelHeight: number = MINI_SEARCH_PANEL_HEIGHT,
): SearchPanelGeometry {
  const height = panelHeight;
  const extra = height - input.restingHeight;
  const spaceBelow = input.monitor
    ? (input.monitor.y + input.monitor.h) - (input.logicalY + input.restingHeight)
    : Infinity;
  if (spaceBelow >= extra) {
    return { height, direction: "down", newY: input.logicalY };
  }
  return { height, direction: "up", newY: input.logicalY - extra };
}

async function getLogicalMonitorBounds(): Promise<MonitorRect[]> {
  try {
    const monitors = await availableMonitors();
    return monitors.map(m => {
      const sf = m.scaleFactor;
      return {
        x: m.position.x / sf,
        y: m.position.y / sf,
        w: m.size.width / sf,
        h: m.size.height / sf,
      };
    });
  } catch {
    return [];
  }
}

export type MiniRestingSize = "normal" | "compact";

export function cycleRestingSize(current: MiniRestingSize): MiniRestingSize {
  return current === "normal" ? "compact" : "normal";
}

export function cycleMiniWidth(current: MiniWidthSize): MiniWidthSize {
  return current === "small" ? "medium" : current === "medium" ? "large" : "small";
}

interface HoverControllerOptions {
  expandDelayMs: number;
  collapseDelayMs: number;
  onExpand: () => void;
  onCollapse: () => void;
  isExpanded: () => boolean;
}

export interface HoverController {
  handleEnter: () => void;
  handleLeave: () => void;
  cancel: () => void;
}

export function makeHoverController(opts: HoverControllerOptions): HoverController {
  let expandTimer: ReturnType<typeof setTimeout> | null = null;
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;

  const clearExpand = () => {
    if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
  };
  const clearCollapse = () => {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  };

  return {
    handleEnter() {
      clearCollapse();
      if (opts.isExpanded()) return;
      clearExpand();
      expandTimer = setTimeout(() => {
        expandTimer = null;
        opts.onExpand();
      }, opts.expandDelayMs);
    },
    handleLeave() {
      clearExpand();
      if (!opts.isExpanded()) return;
      clearCollapse();
      collapseTimer = setTimeout(() => {
        collapseTimer = null;
        opts.onCollapse();
      }, opts.collapseDelayMs);
    },
    cancel() {
      clearExpand();
      clearCollapse();
    },
  };
}

export function useMiniMode(
  restoredRef: React.RefObject<boolean>,
  uiZoomRef: React.RefObject<number>,
  miniZoomRef: React.RefObject<number>,
) {
  const [miniMode, setMiniMode] = useState(false);
  const miniModeRef = useRef(false);
  const fullSizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const [miniExpanded, setMiniExpanded] = useState(false);
  const miniExpandedRef = useRef(false);
  useEffect(() => { miniExpandedRef.current = miniExpanded; }, [miniExpanded]);
  const [miniRestingSize, setMiniRestingSizeState] = useState<MiniRestingSize>("normal");
  const miniRestingSizeRef = useRef<MiniRestingSize>("normal");
  useEffect(() => { miniRestingSizeRef.current = miniRestingSize; }, [miniRestingSize]);
  const [miniWidthSize, setMiniWidthSizeState] = useState<MiniWidthSize>("medium");
  const miniWidthSizeRef = useRef<MiniWidthSize>("medium");
  useEffect(() => { miniWidthSizeRef.current = miniWidthSize; }, [miniWidthSize]);

  // The mini player is the same webview, so its zoom factor (`miniZoomRef`)
  // scales the content; to keep that content fitting, every mini-window
  // dimension is multiplied by the same factor. All geometry below routes
  // through these scaled accessors so the window and the rendered content stay
  // proportional at any zoom. (Default zoom 1 → unchanged dimensions.)
  const sz = useCallback((px: number) => Math.round(px * (miniZoomRef.current ?? 1)), [miniZoomRef]);
  const expandedH = useCallback(() => sz(MINI_EXPANDED_HEIGHT), [sz]);
  const searchH = useCallback(() => sz(MINI_SEARCH_PANEL_HEIGHT), [sz]);
  const minW = useCallback(() => sz(MINI_MIN_WIDTH), [sz]);
  const widthFor = useCallback((s: MiniWidthSize) => sz(MINI_WIDTHS[s]), [sz]);

  // Used in Task 3 for expand/collapse paths
  const currentRestingHeight = useCallback(
    () => sz(miniRestingSizeRef.current === "compact" ? MINI_COMPACT_HEIGHT : MINI_NORMAL_HEIGHT),
    [sz],
  );

  const expandDirectionRef = useRef<"down" | "up">("down");
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandingRef = useRef(false);
  const searchOpenRef = useRef(false);
  const searchDirectionRef = useRef<"down" | "up">("down");
  // Latest known cursor-over-window state from the Rust cursor tracker. Used to
  // decide whether closing the search panel should land expanded (cursor over)
  // or collapsed to the resting size (cursor away).
  const cursorOverRef = useRef(false);
  // True while the user is dragging the mini window. On Windows `startDragging`
  // enters an OS modal move loop during which the window can't be reliably
  // resized, yet the cursor tracker keeps firing hover events — so hover-expand
  // would flip the layout to the normal/expanded rows inside a still-compact
  // window. We suppress hover expand/collapse for the duration of the drag.
  const draggingRef = useRef(false);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverControllerRef = useRef<HoverController | null>(null);

  const cancelCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  // (Re)arm the timer that ends the drag-suppression window. Called both from
  // the drag mousedown hint (`beginMiniDrag`) and from each user-driven move
  // event, so drag is considered over once the window stops moving.
  const armDragEnd = useCallback((delayMs: number) => {
    if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
    dragEndTimerRef.current = setTimeout(() => {
      dragEndTimerRef.current = null;
      draggingRef.current = false;
    }, delayMs);
  }, []);

  // Hint from the drag mousedown handler that a drag is starting. The
  // authoritative end-of-drag signal is the move stream going quiet (see the
  // save effect below), so this only needs to cover the gap before the first
  // move event and self-heal if a click-hold produces no moves at all.
  const beginMiniDrag = useCallback(() => {
    if (!miniModeRef.current) return;
    draggingRef.current = true;
    cancelCollapseTimer();
    hoverControllerRef.current?.cancel();
    armDragEnd(600);
  }, [cancelCollapseTimer, armDragEnd]);

  const expandMini = useCallback(async () => {
    if (!miniModeRef.current || expandingRef.current || draggingRef.current) return;
    expandingRef.current = true;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const logicalY = pos.y / factor;
      const logicalW = size.width / factor;
      const bounds = await getLogicalMonitorBounds();

      const monitor = bounds.find(m =>
        pos.x / factor >= m.x && pos.x / factor < m.x + m.w &&
        logicalY >= m.y && logicalY < m.y + m.h
      ) || bounds[0];

      const restingHeight = currentRestingHeight();
      const expanded = expandedH();
      const extraHeight = expanded - restingHeight;
      const spaceBelow = monitor
        ? (monitor.y + monitor.h) - (logicalY + restingHeight)
        : Infinity;

      if (spaceBelow >= extraHeight) {
        expandDirectionRef.current = "down";
        await win.setMinSize(new LogicalSize(minW(), expanded));
        await win.setSize(new LogicalSize(logicalW, expanded));
      } else {
        expandDirectionRef.current = "up";
        await win.setMinSize(new LogicalSize(minW(), expanded));
        await win.setPosition(new LogicalPosition(pos.x / factor, logicalY - extraHeight));
        await win.setSize(new LogicalSize(logicalW, expanded));
      }
      setMiniExpanded(true);
    } catch (err) {
      console.error("expandMini failed:", err);
    } finally {
      expandingRef.current = false;
    }
  }, [currentRestingHeight]);

  const collapseMini = useCallback(async () => {
    if (!miniModeRef.current || expandingRef.current || draggingRef.current) return;
    expandingRef.current = true;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const logicalW = size.width / factor;

      const restingHeight = currentRestingHeight();
      const extraHeight = expandedH() - restingHeight;
      await win.setSize(new LogicalSize(logicalW, restingHeight));
      if (expandDirectionRef.current === "up") {
        await win.setPosition(new LogicalPosition(pos.x / factor, pos.y / factor + extraHeight));
      }
      await win.setMinSize(new LogicalSize(minW(), restingHeight));
      setMiniExpanded(false);
    } catch (err) {
      console.error("collapseMini failed:", err);
    } finally {
      expandingRef.current = false;
    }
  }, [currentRestingHeight]);

  const openSearchPanel = useCallback(async () => {
    if (!miniModeRef.current || searchOpenRef.current) return;
    cancelCollapseTimer();
    searchOpenRef.current = true;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const logicalY = pos.y / factor;
      const logicalW = size.width / factor;
      const priorHeight = size.height / factor;
      const bounds = await getLogicalMonitorBounds();
      const monitor = bounds.find(m =>
        pos.x / factor >= m.x && pos.x / factor < m.x + m.w &&
        logicalY >= m.y && logicalY < m.y + m.h
      ) || bounds[0] || null;
      // Anchor the grow decision on the window's CURRENT height, so a search
      // opened from the hover-expanded state grows from there, not the resting size.
      const geo = searchPanelGeometry({ logicalY, restingHeight: priorHeight, monitor }, searchH());
      searchDirectionRef.current = geo.direction;
      await win.setMinSize(new LogicalSize(minW(), geo.height));
      if (geo.direction === "up") {
        await win.setPosition(new LogicalPosition(pos.x / factor, geo.newY));
      }
      await win.setSize(new LogicalSize(logicalW, geo.height));
    } catch (err) {
      console.error("openSearchPanel failed:", err);
    }
  }, [cancelCollapseTimer, currentRestingHeight]);

  const closeSearchPanel = useCallback(async () => {
    if (!miniModeRef.current || !searchOpenRef.current) return;
    searchOpenRef.current = false;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const logicalW = size.width / factor;
      // Restore to whatever the hover state dictates right now: if the cursor is
      // over the window, land on the expanded player; otherwise the resting size.
      const expand = cursorOverRef.current;
      const restoreHeight = expand ? expandedH() : currentRestingHeight();
      const extra = searchH() - restoreHeight;
      await win.setMinSize(new LogicalSize(minW(), restoreHeight));
      if (searchDirectionRef.current === "up") {
        // Search grew upward (bottom edge fixed); shrink back down to it.
        await win.setPosition(new LogicalPosition(pos.x / factor, pos.y / factor + extra));
      }
      await win.setSize(new LogicalSize(logicalW, restoreHeight));
      // Sync the expand state so the rendered layout matches the new height and a
      // subsequent hover-collapse knows which way to shrink.
      expandDirectionRef.current = searchDirectionRef.current;
      setMiniExpanded(expand);
    } catch (err) {
      console.error("closeSearchPanel failed:", err);
    }
  }, [currentRestingHeight]);

  const toggleMiniMode = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      if (!miniModeRef.current) {
        cancelCollapseTimer();
        setMiniExpanded(false);
        const restingHeight = currentRestingHeight();
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const geo = { w: size.width / factor, h: size.height / factor, x: pos.x / factor, y: pos.y / factor };
        fullSizeRef.current = geo;
        store.set("fullWindowWidth", geo.w);
        store.set("fullWindowHeight", geo.h);
        store.set("fullWindowX", geo.x);
        store.set("fullWindowY", geo.y);
        setMiniMode(true);
        miniModeRef.current = true;
        store.set("miniMode", true);
        await win.hide();
        // Apply the mini player's own zoom (independent of the full-window zoom)
        // while hidden, before sizing, so content + window stay proportional.
        await applyWebviewZoom(miniZoomRef.current ?? 1);
        const miniW = widthFor(miniWidthSizeRef.current);
        await win.setMinSize(new LogicalSize(minW(), restingHeight));
        await win.setSize(new LogicalSize(miniW, restingHeight));
        const [mx, my] = await Promise.all([
          store.get<number | null>("miniWindowX"),
          store.get<number | null>("miniWindowY"),
        ]);
        if (mx != null && my != null) {
          const bounds = await getLogicalMonitorBounds();
          if (isPositionOnScreen(mx, my, bounds)) {
            await win.setPosition(new LogicalPosition(mx, my));
          } else if (bounds.length > 0) {
            const clamped = clampToNearestMonitor(mx, my, miniW, restingHeight, bounds);
            await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
          }
        }
        await win.setAlwaysOnTop(true);
        await win.setResizable(false);
        await win.show();
        await win.setFocus();
      } else {
        if (searchOpenRef.current) { searchOpenRef.current = false; }
        cancelCollapseTimer();
        miniModeRef.current = false;
        const pos = await win.outerPosition();
        await store.set("miniWindowX", pos.x / factor);
        await store.set("miniWindowY", pos.y / factor);
        // Re-render to the full-mode layout, then hide the window before resizing
        // so the intermediate setMinSize/setSize/setPosition steps don't play as a
        // visible multi-step resize animation. Mirrors the enter-mini path above.
        setMiniExpanded(false);
        setMiniMode(false);
        store.set("miniMode", false);
        await win.hide();
        // Restore the full-window zoom (the full UI scales content but not the
        // window itself, so no dimension scaling here — just the zoom factor).
        await applyWebviewZoom(uiZoomRef.current ?? 1);
        await win.setAlwaysOnTop(false);
        await win.setResizable(true);
        await win.setMinSize(new LogicalSize(FULL_MIN_WIDTH, FULL_MIN_HEIGHT));
        const geo = fullSizeRef.current;
        const bounds = await getLogicalMonitorBounds();
        if (geo) {
          await win.setSize(new LogicalSize(geo.w, geo.h));
          if (isPositionOnScreen(geo.x, geo.y, bounds)) {
            await win.setPosition(new LogicalPosition(geo.x, geo.y));
          } else if (bounds.length > 0) {
            const clamped = clampToNearestMonitor(geo.x, geo.y, geo.w, geo.h, bounds);
            await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
          }
        } else {
          const [fw, fh, fx, fy] = await Promise.all([
            store.get<number | null>("fullWindowWidth"),
            store.get<number | null>("fullWindowHeight"),
            store.get<number | null>("fullWindowX"),
            store.get<number | null>("fullWindowY"),
          ]);
          if (fw && fh) await win.setSize(new LogicalSize(fw, fh));
          if (fx != null && fy != null) {
            if (isPositionOnScreen(fx, fy, bounds)) {
              await win.setPosition(new LogicalPosition(fx, fy));
            } else if (bounds.length > 0) {
              const clamped = clampToNearestMonitor(fx, fy, fw ?? FULL_MIN_WIDTH, fh ?? FULL_MIN_HEIGHT, bounds);
              await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
            }
          }
        }
        await win.show();
        await win.setFocus();
      }
    } catch (err) {
      console.error("toggleMiniMode failed:", err);
    }
  }, [cancelCollapseTimer, currentRestingHeight]);

  // Save window size and position on resize/move
  useEffect(() => {
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout>;
    const save = async () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (cancelled || !restoredRef.current || expandingRef.current) return;
        const factor = await win.scaleFactor();
        const pos = await win.outerPosition();
        if (miniModeRef.current) {
          store.set("miniWindowX", pos.x / factor);
          store.set("miniWindowY", pos.y / factor);
        } else {
          const size = await win.innerSize();
          store.set("windowWidth", size.width / factor);
          store.set("windowHeight", size.height / factor);
          store.set("windowX", pos.x / factor);
          store.set("windowY", pos.y / factor);
        }
      }, 500);
    };
    // A window move we didn't initiate ourselves means the user is dragging the
    // mini window. Keep hover expand/collapse suppressed and treat the drag as
    // over only once the move stream goes quiet. (Programmatic repositions during
    // expand/collapse set `expandingRef`, so they're excluded.)
    const onUserMove = () => {
      if (!miniModeRef.current || expandingRef.current) return;
      draggingRef.current = true;
      hoverControllerRef.current?.cancel();
      cancelCollapseTimer();
      armDragEnd(250);
    };
    win.onResized(save).then(unlisten => {
      if (cancelled) unlisten();
      else cleanups.push(unlisten);
    });
    win.onMoved(save).then(unlisten => {
      if (cancelled) unlisten();
      else cleanups.push(unlisten);
    });
    win.onMoved(onUserMove).then(unlisten => {
      if (cancelled) unlisten();
      else cleanups.push(unlisten);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (dragEndTimerRef.current) { clearTimeout(dragEndTimerRef.current); dragEndTimerRef.current = null; }
      cleanups.forEach(fn => fn());
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const saved = await store.get<string | null>("miniRestingSize");
        let value = saved;
        if (saved === "ultra") {
          // Old "ultra" (24px) -> new "compact"
          value = "compact";
          await store.set("miniRestingSize", value);
        } else if (saved === "compact") {
          // Ambiguous: could be old "compact" (52px) or new "compact" (24px).
          // Check migration flag to distinguish.
          const migrated = await store.get<boolean>("miniSizeMigrated");
          if (!migrated) {
            value = "normal";
            await store.set("miniRestingSize", value);
            await store.set("miniSizeMigrated", true);
          }
        } else if (saved === "normal") {
          if (!await store.get<boolean>("miniSizeMigrated")) {
            await store.set("miniSizeMigrated", true);
          }
        }
        if (value === "normal" || value === "compact") {
          setMiniRestingSizeState(value);
        }
        const savedWidth = await store.get<MiniWidthSize | null>("miniWidthSize");
        if (savedWidth === "small" || savedWidth === "medium" || savedWidth === "large") {
          setMiniWidthSizeState(savedWidth);
        }
      } catch (err) {
        console.error("Failed to load miniRestingSize:", err);
      }
    })();
  }, []);

  useEffect(() => {
    if (!miniMode) return;
    return subscribe("restore-from-mini", () => {
      if (miniModeRef.current) toggleMiniMode();
    });
  }, [miniMode, toggleMiniMode]);

  useEffect(() => {
    if (!miniMode) {
      invoke("set_cursor_tracker", { active: false }).catch(console.error);
      return;
    }

    invoke("set_cursor_tracker", { active: true }).catch(console.error);

    const controller = makeHoverController({
      expandDelayMs: MINI_HOVER_EXPAND_DELAY,
      collapseDelayMs: MINI_HOVER_COLLAPSE_DELAY,
      onExpand: () => { if (!searchOpenRef.current) expandMini(); },
      onCollapse: () => { if (!searchOpenRef.current) collapseMini(); },
      isExpanded: () => miniExpandedRef.current,
    });
    hoverControllerRef.current = controller;

    const stopEnter = subscribe("mini-cursor-entered", () => { cursorOverRef.current = true; controller.handleEnter(); });
    const stopLeave = subscribe("mini-cursor-left", () => { cursorOverRef.current = false; controller.handleLeave(); });

    return () => {
      controller.cancel();
      hoverControllerRef.current = null;
      invoke("set_cursor_tracker", { active: false }).catch(console.error);
      stopEnter();
      stopLeave();
    };
  }, [miniMode, expandMini, collapseMini]);

  const setMiniRestingSize = useCallback((next: MiniRestingSize) => {
    setMiniRestingSizeState(next);
    store.set("miniRestingSize", next).catch((err: unknown) => {
      console.error("Failed to persist miniRestingSize:", err);
    });
  }, []);

  const setMiniWidthSize = useCallback(async (next: MiniWidthSize) => {
    setMiniWidthSizeState(next);
    store.set("miniWidthSize", next).catch((err: unknown) => {
      console.error("Failed to persist miniWidthSize:", err);
    });
    if (!miniModeRef.current) return;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const newWidth = widthFor(next);
      const currentHeight = miniExpandedRef.current ? expandedH() : currentRestingHeight();
      await win.setSize(new LogicalSize(newWidth, currentHeight));
      const bounds = await getLogicalMonitorBounds();
      const clamped = clampToNearestMonitor(
        pos.x / factor, pos.y / factor, newWidth, currentHeight, bounds,
      );
      if (clamped.x !== pos.x / factor || clamped.y !== pos.y / factor) {
        await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
      }
    } catch (err) {
      console.error("Failed to resize mini window:", err);
    }
  }, [widthFor, expandedH, currentRestingHeight]);

  // Re-apply the mini zoom factor and re-fit the current mini window to the new
  // scaled dimensions. Called by App.tsx when the user changes the mini-player
  // size while it is showing (Settings dropdown or the Cmd-+/- hotkeys). No-op
  // in full mode — the new factor takes effect next time the mini player opens.
  const applyMiniZoom = useCallback(async () => {
    if (!miniModeRef.current) return;
    await applyWebviewZoom(miniZoomRef.current ?? 1);
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const width = widthFor(miniWidthSizeRef.current);
      const height = searchOpenRef.current ? searchH()
        : miniExpandedRef.current ? expandedH()
        : currentRestingHeight();
      await win.setMinSize(new LogicalSize(minW(), height));
      await win.setSize(new LogicalSize(width, height));
      const bounds = await getLogicalMonitorBounds();
      const clamped = clampToNearestMonitor(pos.x / factor, pos.y / factor, width, height, bounds);
      if (clamped.x !== pos.x / factor || clamped.y !== pos.y / factor) {
        await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
      }
    } catch (err) {
      console.error("Failed to apply mini zoom resize:", err);
    }
  }, [widthFor, searchH, expandedH, currentRestingHeight, minW, miniZoomRef]);

  return {
    miniMode, setMiniMode, miniModeRef, fullSizeRef, toggleMiniMode, miniExpanded,
    cancelCollapseTimer, miniRestingSize, setMiniRestingSize,
    miniWidthSize, setMiniWidthSize, applyMiniZoom,
    openSearchPanel, closeSearchPanel, searchOpenRef, beginMiniDrag,
  };
}
