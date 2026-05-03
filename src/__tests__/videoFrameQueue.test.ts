import { describe, it, expect, vi, beforeEach } from "vitest";
import { VideoFrameQueue, HOVER_FRAME_INTERVAL_MS } from "../videoFrameQueue";

describe("HOVER_FRAME_INTERVAL_MS", () => {
  it("is exported as 600", () => {
    expect(HOVER_FRAME_INTERVAL_MS).toBe(600);
  });
});

type InvokeFn = (cmd: string, args: unknown) => Promise<unknown>;

describe("VideoFrameQueue", () => {
  let invokeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock = vi.fn();
  });

  it("transitions directly to ready on cache hit (no extract call)", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return { status: "ok", paths: ["/a.jpg", "/b.jpg"], timestamps: [1, 2] };
      throw new Error("unexpected");
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => `asset://${p}`);
    const notify = vi.fn();
    q.subscribe(notify);
    q.enqueue(1);
    await q.drain();
    const entry = q.getEntry(1);
    expect(entry.status).toBe("ready");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_video_frames", { trackId: 1 });
  });

  it("transitions to loading then ready on cache miss", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return null;
      if (cmd === "extract_video_frames") return { status: "ok", paths: ["/a.jpg"], timestamps: [1] };
      throw new Error("unexpected");
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    await q.drain();
    expect(q.getEntry(1).status).toBe("ready");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_video_frames", { trackId: 1 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "extract_video_frames", { trackId: 1 });
  });

  it("processes multiple enqueues serially, not in parallel", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | null = null;
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "get_video_frames") return null;
      const id = (args as { trackId: number }).trackId;
      order.push(`start:${id}`);
      if (id === 1) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      order.push(`end:${id}`);
      return { status: "ok", paths: [`/f${id}.jpg`], timestamps: [0] };
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    q.enqueue(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:1"]);
    resolveFirst!();
    await q.drain();
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("cancel before job starts prevents extract call", async () => {
    let resolveFirst: (() => void) | null = null;
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "get_video_frames") return null;
      const id = (args as { trackId: number }).trackId;
      if (id === 1) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      return { status: "ok", paths: [`/f${id}.jpg`], timestamps: [0] };
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    q.enqueue(2);
    await new Promise((r) => setTimeout(r, 0));
    q.cancel(2);
    resolveFirst!();
    await q.drain();
    const calls = invokeMock.mock.calls.map((c) => [c[0], (c[1] as { trackId: number }).trackId]);
    expect(calls).toContainEqual(["extract_video_frames", 1]);
    expect(calls).not.toContainEqual(["extract_video_frames", 2]);
  });

  it("cancel during in-flight extraction still completes it", async () => {
    let resolveFirst: (() => void) | null = null;
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "get_video_frames") return null;
      const id = (args as { trackId: number }).trackId;
      if (id === 1 && cmd === "extract_video_frames") {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      return { status: "ok", paths: [`/f${id}.jpg`], timestamps: [0] };
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    await new Promise((r) => setTimeout(r, 0));
    q.cancel(1);
    resolveFirst!();
    await q.drain();
    expect(q.getEntry(1).status).toBe("ready");
  });

  it("enqueue is a no-op on already ready / loading / unavailable entries", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return { status: "ok", paths: ["/a.jpg"], timestamps: [0] };
      throw new Error("unexpected");
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    await q.drain();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    q.enqueue(1);
    q.enqueue(1);
    await q.drain();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("evict removes the entry so next enqueue refetches", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return { status: "ok", paths: ["/a.jpg"], timestamps: [0] };
      throw new Error("unexpected");
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    await q.drain();
    expect(q.getEntry(1).status).toBe("ready");
    q.evict(1);
    expect(q.getEntry(1).status).toBe("idle");
    q.enqueue(1);
    await q.drain();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("extraction rejection marks entry unavailable", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return null;
      throw "ffmpeg crashed";
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    await q.drain();
    expect(q.getEntry(1).status).toBe("unavailable");
  });

  it("extract returning status=unavailable marks entry unavailable", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return null;
      return { status: "unavailable" };
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    q.enqueue(1);
    await q.drain();
    expect(q.getEntry(1).status).toBe("unavailable");
  });

  it("applies convertFileSrc to frame paths", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return { status: "ok", paths: ["/raw.jpg"], timestamps: [0] };
      throw new Error("unexpected");
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => `asset://${p}`);
    q.enqueue(1);
    await q.drain();
    const entry = q.getEntry(1);
    if (entry.status !== "ready") throw new Error("expected ready");
    expect(entry.frames).toEqual(["asset:///raw.jpg"]);
  });

  it("subscribers are notified on every state change", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "get_video_frames") return null;
      return { status: "ok", paths: ["/a.jpg"], timestamps: [0] };
    });
    const q = new VideoFrameQueue(invokeMock as unknown as InvokeFn, (p) => p);
    const notify = vi.fn();
    q.subscribe(notify);
    q.enqueue(1);
    await q.drain();
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
