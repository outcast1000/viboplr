import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { decideSwitchAction } from "../utils/profileSwitch";

interface ProfileSwitchDeps {
  /** App restore-complete guard (App.tsx owns it). */
  restoredRef: React.RefObject<boolean>;
  /** Drain the debounced queue/main-playlist write (useQueue.flushNow). */
  flushQueue: () => Promise<void>;
  /** Drain the debounced app-store write (store.save). */
  saveStore: () => Promise<void>;
  /** Transient user feedback for failures. */
  notify: (message: string) => void;
}

/**
 * Orchestrates switching the app into another profile: single-flight guard,
 * blocking overlay state, flush of both debounced writers, then the
 * `switch_profile` relaunch command. Both entry points converge here — the
 * Settings list and the shortcut handoff (`profile-switch-requested` event /
 * pending pull). On success the process exits; on any failure the switch
 * aborts, the error surfaces, and the UI re-enables.
 */
export function useProfileSwitch({ restoredRef, flushQueue, saveStore, notify }: ProfileSwitchDeps) {
  // The profile being switched to (drives the blocking overlay), or null.
  const [switching, setSwitching] = useState<string | null>(null);
  const switchingRef = useRef(false);

  const switchToProfile = useCallback(
    async (name: string, opts?: { allowCreate?: boolean }) => {
      const decision = decideSwitchAction(restoredRef.current === true, switchingRef.current);
      if (decision === "ignore") return;
      switchingRef.current = true;
      setSwitching(name);
      try {
        if (decision === "flush-then-switch") {
          await Promise.all([saveStore(), flushQueue()]);
        }
        await invoke("switch_profile", { name, allowCreate: opts?.allowCreate ?? false });
        // On success the backend exits this process — nothing below runs.
      } catch (e) {
        console.error(`Failed to switch to profile "${name}":`, e);
        notify(`Couldn't switch to profile “${name}”: ${e}`);
        switchingRef.current = false;
        setSwitching(null);
      }
    },
    [restoredRef, flushQueue, saveStore, notify]
  );

  return { switching, switchToProfile };
}
