// Interface-zoom state: two independent preset factors — `uiZoom` (full window)
// and `miniZoom` (mini player) — each persisted to the app store. This hook owns
// only state/refs/persistence; it never calls setZoom itself.
//
// Application is orchestrated elsewhere so the side effect happens at the right
// moment without a flash or double-apply:
//   - useMiniMode applies the correct factor inside its window transitions (while
//     the window is hidden) and scales the mini-window geometry by `miniZoomRef`.
//   - App.tsx applies the saved factor once on startup restore (via `hydrate`),
//     and applies live changes from Settings / the Cmd-+/- hotkeys for full mode.
// The refs are the synchronous channel those consumers read (mirrors the
// ref-based pattern used across the queue/playback hooks).
import { useState, useRef, useCallback } from "react";
import { store } from "../store";
import { clampZoomToPreset } from "../utils/zoom";

export function useUiZoom() {
  const [uiZoom, setUiZoomState] = useState(1);
  const uiZoomRef = useRef(1);
  const [miniZoom, setMiniZoomState] = useState(1);
  const miniZoomRef = useRef(1);

  const setUiZoom = useCallback((value: number) => {
    const v = clampZoomToPreset(value);
    uiZoomRef.current = v;
    setUiZoomState(v);
    store.set("uiZoom", v).catch(e => console.error("Failed to persist uiZoom:", e));
  }, []);

  const setMiniZoom = useCallback((value: number) => {
    const v = clampZoomToPreset(value);
    miniZoomRef.current = v;
    setMiniZoomState(v);
    store.set("miniZoom", v).catch(e => console.error("Failed to persist miniZoom:", e));
  }, []);

  // Seed from persisted values on startup without re-persisting. Called by
  // App.tsx's restore effect, which already batch-reads these from the store.
  const hydrate = useCallback((ui: number | null | undefined, mini: number | null | undefined) => {
    if (typeof ui === "number") {
      const v = clampZoomToPreset(ui);
      uiZoomRef.current = v;
      setUiZoomState(v);
    }
    if (typeof mini === "number") {
      const v = clampZoomToPreset(mini);
      miniZoomRef.current = v;
      setMiniZoomState(v);
    }
  }, []);

  return { uiZoom, miniZoom, uiZoomRef, miniZoomRef, setUiZoom, setMiniZoom, hydrate };
}
