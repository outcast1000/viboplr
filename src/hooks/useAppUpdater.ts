import { useState, useRef, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { subscribe } from "../utils/tauriEvents";

export type UpdateChannel = "stable" | "beta";

export interface UpdateState {
  available: { version: string; body: string } | null;
  checking: boolean;
  downloading: boolean;
  progress: { downloaded: number; total: number } | null;
  upToDate: boolean;
}

interface AppUpdateMeta {
  version: string;
  body: string | null;
}

/**
 * App self-update state. The check/install flow runs in Rust
 * (`app_update_check` / `app_update_install`) so the update channel can pick
 * its endpoint at runtime: `stable` uses the config-baked
 * `releases/latest/download/…` manifests (prereleases invisible), `beta`
 * discovers the newest release *including* prereleases via the GitHub API —
 * and naturally moves back to stable when a newer stable ships.
 */
export function useAppUpdater(channel: UpdateChannel, onBeforeInstall?: () => void) {
  const [appVersion, setAppVersion] = useState("");
  const [updateState, setUpdateState] = useState<UpdateState>({
    available: null,
    checking: false,
    downloading: false,
    progress: null,
    upToDate: false,
  });
  // The startup/daily timer's closure must see the live channel choice.
  const channelRef = useRef(channel);
  channelRef.current = channel;

  async function checkNow(): Promise<AppUpdateMeta | null> {
    return invoke<AppUpdateMeta | null>("app_update_check", { channel: channelRef.current });
  }

  useEffect(() => {
    getVersion().then(setAppVersion);

    const runCheck = async () => {
      try {
        const update = await checkNow();
        if (update) {
          setUpdateState(s => ({ ...s, available: { version: update.version, body: update.body ?? "" } }));
        }
      } catch {
        // Silently ignore — no update endpoint configured or network error
      }
    };

    // First check 30s after startup (don't compete with startup work), then
    // daily — matching the plugin/skin and dependency update schedules.
    let interval: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => {
      runCheck();
      interval = setInterval(runCheck, 24 * 60 * 60 * 1000);
    }, 30_000);
    return () => {
      clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }, []);

  async function handleCheckForUpdates() {
    setUpdateState(s => ({ ...s, checking: true, upToDate: false }));
    try {
      const update = await checkNow();
      if (update) {
        setUpdateState(s => ({ ...s, checking: false, available: { version: update.version, body: update.body ?? "" } }));
      } else {
        setUpdateState(s => ({ ...s, checking: false, available: null, upToDate: true }));
        setTimeout(() => setUpdateState(s => ({ ...s, upToDate: false })), 5000);
      }
    } catch (e) {
      console.error("Update check failed:", e);
      setUpdateState(s => ({ ...s, checking: false, upToDate: true }));
      setTimeout(() => setUpdateState(s => ({ ...s, upToDate: false })), 5000);
    }
  }

  async function handleInstallUpdate() {
    if (!updateState.available) return;
    setUpdateState(s => ({ ...s, downloading: true, progress: null }));
    const stopProgress = subscribe<{ downloaded: number; total: number | null }>(
      "app-update-progress",
      ({ payload }) => {
        setUpdateState(s => ({
          ...s,
          progress: { downloaded: payload.downloaded, total: payload.total ?? 0 },
        }));
      },
    );
    try {
      onBeforeInstall?.();
      await new Promise((r) => setTimeout(r, 300));
      await invoke("app_update_install");
      await relaunch();
    } catch (e) {
      setUpdateState(s => ({ ...s, downloading: false, progress: null }));
      console.error("Failed to install update:", e);
    } finally {
      stopProgress();
    }
  }

  return { appVersion, updateState, handleCheckForUpdates, handleInstallUpdate };
}
