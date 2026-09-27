// The Library-refresh scheduler behind the shared tag ops. What it prevents is
// a regression the tag-ops slice introduced: the auto-tagger's full-library
// pass fires one bulkUpdateTracks per artist/album/year at once, and each used
// to trigger its own full library reload. Pinned: a burst is one run, kinds
// merge, and a sustained stream still flushes at the max wait.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCoalescedRefresh } from "../utils/coalescedRefresh";

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

describe("createCoalescedRefresh", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a burst of requests runs once, after the quiet period", () => {
    const run = vi.fn();
    const r = createCoalescedRefresh(run, { delayMs: 750, maxWaitMs: 5000, timers });
    for (let i = 0; i < 300; i++) r.request("files");
    vi.advanceTimersByTime(749);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ tags: false, files: true });
  });

  it("merges both kinds into the one run", () => {
    const run = vi.fn();
    const r = createCoalescedRefresh(run, { delayMs: 750, maxWaitMs: 5000, timers });
    r.request("tags");
    vi.advanceTimersByTime(300);
    r.request("files");
    vi.advanceTimersByTime(750);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ tags: true, files: true });
  });

  it("a sustained stream still flushes at the max wait", () => {
    const run = vi.fn();
    const r = createCoalescedRefresh(run, { delayMs: 750, maxWaitMs: 5000, timers });
    // A request every 500ms would reset a plain trailing debounce forever.
    for (let elapsed = 0; elapsed < 5000; elapsed += 500) {
      r.request("tags");
      vi.advanceTimersByTime(500);
    }
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ tags: true, files: false });
  });

  it("a request after a flush starts a fresh burst", () => {
    const run = vi.fn();
    const r = createCoalescedRefresh(run, { delayMs: 750, maxWaitMs: 5000, timers });
    r.request("files");
    vi.advanceTimersByTime(750);
    r.request("tags");
    vi.advanceTimersByTime(750);
    expect(run.mock.calls).toEqual([[{ tags: false, files: true }], [{ tags: true, files: false }]]);
  });

  it("cancel drops what is pending and leaves the scheduler usable", () => {
    const run = vi.fn();
    const r = createCoalescedRefresh(run, { delayMs: 750, maxWaitMs: 5000, timers });
    r.request("files");
    r.cancel();
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
    r.request("tags");
    vi.advanceTimersByTime(750);
    expect(run).toHaveBeenCalledWith({ tags: true, files: false });
  });
});
