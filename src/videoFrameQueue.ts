export const HOVER_FRAME_INTERVAL_MS = 600;
const EXTRACT_TIMEOUT_MS = 60_000;

export type FrameEntry =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; frames: string[]; timestamps: number[] }
  | { status: "unavailable" };

interface VideoFrameResult {
  status: string;
  paths?: string[];
  timestamps?: number[];
}

export type FrameQueueEvent =
  | { kind: "started" }
  | { kind: "failed"; trackId: number; reason: string }
  | { kind: "finished"; extracted: number; failed: number };

type InvokeFn = (cmd: string, args: unknown) => Promise<unknown>;
type ConvertFn = (path: string) => string;
type Unsubscribe = () => void;
type Listener = () => void;
type EventCallback = (event: FrameQueueEvent) => void;

const IDLE: FrameEntry = { status: "idle" };

/**
 * FIFO queue (concurrency 1) that performs cache checks synchronously on enqueue
 * and queues `extract_video_frames` invokes on cache miss. Framework-agnostic.
 */
export class VideoFrameQueue {
  private entries = new Map<number, FrameEntry>();
  private pending: number[] = [];
  private cancelled = new Set<number>();
  private processing = false;
  private listeners = new Set<Listener>();
  private inflightPromise: Promise<void> = Promise.resolve();
  private eventCb: EventCallback | null = null;
  private batchExtracted = 0;
  private batchFailed = 0;

  constructor(private invoke: InvokeFn, private convertFileSrc: ConvertFn) {}

  onEvent(cb: EventCallback | null): void {
    this.eventCb = cb;
  }

  getEntry(trackId: number): FrameEntry {
    return this.entries.get(trackId) ?? IDLE;
  }

  subscribe(listener: Listener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Await until all queued work has settled. Test helper. */
  async drain(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    while (this.processing || this.pending.length > 0) {
      await this.inflightPromise;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  enqueue(trackId: number): void {
    const current = this.entries.get(trackId);
    if (current && current.status !== "idle") return;
    this.setEntry(trackId, { status: "loading" });
    this.cancelled.delete(trackId);
    void this.checkCache(trackId);
  }

  cancel(trackId: number): void {
    const current = this.entries.get(trackId);
    if (!current || current.status !== "loading") return;
    this.pending = this.pending.filter((id) => id !== trackId);
    this.cancelled.add(trackId);
  }

  evict(trackId: number): void {
    this.entries.delete(trackId);
    this.pending = this.pending.filter((id) => id !== trackId);
    this.cancelled.delete(trackId);
    this.notify();
  }

  private setEntry(trackId: number, entry: FrameEntry) {
    this.entries.set(trackId, entry);
    this.notify();
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  private toReady(res: VideoFrameResult): FrameEntry {
    if (res.status === "ok" && res.paths) {
      return {
        status: "ready",
        frames: res.paths.map((p) => this.convertFileSrc(p)),
        timestamps: res.timestamps ?? [],
      };
    }
    return { status: "unavailable" };
  }

  private async checkCache(trackId: number): Promise<void> {
    try {
      const cached = (await this.invoke("get_video_frames", { trackId })) as VideoFrameResult | null;
      if (cached && cached.status === "ok" && cached.paths) {
        this.setEntry(trackId, this.toReady(cached));
        return;
      }
    } catch (e) {
      console.error("Failed to check video frame cache:", e);
      this.setEntry(trackId, { status: "unavailable" });
      return;
    }
    this.pending.push(trackId);
    this.pump();
  }

  private pump(): void {
    if (this.processing) return;
    const next = this.pending.shift();
    if (next === undefined) {
      if (this.batchExtracted + this.batchFailed > 0) {
        this.eventCb?.({ kind: "finished", extracted: this.batchExtracted, failed: this.batchFailed });
        this.batchExtracted = 0;
        this.batchFailed = 0;
      }
      return;
    }
    if (this.cancelled.has(next)) {
      this.cancelled.delete(next);
      this.setEntry(next, { status: "idle" });
      this.pump();
      return;
    }
    if (!this.processing && this.batchExtracted === 0 && this.batchFailed === 0) {
      this.eventCb?.({ kind: "started" });
    }
    this.processing = true;
    this.inflightPromise = this.extract(next).finally(() => {
      this.processing = false;
      this.pump();
    });
  }

  private async extract(trackId: number): Promise<void> {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("extraction timed out")), EXTRACT_TIMEOUT_MS)
      );
      const res = (await Promise.race([
        this.invoke("extract_video_frames", { trackId }),
        timeout,
      ])) as VideoFrameResult;
      const entry = this.toReady(res);
      this.setEntry(trackId, entry);
      if (entry.status === "ready") {
        this.batchExtracted++;
      } else {
        this.batchFailed++;
        this.eventCb?.({ kind: "failed", trackId, reason: "ffmpeg unavailable" });
      }
    } catch (e) {
      console.error("Failed to extract video frames:", e);
      this.batchFailed++;
      const reason = e instanceof Error ? e.message : String(e);
      this.eventCb?.({ kind: "failed", trackId, reason });
      this.setEntry(trackId, { status: "unavailable" });
    }
  }
}
