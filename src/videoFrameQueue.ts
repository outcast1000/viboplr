export const HOVER_FRAME_INTERVAL_MS = 600;

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

type InvokeFn = (cmd: string, args: unknown) => Promise<unknown>;
type ConvertFn = (path: string) => string;
type Unsubscribe = () => void;
type Listener = () => void;

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
  // Stable snapshot of ready first-frames keyed by trackId. Rebuilt only when
  // the underlying entries change — `useSyncExternalStore` requires the same
  // reference across calls when nothing changed, otherwise React loops.
  private readyFrameSnapshot: Readonly<Record<number, string>> = Object.freeze({});

  constructor(private invoke: InvokeFn, private convertFileSrc: ConvertFn) {}

  getEntry(trackId: number): FrameEntry {
    return this.entries.get(trackId) ?? IDLE;
  }

  /**
   * Returns a referentially stable map of `trackId -> first ready frame URL`.
   * Same reference is returned across calls until an entry changes. Safe to
   * use as a `useSyncExternalStore` snapshot.
   */
  getReadyFrameSnapshot(): Readonly<Record<number, string>> {
    return this.readyFrameSnapshot;
  }

  private rebuildReadyFrameSnapshot() {
    const next: Record<number, string> = {};
    for (const [id, entry] of this.entries) {
      if (entry.status === "ready" && entry.frames[0]) next[id] = entry.frames[0];
    }
    this.readyFrameSnapshot = Object.freeze(next);
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
    console.debug(`[VideoFrameQueue] enqueue track=${trackId} pending=${this.pending.length} processing=${this.processing}`);
    this.setEntry(trackId, { status: "loading" });
    this.cancelled.delete(trackId);
    void this.checkCache(trackId);
  }

  cancel(trackId: number): void {
    const current = this.entries.get(trackId);
    if (!current || current.status !== "loading") return;
    console.debug(`[VideoFrameQueue] cancel track=${trackId}`);
    this.pending = this.pending.filter((id) => id !== trackId);
    this.cancelled.add(trackId);
    this.setEntry(trackId, IDLE);
  }

  evict(trackId: number): void {
    const had = this.entries.delete(trackId);
    this.pending = this.pending.filter((id) => id !== trackId);
    this.cancelled.delete(trackId);
    if (had) this.rebuildReadyFrameSnapshot();
    this.notify();
  }

  private setEntry(trackId: number, entry: FrameEntry) {
    this.entries.set(trackId, entry);
    this.rebuildReadyFrameSnapshot();
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
        console.debug(`[VideoFrameQueue] cache hit track=${trackId}`);
        this.setEntry(trackId, this.toReady(cached));
        return;
      }
    } catch (e) {
      console.error("Failed to check video frame cache:", e);
      this.setEntry(trackId, { status: "unavailable" });
      return;
    }
    const current = this.entries.get(trackId);
    if (!current || current.status !== "loading") {
      console.debug(`[VideoFrameQueue] cache miss but cancelled before queuing track=${trackId}`);
      return;
    }
    console.debug(`[VideoFrameQueue] cache miss, queuing extraction track=${trackId} pending=${this.pending.length}`);
    this.pending.push(trackId);
    this.pump();
  }

  private pump(): void {
    if (this.processing) return;
    const next = this.pending.shift();
    if (next === undefined) return;
    if (this.cancelled.has(next)) {
      console.debug(`[VideoFrameQueue] skipping cancelled track=${next} pending=${this.pending.length}`);
      this.cancelled.delete(next);
      this.setEntry(next, { status: "idle" });
      this.pump();
      return;
    }
    console.debug(`[VideoFrameQueue] extracting track=${next} pending=${this.pending.length}`);
    this.processing = true;
    this.inflightPromise = this.extract(next).finally(() => {
      this.processing = false;
      this.pump();
    });
  }

  private async extract(trackId: number): Promise<void> {
    try {
      const res = (await this.invoke("extract_video_frames", { trackId })) as VideoFrameResult;
      console.debug(`[VideoFrameQueue] extracted track=${trackId} status=${res.status}`);
      this.setEntry(trackId, this.toReady(res));
    } catch (e) {
      console.error("Failed to extract video frames:", e);
      this.setEntry(trackId, { status: "unavailable" });
    }
  }
}
