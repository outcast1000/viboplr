import { useEffect, useState } from "react";
import { store } from "../store";

const MIN_VIDEO_HEIGHT = 100;
const MIN_CONTENT_HEIGHT = 150;
const DEFAULT_VIDEO_HEIGHT = 300;
const SPLITTER_HEIGHT = 6;

export function useVideoSplit(restoredRef: React.RefObject<boolean>) {
  const [videoHeight, setVideoHeight] = useState(DEFAULT_VIDEO_HEIGHT);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Persist height
  useEffect(() => {
    if (restoredRef.current) store.set("videoSplitHeight", videoHeight);
  }, [videoHeight]);

  function toggleCollapse() {
    setIsCollapsed(prev => !prev);
  }

  function onSplitterMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = videoHeight;
    const mainEl = (e.currentTarget as HTMLElement).parentElement;
    if (!mainEl) return;

    // Compute available space for video (main height minus content min height and non-resizable elements)
    const contentEl = mainEl.querySelector(".content") as HTMLElement | null;
    const contentMinHeight = contentEl ? Math.max(MIN_CONTENT_HEIGHT, contentEl.scrollHeight > contentEl.clientHeight ? MIN_CONTENT_HEIGHT : MIN_CONTENT_HEIGHT) : MIN_CONTENT_HEIGHT;
    const availableHeight = mainEl.clientHeight - contentMinHeight - SPLITTER_HEIGHT;

    function onMouseMove(ev: MouseEvent) {
      const delta = ev.clientY - startY;
      // Dragging down = smaller video (video is below splitter)
      const clamped = Math.min(availableHeight, Math.max(MIN_VIDEO_HEIGHT, startHeight - delta));
      setVideoHeight(clamped);
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

  return {
    videoHeight,
    setVideoHeight,
    isCollapsed,
    toggleCollapse,
    effectiveHeight: isCollapsed ? 0 : videoHeight,
    onSplitterMouseDown,
  };
}
