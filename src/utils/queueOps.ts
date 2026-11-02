// Queue entry operations shared by every caller that puts tracks into the
// queue from outside the queue's own UI: the plugin playback bridge (App's
// pluginPlaybackCallbacks), the Cmd+K plugin-result actions, and the control
// API dispatcher (hooks/useControlApi.ts). Same split as hostOps.ts — the op
// owns the decisions, the callers own argument shape and responses.
//
// Duplicates (queue.md "Duplicate Detection"): an enqueue adds what it was
// given. Only the control API asks to leave out tracks already queued
// (`skipDuplicates`), and reports how many it left out.
//
// There is no like step: a queue entry carries no like of its own, every
// heart reads the track-like store by song (frontend.md → trackLikeStore).
//
// Replacing plays (`playNow`, `playWithBackfill`) are not enqueues: they
// replace the queue, and a backfill tail continues a play the user already
// made (conventions.md "Play With Backfill").

import type { QueueTrack } from "../types";
import type { EnqueueOptions, EnqueueOutcome, PlaylistContext } from "../hooks/useQueue";

export interface BackfillOpts {
  /** Plays now; empty when the first track isn't known yet (the list then
   *  replaces the queue when it lands). */
  head: QueueTrack[];
  context?: PlaylistContext | null;
  resolveTail: () => Promise<QueueTrack[]>;
  tailErrorMessage?: string;
  /** Who is building the list (a plugin's name), shown while it loads. */
  source?: string | null;
  /** The surface that started the play (a Home card). */
  originKey?: string | null;
}

/** `"end"` appends; `"next"` inserts after the playing entry; a number is an
 *  absolute queue index. */
export type QueuePosition = "end" | "next" | number;

export interface QueueOpsDeps {
  playTracks: (tracks: QueueTrack[], startIndex: number, context?: PlaylistContext | null) => number;
  /** useQueue.enqueueTracks. */
  enqueueTracks: (tracks: QueueTrack[], opts: EnqueueOptions) => EnqueueOutcome;
  /** The live queue index (read at call time — "next" must not use a stale one). */
  queueIndex: () => number;
  /** usePlayActions.playWithBackfill. */
  playWithBackfill: (opts: BackfillOpts) => Promise<QueueTrack[]>;
}

export type AddToQueueOutcome = EnqueueOutcome;

/** Replace the queue and start playing. Returns the play generation. */
export function playNow(
  deps: QueueOpsDeps,
  tracks: QueueTrack[],
  opts: { startIndex?: number; context?: PlaylistContext | null } = {},
): number {
  return deps.playTracks(tracks, opts.startIndex ?? 0, opts.context);
}

function absolutePosition(position: QueuePosition, queueIndex: number): number | undefined {
  if (position === "end") return undefined;
  if (position === "next") return queueIndex + 1;
  return position;
}

/** Add to the current queue without interrupting playback. */
export function addToQueue(
  deps: QueueOpsDeps,
  tracks: QueueTrack[],
  opts: { position?: QueuePosition; skipDuplicates?: boolean } = {},
): AddToQueueOutcome {
  const position = absolutePosition(opts.position ?? "end", deps.queueIndex());
  return deps.enqueueTracks(tracks, { position, skipDuplicates: opts.skipDuplicates });
}

/** A play whose list takes time to build (see conventions.md "Play With
 *  Backfill"): a known head plays now and the rest is appended behind it; with
 *  no head the list replaces the queue once it lands. Resolves with what landed. */
export async function playWithBackfill(deps: QueueOpsDeps, opts: BackfillOpts): Promise<QueueTrack[]> {
  return deps.playWithBackfill(opts);
}
