import { useEffect, useRef } from "react";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";

interface GlobalShortcutActions {
  togglePlayPause: () => void;
  playNext: () => void;
  playPrevious: () => void;
  stop: () => void;
}

export function useGlobalShortcuts(actions: GlobalShortcutActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    let mounted = true;

    async function registerShortcuts() {
      try {
        await register("MediaPlayPause", () => { if (mounted) actionsRef.current.togglePlayPause(); });
        await register("MediaTrackNext", () => { if (mounted) actionsRef.current.playNext(); });
        await register("MediaTrackPrevious", () => { if (mounted) actionsRef.current.playPrevious(); });
        await register("MediaStop", () => { if (mounted) actionsRef.current.stop(); });
      } catch (e) {
        console.warn("Failed to register global shortcuts:", e);
      }
    }

    registerShortcuts();

    return () => {
      mounted = false;
      unregisterAll().catch(console.warn);
    };
  }, []);
}
