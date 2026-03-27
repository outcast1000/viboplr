import { useState, useCallback, useRef, useEffect } from "react";
import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { store } from "../store";
import type { Track } from "../types";

const MINI_HEIGHT = 52;
const MINI_MIN_WIDTH = 280;
const MINI_MAX_WIDTH = 550;
const MINI_INITIAL_WIDTH = 500;
const FULL_MIN_WIDTH = 300;
const FULL_MIN_HEIGHT = 400;

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

function measureMiniFooter(): number {
  const footer = document.querySelector(".now-playing-mini") as HTMLElement;
  if (!footer) return MINI_INITIAL_WIDTH;

  // Measure right-side controls (fixed width)
  const rightEl = footer.querySelector(".mini-right") as HTMLElement;
  const rightWidth = rightEl ? rightEl.offsetWidth : 0;

  // Measure art (fixed width)
  const artEl = footer.querySelector(".now-mini-art, .now-mini-art-fallback") as HTMLElement;
  const artWidth = artEl ? artEl.offsetWidth : 0;

  // Measure natural text width (scrollWidth gives unconstrained width)
  const textEl = footer.querySelector(".now-mini-info-text") as HTMLElement;
  const textWidth = textEl ? textEl.scrollWidth : 0;

  // padding (12px * 2) + gaps (8px info gap + 10px footer gap) + some breathing room
  const total = artWidth + textWidth + rightWidth + 24 + 8 + 10 + 8;
  return Math.max(MINI_MIN_WIDTH, Math.min(Math.ceil(total), MINI_MAX_WIDTH));
}

export function useMiniMode(restoredRef: React.RefObject<boolean>, currentTrack: Track | null) {
  const [miniMode, setMiniMode] = useState(false);
  const miniModeRef = useRef(false);
  const fullSizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);

  const toggleMiniMode = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      if (!miniModeRef.current) {
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const geo = { w: size.width / factor, h: size.height / factor, x: pos.x / factor, y: pos.y / factor };
        fullSizeRef.current = geo;
        store.set("fullWindowWidth", geo.w);
        store.set("fullWindowHeight", geo.h);
        store.set("fullWindowX", geo.x);
        store.set("fullWindowY", geo.y);
        await win.setMinSize(new LogicalSize(MINI_MIN_WIDTH, MINI_HEIGHT));
        await win.setSize(new LogicalSize(MINI_INITIAL_WIDTH, MINI_HEIGHT));
        const [mx, my] = await Promise.all([
          store.get<number | null>("miniWindowX"),
          store.get<number | null>("miniWindowY"),
        ]);
        if (mx != null && my != null) {
          const bounds = await getLogicalMonitorBounds();
          if (isPositionOnScreen(mx, my, bounds)) {
            await win.setPosition(new LogicalPosition(mx, my));
          } else if (bounds.length > 0) {
            const clamped = clampToNearestMonitor(mx, my, MINI_INITIAL_WIDTH, MINI_HEIGHT, bounds);
            await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
          }
        }
        await win.setAlwaysOnTop(true);
        await win.setResizable(false);
        setMiniMode(true);
        miniModeRef.current = true;
        store.set("miniMode", true);
      } else {
        const pos = await win.outerPosition();
        store.set("miniWindowX", pos.x / factor);
        store.set("miniWindowY", pos.y / factor);
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
        setMiniMode(false);
        miniModeRef.current = false;
        store.set("miniMode", false);
      }
    } catch (err) {
      console.error("toggleMiniMode failed:", err);
    }
  }, []);

  // Auto-resize mini window when track changes or mini mode is entered
  const miniSettledRef = useRef(false);
  useEffect(() => {
    if (!miniMode) { miniSettledRef.current = false; return; }
    if (!miniSettledRef.current) {
      // Just entered mini mode — delay measurement to let window resize settle (Windows/WebView2)
      const timer = setTimeout(async () => {
        const win = getCurrentWindow();
        const newWidth = measureMiniFooter();
        await win.setSize(new LogicalSize(newWidth, MINI_HEIGHT));
        miniSettledRef.current = true;
      }, 60);
      return () => clearTimeout(timer);
    } else {
      // Track changed while in mini mode — pin right edge
      const frame = requestAnimationFrame(async () => {
        const win = getCurrentWindow();
        const newWidth = measureMiniFooter();
        const factor = await win.scaleFactor();
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const rightEdge = pos.x / factor + size.width / factor;
        await win.setSize(new LogicalSize(newWidth, MINI_HEIGHT));
        await win.setPosition(new LogicalPosition(rightEdge - newWidth, pos.y / factor));
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [miniMode, currentTrack]);

  // Save window size and position on resize/move
  useEffect(() => {
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout>;
    const save = async () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (cancelled || !restoredRef.current) return;
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

  return { miniMode, setMiniMode, miniModeRef, fullSizeRef, toggleMiniMode };
}
