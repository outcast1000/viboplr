import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { VideoFrameQueue, type FrameEntry } from "../videoFrameQueue";

interface QueueContextValue {
  queue: VideoFrameQueue;
}

const QueueContext = createContext<QueueContextValue | null>(null);

export function VideoFrameQueueProvider({ children }: { children: React.ReactNode }) {
  const queue = useMemo(
    () => new VideoFrameQueue((cmd, args) => invoke(cmd, args as Record<string, unknown>), convertFileSrc),
    []
  );
  return <QueueContext.Provider value={{ queue }}>{children}</QueueContext.Provider>;
}

export function useVideoFrameQueue() {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error("useVideoFrameQueue must be used within VideoFrameQueueProvider");
  return ctx.queue;
}

/**
 * Subscribe to a single trackId. Re-renders only when that entry changes.
 */
export function useVideoFrameEntry(trackId: number | null): FrameEntry {
  const queue = useVideoFrameQueue();
  const entry = useSyncExternalStore(
    (cb) => queue.subscribe(cb),
    () => (trackId == null ? ({ status: "idle" } as FrameEntry) : queue.getEntry(trackId)),
    () => ({ status: "idle" } as FrameEntry)
  );
  return entry;
}
