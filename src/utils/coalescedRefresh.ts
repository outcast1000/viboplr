// Coalesces the Library refreshes the shared tag ops ask for (utils/tagOps.ts
// → App's TagOpsDeps). Two kinds, merged into one run per burst:
//
//   - "tags":  a DB-only tag add → the tags-only recount, then a library reload
//   - "files": a file-metadata write → library + track-list reload
//
// Why both need it: the auto-tagger's full-library pass fires one
// bulkUpdateTracks per distinct artist / album / year through Promise.all, and
// tags every scanned track one call at a time — undebounced, that was hundreds
// of back-to-back full reloads. Trailing debounce so a burst costs one run, plus
// a max wait so a sustained stream (a long scan) still refreshes every few
// seconds instead of only once it stops. Pure (timers injectable) for tests.

export interface RefreshKinds {
  tags: boolean;
  files: boolean;
}

export interface CoalescedRefresh {
  request: (kind: keyof RefreshKinds) => void;
  /** Drop anything pending (unmount). */
  cancel: () => void;
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createCoalescedRefresh(
  run: (kinds: RefreshKinds) => void,
  opts: { delayMs: number; maxWaitMs: number; timers?: Timers },
): CoalescedRefresh {
  const t = opts.timers ?? realTimers;
  let pending: RefreshKinds = { tags: false, files: false };
  let timer: unknown = null;
  let firstRequestAt: number | null = null;

  const flush = () => {
    timer = null;
    firstRequestAt = null;
    const kinds = pending;
    pending = { tags: false, files: false };
    run(kinds);
  };

  return {
    request(kind) {
      pending[kind] = true;
      const now = t.now();
      if (firstRequestAt === null) firstRequestAt = now;
      if (timer !== null) t.clearTimeout(timer);
      // Never push the run past maxWait from the first request of the burst.
      const wait = Math.max(0, Math.min(opts.delayMs, firstRequestAt + opts.maxWaitMs - now));
      timer = t.setTimeout(flush, wait);
    },
    cancel() {
      if (timer !== null) t.clearTimeout(timer);
      timer = null;
      firstRequestAt = null;
      pending = { tags: false, files: false };
    },
  };
}
