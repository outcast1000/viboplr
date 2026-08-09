import { useState, useRef, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { subscribe } from "../utils/tauriEvents";

export type UpdateChannel = "stable" | "beta";

export type UpdateStage = "check" | "install";

export interface UpdateError {
  /** Which step failed — decides whether the retry re-checks or re-installs. */
  stage: UpdateStage;
  /** Plain-language sentence shown to the user. */
  message: string;
  /** Raw backend text, for the diagnostic report. Never the primary display. */
  detail: string;
  /** Set for an install failure, so the row can name the version that failed. */
  version?: string;
}

export interface UpdateState {
  available: { version: string; body: string } | null;
  checking: boolean;
  downloading: boolean;
  progress: { downloaded: number; total: number } | null;
  upToDate: boolean;
  /**
   * Last failure, held until the user retries or a later attempt succeeds.
   * A toast auto-dismisses after 4.5s, which is not long enough to notice a
   * background failure — so the error also has to live somewhere still.
   */
  error: UpdateError | null;
}

interface AppUpdateMeta {
  version: string;
  body: string | null;
}

/** What the sidebar's Settings dot is reporting, if anything. */
export type UpdateBadge = "available" | "error";

/**
 * Which dot the Settings nav button should show. `error` outranks `available`
 * because a failure is the more actionable of the two — and the update is
 * still available behind it, reachable from the same panel either way.
 *
 * Without this, a failed background check has no presence anywhere outside
 * Settings, which is the one place a user who doesn't know it failed has no
 * reason to open.
 */
export function updateBadgeFor(state: UpdateState): UpdateBadge | null {
  if (state.error) return "error";
  if (state.available) return "available";
  return null;
}

/** Backend errors come back as strings (Rust `Result<_, String>`); keep them short for a toast. */
function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/**
 * Turn an updater error into something a user can act on. The raw text is a
 * transport detail ("Download request failed with status: 503") that reads as
 * an app bug; every branch here names the real situation instead. The raw text
 * is kept as `detail` for the diagnostic report.
 */
export function humanizeUpdateError(raw: string, stage: UpdateStage): string {
  const s = raw.toLowerCase();
  if (/\b(503|502|504)\b/.test(s) || s.includes("service unavailable")) {
    return "GitHub is temporarily unavailable. This usually clears within a few minutes — try again shortly.";
  }
  if (s.includes("429") || s.includes("rate limit")) {
    return "GitHub is rate-limiting this connection. Try again in a few minutes.";
  }
  if (s.includes("signature") || s.includes("minisign")) {
    return "The downloaded update failed its signature check and was not installed. Download it from viboplr.com instead.";
  }
  if (s.includes("dns") || s.includes("resolve") || s.includes("connect") || s.includes("network") || s.includes("timed out") || s.includes("timeout")) {
    return "Couldn't reach the update server. Check your internet connection and try again.";
  }
  if (s.includes("permission") || s.includes("denied") || s.includes("read-only")) {
    return "Viboplr couldn't write the update. Make sure it's in your Applications folder and not running from the disk image.";
  }
  if (s.includes("no pending update")) {
    return "That update is no longer staged. Check for updates again.";
  }
  return stage === "check"
    ? "Couldn't check for updates."
    : "The update couldn't be installed.";
}

/**
 * App self-update state. The check/install flow runs in Rust
 * (`app_update_check` / `app_update_install`) so the update channel can pick
 * its endpoint at runtime: `stable` uses the config-baked
 * `releases/latest/download/…` manifests (prereleases invisible), `beta`
 * discovers the newest release *including* prereleases via the GitHub API —
 * and naturally moves back to stable when a newer stable ships.
 */
export function useAppUpdater(
  channel: UpdateChannel,
  onBeforeInstall?: () => void,
  notify?: (message: string) => void,
) {
  const [appVersion, setAppVersion] = useState("");
  const [updateState, setUpdateState] = useState<UpdateState>({
    available: null,
    checking: false,
    downloading: false,
    progress: null,
    upToDate: false,
    error: null,
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
          setUpdateState(s => ({
            ...s,
            available: { version: update.version, body: update.body ?? "" },
            error: null,
          }));
        }
      } catch (e) {
        // No toast — an unprompted background failure isn't worth interrupting
        // for. But it is recorded, so Settings can show it instead of looking
        // idle, which is what "silently ignore" used to leave behind.
        console.error("Background update check failed:", e);
        const detail = errText(e);
        setUpdateState(s => (s.error ? s : {
          ...s,
          error: { stage: "check", message: humanizeUpdateError(detail, "check"), detail },
        }));
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
    setUpdateState(s => ({ ...s, checking: true, upToDate: false, error: null }));
    try {
      const update = await checkNow();
      if (update) {
        setUpdateState(s => ({ ...s, checking: false, available: { version: update.version, body: update.body ?? "" } }));
      } else {
        setUpdateState(s => ({ ...s, checking: false, available: null, upToDate: true }));
        setTimeout(() => setUpdateState(s => ({ ...s, upToDate: false })), 5000);
      }
    } catch (e) {
      // A failed check must NOT read as "Up to date" — surface the real reason.
      console.error("Update check failed:", e);
      const detail = errText(e);
      const message = humanizeUpdateError(detail, "check");
      setUpdateState(s => ({
        ...s,
        checking: false,
        upToDate: false,
        error: { stage: "check", message, detail },
      }));
      notify?.(message);
    }
  }

  async function handleInstallUpdate() {
    if (!updateState.available) return;
    const version = updateState.available.version;
    setUpdateState(s => ({ ...s, downloading: true, progress: null, error: null }));
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
      console.error("Failed to install update:", e);
      const detail = errText(e);
      const message = humanizeUpdateError(detail, "install");
      // `available` is deliberately kept: the backend puts the pending update
      // back on failure, so the Retry button has something to retry.
      setUpdateState(s => ({
        ...s,
        downloading: false,
        progress: null,
        error: { stage: "install", message, detail, version },
      }));
      notify?.(message);
    } finally {
      stopProgress();
    }
  }

  /** Clear the persistent error without retrying (the row's dismiss action). */
  function dismissUpdateError() {
    setUpdateState(s => ({ ...s, error: null }));
  }

  return { appVersion, updateState, handleCheckForUpdates, handleInstallUpdate, dismissUpdateError };
}
