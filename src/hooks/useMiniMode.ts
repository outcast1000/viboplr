import { useState, useCallback, useRef, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { store } from "../store";
import type { Track } from "../types";

const MINI_HEIGHT = 40;
const MINI_MIN_WIDTH = 280;
const MINI_MAX_WIDTH = 550;
const MINI_INITIAL_WIDTH = 500;
const FULL_MIN_WIDTH = 300;
const FULL_MIN_HEIGHT = 400;
const isMac = navigator.platform.includes("Mac");

function measureMiniFooter(): number {
  const footer = document.querySelector(".now-playing-mini") as HTMLElement;
  if (!footer) return MINI_INITIAL_WIDTH;
  const clone = footer.cloneNode(true) as HTMLElement;
  clone.style.cssText = "position:fixed;top:-9999px;left:-9999px;visibility:hidden;width:max-content;pointer-events:none;";
  document.body.appendChild(clone);
  const width = clone.offsetWidth;
  document.body.removeChild(clone);
  return Math.max(MINI_MIN_WIDTH, Math.min(width + 16, MINI_MAX_WIDTH));
}

export function useMiniMode(restoredRef: React.RefObject<boolean>, currentTrack: Track | null) {
  const [miniMode, setMiniMode] = useState(false);
  const miniModeRef = useRef(false);
  const fullSizeRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);

  const toggleMiniMode = useCallback(async () => {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    if (!miniModeRef.current) {
      // Entering mini mode — save current full geometry
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
      // Restore saved mini position if available
      const [mx, my] = await Promise.all([
        store.get<number | null>("miniWindowX"),
        store.get<number | null>("miniWindowY"),
      ]);
      if (mx != null && my != null) {
        await win.setPosition(new LogicalPosition(mx, my));
      }
      await win.setAlwaysOnTop(true);
      await win.setDecorations(false);
      setMiniMode(true);
      miniModeRef.current = true;
      store.set("miniMode", true);
    } else {
      // Exiting mini mode — save mini position, then restore full geometry
      const pos = await win.outerPosition();
      store.set("miniWindowX", pos.x / factor);
      store.set("miniWindowY", pos.y / factor);
      if (isMac) await win.setDecorations(true);
      await win.setAlwaysOnTop(false);
      await win.setMinSize(new LogicalSize(FULL_MIN_WIDTH, FULL_MIN_HEIGHT));
      const geo = fullSizeRef.current;
      if (geo) {
        await win.setSize(new LogicalSize(geo.w, geo.h));
        await win.setPosition(new LogicalPosition(geo.x, geo.y));
      } else {
        // Fallback: read from store
        const [fw, fh, fx, fy] = await Promise.all([
          store.get<number | null>("fullWindowWidth"),
          store.get<number | null>("fullWindowHeight"),
          store.get<number | null>("fullWindowX"),
          store.get<number | null>("fullWindowY"),
        ]);
        if (fw && fh) await win.setSize(new LogicalSize(fw, fh));
        if (fx != null && fy != null) await win.setPosition(new LogicalPosition(fx, fy));
      }
      setMiniMode(false);
      miniModeRef.current = false;
      store.set("miniMode", false);
    }
  }, []);

  // Auto-resize mini window when track changes or mini mode is entered
  const miniSettledRef = useRef(false);
  useEffect(() => {
    if (!miniMode) { miniSettledRef.current = false; return; }
    const frame = requestAnimationFrame(async () => {
      const win = getCurrentWindow();
      const newWidth = measureMiniFooter();
      if (miniSettledRef.current) {
        // Track changed while in mini mode — pin right edge
        const factor = await win.scaleFactor();
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const rightEdge = pos.x / factor + size.width / factor;
        await win.setSize(new LogicalSize(newWidth, MINI_HEIGHT));
        await win.setPosition(new LogicalPosition(rightEdge - newWidth, pos.y / factor));
      } else {
        // Just entered mini mode — set size only, keep position
        await win.setSize(new LogicalSize(newWidth, MINI_HEIGHT));
        miniSettledRef.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [miniMode, currentTrack]);

  // Save window size and position on resize/move
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout>;
    const save = async () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!restoredRef.current) return;
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
    const unlistenResize = win.onResized(save);
    const unlistenMove = win.onMoved(save);
    return () => {
      clearTimeout(timer);
      unlistenResize.then(f => f());
      unlistenMove.then(f => f());
    };
  }, []);

  return { miniMode, setMiniMode, miniModeRef, fullSizeRef, toggleMiniMode };
}
