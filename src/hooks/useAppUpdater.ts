import { useState, useRef, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateState {
  available: { version: string; body: string } | null;
  checking: boolean;
  downloading: boolean;
  progress: { downloaded: number; total: number } | null;
  upToDate: boolean;
}

export function useAppUpdater(addLog: (msg: string, module?: string) => void) {
  const [appVersion, setAppVersion] = useState("");
  const [updateState, setUpdateState] = useState<UpdateState>({
    available: null,
    checking: false,
    downloading: false,
    progress: null,
    upToDate: false,
  });
  const updateRef = useRef<Awaited<ReturnType<typeof check>>>(null);

  useEffect(() => {
    getVersion().then(setAppVersion);
    const timer = setTimeout(async () => {
      try {
        const update = await check();
        if (update) {
          updateRef.current = update;
          setUpdateState(s => ({ ...s, available: { version: update.version, body: update.body ?? "" } }));
        }
      } catch {
        // Silently ignore — no update endpoint configured or network error
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  async function handleCheckForUpdates() {
    setUpdateState(s => ({ ...s, checking: true, upToDate: false }));
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setUpdateState(s => ({ ...s, checking: false, available: { version: update.version, body: update.body ?? "" } }));
      } else {
        setUpdateState(s => ({ ...s, checking: false, upToDate: true }));
      }
    } catch {
      setUpdateState(s => ({ ...s, checking: false, upToDate: true }));
    }
  }

  async function handleInstallUpdate() {
    const update = updateRef.current;
    if (!update) return;
    setUpdateState(s => ({ ...s, downloading: true, progress: null }));
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          setUpdateState(s => ({ ...s, progress: { downloaded: 0, total: event.data.contentLength! } }));
        } else if (event.event === "Progress") {
          setUpdateState(s => ({
            ...s,
            progress: s.progress
              ? { downloaded: s.progress.downloaded + event.data.chunkLength, total: s.progress.total }
              : null,
          }));
        }
      });
      await relaunch();
    } catch {
      setUpdateState(s => ({ ...s, downloading: false, progress: null }));
      addLog("Failed to install update.", "updater");
    }
  }

  return { appVersion, updateState, handleCheckForUpdates, handleInstallUpdate };
}
