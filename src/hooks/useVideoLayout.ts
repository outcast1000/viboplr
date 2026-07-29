import { useEffect, useState } from "react";
import { store } from "../store";

// "queue" is not a side of the main content area — it pins the video to the
// bottom of the queue panel (column 3). It shares the DockSide type because the
// video "Dock position" menu offers it alongside the four main-area sides.
export type DockSide = "top" | "bottom" | "left" | "right" | "queue";
export type FitMode = "contain" | "fit-width" | "fit-height" | "fill";

export interface VideoLayoutState {
  dockSide: DockSide;
  fitMode: FitMode;
  sizes: Record<DockSide, number>;
  isCollapsed: boolean;
}

const DEFAULT_LAYOUT: VideoLayoutState = {
  dockSide: "queue",
  fitMode: "contain",
  sizes: { top: 300, bottom: 300, left: 400, right: 400, queue: 260 },
  isCollapsed: false,
};

const MIN_VIDEO_SIZE = 100;
const MIN_CONTENT_SIZE = 150;
const SPLITTER_SIZE = 6;
// Kept in sync with `.now-playing` height (--now-playing-h in App.css) — the
// queue-placed video is pinned above the now-playing bar.
const NOW_PLAYING_H = 106;
const CAPTION_BAR_H = 40;

export function useVideoLayout(restoredRef: React.RefObject<boolean>) {
  const [dockSide, setDockSideState] = useState<DockSide>(DEFAULT_LAYOUT.dockSide);
  const [fitMode, setFitModeState] = useState<FitMode>(DEFAULT_LAYOUT.fitMode);
  const [sizes, setSizes] = useState<Record<DockSide, number>>(DEFAULT_LAYOUT.sizes);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const isHorizontal = dockSide === "top" || dockSide === "bottom";
  const videoSize = sizes[dockSide];
  const effectiveSize = isCollapsed ? 0 : videoSize;

  // Persist full layout state
  useEffect(() => {
    if (restoredRef.current) {
      store.set("videoLayout", { dockSide, fitMode, sizes, isCollapsed });
    }
  }, [dockSide, fitMode, sizes, isCollapsed]);

  function setDockSide(side: DockSide) {
    setDockSideState(side);
  }

  function setFitMode(mode: FitMode) {
    setFitModeState(mode);
  }

  function setVideoSize(size: number) {
    setSizes(prev => ({ ...prev, [dockSide]: size }));
  }

  function toggleCollapse() {
    setIsCollapsed(prev => !prev);
  }

  function onSplitterMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startPos = isHorizontal ? e.clientY : e.clientX;
    const startSize = videoSize;
    const mainEl = (e.currentTarget as HTMLElement).parentElement;
    if (!mainEl) return;

    const totalSpace = isHorizontal ? mainEl.clientHeight : mainEl.clientWidth;
    const availableSpace = totalSpace - MIN_CONTENT_SIZE - SPLITTER_SIZE;

    function onMouseMove(ev: MouseEvent) {
      const currentPos = isHorizontal ? ev.clientY : ev.clientX;
      const delta = currentPos - startPos;
      // For bottom/right: drag toward video edge = shrink (negative delta for bottom, positive for right)
      // For top/left: drag toward video edge = shrink (positive delta for top, negative for left)
      // Unified: "drag toward content" = grow video
      let newSize: number;
      if (dockSide === "bottom" || dockSide === "right") {
        // For "bottom": mouse going up (negative deltaY) = growing video
        // For "right": mouse going left (negative deltaX) = growing video
        newSize = startSize - delta;
      } else {
        // For "top" (column-reverse): mouse going down (positive deltaY) = growing video
        // For "left" (row-reverse): mouse going right (positive deltaX) = growing video
        newSize = startSize + delta;
      }
      const clamped = Math.min(availableSpace, Math.max(MIN_VIDEO_SIZE, newSize));
      setSizes(prev => ({ ...prev, [dockSide]: clamped }));
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = isHorizontal ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // Resize handle for the queue-placed video. It's pinned to the bottom of the
  // queue column, so dragging DOWN shrinks it (mirror of the "bottom" dock).
  // Bounds are viewport-derived (the fixed overlay has no flex parent to measure).
  function onQueueResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startSize = sizes.queue;
    const maxSize = Math.max(
      MIN_VIDEO_SIZE,
      window.innerHeight - NOW_PLAYING_H - CAPTION_BAR_H - MIN_CONTENT_SIZE,
    );

    function onMouseMove(ev: MouseEvent) {
      const delta = ev.clientY - startY;
      const newSize = startSize - delta;
      const clamped = Math.min(maxSize, Math.max(MIN_VIDEO_SIZE, newSize));
      setSizes(prev => ({ ...prev, queue: clamped }));
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // Restore full layout from store
  function restoreLayout(saved: VideoLayoutState) {
    if (saved.dockSide) setDockSideState(saved.dockSide);
    if (saved.fitMode) setFitModeState(saved.fitMode);
    // Merge over defaults so state saved before a new side existed (e.g. "queue")
    // still gets a size instead of NaN.
    if (saved.sizes) setSizes({ ...DEFAULT_LAYOUT.sizes, ...saved.sizes });
    if (saved.isCollapsed !== undefined) setIsCollapsed(saved.isCollapsed);
  }

  return {
    dockSide,
    setDockSide,
    fitMode,
    setFitMode,
    videoSize,
    setVideoSize,
    sizes,
    isCollapsed,
    toggleCollapse,
    effectiveSize,
    isHorizontal,
    onSplitterMouseDown,
    onQueueResizeMouseDown,
    restoreLayout,
  };
}
