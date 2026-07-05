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
  toggleLike: (track: QueueTrack) => void;
  focusSearch: () => void;
  handleNext: () => void;
  handleToggleQueueCollapsed: () => void;
  handleToggleSidebar: () => void;
  // Interface zoom: +1 larger, -1 smaller (acts on mini player or full window).
  adjustZoom: (dir: 1 | -1) => void;
  // Mini-player quick search.
  miniSearchOpen: boolean;
  openMiniSearch: (initialChar: string) => void;
  // True while a profile switch is in flight — the app is about to relaunch
  // and its state is already flushed, so shortcuts must not mutate anything.
  profileSwitchActive: boolean;
}

export function useInAppKeyboardShortcuts(deps: KeyboardShortcutDeps) {
  const ref = useRef(deps);
  ref.current = deps;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const d = ref.current;
      // The profile-switch overlay blocks pointer events but not this
      // window-level listener; a mutation here would land after the flush
      // and be lost on relaunch.
      if (d.profileSwitchActive) return;
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

      // Non-modifier shortcuts (only when not typing in an input)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !isInput) {
        switch (e.key) {
          case " ":
            e.preventDefault();
            d.handlePause();
            return;
          case "ArrowLeft": {
            e.preventDefault();
            playback.seekBy(-15);
            return;
          }
          case "ArrowRight": {
            e.preventDefault();
            playback.seekBy(15);
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

      // Cmd/Ctrl +/- : step interface zoom. Accept "=" (unshifted +) and "+",
      // and "-"/"_", so the standard browser-zoom keys work regardless of Shift.
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        d.adjustZoom(1);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        d.adjustZoom(-1);
        return;
      }

      switch (e.key) {
        case "1":
          e.preventDefault();
          library.setView("search");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          library.setSelectedTrack(null);
          break;
        case "2":
          e.preventDefault();
          library.setView("history");
          library.setSelectedArtist(null);
          library.setSelectedAlbum(null);
          library.setSelectedTag(null);
          break;
        case "3":
          e.preventDefault();
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
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
