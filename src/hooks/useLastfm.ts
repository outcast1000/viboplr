import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface UseLastfmReturn {
  // State
  lastfmConnected: boolean;
  lastfmUsername: string | null;
  lastfmImporting: boolean;
  lastfmImportProgress: { page: number; total_pages: number; imported: number; skipped: number } | null;
  lastfmImportResult: { imported: number; skipped: number } | null;
  lastfmAutoImportEnabled: boolean;
  lastfmAutoImportIntervalMins: number;
  lastfmLastImportAt: number | null;

  // Handlers
  handleLastfmConnect: () => Promise<void>;
  handleLastfmDisconnect: () => Promise<void>;
  handleLastfmImportHistory: () => void;
  handleLastfmCancelImport: () => void;
  handleLastfmAutoImportToggle: (enabled: boolean) => Promise<void>;
  handleLastfmAutoImportIntervalChange: (mins: number) => Promise<void>;

  // Setters for restore
  setLastfmConnected: (value: boolean) => void;
  setLastfmUsername: (value: string | null) => void;
  setLastfmAutoImportEnabled: (value: boolean) => void;
  setLastfmAutoImportIntervalMins: (value: number) => void;
  setLastfmLastImportAt: (value: number | null) => void;
  setLastfmImportResult: (value: { imported: number; skipped: number } | null) => void;
}

export function useLastfm(
  store: { set: (key: string, value: any) => Promise<void> },
  addLog: (msg: string) => void,
  historyRef: React.RefObject<{ reload: () => void } | null>,
): UseLastfmReturn {
  const [lastfmConnected, setLastfmConnected] = useState(false);
  const [lastfmUsername, setLastfmUsername] = useState<string | null>(null);
  const [lastfmImporting, setLastfmImporting] = useState(false);
  const [lastfmImportProgress, setLastfmImportProgress] = useState<{ page: number; total_pages: number; imported: number; skipped: number } | null>(null);
  const [lastfmImportResult, setLastfmImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [lastfmAutoImportEnabled, setLastfmAutoImportEnabled] = useState(false);
  const [lastfmAutoImportIntervalMins, setLastfmAutoImportIntervalMins] = useState(60);
  const [lastfmLastImportAt, setLastfmLastImportAt] = useState<number | null>(null);

  useEffect(() => {
    const unlisten = listen("lastfm-auth-error", async () => {
      setLastfmConnected(false);
      setLastfmUsername(null);
      await store.set("lastfmSessionKey", null);
      await store.set("lastfmUsername", null);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    const u1 = listen<{ page: number; total_pages: number; imported: number; skipped: number; source: string }>("lastfm-import-progress", (e) => {
      if (e.payload.source === "manual") {
        setLastfmImportProgress(e.payload);
      }
    });
    const u2 = listen<{ imported: number; skipped: number; timestamp: number; source: string }>("lastfm-import-complete", (e) => {
      if (e.payload.source === "manual") {
        setLastfmImporting(false);
        setLastfmImportProgress(null);
        setLastfmImportResult(e.payload);
      }
      // Both manual and auto update the last import timestamp
      setLastfmLastImportAt(e.payload.timestamp);
      store.set("lastfmLastImportAt", e.payload.timestamp);
      addLog(`Last.fm import complete (${e.payload.source}): ${e.payload.imported} imported, ${e.payload.skipped} skipped`);
      historyRef.current?.reload();
    });
    const u3 = listen<{ message: string; source: string } | string>("lastfm-import-error", (e) => {
      const payload = typeof e.payload === "string" ? { message: e.payload, source: "manual" } : e.payload;
      if (payload.source === "manual") {
        setLastfmImporting(false);
        setLastfmImportProgress(null);
        if (payload.message !== "cancelled") {
          addLog(`Last.fm import error: ${payload.message}`);
        }
        historyRef.current?.reload();
      } else {
        addLog(`Last.fm auto-import error: ${payload.message}`);
      }
    });
    return () => { u1.then(f => f()); u2.then(f => f()); u3.then(f => f()); };
  }, []);

  async function handleLastfmConnect() {
    try {
      const url = await invoke<string>("lastfm_get_auth_url");
      await openUrl(url);
    } catch (e) {
      console.error("Failed to get Last.fm auth URL:", e);
    }
  }

  async function handleLastfmDisconnect() {
    invoke("lastfm_stop_auto_import").catch(console.error);
    await invoke("lastfm_disconnect").catch(console.error);
    setLastfmConnected(false);
    setLastfmUsername(null);
    setLastfmAutoImportEnabled(false);
    await store.set("lastfmSessionKey", null);
    await store.set("lastfmUsername", null);
    await store.set("lastfmAutoImportEnabled", false);
  }

  function handleLastfmImportHistory() {
    setLastfmImporting(true);
    setLastfmImportProgress(null);
    setLastfmImportResult(null);
    invoke("lastfm_import_history", { lastImportAt: lastfmLastImportAt }).catch((e) => {
      setLastfmImporting(false);
      addLog(`Last.fm import failed: ${e}`);
    });
  }

  function handleLastfmCancelImport() {
    invoke("lastfm_cancel_import").catch(console.error);
  }

  async function handleLastfmAutoImportToggle(enabled: boolean) {
    setLastfmAutoImportEnabled(enabled);
    await store.set("lastfmAutoImportEnabled", enabled);
    if (enabled) {
      invoke("lastfm_start_auto_import", {
        intervalMins: lastfmAutoImportIntervalMins,
        lastImportAt: lastfmLastImportAt ?? null,
      }).catch(console.error);
    } else {
      invoke("lastfm_stop_auto_import").catch(console.error);
    }
  }

  async function handleLastfmAutoImportIntervalChange(mins: number) {
    setLastfmAutoImportIntervalMins(mins);
    await store.set("lastfmAutoImportIntervalMins", mins);
    invoke("lastfm_set_auto_import_interval", { intervalMins: mins }).catch(console.error);
  }

  return {
    lastfmConnected,
    lastfmUsername,
    lastfmImporting,
    lastfmImportProgress,
    lastfmImportResult,
    lastfmAutoImportEnabled,
    lastfmAutoImportIntervalMins,
    lastfmLastImportAt,
    handleLastfmConnect,
    handleLastfmDisconnect,
    handleLastfmImportHistory,
    handleLastfmCancelImport,
    handleLastfmAutoImportToggle,
    handleLastfmAutoImportIntervalChange,
    setLastfmConnected,
    setLastfmUsername,
    setLastfmAutoImportEnabled,
    setLastfmAutoImportIntervalMins,
    setLastfmLastImportAt,
    setLastfmImportResult,
  };
}
