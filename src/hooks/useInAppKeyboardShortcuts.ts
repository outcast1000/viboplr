// In-app keyboard shortcuts (window keydown), extracted from App.tsx.
//
// Distinct from useGlobalShortcuts.ts, which registers OS-level media keys via
// Tauri's global-shortcut plugin. This handles the in-window shortcuts documented
// in frontend.md (Space, arrows, Cmd+1/2/K/F/L/P/M, etc.).
//
// All inputs are funneled through a ref that is refreshed every render, so the
// single installed listener never reads stale closures.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isVideoTrack } from "../utils";
import { shouldWakeMiniSearch } from "../utils/miniSearchTrigger";
import type { QueueTrack } from "../types";
import type { useLibrary } from "./useLibrary";
import type { usePlayback } from "./usePlayback";
import type { useQueue } from "./useQueue";
import type { useMiniMode } from "./useMiniMode";

export interface KeyboardShortcutDeps {
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  queueHook: ReturnType<typeof useQueue>;
  mini: ReturnType<typeof useMiniMode>;
  // Volatile playback state read on each keypress.
  volume: number;
  getMediaElement: () => HTMLMediaElement | null;
  handleSeek: (secs: number) => void;
  handlePause: () => void;
  currentTrack: QueueTrack | null;
  // Stable refs / callbacks owned by App.tsx.
  goBack: () => void;
  goForward: () => void;
  pushState: () => void;
  toggleLike: (track: QueueTrack) => void;
  focusSearch: () => void;
  handleNext: () => void;
  handleToggleQueueCollapsed: () => void;
  handleToggleSidebar: () => void;
  // Mini-player quick search.
  miniSearchOpen: boolean;
  openMiniSearch: (initialChar: string) => void;
}

export function useInAppKeyboardShortcuts(deps: KeyboardShortcutDeps) {
  const ref = useRef(deps);
  ref.current = deps;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const d = ref.current;
      const { library, playback, queueHook, mini } = d;
      const isInput = (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA";

      if (
        shouldWakeMiniSearch(e, {
          miniMode: d.mini.miniMode,
          inputFocused: isInput,
          searchOpen: d.miniSearchOpen,
        })
      ) {
        e.preventDefault();
        d.openMiniSearch(e.key);
        return;
      }

      if (e.key === "Escape" && library.selectedTrack !== null) {
        library.setSelectedTrack(null);
        return;
      }
      if (e.key === "Escape" && (library.fallbackArtistName || library.fallbackAlbumName || library.fallbackTrackName)) {
        d.goBack();
        return;
      }

      // F12 or Ctrl+Shift+I: open devtools
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && e.key === "I")) {
        e.preventDefault();
        invoke("open_devtools");
        return;
      }

      // Alt+Arrow: navigation history
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === "ArrowLeft") { e.preventDefault(); d.goBack(); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); d.goForward(); return; }
      }

      // Non-modifier shortcuts (only when not typing in an input)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !isInput) {
        switch (e.key) {
          case " ":
            e.preventDefault();
            d.handlePause();
            return;
          case "ArrowLeft": {
            e.preventDefault();
            const el = d.getMediaElement();
            if (el) d.handleSeek(Math.max(0, el.currentTime - 15));
            return;
          }
          case "ArrowRight": {
            e.preventDefault();
            const el = d.getMediaElement();
            if (el) d.handleSeek(Math.min(el.duration || 0, el.currentTime + 15));
            return;
          }
          case "ArrowUp":
            e.preventDefault();
            playback.handleVolume(Math.min(1, d.volume + 0.05));
            return;
          case "ArrowDown":
            e.preventDefault();
            playback.handleVolume(Math.max(0, d.volume - 0.05));
            return;
          case "/":
            e.preventDefault();
            d.focusSearch();
            return;
        }
      }

      if (!(e.ctrlKey || e.metaKey)) return;

      // Cmd/Ctrl+K: focus central search
      if (e.key === "k") {
        e.preventDefault();
        d.focusSearch();
        return;
      }

      switch (e.key) {
        case "1":
          e.preventDefault();
          d.pushState();
          library.setView("search");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
          break;
        case "2":
          e.preventDefault();
          d.pushState();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          break;
        case "3":
          e.preventDefault();
          d.pushState();
          library.setView("nowplaying");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
          break;
        case "f":
          if (d.currentTrack && isVideoTrack(d.currentTrack)) {
            e.preventDefault();
            playback.toggleFullscreen();
          }
          break;
        case "l":
          e.preventDefault();
          if (d.currentTrack) d.toggleLike(d.currentTrack);
          break;
        case "p":
          e.preventDefault();
          d.handleToggleQueueCollapsed();
          break;
        case "m":
          e.preventDefault();
          playback.toggleMute();
          break;
        case "M":
          e.preventDefault();
          mini.toggleMiniMode();
          break;
        case "ArrowLeft":
          e.preventDefault();
          queueHook.playPrevious();
          break;
        case "ArrowRight":
          e.preventDefault();
          d.handleNext();
          break;
        case "b":
          e.preventDefault();
          d.handleToggleSidebar();
          break;
        case "[":
          e.preventDefault();
          d.goBack();
          break;
        case "]":
          e.preventDefault();
          d.goForward();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
