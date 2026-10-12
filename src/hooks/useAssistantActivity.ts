import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { combineUnlisten, subscribe } from "../utils/tauriEvents";
import { applyActivityEvent, type ActivityEntry, type ActivityEvent } from "../utils/assistantActivity";
import type { Notify } from "./useToasts";
import { useLatestRef } from "./useLatestRef";

/**
 * What the assistant is doing, and the user's pause switch.
 *
 * Both halves live in Rust (`assistant_activity.rs`): the control API's
 * middleware emits `assistant-activity` per request and enforces the pause, so
 * this hook only mirrors them for display. The log is memory-only — it is the
 * answer to "what just happened", not a record; the durable trace is the
 * `Assistant change [verb]` lines in the app log.
 *
 * One instance, in App: the pill and Settings → AI control share it.
 */
export function useAssistantActivity(notify: Notify, onOpenLog?: () => void) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [paused, setPausedState] = useState(false);
  // Highest entry id the user has dismissed; failures at or below it stop
  // counting. An id, not a flag, so a newer failure still speaks up.
  const [dismissedBefore, setDismissedBefore] = useState(0);
  const notifyRef = useLatestRef(notify);
  const openLogRef = useLatestRef(onOpenLog);

  useEffect(
    () =>
      combineUnlisten(
        subscribe<ActivityEvent>("assistant-activity", (e) => {
          setEntries((prev) => applyActivityEvent(prev, e.payload));
          // A change that failed is something the user has to deal with, so it
          // is also a notification (it lights the bell if it goes unhandled).
          // Successes and reads never are — the segment and the log say those.
          const ev = e.payload;
          if (ev.phase === "end" && ev.outcome === "failed" && (ev.kind === "write" || ev.kind === "outward")) {
            const what = ev.detail ? `${ev.label} (${ev.detail})` : ev.label;
            notifyRef.current(`${what} failed${ev.error ? `: ${ev.error}` : "."}`, {
              kind: "error",
              source: "Assistant",
              action: openLogRef.current
                ? {
                    label: "Open AI control",
                    run: () => {
                      // Looking at the log is looking at this failure.
                      setDismissedBefore((d) => Math.max(d, ev.id));
                      openLogRef.current?.();
                    },
                  }
                : undefined,
            });
          }
        }),
        subscribe<boolean>("assistant-paused-changed", (e) => setPausedState(e.payload)),
      ),
    // The refs are stable; listing them keeps the subscription installed once.
    [notifyRef, openLogRef],
  );

  useEffect(() => {
    invoke<boolean>("assistant_pause_get")
      .then(setPausedState)
      .catch((e) => console.error("Failed to read the assistant pause state:", e));
  }, []);

  const setPaused = useCallback(
    async (next: boolean) => {
      try {
        await invoke<boolean>("assistant_pause_set", { paused: next });
        setPausedState(next);
      } catch (e) {
        console.error("Failed to change the assistant pause state:", e);
        notify(next ? "Couldn't pause the assistant." : "Couldn't resume the assistant.", { kind: "error" });
      }
    },
    [notify],
  );

  const dismissFailures = useCallback(() => {
    setDismissedBefore(entries.reduce((max, e) => Math.max(max, e.id), 0));
  }, [entries]);

  const clear = useCallback(() => {
    setDismissedBefore(entries.reduce((max, e) => Math.max(max, e.id), 0));
    setEntries([]);
  }, [entries]);

  return { entries, paused, setPaused, dismissedBefore, dismissFailures, clear };
}

export type AssistantActivityState = ReturnType<typeof useAssistantActivity>;
