import { useState, useCallback, useRef, useEffect } from "react";
import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { store } from "../store";
import type { Track } from "../types";

const MINI_COMPACT_HEIGHT = 52;
const MINI_ULTRA_HEIGHT = 24;
const MINI_EXTRA_ROW_HEIGHT = 54;
const MINI_EXPANDED_HEIGHT = MINI_COMPACT_HEIGHT + MINI_EXTRA_ROW_HEIGHT;
const MINI_MIN_WIDTH = 280;
const FULL_MIN_WIDTH = 300;
const FULL_MIN_HEIGHT = 400;
const MINI_HOVER_EXPAND_DELAY = 500;
const MINI_HOVER_COLLAPSE_DELAY = 300;

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

export type MiniRestingSize = "ultra" | "compact";

export function cycleRestingSize(current: MiniRestingSize): MiniRestingSize {
  return current === "compact" ? "ultra" : "compact";
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

function measureMiniFooter(): number {
  const footer = document.querySelector(".now-playing-mini") as HTMLElement;
  if (!footer) return MINI_INITIAL_WIDTH;

  // Measure right-side controls (fixed width)
  const rightEl = footer.querySelector(".mini-right") as HTMLElement;
  const rightWidth = rightEl ? rightEl.offsetWidth : 0;

  // Measure art (fixed width)
  const artEl = footer.querySelector(".now-mini-art, .now-mini-art-fallback") as HTMLElement;
  const artWidth = artEl ? artEl.offsetWidth : 0;

  // Measure natural text width — must check individual spans since the container clips overflow
  const titleEl = footer.querySelector(".now-title") as HTMLElement;
  const artistEl = footer.querySelector(".now-artist") as HTMLElement;
  const textWidth = Math.max(
    titleEl ? titleEl.scrollWidth : 0,
    artistEl ? artistEl.scrollWidth : 0,
  );

  // padding (12px * 2) + gaps (8px info gap + 10px footer gap) + some breathing room
  const total = artWidth + textWidth + rightWidth + 24 + 8 + 10 + 8;
  return Math.max(MINI_MIN_WIDTH, Math.min(Math.ceil(total), MINI_MAX_WIDTH));
}

export function useMiniMode(restoredRef: React.RefObject<boolean>, currentTrack: Track | null) {
  const [miniMode, setMiniMode] = useState(false);
  const miniModeRef = useRef(false);
  const fullSizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const [miniExpanded, setMiniExpanded] = useState(false);
  const miniExpandedRef = useRef(false);
  useEffect(() => { miniExpandedRef.current = miniExpanded; }, [miniExpanded]);
  const [miniRestingSize, setMiniRestingSizeState] = useState<MiniRestingSize>("compact");
  const miniRestingSizeRef = useRef<MiniRestingSize>("compact");
  useEffect(() => { miniRestingSizeRef.current = miniRestingSize; }, [miniRestingSize]);

  // Used in Task 3 for expand/collapse paths
  const currentRestingHeight = useCallback(
    () => (miniRestingSizeRef.current === "ultra" ? MINI_ULTRA_HEIGHT : MINI_COMPACT_HEIGHT),
    [],
  );

  const expandDirectionRef = useRef<"down" | "up">("down");
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandingRef = useRef(false);

  const cancelCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const expandMini = useCallback(async () => {
    if (!miniModeRef.current || expandingRef.current) return;
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
      const extraHeight = MINI_EXPANDED_HEIGHT - restingHeight;
      const spaceBelow = monitor
        ? (monitor.y + monitor.h) - (logicalY + restingHeight)
        : Infinity;

      if (spaceBelow >= extraHeight) {
        expandDirectionRef.current = "down";
        await win.setMinSize(new LogicalSize(MINI_MIN_WIDTH, MINI_EXPANDED_HEIGHT));
        await win.setSize(new LogicalSize(logicalW, MINI_EXPANDED_HEIGHT));
      } else {
        expandDirectionRef.current = "up";
        await win.setMinSize(new LogicalSize(MINI_MIN_WIDTH, MINI_EXPANDED_HEIGHT));
        await win.setPosition(new LogicalPosition(pos.x / factor, logicalY - extraHeight));
        await win.setSize(new LogicalSize(logicalW, MINI_EXPANDED_HEIGHT));
      }
      setMiniExpanded(true);
    } catch (err) {
      console.error("expandMini failed:", err);
    } finally {
      expandingRef.current = false;
    }
  }, [currentRestingHeight]);

  const collapseMini = useCallback(async () => {
    if (!miniModeRef.current || expandingRef.current) return;
    expandingRef.current = true;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const logicalW = size.width / factor;

      const restingHeight = currentRestingHeight();
      const extraHeight = MINI_EXPANDED_HEIGHT - restingHeight;
      await win.setSize(new LogicalSize(logicalW, restingHeight));
      if (expandDirectionRef.current === "up") {
        await win.setPosition(new LogicalPosition(pos.x / factor, pos.y / factor + extraHeight));
      }
      await win.setMinSize(new LogicalSize(MINI_MIN_WIDTH, restingHeight));
      setMiniExpanded(false);
    } catch (err) {
      console.error("collapseMini failed:", err);
    } finally {
      expandingRef.current = false;
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
        await win.setMinSize(new LogicalSize(MINI_MIN_WIDTH, restingHeight));
        await win.setSize(new LogicalSize(MINI_INITIAL_WIDTH, restingHeight));
        const [mx, my] = await Promise.all([
          store.get<number | null>("miniWindowX"),
          store.get<number | null>("miniWindowY"),
        ]);
        if (mx != null && my != null) {
          const bounds = await getLogicalMonitorBounds();
          if (isPositionOnScreen(mx, my, bounds)) {
            await win.setPosition(new LogicalPosition(mx, my));
          } else if (bounds.length > 0) {
            const clamped = clampToNearestMonitor(mx, my, MINI_INITIAL_WIDTH, restingHeight, bounds);
            await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
          }
        }
        await win.setAlwaysOnTop(true);
        await win.setResizable(false);
        await win.show();
        await win.setFocus();
      } else {
        cancelCollapseTimer();
        miniModeRef.current = false;
        const pos = await win.outerPosition();
        await store.set("miniWindowX", pos.x / factor);
        await store.set("miniWindowY", pos.y / factor);
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
        setMiniExpanded(false);
        setMiniMode(false);
        store.set("miniMode", false);
      }
    } catch (err) {
      console.error("toggleMiniMode failed:", err);
    }
  }, [cancelCollapseTimer, currentRestingHeight]);

  // Auto-resize mini window when track changes or mini mode is entered
  const miniSettledRef = useRef(false);
  useEffect(() => {
    if (!miniMode) { miniSettledRef.current = false; return; }
    if (!miniSettledRef.current) {
      // Just entered mini mode — delay measurement to let window resize settle (Windows/WebView2)
      const timer = setTimeout(async () => {
        if (!miniModeRef.current) return;
        const win = getCurrentWindow();
        const newWidth = measureMiniFooter();
        const currentHeight = miniExpanded ? MINI_EXPANDED_HEIGHT : currentRestingHeight();
        await win.setSize(new LogicalSize(newWidth, currentHeight));
        miniSettledRef.current = true;
      }, 60);
      return () => clearTimeout(timer);
    } else {
      // Track changed while in mini mode — pin right edge
      const frame = requestAnimationFrame(async () => {
        if (!miniModeRef.current) return;
        const win = getCurrentWindow();
        const newWidth = measureMiniFooter();
        const factor = await win.scaleFactor();
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const rightEdge = pos.x / factor + size.width / factor;
        const currentHeight = miniExpanded ? MINI_EXPANDED_HEIGHT : currentRestingHeight();
        await win.setSize(new LogicalSize(newWidth, currentHeight));
        await win.setPosition(new LogicalPosition(rightEdge - newWidth, pos.y / factor));
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [miniMode, currentTrack, miniExpanded, miniRestingSize]);

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
    win.onResized(save).then(unlisten => {
      if (cancelled) unlisten();
      else cleanups.push(unlisten);
    });
    win.onMoved(save).then(unlisten => {
      if (cancelled) unlisten();
      else cleanups.push(unlisten);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanups.forEach(fn => fn());
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const saved = await store.get<MiniRestingSize | null>("miniRestingSize");
        if (saved === "ultra" || saved === "compact") {
          setMiniRestingSizeState(saved);
        }
      } catch (err) {
        console.error("Failed to load miniRestingSize:", err);
      }
    })();
  }, []);

  useEffect(() => {
    if (!miniMode) return;

    const controller = makeHoverController({
      expandDelayMs: MINI_HOVER_EXPAND_DELAY,
      collapseDelayMs: MINI_HOVER_COLLAPSE_DELAY,
      onExpand: () => { expandMini(); },
      onCollapse: () => { collapseMini(); },
      isExpanded: () => miniExpandedRef.current,
    });

    // Expand on mouse over OR on focus gained. Collapse on mouse out OR focus lost.
    // The controller dedupes (handleEnter while expanded is a noop).
    const root = document.documentElement;
    const onEnter = () => controller.handleEnter();
    const onLeave = () => controller.handleLeave();

    root.addEventListener("mouseenter", onEnter);
    root.addEventListener("mouseleave", onLeave);
    window.addEventListener("focus", onEnter);
    window.addEventListener("blur", onLeave);

    if (root.matches(":hover") || document.hasFocus()) {
      controller.handleEnter();
    }

    return () => {
      controller.cancel();
      root.removeEventListener("mouseenter", onEnter);
      root.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("focus", onEnter);
      window.removeEventListener("blur", onLeave);
    };
  }, [miniMode, expandMini, collapseMini]);

  const setMiniRestingSize = useCallback((next: MiniRestingSize) => {
    setMiniRestingSizeState(next);
    store.set("miniRestingSize", next).catch((err: unknown) => {
      console.error("Failed to persist miniRestingSize:", err);
    });
  }, []);

  return {
    miniMode, setMiniMode, miniModeRef, fullSizeRef, toggleMiniMode, miniExpanded,
    cancelCollapseTimer, miniRestingSize, setMiniRestingSize,
  };
}
